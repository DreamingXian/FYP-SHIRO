// =============================================================================
// SHIRO Edge Server - People in one LiDAR turn (Phase 10, step 5b)
// A turn of a LiDAR placed in a ward, compared with its empty room, shows the
// people in the room at the height of the scan slice (about 0.95 m: the hips of
// a standing person, the chest of a sitting one; someone lying in bed or on
// the floor is below it):
//   1. the directions with a return clearly closer than the empty room (background.js)
//   2. their returns in ward coordinates, inside the room
//   3. neighbouring returns grouped into pieces (gap of at most 3 directions and 0.2 m)
//   4. pieces close to each other joined: one body often shows as torso and arm
//   5. a group counts as a person when it is wide enough and has enough returns;
//      smaller things (a chair back, a bag, a pole) are left out
//   6. its centre: the LiDAR sees the near side of the body, so the middle of
//      the returns is moved a little farther away from the LiDAR
// The limits were checked on the 31 recorded runs of 21 Nov 2026
// (tools/replay_lidar_runs.js, docs/test_records/ips-accuracy-10.md).
// Plain functions: no database, no clock.
// =============================================================================
const { foregroundBins } = require('./background');
const { returnToWard } = require('./scan_geometry');

const DEFAULTS = Object.freeze({
  inRoomMarginM: 0.05,     // returns closer than this to a wall are the wall, not a person
  pieceMaxGapBins: 3,      // directions without a return allowed inside one piece
  pieceMaxJumpM: 0.20,     // larger jump between neighbouring returns: another piece
  joinGapM: 0.35,          // pieces whose nearest returns are this close are one body
  maxPersonExtentM: 0.90,  // ... unless the joined group would be wider than a person
  minWidthM: 0.12,         // narrower groups are things, not people
  minPoints: 9,            // returns a person needs, up to fullPointsRangeM from the LiDAR
  fullPointsRangeM: 3.0,   // farther away a body covers fewer directions: minPoints x 3 m / range
  leastPoints: 4,          // ... but never fewer than this
  centreDepthM: 0.10       // from the seen surface to the middle of the body
});

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Largest distance between two returns of a group (its width as seen). */
function extentOf(points) {
  let best = 0;
  for (let a = 0; a < points.length; a++) {
    for (let b = a + 1; b < points.length; b++) {
      const d = dist(points[a], points[b]);
      if (d > best) best = d;
    }
  }
  return best;
}

/** Smallest distance between a return of one group and a return of the other. */
function gapBetween(pa, pb) {
  let best = Infinity;
  for (const a of pa) for (const b of pb) best = Math.min(best, dist(a, b));
  return best;
}

/**
 * The people a turn shows.
 * @param {ArrayLike<number>} distancesMm  720 distances of the turn (0 = no return)
 * @param {object} model   the empty room (background.js)
 * @param {{x, y, heading_deg}} pose  where the LiDAR stands in the ward
 * @param {{length_x, width_y}} room  the ward's floor
 * @param {object} [options]  overrides of DEFAULTS
 * @returns {{people: Array<{x, y, width_m, points, range_m}>, others: Array<{x, y, width_m, points}>}}
 *          others: the groups too small to be a person (for the live scan and for tests)
 */
function findPeople(distancesMm, model, pose, room, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const L = Number(room.length_x);
  const W = Number(room.width_y);

  // 1-2. New returns inside the room, in the order of their directions
  const points = [];
  for (const i of foregroundBins(distancesMm, model)) {
    const p = returnToWard(pose, i, distancesMm[i] / 1000);
    if (p.x < o.inRoomMarginM || p.y < o.inRoomMarginM || p.x > L - o.inRoomMarginM || p.y > W - o.inRoomMarginM) continue;
    points.push({ i, x: p.x, y: p.y });
  }

  // 3. Pieces of neighbouring returns
  let groups = [];
  let current = [];
  for (const p of points) {
    const last = current[current.length - 1];
    if (last && (p.i - last.i > o.pieceMaxGapBins + 1 || dist(p, last) > o.pieceMaxJumpM)) {
      groups.push(current);
      current = [];
    }
    current.push(p);
  }
  if (current.length) groups.push(current);

  // 4. Join the closest pieces while they are close and the result is no wider than a person.
  //    Also joins the pieces on both sides of direction 0 (the list wraps around there).
  for (;;) {
    let best = null;
    for (let a = 0; a < groups.length; a++) {
      for (let b = a + 1; b < groups.length; b++) {
        const gap = gapBetween(groups[a], groups[b]);
        if (gap > o.joinGapM || (best && gap >= best.gap)) continue;
        if (extentOf(groups[a].concat(groups[b])) > o.maxPersonExtentM) continue;
        best = { a, b, gap };
      }
    }
    if (!best) break;
    groups[best.a] = groups[best.a].concat(groups[best.b]);
    groups.splice(best.b, 1);
  }

  // 5-6. People and the rest
  const people = [];
  const others = [];
  for (const g of groups) {
    const width = extentOf(g);
    const mx = g.reduce((s, p) => s + p.x, 0) / g.length;
    const my = g.reduce((s, p) => s + p.y, 0) / g.length;
    const range = Math.hypot(mx - pose.x, my - pose.y);
    const neededPoints = range <= o.fullPointsRangeM
      ? o.minPoints
      : Math.max(o.leastPoints, Math.ceil(o.minPoints * o.fullPointsRangeM / range));
    if (g.length >= neededPoints && width >= o.minWidthM) {
      const k = range > 1e-6 ? (range + o.centreDepthM) / range : 1;
      people.push({
        x: pose.x + (mx - pose.x) * k,
        y: pose.y + (my - pose.y) * k,
        width_m: width,
        points: g.length,
        range_m: range
      });
    } else {
      others.push({ x: mx, y: my, width_m: width, points: g.length });
    }
  }
  return { people, others };
}

module.exports = { DEFAULTS, findPeople, extentOf };
