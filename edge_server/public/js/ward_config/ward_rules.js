// =============================================================================
// SHIRO - the rules of a ward layout (Phase 11)
// Used by the ward editor (shows the problems before saving) and by the server
// (refuses to save a layout that breaks them: controllers/ward_controller.js).
//   - Everything inside the room: beds, obstacles, wall sensors, the LiDAR, the door.
//   - One LiDAR per ward: one 360° LiDAR at about bed height sees a normal ward.
//   - At most 15 obstacles (furniture, partitions; small ones count too).
//   - Beds by floor space: one bed per 5 m² of free floor (room minus obstacles).
//     5 m² is the bed (0.9 × 2.0 m) with a 1 m strip on one side for care and
//     0.6 m at the foot. A project minimum, well below real hospital guidance,
//     so that small test rooms still take a bed.
// Beds that overlap each other are a warning, not an error (older layouts have
// them by a few centimetres).
// =============================================================================
(function () {
  const LIMITS = { maxLidars: 1, maxObstacles: 15, floorPerBedM2: 5, minAnchors: 3, maxAnchors: 12 };
  const EPS = 0.005;   // half a centimetre: rounding of values typed with 2 decimals

  const num = (v, fallback) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : fallback);
  const fmt = (v) => Number(v).toFixed(2);

  /** The room's size; the server stores 6.40 × 4.80 m when none is given. */
  function roomSize(ward) {
    return { L: num(ward && ward.length_x, 6.40), W: num(ward && ward.width_y, 4.80) };
  }

  /** The floor a bed covers, from its corner (x, y) and its turn. */
  function bedRect(bed) {
    const rot = ((parseInt(bed.rotation_deg, 10) || 0) % 360 + 360) % 360;
    const along = rot === 90 || rot === 270;
    const width = num(bed.width, 0.9);
    const length = num(bed.length, 2.0);
    return { x: num(bed.x, 0), y: num(bed.y, 0), w: along ? length : width, l: along ? width : length };
  }

  function obstacleRect(o) {
    return { x: num(o.x, 0), y: num(o.y, 0), w: num(o.width, 1), l: num(o.length, 1) };
  }

  const rectInside = (r, L, W) => r.x >= -EPS && r.y >= -EPS && r.x + r.w <= L + EPS && r.y + r.l <= W + EPS;
  const pointInside = (x, y, L, W) => x >= -EPS && y >= -EPS && x <= L + EPS && y <= W + EPS;
  const overlapArea = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.l, b.y + b.l) - Math.max(a.y, b.y));

  /** Free floor: the room minus its obstacles (the part of each inside the room). */
  function freeFloorM2(ward) {
    const { L, W } = roomSize(ward);
    const room = { x: 0, y: 0, w: L, l: W };
    const covered = (Array.isArray(ward.obstacles) ? ward.obstacles : [])
      .reduce((sum, o) => sum + overlapArea(obstacleRect(o), room), 0);
    return Math.max(0, L * W - covered);
  }

  /** How many beds the room has space for: at least 1. */
  function maxBeds(ward) {
    return Math.max(1, Math.floor((freeFloorM2(ward) + 1e-9) / LIMITS.floorPerBedM2));
  }

  /** How far the door may run along its wall. */
  function doorWallLength(ward) {
    const { L, W } = roomSize(ward);
    const wall = String((ward.door && ward.door.wall) || 'SOUTH').toUpperCase();
    return wall === 'EAST' || wall === 'WEST' ? W : L;
  }

  /**
   * The problems of a layout. errors: saving is refused; warnings: saved, but
   * worth a look. Each is a sentence for the person editing the ward.
   */
  function checkWardLayout(ward) {
    const errors = [];
    const warnings = [];
    if (!ward || typeof ward !== 'object') return { errors: ['No layout.'], warnings, maxBeds: 1 };
    const { L, W } = roomSize(ward);
    const size = `${fmt(L)} × ${fmt(W)} m`;
    const beds = Array.isArray(ward.beds) ? ward.beds : [];
    const obstacles = Array.isArray(ward.obstacles) ? ward.obstacles : [];
    const anchors = Array.isArray(ward.anchors) ? ward.anchors : [];
    const lidars = Array.isArray(ward.room_sensors) ? ward.room_sensors : [];

    beds.forEach((b, i) => {
      const r = bedRect(b);
      if (!rectInside(r, L, W)) {
        errors.push(`${b.bed_code || `Bed ${i + 1}`} is partly outside the room (it covers x ${fmt(r.x)}–${fmt(r.x + r.w)} m, y ${fmt(r.y)}–${fmt(r.y + r.l)} m; the room is ${size}). Move it inside.`);
      }
    });
    obstacles.forEach((o, i) => {
      const r = obstacleRect(o);
      if (!rectInside(r, L, W)) {
        errors.push(`Obstacle "${o.label || `${i + 1}`}" is partly outside the room (x ${fmt(r.x)}–${fmt(r.x + r.w)} m, y ${fmt(r.y)}–${fmt(r.y + r.l)} m; the room is ${size}). Move it inside or make it smaller.`);
      }
    });
    anchors.forEach((a, i) => {
      if (!pointInside(num(a.x, 0), num(a.y, 0), L, W)) {
        errors.push(`${a.anchor_id || `Wall sensor ${i + 1}`} is outside the room (${fmt(num(a.x, 0))}, ${fmt(num(a.y, 0))} m; the room is ${size}). Put it on a wall.`);
      }
    });
    lidars.forEach((s, i) => {
      if (!pointInside(num(s.x, 0), num(s.y, 0), L, W)) {
        errors.push(`${s.sensor_id || `LiDAR ${i + 1}`} is outside the room (${fmt(num(s.x, 0))}, ${fmt(num(s.y, 0))} m; the room is ${size}).`);
      }
    });
    if (ward.door) {
      const start = num(ward.door.x, 0);
      const end = start + num(ward.door.width, 0.9);
      const wallLen = doorWallLength(ward);
      if (start < -EPS || end > wallLen + EPS) {
        errors.push(`The door does not fit on the ${String(ward.door.wall || 'south').toLowerCase()} wall: it runs from ${fmt(start)} to ${fmt(end)} m, the wall is ${fmt(wallLen)} m long.`);
      }
    }

    const bedCap = maxBeds(ward);
    if (beds.length > bedCap) {
      errors.push(`This room has floor space for ${bedCap} bed${bedCap === 1 ? '' : 's'} (about ${LIMITS.floorPerBedM2} m² of free floor each); it has ${beds.length}. Remove ${beds.length - bedCap}, or make the room larger.`);
    }
    if (obstacles.length > LIMITS.maxObstacles) {
      errors.push(`A ward has at most ${LIMITS.maxObstacles} obstacles; this one has ${obstacles.length}. Join small ones into one, or leave out those that do not block walking.`);
    }
    if (lidars.length > LIMITS.maxLidars) {
      errors.push(`A ward has one LiDAR; this one has ${lidars.length}. Remove ${lidars.length - LIMITS.maxLidars}.`);
    }

    // Beds on top of each other: shown, not refused
    for (let i = 0; i < beds.length; i++) {
      for (let j = i + 1; j < beds.length; j++) {
        const area = overlapArea(bedRect(beds[i]), bedRect(beds[j]));
        if (area > 0.01) warnings.push(`${beds[i].bed_code || `Bed ${i + 1}`} and ${beds[j].bed_code || `Bed ${j + 1}`} overlap.`);
      }
    }
    return { errors, warnings, maxBeds: bedCap };
  }

  const api = { LIMITS, checkWardLayout, maxBeds, freeFloorM2, bedRect, roomSize };
  if (typeof window !== 'undefined') window.ShiroWardRules = api;
  // Node (the server and the unit tests)
  // eslint-disable-next-line no-undef
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
