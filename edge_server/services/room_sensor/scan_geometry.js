// =============================================================================
// SHIRO Edge Server - LiDAR scan geometry (Phase 10)
// Turns a LiDAR's directions and distances into ward coordinates, and builds
// the surfaces its scan slice can hit from the ward layout.
//
// A turn holds 720 directions (scan_frame.js): direction i covers
// [i * 0.5, i * 0.5 + 0.5) degrees clockwise seen from above, 0 at the ▲ on
// top of the LiDAR. The LiDAR stands at (x, y) with its ▲ pointing heading_deg
// (compass: 0 = north = +y, 90 = east = +x). A return at distance d in
// direction i is at compass bearing heading + angle:
//   x + d * sin(bearing),  y + d * cos(bearing)
//
// Plain functions: no database, no clock. Metres from the ward's south-west
// corner, x towards east, y towards north.
// =============================================================================
const { BINS, DEG_PER_BIN } = require('./scan_frame');

const SLICE_ABOVE_BASE_M = 0.03;   // Slamtec: the laser is 29.8 mm above the C1's base
const DEFAULT_BASE_HEIGHT_M = 0.92;
const DEG = Math.PI / 180;

const finite = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/** The middle of direction i, degrees clockwise from the ▲. */
function binAngleDeg(i) {
  return (i + 0.5) * DEG_PER_BIN;
}

/** The compass bearing (degrees, 0..360) of direction i for a LiDAR whose ▲ points headingDeg. */
function bearingDeg(i, headingDeg, mirrored = false) {
  const b = finite(headingDeg) + (mirrored ? -binAngleDeg(i) : binAngleDeg(i));
  return ((b % 360) + 360) % 360;
}

/** Where a return lands in the ward. pose: { x, y, heading_deg }; distance in metres. */
function returnToWard(pose, i, distanceM, mirrored = false) {
  const b = bearingDeg(i, pose.heading_deg, mirrored) * DEG;
  return { x: finite(pose.x) + distanceM * Math.sin(b), y: finite(pose.y) + distanceM * Math.cos(b) };
}

/**
 * Every return of a turn in ward coordinates.
 * @param {ArrayLike<number>} distancesMm  720 distances, 0 = no return
 * @returns {Array<{i: number, x: number, y: number, d: number}>}
 */
function scanToWard(pose, distancesMm, mirrored = false) {
  const points = [];
  for (let i = 0; i < BINS; i++) {
    const mm = distancesMm[i];
    if (!mm) continue;
    const p = returnToWard(pose, i, mm / 1000, mirrored);
    points.push({ i, x: p.x, y: p.y, d: mm / 1000 });
  }
  return points;
}

/** The height of the scan slice for a LiDAR whose base is baseHeight above the floor. */
function sliceHeight(baseHeight) {
  return finite(baseHeight, DEFAULT_BASE_HEIGHT_M) + SLICE_ABOVE_BASE_M;
}

/**
 * The surfaces a scan slice at sliceH can hit: the four walls and the sides of
 * every obstacle at least that tall. All are axis-aligned segments
 * { x0, y0, x1, y1, axis: 'x' (runs along x) | 'y', source }.
 * Obstacles: { x, y, width (along x), length (along y), height } (ward layout).
 */
function wardSurfaces(layout, sliceH) {
  const L = finite(layout && layout.length_x);
  const W = finite(layout && layout.width_y);
  const segments = [
    { x0: 0, y0: 0, x1: L, y1: 0, axis: 'x', source: 'south wall' },
    { x0: 0, y0: W, x1: L, y1: W, axis: 'x', source: 'north wall' },
    { x0: 0, y0: 0, x1: 0, y1: W, axis: 'y', source: 'west wall' },
    { x0: L, y0: 0, x1: L, y1: W, axis: 'y', source: 'east wall' }
  ];
  const roomH = finite(layout && layout.height_z, 2.6);
  for (const o of (layout && layout.obstacles) || []) {
    const h = o.height === undefined || o.height === null ? (String(o.type || '').toUpperCase() === 'TABLE' ? 0.75 : roomH) : finite(o.height);
    // A little below the slice still counts: heights are measured by hand
    if (h < sliceH - 0.02) continue;
    const x0 = finite(o.x);
    const y0 = finite(o.y);
    const x1 = x0 + finite(o.width, 1);
    const y1 = y0 + finite(o.length, 1);
    const label = String(o.label || o.type || 'obstacle');
    segments.push(
      { x0, y0, x1, y1: y0, axis: 'x', source: label },
      { x0, y0: y1, x1, y1, axis: 'x', source: label },
      { x0, y0, x1: x0, y1, axis: 'y', source: label },
      { x0: x1, y0, x1, y1, axis: 'y', source: label }
    );
  }
  return segments;
}

/** Distance from (x, y) to an axis-aligned segment. */
function distanceToSegment(x, y, s) {
  if (s.axis === 'x') {
    const lo = Math.min(s.x0, s.x1);
    const hi = Math.max(s.x0, s.x1);
    const dx = x < lo ? lo - x : x > hi ? x - hi : 0;
    return Math.hypot(dx, y - s.y0);
  }
  const lo = Math.min(s.y0, s.y1);
  const hi = Math.max(s.y0, s.y1);
  const dy = y < lo ? lo - y : y > hi ? y - hi : 0;
  return Math.hypot(x - s.x0, dy);
}

/** The nearest surface to (x, y): { distance, segment }. */
function nearestSurface(x, y, segments) {
  let best = Infinity;
  let bestSegment = null;
  for (const s of segments) {
    const d = distanceToSegment(x, y, s);
    if (d < best) {
      best = d;
      bestSegment = s;
    }
  }
  return { distance: best, segment: bestSegment };
}

/** Inside the ward's floor rectangle, at least margin metres from its walls. */
function insideWard(layout, x, y, margin = 0) {
  return x >= margin && y >= margin && x <= finite(layout.length_x) - margin && y <= finite(layout.width_y) - margin;
}

module.exports = {
  BINS,
  DEG_PER_BIN,
  SLICE_ABOVE_BASE_M,
  DEFAULT_BASE_HEIGHT_M,
  binAngleDeg,
  bearingDeg,
  returnToWard,
  scanToWard,
  sliceHeight,
  wardSurfaces,
  distanceToSegment,
  nearestSurface,
  insideWard
};
