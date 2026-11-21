// Test helper (not a test): simulated LiDAR turns of a ward, as the RPLIDAR C1
// would send them. Rays from the LiDAR hit the walls, the tall obstacles and
// round "people"; each direction gets one sample at a random angle inside it,
// with distance noise, and some directions get no sample at all (the C1 takes
// about 500 samples for 720 directions). Seeded, so every run is the same.
const { BINS, DEG_PER_BIN } = require('../../services/room_sensor/scan_frame');
const { wardSurfaces, sliceHeight } = require('../../services/room_sensor/scan_geometry');

// WARD-005 as drawn on 21 Nov 2026
const WARD_005 = Object.freeze({
  ward_id: 'WARD-005', length_x: 2.29, width_y: 3.39, height_z: 2.45,
  door: { wall: 'EAST', x: 2.57, y: 0, width: 0.79 },
  obstacles: [
    { id: 'OBS-1', type: 'STORAGE', label: 'air conditional', x: 0, y: 0.47, width: 0.21, length: 0.78, height: 2.45 },
    { id: 'OBS-2', type: 'TABLE', label: 'table', x: 0, y: 2.68, width: 1.52, length: 0.71, height: 0.8 },
    { id: 'OBS-3', type: 'STORAGE', label: 'Partition Wall 3', x: 0, y: 0.66, width: 0.6, length: 0.54, height: 1.15 },
    { id: 'OBS-4', type: 'STORAGE', label: 'Partition Wall 4', x: 0, y: 0, width: 0.5, length: 0.45, height: 1.3 }
  ],
  beds: [{ bed_id: 'BED-005-01', bed_code: 'Bed 1', x: 1.19, y: 0, width: 1.1, length: 2, rotation_deg: 180 }],
  anchors: [],
  room_sensors: [{ sensor_id: 'LiDAR 1', device_id: 'lidar-001', x: 2.11, y: 2.08, base_height: 0.92, heading_deg: 270 }]
});

function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Distance along a ray (unit dx, dy from x0, y0) to an axis-aligned segment, or Infinity. */
function hitSegment(x0, y0, dx, dy, s) {
  if (s.axis === 'x') {
    if (Math.abs(dy) < 1e-12) return Infinity;
    const t = (s.y0 - y0) / dy;
    const x = x0 + t * dx;
    return t > 1e-6 && x >= Math.min(s.x0, s.x1) - 1e-9 && x <= Math.max(s.x0, s.x1) + 1e-9 ? t : Infinity;
  }
  if (Math.abs(dx) < 1e-12) return Infinity;
  const t = (s.x0 - x0) / dx;
  const y = y0 + t * dy;
  return t > 1e-6 && y >= Math.min(s.y0, s.y1) - 1e-9 && y <= Math.max(s.y0, s.y1) + 1e-9 ? t : Infinity;
}

/** Distance along a ray to a circle (a person's body at the slice), or Infinity. */
function hitCircle(x0, y0, dx, dy, c) {
  const fx = x0 - c.x;
  const fy = y0 - c.y;
  const b = fx * dx + fy * dy;
  const disc = b * b - (fx * fx + fy * fy - c.r * c.r);
  if (disc < 0) return Infinity;
  const t = -b - Math.sqrt(disc);
  return t > 1e-6 ? t : Infinity;
}

/**
 * One simulated turn: 720 distances in mm.
 * @param {object} layout  the ward
 * @param {{x, y, heading_deg, base_height?}} pose  where the LiDAR really is
 * @param {object} [o]  people: [{x, y, r}], noiseMm, hitRate (share of directions with a sample), random, mirrored
 */
function simulateTurn(layout, pose, o = {}) {
  const random = o.random || rng(7);
  const noiseMm = o.noiseMm ?? 10;
  const hitRate = o.hitRate ?? 0.7;
  const segments = o.segments || wardSurfaces(layout, sliceHeight(pose.base_height));
  const people = o.people || [];
  const out = new Array(BINS).fill(0);
  for (let i = 0; i < BINS; i++) {
    if (random() > hitRate) continue;
    const a = (i + random()) * DEG_PER_BIN;
    const bearing = (pose.heading_deg + (o.mirrored ? -a : a)) * Math.PI / 180;
    const dx = Math.sin(bearing);
    const dy = Math.cos(bearing);
    let t = Infinity;
    for (const s of segments) t = Math.min(t, hitSegment(pose.x, pose.y, dx, dy, s));
    for (const p of people) t = Math.min(t, hitCircle(pose.x, pose.y, dx, dy, p));
    if (!Number.isFinite(t) || t > 12) continue;
    // Uniform noise of +/- noiseMm (the C1 is about +/- 30 mm at worst)
    out[i] = Math.max(1, Math.round(t * 1000 + (random() * 2 - 1) * noiseMm));
  }
  return out;
}

/** n turns of the same scene, each with its own random samples. */
function simulateTurns(layout, pose, n, o = {}) {
  const random = o.random || rng(o.seed || 11);
  const segments = wardSurfaces(layout, sliceHeight(pose.base_height));
  return Array.from({ length: n }, () => simulateTurn(layout, pose, { ...o, random, segments }));
}

module.exports = { WARD_005, rng, simulateTurn, simulateTurns };
