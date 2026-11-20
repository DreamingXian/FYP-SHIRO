// =============================================================================
// SHIRO Edge Server - Lining a LiDAR's scan up with the ward's walls (Phase 10)
// A LiDAR placed by hand is a few centimetres and a degree or two away from
// where the ward editor says it is. Its scan of the empty room shows where the
// walls are as the LiDAR sees them; this module finds the position (x, y) and
// heading at which those points lie on the walls and tall obstacles drawn in
// the ward layout.
//
// Method: each return is scored by its distance to the nearest drawn surface,
// counted at most 10 cm (people, an open door, a chair: anything not drawn
// costs the same however far it is). The score is the mean of the squared,
// capped distances.
//   1. Grid search within 0.30 m and 10 degrees of the position in the editor,
//      on a 1 cm distance map of the ward.
//   2. Pattern search from the best grid point, with exact distances, down to
//      0.5 mm and 0.01 degrees.
//   3. Checks: the same search over all headings, and with the scan mirrored.
//      If either fits clearly better, the heading in the editor (or the scan's
//      direction of turning) is wrong, and the result says so.
//
// Plain functions: no database, no clock.
// =============================================================================
const { BINS, binAngleDeg, wardSurfaces, nearestSurface, distanceToSegment, sliceHeight } = require('./scan_geometry');

const DEFAULTS = Object.freeze({
  capM: 0.10,              // a point farther than this from every surface counts as this far
  inlierM: 0.05,           // "on a surface"
  searchXYM: 0.30,
  gridStepXYM: 0.03,
  searchHeadingDeg: 10,
  gridStepDeg: 0.5,
  checkStepDeg: 2,         // the all-headings and mirrored checks
  checkStepXYM: 0.06,
  mapCellM: 0.01,
  mapMarginM: 0.5,
  maxMapCells: 2000000,
  minRangeM: 0.10,
  maxRangeM: 8.0,
  minPoints: 60,
  clearlyBetter: 0.7       // another fit is clearly better when its score is below 70% of this one's
});

const DEG = Math.PI / 180;
const norm360 = (deg) => ((deg % 360) + 360) % 360;
const round = (v, digits) => Math.round(v * 10 ** digits) / 10 ** digits;
const finite = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

function compassName(deg) {
  const names = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  return names[Math.round(norm360(deg) / 45) % 8];
}

/** A grid of the distance to the nearest surface, capped, for fast scoring. */
function distanceMap(layout, segments, cfg) {
  const L = finite(layout.length_x);
  const W = finite(layout.width_y);
  let cell = cfg.mapCellM;
  const span = (len) => Math.ceil((len + 2 * cfg.mapMarginM) / cell) + 1;
  while (span(L) * span(W) > cfg.maxMapCells) cell *= 2;
  const nx = span(L);
  const ny = span(W);
  const x0 = -cfg.mapMarginM;
  const y0 = -cfg.mapMarginM;
  const field = new Float32Array(nx * ny);
  for (let iy = 0; iy < ny; iy++) {
    const y = y0 + iy * cell;
    for (let ix = 0; ix < nx; ix++) {
      const x = x0 + ix * cell;
      let best = cfg.capM;
      for (const s of segments) {
        const d = distanceToSegment(x, y, s);
        if (d < best) best = d;
      }
      field[iy * nx + ix] = best;
    }
  }
  return {
    at(x, y) {
      const ix = Math.round((x - x0) / cell);
      const iy = Math.round((y - y0) / cell);
      if (ix < 0 || iy < 0 || ix >= nx || iy >= ny) return cfg.capM;
      return field[iy * nx + ix];
    }
  };
}

/** The scan's returns as distance and angle from the ▲ (radians). */
function scanPoints(distancesMm, cfg) {
  const points = [];
  for (let i = 0; i < BINS; i++) {
    const r = (distancesMm[i] || 0) / 1000;
    if (r >= cfg.minRangeM && r <= cfg.maxRangeM) points.push({ r, a: binAngleDeg(i) * DEG });
  }
  return points;
}

/** Offsets of the points from the LiDAR for a heading (degrees). */
function offsetsFor(points, headingDeg, mirrored) {
  const h = headingDeg * DEG;
  const ox = new Float64Array(points.length);
  const oy = new Float64Array(points.length);
  for (let k = 0; k < points.length; k++) {
    const b = mirrored ? h - points[k].a : h + points[k].a;
    ox[k] = points[k].r * Math.sin(b);
    oy[k] = points[k].r * Math.cos(b);
  }
  return { ox, oy };
}

/** Mean capped squared distance on the map, using every step-th point. */
function mapScore(map, off, x, y, step = 1) {
  let sum = 0;
  let n = 0;
  for (let k = 0; k < off.ox.length; k += step) {
    const d = map.at(x + off.ox[k], y + off.oy[k]);
    sum += d * d;
    n++;
  }
  return n ? sum / n : Infinity;
}

/** Grid search over headings and positions on the map. Returns the best { x, y, heading, score }. */
function gridSearch(map, points, centre, { headings, xyHalf, xyStep, mirrored = false, pointStep = 1 }) {
  let best = { score: Infinity };
  const steps = Math.round(xyHalf / xyStep);
  for (const heading of headings) {
    const off = offsetsFor(points, heading, mirrored);
    for (let iy = -steps; iy <= steps; iy++) {
      for (let ix = -steps; ix <= steps; ix++) {
        const x = centre.x + ix * xyStep;
        const y = centre.y + iy * xyStep;
        const score = mapScore(map, off, x, y, pointStep);
        if (score < best.score) best = { x, y, heading, score };
      }
    }
  }
  return best;
}

/** Exact score: mean capped squared distance to the nearest surface. */
function exactScore(segments, points, pose, cfg) {
  const off = offsetsFor(points, pose.heading, false);
  let sum = 0;
  for (let k = 0; k < points.length; k++) {
    const d = Math.min(cfg.capM, nearestSurface(pose.x + off.ox[k], pose.y + off.oy[k], segments).distance);
    sum += d * d;
  }
  return sum / points.length;
}

/** Pattern search with exact distances from a start pose. */
function refine(segments, points, start, cfg) {
  let pose = { ...start };
  let score = exactScore(segments, points, pose, cfg);
  let stepXY = 0.01;
  let stepDeg = 0.25;
  while (stepXY >= 0.0005) {
    let improved = false;
    const tries = [
      { x: pose.x + stepXY, y: pose.y, heading: pose.heading }, { x: pose.x - stepXY, y: pose.y, heading: pose.heading },
      { x: pose.x, y: pose.y + stepXY, heading: pose.heading }, { x: pose.x, y: pose.y - stepXY, heading: pose.heading },
      { x: pose.x, y: pose.y, heading: pose.heading + stepDeg }, { x: pose.x, y: pose.y, heading: pose.heading - stepDeg }
    ];
    for (const t of tries) {
      const s = exactScore(segments, points, t, cfg);
      if (s < score - 1e-12) {
        pose = t;
        score = s;
        improved = true;
      }
    }
    if (!improved) {
      stepXY /= 2;
      stepDeg /= 2;
    }
  }
  return { ...pose, score };
}

/** How well the points sit on the surfaces at a pose. */
function fitStats(segments, points, pose, cfg) {
  const off = offsetsFor(points, pose.heading, false);
  const residuals = [];
  let alongX = 0;
  let alongY = 0;
  for (let k = 0; k < points.length; k++) {
    const near = nearestSurface(pose.x + off.ox[k], pose.y + off.oy[k], segments);
    if (near.distance <= cfg.inlierM) {
      residuals.push(near.distance);
      if (near.segment.axis === 'x') alongX++;
      else alongY++;
    }
  }
  residuals.sort((a, b) => a - b);
  const n = residuals.length;
  return {
    points: points.length,
    on_surface: n,
    on_surface_pct: round((100 * n) / points.length, 1),
    median_residual_mm: n ? Math.round(1000 * residuals[Math.floor((n - 1) / 2)]) : null,
    rms_residual_mm: n ? Math.round(1000 * Math.sqrt(residuals.reduce((s, d) => s + d * d, 0) / n)) : null,
    // Walls running east-west fix y; walls running north-south fix x
    on_east_west_surfaces_pct: n ? round((100 * alongX) / n, 1) : 0,
    on_north_south_surfaces_pct: n ? round((100 * alongY) / n, 1) : 0
  };
}

/**
 * Finds where the LiDAR is from its scan of the room.
 * @param {object} args
 * @param {ArrayLike<number>} args.distancesMm  720 distances in mm (best: the learned empty room)
 * @param {object} args.layout   ward layout (length_x, width_y, height_z, obstacles)
 * @param {{x, y, heading_deg, base_height?}} args.pose  where the editor has the LiDAR now
 * @param {object} [args.options]
 */
function alignScan({ distancesMm, layout, pose, options = {} }) {
  const cfg = { ...DEFAULTS, ...options };
  const L = finite(layout && layout.length_x);
  const W = finite(layout && layout.width_y);
  if (!(L > 0) || !(W > 0)) return { ok: false, reason: 'The ward has no size.' };
  const start = { x: finite(pose && pose.x), y: finite(pose && pose.y), heading: norm360(finite(pose && pose.heading_deg)) };
  const points = scanPoints(distancesMm, cfg);
  if (points.length < cfg.minPoints) {
    return { ok: false, reason: `The scan has only ${points.length} returns between ${cfg.minRangeM} and ${cfg.maxRangeM} m; at least ${cfg.minPoints} are needed.` };
  }
  const segments = wardSurfaces(layout, sliceHeight(pose && pose.base_height));
  const map = distanceMap(layout, segments, cfg);

  // 1. Near the editor's position
  const localHeadings = [];
  for (let d = -cfg.searchHeadingDeg; d <= cfg.searchHeadingDeg + 1e-9; d += cfg.gridStepDeg) localHeadings.push(start.heading + d);
  const coarse = gridSearch(map, points, start, { headings: localHeadings, xyHalf: cfg.searchXYM, xyStep: cfg.gridStepXYM });

  // 2. Fine
  const fine = refine(segments, points, coarse, cfg);
  const result = { x: fine.x, y: fine.y, heading: norm360(fine.heading) };

  // 3. Checks: any heading, and the scan mirrored
  const allHeadings = [];
  for (let h = 0; h < 360; h += cfg.checkStepDeg) allHeadings.push(h);
  const anyHeading = gridSearch(map, points, start, { headings: allHeadings, xyHalf: cfg.searchXYM, xyStep: cfg.checkStepXYM, pointStep: 2 });
  const mirrored = gridSearch(map, points, start, { headings: allHeadings, xyHalf: cfg.searchXYM, xyStep: cfg.checkStepXYM, pointStep: 2, mirrored: true });
  // The local result scored the same coarse way, for a fair comparison
  const localCheck = gridSearch(map, points, result, { headings: [result.heading], xyHalf: 0, xyStep: cfg.checkStepXYM, pointStep: 2 });

  const before = fitStats(segments, points, start, cfg);
  const after = fitStats(segments, points, result, cfg);
  const warnings = [];

  const headingOff = Math.abs(((anyHeading.heading - result.heading + 540) % 360) - 180);
  let wrongHeading = false;
  if (headingOff > cfg.searchHeadingDeg && anyHeading.score < cfg.clearlyBetter * localCheck.score) {
    wrongHeading = true;
    warnings.push(`The scan fits much better with the ▲ pointing about ${Math.round(anyHeading.heading)}° (${compassName(anyHeading.heading)}). Check which way the ▲ points and set that heading, then align again.`);
  }
  const mirroredBetter = mirrored.score < cfg.clearlyBetter * Math.min(localCheck.score, anyHeading.score);
  if (mirroredBetter) {
    warnings.push('The scan fits much better mirrored (as if the LiDAR turned the other way). Report this: the scan directions would be read wrongly.');
  }
  const dx = result.x - start.x;
  const dy = result.y - start.y;
  const dHeading = ((result.heading - start.heading + 540) % 360) - 180;
  if (Math.abs(dx) > cfg.searchXYM - cfg.gridStepXYM || Math.abs(dy) > cfg.searchXYM - cfg.gridStepXYM ||
      Math.abs(dHeading) > cfg.searchHeadingDeg - cfg.gridStepDeg) {
    warnings.push(`The best fit is at the edge of the search (${cfg.searchXYM} m, ${cfg.searchHeadingDeg}°): the LiDAR is probably farther from the position in the editor. Measure it again, enter it, and align again.`);
  }
  if (after.on_surface > 0 && (after.on_east_west_surfaces_pct < 10 || after.on_north_south_surfaces_pct < 10)) {
    warnings.push(after.on_east_west_surfaces_pct < 10
      ? 'Hardly any wall running east-west is seen: the north-south position (y) is not well fixed.'
      : 'Hardly any wall running north-south is seen: the east-west position (x) is not well fixed.');
  }

  let quality = 'POOR';
  if (!wrongHeading && !mirroredBetter && after.on_surface_pct >= 60 && after.median_residual_mm !== null && after.median_residual_mm <= 25) quality = 'GOOD';
  else if (!wrongHeading && !mirroredBetter && after.on_surface_pct >= 40) quality = 'FAIR';
  if (quality !== 'GOOD' && after.on_surface_pct < 60) {
    warnings.push(`Only ${after.on_surface_pct}% of the returns lie within 5 cm of a drawn wall or obstacle. Things not drawn in the layout (furniture taller than ${round(sliceHeight(pose && pose.base_height), 2)} m, curtains, people) lower this; check the room size and obstacles too.`);
  }

  return {
    ok: true,
    pose: { x: round(result.x, 2), y: round(result.y, 2), heading_deg: round(norm360(result.heading), 1) },
    change: {
      dx_m: round(dx, 3), dy_m: round(dy, 3), moved_m: round(Math.hypot(dx, dy), 3), dheading_deg: round(dHeading, 2)
    },
    before,
    after,
    quality,
    checks: {
      best_any_heading_deg: Math.round(anyHeading.heading),
      mirrored_fits_better: mirroredBetter
    },
    warnings
  };
}

module.exports = { alignScan, DEFAULTS };
