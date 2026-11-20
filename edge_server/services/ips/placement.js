// =============================================================================
// SHIRO Edge Server - Placement planner for the anchors and the LiDAR (Phase 10)
//
// Suggests where to mount the Bluetooth anchors and the LiDAR room sensor in a
// ward, and says it in words someone with a tape measure can follow.
//
// Anchors: candidate spots every 10 cm along the walls (and the outer faces of
// tall partitions or bathrooms) at one mounting height. A layout is scored by
// the expected position error over the floor at wrist height, from the
// Cramer-Rao lower bound for positioning by signal strength (Patwari et al.,
// "Relative location estimation in wireless sensor networks", IEEE Trans.
// Signal Processing 51(8), 2003), with the room itself as prior knowledge:
//   - an anchor with a clear line to a floor point adds information that grows
//     with 1/d^4 in the direction of the anchor; close anchors from different
//     directions help most, one straight above the wrist helps little;
//   - an anchor whose line is blocked by a tall object adds nothing;
//   - door and bed areas count twice (zones.js), where the position matters most.
// Search: anchors are added one at a time (each where it lowers the error most),
// then moved one at a time to better spots until nothing improves.
//
// LiDAR: candidate spots 0.18 m out from each wall, not on furniture and not in
// the door area; the one that sees the most floor in its scan slice (0.95 m
// above the floor) wins, with a penalty for spots on a walking route between a
// bed and the door. Beds are below the slice. Anything taller blocks it, and so
// does a table: things put on it reach the slice.
//
// Plain functions: no database, no clock. Coordinates in metres from the
// south-west corner, x towards east, y towards north. Facing and heading are
// compass degrees: 0 = north, 90 = east, clockwise.
// =============================================================================

const { buildZones, zoneAt, bedFootprint } = require('./zones');

const DEFAULTS = Object.freeze({
  anchorCount: 6,
  wristHeight: 0.85,          // a standing or sitting patient's wrist
  recommendedHeight: 2.40,
  ceilingGap: 0.15,           // below the ceiling, when the ceiling is lower than 2.55 m
  minHeight: 1.50,
  maxHeight: 3.00,
  gridStep: 0.20,
  maxGridPoints: 1500,
  candidateStep: 0.10,
  maxCandidates: 320,
  cornerGap: 0.30,
  faceEndGap: 0.15,
  doorGap: 0.20,
  minSeparation: 0.80,
  pathLossExponent: 3.2,      // the calibration default
  shadowingDb: 6,             // spread of the signal around the path-loss line, dB
  zoneWeight: 2,
  maxRounds: 10,
  lidarOffset: 0.18,          // centre of the LiDAR from the wall
  lidarBaseHeight: 0.92,
  lidarSliceAboveBase: 0.03,  // Slamtec: the laser is 29.8 mm above the base
  lidarRange: 6.0,            // black objects (datasheet C1M1-R2)
  lidarDoorMargin: 0.10,
  lidarClutterHeight: 0.30,   // cups, bags, a laptop on a table
  lidarRouteClearance: 0.50,  // from a walking route between a bed and the door
  lidarRoutePenalty: 5        // percentage points of floor seen
});

const MOUNTABLE_OBSTACLES = ['TOILET', 'PARTITION', 'PILLAR'];

/** A layout the planner cannot work with (too small, no free wall). */
class PlacementError extends Error {}

const round2 = (v) => Math.round(v * 100) / 100;
const finite = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

function obstacleHeight(o, roomH) {
  if (o.height !== undefined && o.height !== null && Number.isFinite(Number(o.height))) return Number(o.height);
  return String(o.type || '').toUpperCase() === 'TABLE' ? 0.75 : roomH;
}

function obstacleRects(layout, roomH) {
  return (layout.obstacles || []).map((o, i) => ({
    id: o.id || `obstacle-${i + 1}`,
    type: String(o.type || '').toUpperCase(),
    label: String(o.label || o.type || `Obstacle ${i + 1}`),
    x: finite(o.x), y: finite(o.y), w: finite(o.width, 1), l: finite(o.length, 1),
    h: obstacleHeight(o, roomH)
  }));
}

const insideRect = (r, x, y, margin = 0) =>
  x >= r.x - margin && x <= r.x + r.w + margin && y >= r.y - margin && y <= r.y + r.l + margin;

/**
 * The range [t0, t1] (0..1) of the segment (x0,y0)-(x1,y1) inside a rectangle,
 * or null when it misses it (Liang-Barsky clipping).
 */
function segmentInRect(x0, y0, x1, y1, r) {
  let t0 = 0;
  let t1 = 1;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const p = [-dx, dx, -dy, dy];
  const q = [x0 - r.x, r.x + r.w - x0, y0 - r.y, r.y + r.l - y0];
  for (let i = 0; i < 4; i++) {
    if (Math.abs(p[i]) < 1e-12) {
      if (q[i] < 0) return null;
      continue;
    }
    const t = q[i] / p[i];
    if (p[i] < 0) {
      if (t > t1) return null;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return null;
      if (t < t1) t1 = t;
    }
  }
  return t0 <= t1 ? [t0, t1] : null;
}

/**
 * True when nothing blocks the straight line from an anchor (ax, ay, az) down
 * to a point (tx, ty, tz). The line goes down, so inside an obstacle's
 * footprint it is lowest where it leaves it: the obstacle blocks when it is at
 * least that high (as check3dRayLos in the ward editor).
 */
function clearLine(ax, ay, az, tx, ty, tz, obstacles, ignoreId) {
  for (const o of obstacles) {
    if (ignoreId && o.id === ignoreId) continue;
    const hit = segmentInRect(ax, ay, tx, ty, o);
    if (!hit) continue;
    const [tIn, tOut] = hit;
    if (tOut < 0.01 || tIn > 0.99) continue;
    const exitHeight = az + Math.min(1, tOut) * (tz - az);
    if (o.h >= exitHeight) return false;
  }
  return true;
}

/** Mounting height: 2.40 m, or 15 cm below a lower ceiling; never above 3.0 m. */
function mountingHeight(roomH, requested, cfg = DEFAULTS) {
  const ceilingLimit = roomH - 0.05;
  if (Number.isFinite(requested)) return round2(Math.max(cfg.minHeight, Math.min(requested, cfg.maxHeight, ceilingLimit)));
  return round2(Math.max(cfg.minHeight, Math.min(cfg.recommendedHeight, roomH - cfg.ceilingGap, cfg.maxHeight)));
}

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
function compassName(deg) {
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

/**
 * The surfaces an anchor can be mounted on: the four room walls and the outer
 * faces of partitions, pillars and bathrooms that reach the mounting height.
 * Each runs from a start corner to an end corner; facing is into the room.
 */
function mountingSurfaces(L, W, obstacles, height) {
  const surfaces = [
    { id: 'SOUTH', name: 'south wall', short: 'S wall', x1: 0, y1: 0, x2: L, y2: 0, facing: 0, from: 'south-west corner', to: 'south-east corner', fromShort: 'SW', toShort: 'SE', endGap: DEFAULTS.cornerGap },
    { id: 'NORTH', name: 'north wall', short: 'N wall', x1: 0, y1: W, x2: L, y2: W, facing: 180, from: 'north-west corner', to: 'north-east corner', fromShort: 'NW', toShort: 'NE', endGap: DEFAULTS.cornerGap },
    { id: 'WEST', name: 'west wall', short: 'W wall', x1: 0, y1: 0, x2: 0, y2: W, facing: 90, from: 'south-west corner', to: 'north-west corner', fromShort: 'SW', toShort: 'NW', endGap: DEFAULTS.cornerGap },
    { id: 'EAST', name: 'east wall', short: 'E wall', x1: L, y1: 0, x2: L, y2: W, facing: 270, from: 'south-east corner', to: 'north-east corner', fromShort: 'SE', toShort: 'NE', endGap: DEFAULTS.cornerGap }
  ];
  for (const o of obstacles) {
    if (!MOUNTABLE_OBSTACLES.includes(o.type) || o.h < height) continue;
    const of = `of ${o.label}`;
    const faces = [
      { side: 'north', ok: o.y + o.l < W - 0.25, x1: o.x, y1: o.y + o.l, x2: o.x + o.w, y2: o.y + o.l, facing: 0, from: `north-west corner ${of}`, to: `north-east corner ${of}`, fromShort: 'NW', toShort: 'NE' },
      { side: 'south', ok: o.y > 0.25, x1: o.x, y1: o.y, x2: o.x + o.w, y2: o.y, facing: 180, from: `south-west corner ${of}`, to: `south-east corner ${of}`, fromShort: 'SW', toShort: 'SE' },
      { side: 'east', ok: o.x + o.w < L - 0.25, x1: o.x + o.w, y1: o.y, x2: o.x + o.w, y2: o.y + o.l, facing: 90, from: `south-east corner ${of}`, to: `north-east corner ${of}`, fromShort: 'SE', toShort: 'NE' },
      { side: 'west', ok: o.x > 0.25, x1: o.x, y1: o.y, x2: o.x, y2: o.y + o.l, facing: 270, from: `south-west corner ${of}`, to: `north-west corner ${of}`, fromShort: 'SW', toShort: 'NW' }
    ];
    for (const f of faces) {
      if (!f.ok) continue;
      surfaces.push({
        id: `${o.id}:${f.side}`, name: `${f.side} side of ${o.label}`, short: `${o.label} ${f.side}`,
        x1: f.x1, y1: f.y1, x2: f.x2, y2: f.y2, facing: f.facing, from: f.from, to: f.to,
        fromShort: f.fromShort, toShort: f.toShort, endGap: DEFAULTS.faceEndGap, mountedOn: o.id
      });
    }
  }
  return surfaces;
}

/** Where the door is along a room wall, as [start, end] in metres from that wall's start corner. */
function doorSpan(door, surfaceId) {
  if (!door || String(door.wall || '').toUpperCase() !== surfaceId) return null;
  const start = finite(door.x);
  return [start, start + finite(door.width, 0.9)];
}

/** Candidate anchor spots along every surface. */
function anchorCandidates(L, W, layout, obstacles, height, step) {
  const surfaces = mountingSurfaces(L, W, obstacles, height);
  const out = [];
  for (const s of surfaces) {
    const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
    if (len < 2 * s.endGap) continue;
    const door = s.mountedOn ? null : doorSpan(layout.door, s.id);
    const ux = (s.x2 - s.x1) / len;
    const uy = (s.y2 - s.y1) / len;
    const n = Math.floor((len - 2 * s.endGap) / step + 1e-9);
    for (let i = 0; i <= n; i++) {
      const along = round2(s.endGap + i * step);
      if (door && along >= door[0] - DEFAULTS.doorGap && along <= door[1] + DEFAULTS.doorGap) continue;
      const x = round2(s.x1 + ux * along);
      const y = round2(s.y1 + uy * along);
      // Not behind something standing against the wall that reaches the mounting height
      const covered = obstacles.some(o => o.id !== s.mountedOn && o.h >= height - 0.10 && insideRect(o, x, y, 0.05));
      if (covered) continue;
      out.push({ x, y, z: height, surface: s, along, length: round2(len) });
    }
  }
  return out;
}

/** Floor points at wrist height, with their zone and weight. Obstacles are not floor; beds are. */
function floorGrid(L, W, obstacles, zoneMap, step, cfg) {
  const points = [];
  for (let gx = step / 2; gx < L; gx += step) {
    for (let gy = step / 2; gy < W; gy += step) {
      const x = round2(gx);
      const y = round2(gy);
      if (obstacles.some(o => insideRect(o, x, y))) continue;
      const zone = zoneAt(zoneMap, x, y);
      const weight = zone.type === 'DOOR' || zone.type === 'BED' ? cfg.zoneWeight : 1;
      points.push({ x, y, zone: zone.type, weight });
    }
  }
  return points;
}

/**
 * Information an anchor adds at each floor point: the 2x2 Fisher information
 * (xx, xy, yy) of the horizontal position from its signal strength, or zeros
 * where its line is blocked.
 */
function anchorInformation(anchor, points, obstacles, cfg, ignoreId) {
  const b = (10 * cfg.pathLossExponent) / (cfg.shadowingDb * Math.LN10);
  const b2 = b * b;
  const info = new Float64Array(points.length * 3);
  const seen = new Uint8Array(points.length);
  // Start the line 2 cm into the room, so a mounting surface never blocks itself
  const facingRad = ((anchor.facing || 0) * Math.PI) / 180;
  const ax = anchor.x + 0.02 * Math.sin(facingRad);
  const ay = anchor.y + 0.02 * Math.cos(facingRad);
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!clearLine(ax, ay, anchor.z, p.x, p.y, cfg.wristHeight, obstacles, ignoreId)) continue;
    const dx = p.x - anchor.x;
    const dy = p.y - anchor.y;
    const dz = cfg.wristHeight - anchor.z;
    const d2 = Math.max(0.01, dx * dx + dy * dy + dz * dz);
    const k = b2 / (d2 * d2);
    info[i * 3] = k * dx * dx;
    info[i * 3 + 1] = k * dx * dy;
    info[i * 3 + 2] = k * dy * dy;
    seen[i] = 1;
  }
  return { info, seen };
}

/** Weighted quantile of values (0..1). */
function weightedQuantile(values, weights, q) {
  const order = values.map((v, i) => i).sort((a, b) => values[a] - values[b]);
  const total = weights.reduce((s, w) => s + w, 0);
  let acc = 0;
  for (const i of order) {
    acc += weights[i];
    if (acc >= q * total) return values[i];
  }
  return values[order[order.length - 1]];
}

/**
 * Builds an evaluator for one room: sums the information of a set of anchors
 * and turns it into the expected error at every floor point.
 */
function makeEvaluator(points, prior) {
  const n = points.length;
  const weights = points.map(p => p.weight);
  const totalWeight = weights.reduce((s, w) => s + w, 0);

  function errorsOf(sum) {
    const errors = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = sum[i * 3] + prior.xx;
      const b = sum[i * 3 + 1];
      const c = sum[i * 3 + 2] + prior.yy;
      const det = a * c - b * b;
      errors[i] = det > 1e-12 ? Math.sqrt((a + c) / det) : Math.sqrt(1 / prior.xx + 1 / prior.yy);
    }
    return errors;
  }

  /** Weighted mean error of a set, given its summed information. */
  function score(sum) {
    let acc = 0;
    for (let i = 0; i < n; i++) {
      const a = sum[i * 3] + prior.xx;
      const b = sum[i * 3 + 1];
      const c = sum[i * 3 + 2] + prior.yy;
      const det = a * c - b * b;
      const e = det > 1e-12 ? Math.sqrt((a + c) / det) : Math.sqrt(1 / prior.xx + 1 / prior.yy);
      acc += weights[i] * e;
    }
    return acc / totalWeight;
  }

  function sumOf(members) {
    const sum = new Float64Array(n * 3);
    for (const m of members) for (let i = 0; i < sum.length; i++) sum[i] += m.info[i];
    return sum;
  }

  function summary(members) {
    const sum = sumOf(members);
    const errors = errorsOf(sum);
    const list = Array.from(errors);
    let seen3 = 0;
    let seenWeight = 0;
    for (let i = 0; i < n; i++) {
      let count = 0;
      for (const m of members) count += m.seen[i];
      if (count >= 3) {
        seen3++;
        seenWeight += weights[i];
      }
    }
    return {
      anchors: members.length,
      mean_error_m: round2(list.reduce((s, e, i) => s + e * weights[i], 0) / totalWeight),
      median_error_m: round2(weightedQuantile(list, weights, 0.5)),
      p95_error_m: round2(weightedQuantile(list, weights, 0.95)),
      clear_to_3_pct: Math.round((1000 * seen3) / Math.max(1, n)) / 10,
      clear_to_3_weighted_pct: Math.round((1000 * seenWeight) / Math.max(1e-9, totalWeight)) / 10,
      errors: list.map(round2)
    };
  }

  return { score, sumOf, summary, n };
}

function tooClose(c, others, minSeparation) {
  return others.some(o => Math.hypot(o.x - c.x, o.y - c.y) < minSeparation - 1e-9);
}

/**
 * Chooses spots for `count` new anchors among the candidates, next to the fixed
 * ones. Greedy, then one-at-a-time moves until no move lowers the error.
 */
function searchAnchors(candidates, fixed, count, evaluator, cfg) {
  const chosen = [];
  const base = evaluator.sumOf(fixed);
  const sum = new Float64Array(base);
  const n3 = sum.length;
  const trial = new Float64Array(n3);

  for (let k = 0; k < count; k++) {
    let best = -1;
    let bestScore = Infinity;
    for (let c = 0; c < candidates.length; c++) {
      if (chosen.includes(c) || tooClose(candidates[c], [...fixed, ...chosen.map(i => candidates[i])], cfg.minSeparation)) continue;
      const info = candidates[c].info;
      for (let i = 0; i < n3; i++) trial[i] = sum[i] + info[i];
      const s = evaluator.score(trial);
      if (s < bestScore - 1e-9) {
        bestScore = s;
        best = c;
      }
    }
    if (best < 0) break;
    chosen.push(best);
    const info = candidates[best].info;
    for (let i = 0; i < n3; i++) sum[i] += info[i];
  }

  let current = evaluator.score(sum);
  for (let round = 0; round < cfg.maxRounds; round++) {
    let improved = false;
    for (let slot = 0; slot < chosen.length; slot++) {
      const old = candidates[chosen[slot]].info;
      const others = [...fixed, ...chosen.filter((_, j) => j !== slot).map(i => candidates[i])];
      let bestC = chosen[slot];
      let bestScore = current;
      for (let c = 0; c < candidates.length; c++) {
        if (chosen.includes(c) || tooClose(candidates[c], others, cfg.minSeparation)) continue;
        const info = candidates[c].info;
        for (let i = 0; i < n3; i++) trial[i] = sum[i] - old[i] + info[i];
        const s = evaluator.score(trial);
        if (s < bestScore - 1e-6) {
          bestScore = s;
          bestC = c;
        }
      }
      if (bestC !== chosen[slot]) {
        const info = candidates[bestC].info;
        for (let i = 0; i < n3; i++) sum[i] += info[i] - old[i];
        chosen[slot] = bestC;
        current = bestScore;
        improved = true;
      }
    }
    if (!improved) break;
  }
  return chosen.map(i => candidates[i]);
}

/** "east wall, 1.60 m from the south-east corner" for a candidate spot. */
function placeText(c) {
  const s = c.surface;
  const fromStart = c.along <= c.length - c.along;
  const dist = fromStart ? c.along : round2(c.length - c.along);
  return {
    text: `${s.name}, ${dist.toFixed(2)} m from the ${fromStart ? s.from : s.to}`,
    short: `${s.short} · ${dist.toFixed(2)} m from ${fromStart ? s.fromShort : s.toShort}${s.mountedOn ? '' : ' corner'}`.slice(0, 64)
  };
}

const nextLetterId = (used) => {
  for (let i = 0; i < 26; i++) {
    const id = `Anchor ${String.fromCharCode(65 + i)}`;
    if (!used.has(id)) return id;
  }
  return `Anchor ${used.size + 1}`;
};

/** The facing of an existing anchor: into the room from the nearest wall. */
function facingOfPoint(x, y, L, W) {
  const d = [{ f: 0, v: y }, { f: 180, v: W - y }, { f: 90, v: x }, { f: 270, v: L - x }];
  d.sort((a, b) => a.v - b.v);
  return d[0].f;
}

// ----------------------------------------------------------------------------
// LiDAR
// ----------------------------------------------------------------------------

function lidarCandidates(L, W, obstacles, beds, doorRect, cfg) {
  const off = cfg.lidarOffset;
  const out = [];
  const add = (x, y, wall, facing, along, from, to, length) => {
    x = round2(x);
    y = round2(y);
    if (beds.some(b => insideRect(b, x, y, 0.05))) return;
    // Not on furniture: whatever is put on a table blocks the laser just above it
    if (obstacles.some(o => insideRect(o, x, y, 0.05))) return;
    if (doorRect && insideRect(doorRect, x, y, cfg.lidarDoorMargin)) return;
    out.push({ x, y, wall, facing, along: round2(along), from, to, length });
  };
  for (let a = off; a <= L - off + 1e-9; a += 0.1) {
    add(a, off, 'south wall', 0, a, 'south-west corner', 'south-east corner', L);
    add(a, W - off, 'north wall', 180, a, 'north-west corner', 'north-east corner', L);
  }
  for (let a = off; a <= W - off + 1e-9; a += 0.1) {
    add(off, a, 'west wall', 90, a, 'south-west corner', 'north-west corner', W);
    add(L - off, a, 'east wall', 270, a, 'south-east corner', 'north-east corner', W);
  }
  return out;
}

const pointToSegment = (px, py, [x1, y1, x2, y2]) => {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2)) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
};

/**
 * The walking routes in the ward: from where a patient gets out of each bed
 * (the middle of each free long side and of the foot end, 0.3 m out) to the
 * door (0.5 m into the room). A LiDAR on such a route would be knocked over.
 * Head end by rotation (as drawn in the ward editor): 0 north, 90 east, 180 south, 270 west.
 */
function walkingRoutes(layout, L, W, obstacles) {
  const door = layout.door;
  if (!door) return [];
  const along = finite(door.x) + finite(door.width, 0.9) / 2;
  const doorPoints = {
    SOUTH: [along, 0.5], NORTH: [along, W - 0.5], WEST: [0.5, along], EAST: [L - 0.5, along]
  };
  const target = doorPoints[String(door.wall || '').toUpperCase()];
  if (!target) return [];
  const blocked = (x, y) => x < 0.1 || y < 0.1 || x > L - 0.1 || y > W - 0.1 || obstacles.some(o => insideRect(o, x, y));
  const routes = [];
  for (const bed of layout.beds || []) {
    const f = bedFootprint(bed);
    const rot = ((parseInt(bed.rotation_deg, 10) || 0) % 360 + 360) % 360;
    const cx = f.x + f.w / 2;
    const cy = f.y + f.l / 2;
    const exits = rot === 90 || rot === 270
      ? [[cx, f.y - 0.3], [cx, f.y + f.l + 0.3], rot === 90 ? [f.x - 0.3, cy] : [f.x + f.w + 0.3, cy]]
      : [[f.x - 0.3, cy], [f.x + f.w + 0.3, cy], rot === 0 ? [cx, f.y - 0.3] : [cx, f.y + f.l + 0.3]];
    for (const [x, y] of exits) {
      if (!blocked(x, y)) routes.push([x, y, target[0], target[1]]);
    }
  }
  return routes;
}

/** Which floor points a LiDAR at (x, y) sees in its slice. */
function lidarView(spot, points, blockers, cfg) {
  const visible = new Uint8Array(points.length);
  let seenW = 0;
  let totalW = 0;
  let distW = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    totalW += p.weight;
    const d = Math.hypot(p.x - spot.x, p.y - spot.y);
    if (d > cfg.lidarRange) continue;
    if (blockers.some(o => segmentInRect(spot.x, spot.y, p.x, p.y, o))) continue;
    visible[i] = 1;
    seenW += p.weight;
    distW += p.weight * d;
  }
  return {
    visible,
    visible_weighted_pct: totalW > 0 ? (100 * seenW) / totalW : 0,
    mean_distance_m: seenW > 0 ? distW / seenW : 0
  };
}

function planLidar(L, W, layout, obstacles, zoneMap, cfg, step) {
  const slice = cfg.lidarBaseHeight + cfg.lidarSliceAboveBase;
  const beds = (layout.beds || []).map(bedFootprint);
  // Taller than the slice, or close enough below it that things put on it reach the slice (a table)
  const blockers = obstacles.filter(o => o.h >= slice - cfg.lidarClutterHeight);
  // Where a standing or walking person can be: not in an obstacle, not in a bed
  const standable = floorGrid(L, W, obstacles, zoneMap, step, cfg).filter(p => !beds.some(b => insideRect(b, p.x, p.y)));
  const door = zoneMap.zones.find(z => z.type === 'DOOR');
  const candidates = lidarCandidates(L, W, obstacles, beds, door ? door.rect : null, cfg);
  const routes = walkingRoutes(layout, L, W, obstacles);
  const onRoute = (spot) => routes.some(r => pointToSegment(spot.x, spot.y, r) < cfg.lidarRouteClearance);

  let best = null;
  for (const c of candidates) {
    const view = lidarView(c, standable, blockers, cfg);
    // Most floor seen, out of the walking routes; between equal ones the one
    // closer to the floor it sees (finer detail, fewer people in the way)
    const value = view.visible_weighted_pct - 0.5 * view.mean_distance_m - (onRoute(c) ? cfg.lidarRoutePenalty : 0);
    if (!best || value > best.value + 1e-9) best = { c, view, value };
  }

  function describe(spot, view, fromCandidate) {
    const visiblePct = Math.round(10 * view.visible_weighted_pct) / 10;
    const base = {
      x: spot.x, y: spot.y,
      base_height: cfg.lidarBaseHeight,
      slice_height: round2(slice),
      heading_deg: spot.facing,
      heading_name: compassName(spot.facing),
      visible_pct: visiblePct,
      on_walking_route: onRoute(spot),
      hidden: Array.from(view.visible).map((v, i) => (v ? -1 : i)).filter(i => i >= 0)
    };
    if (!fromCandidate) return base;
    const fromStart = spot.along <= spot.length - spot.along;
    const dist = fromStart ? spot.along : round2(spot.length - spot.along);
    const corner = fromStart ? spot.from : spot.to;
    return {
      ...base,
      wall_location: `${spot.wall.replace(' wall', '')} wall · ${dist.toFixed(2)} m from ${corner.replace(' corner', '')}`.slice(0, 64),
      instruction: `Against the ${spot.wall}: centre of the LiDAR ${dist.toFixed(2)} m from the ${corner} and ${cfg.lidarOffset.toFixed(2)} m out from the wall. ` +
        `Base ${cfg.lidarBaseHeight.toFixed(2)} m above the floor, level. The ▲ on top points ${compassName(spot.facing)} (${spot.facing}°), cable towards the wall. ` +
        `Nothing within 5 cm of it at the height of its window.`
    };
  }

  const result = best ? describe(best.c, best.view, true) : null;

  // The LiDAR already placed in the ward, scored the same way
  let current = null;
  const placed = (layout.room_sensors || [])[0];
  if (placed && Number.isFinite(Number(placed.x)) && Number.isFinite(Number(placed.y))) {
    const spot = { x: Number(placed.x), y: Number(placed.y), facing: finite(placed.heading_deg) };
    current = describe(spot, lidarView(spot, standable, blockers, cfg), false);
  }

  return {
    suggested: result,
    current,
    candidates: candidates.length,
    routes: routes.map(r => r.map(round2)),
    // "hidden" holds indices into this list (floor a standing person can be on)
    standable
  };
}

// ----------------------------------------------------------------------------
// The plan
// ----------------------------------------------------------------------------

/**
 * Plans the anchors (and the LiDAR) for a ward layout as the ward editor holds it.
 * @param {object} layout  ward layout: length_x, width_y, height_z, door, beds, obstacles, anchors, room_sensors
 * @param {object} [options]
 * @param {number} [options.anchorCount=6]
 * @param {number|null} [options.mountHeight]  null: 2.40 m or 15 cm below the ceiling
 * @param {boolean} [options.keepExisting=false]  keep the anchors already in the layout where they are
 * @param {boolean} [options.includeLidar=true]
 */
function planPlacement(layout, options = {}) {
  const cfg = { ...DEFAULTS };
  const L = finite(layout && layout.length_x, 0);
  const W = finite(layout && layout.width_y, 0);
  const roomH = finite(layout && layout.height_z, 2.6);
  if (!(L >= 1 && W >= 1)) throw new PlacementError('The room must be at least 1 m by 1 m.');
  if (L * W > 2000) throw new PlacementError('The room is larger than 2000 m²: plan it in parts.');

  const anchorCount = Math.max(3, Math.min(12, Math.round(finite(options.anchorCount, cfg.anchorCount))));
  const requestedHeight = options.mountHeight === null || options.mountHeight === undefined ? NaN : Number(options.mountHeight);
  const height = mountingHeight(roomH, requestedHeight, cfg);
  const keepExisting = options.keepExisting === true;
  const includeLidar = options.includeLidar !== false;
  const warnings = [];

  const obstacles = obstacleRects(layout, roomH);
  const zoneMap = buildZones(layout);
  const area = L * W;
  const gridStep = round2(Math.max(cfg.gridStep, Math.sqrt(area / cfg.maxGridPoints)));
  const points = floorGrid(L, W, obstacles, zoneMap, gridStep, cfg);
  const perimeter = 2 * (L + W);
  const candidateStep = round2(Math.max(cfg.candidateStep, perimeter / cfg.maxCandidates));

  // Prior: the patient is somewhere in the room (uniform: L / sqrt(12) per axis)
  const prior = { xx: 12 / (L * L), yy: 12 / (W * W) };
  const evaluator = makeEvaluator(points, prior);

  const existing = (layout.anchors || []).filter(a => Number.isFinite(Number(a.x)) && Number.isFinite(Number(a.y)));
  const existingMembers = existing.map(a => {
    const facing = facingOfPoint(Number(a.x), Number(a.y), L, W);
    const z = Number.isFinite(Number(a.z)) ? Number(a.z) : height;
    return { anchor: a, x: Number(a.x), y: Number(a.y), z, facing, ...anchorInformation({ x: Number(a.x), y: Number(a.y), z, facing }, points, obstacles, cfg, a.mountedOnObsId) };
  });
  const current = existingMembers.length ? evaluator.summary(existingMembers) : null;

  const candidates = anchorCandidates(L, W, layout, obstacles, height, candidateStep)
    .map(c => ({ ...c, facing: c.surface.facing, ...anchorInformation({ x: c.x, y: c.y, z: c.z, facing: c.surface.facing }, points, obstacles, cfg, c.surface.mountedOn) }));
  if (candidates.length === 0) throw new PlacementError('No wall has room for an anchor: check the room size, the door and the obstacles.');

  const fixed = keepExisting ? existingMembers.slice(0, anchorCount) : [];
  if (keepExisting && existingMembers.length >= anchorCount) {
    warnings.push(`The ward already has ${existingMembers.length} anchors: nothing to add. Raise the number of anchors or untick "keep".`);
  }
  const newSpots = searchAnchors(candidates, fixed, Math.max(0, anchorCount - fixed.length), evaluator, cfg);
  if (fixed.length + newSpots.length < anchorCount) {
    warnings.push(`Only ${fixed.length + newSpots.length} anchors fit with ${cfg.minSeparation.toFixed(2)} m between them.`);
  }
  if (!keepExisting && existingMembers.length > newSpots.length) {
    const dropped = existingMembers.slice(newSpots.length).map(m => m.anchor.anchor_id).join(', ');
    warnings.push(`Not in the suggestion: ${dropped}. Applying it removes them from the ward.`);
  }

  // Names: kept anchors keep theirs. Otherwise each existing board moves to the nearest new spot.
  const used = new Set(fixed.map(m => m.anchor.anchor_id));
  const assigned = new Map();
  if (!keepExisting) {
    const free = newSpots.map((s, i) => i);
    for (const m of existingMembers) {
      if (free.length === 0) break;
      free.sort((a, b) => Math.hypot(newSpots[a].x - m.x, newSpots[a].y - m.y) - Math.hypot(newSpots[b].x - m.x, newSpots[b].y - m.y));
      assigned.set(free.shift(), m);
    }
  }

  const planned = [];
  for (const m of fixed) {
    planned.push({
      anchor_id: m.anchor.anchor_id, device_id: m.anchor.device_id || null,
      x: m.x, y: m.y, z: round2(m.z), facing_deg: m.facing, facing_name: compassName(m.facing),
      wall_location: m.anchor.wall_location || '', action: 'KEEP', moved_m: 0,
      instruction: `Stays where it is (${m.x.toFixed(2)}, ${m.y.toFixed(2)} m, ${m.z.toFixed(2)} m high).`
    });
  }
  newSpots.forEach((s, i) => {
    const prev = assigned.get(i);
    const id = prev ? prev.anchor.anchor_id : nextLetterId(new Set([...used, ...planned.map(p => p.anchor_id), ...existing.map(a => a.anchor_id)]));
    used.add(id);
    const place = placeText(s);
    const moved = prev ? round2(Math.hypot(prev.x - s.x, prev.y - s.y)) : null;
    const action = !prev ? 'NEW' : moved < 0.05 ? 'KEEP' : 'MOVE';
    planned.push({
      anchor_id: id, device_id: prev ? (prev.anchor.device_id || null) : null,
      x: s.x, y: s.y, z: s.z, facing_deg: s.facing, facing_name: compassName(s.facing),
      wall_location: place.short, action, moved_m: moved,
      instruction: `${place.text.charAt(0).toUpperCase()}${place.text.slice(1)}. Board centre ${s.z.toFixed(2)} m above the floor. ` +
        `Upright, antenna end up, components facing into the room (${compassName(s.facing)}, ${s.facing}°).`
    });
  });
  planned.sort((a, b) => a.anchor_id.localeCompare(b.anchor_id, 'en', { numeric: true }));

  const members = [
    ...fixed,
    ...newSpots
  ];
  const suggested = evaluator.summary(members);
  if (suggested.clear_to_3_pct < 95) {
    warnings.push(`Only ${suggested.clear_to_3_pct}% of the floor has a clear line to 3 or more anchors: tall furniture is in the way.`);
  }

  let lidar = null;
  if (includeLidar) {
    const lp = planLidar(L, W, layout, obstacles, zoneMap, cfg, gridStep);
    // The LiDAR's hidden points are indices into its own (standable) list: give them as coordinates
    const toPoints = (list) => (list ? list.map(i => [lp.standable[i].x, lp.standable[i].y]) : []);
    lidar = {
      suggested: lp.suggested ? { ...lp.suggested, hidden: toPoints(lp.suggested.hidden) } : null,
      current: lp.current ? { ...lp.current, hidden: toPoints(lp.current.hidden) } : null,
      walking_routes: lp.routes,
      candidates: lp.candidates
    };
    if (!lp.suggested) warnings.push('No spot along the walls is free for the LiDAR (door, beds or obstacles).');
  }

  return {
    settings: {
      anchor_count: anchorCount, mount_height: height, keep_existing: keepExisting, include_lidar: includeLidar,
      wrist_height: cfg.wristHeight, grid_step: gridStep, candidate_step: candidateStep,
      path_loss_n: cfg.pathLossExponent, shadowing_db: cfg.shadowingDb, zone_weight: cfg.zoneWeight,
      min_separation: cfg.minSeparation
    },
    room: { length_x: L, width_y: W, height_z: roomH },
    // Expected error knowing only that the patient is in the room (no anchors)
    room_only_error_m: round2(Math.sqrt(1 / prior.xx + 1 / prior.yy)),
    grid: { step: gridStep, points: points.map(p => [p.x, p.y, p.weight]) },
    current,
    suggested: { ...suggested, anchors: planned },
    lidar,
    candidates: candidates.length,
    warnings
  };
}

module.exports = {
  planPlacement,
  PlacementError,
  mountingHeight,
  anchorCandidates,
  mountingSurfaces,
  clearLine,
  segmentInRect,
  compassName,
  DEFAULTS
};
