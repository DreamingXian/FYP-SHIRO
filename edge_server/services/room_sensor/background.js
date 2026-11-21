// =============================================================================
// SHIRO Edge Server - The empty room as a LiDAR sees it (Phase 10)
// "Learn empty room" records about 20 s of turns while nobody is in the room.
// For each of the 720 directions it keeps:
//   median_mm  the usual distance to the wall or furniture
//   near_mm    the 10th percentile: the nearest it came, less the noise
//   hit_pct    in how many turns this direction had a return at all
// A return clearly closer than the empty room in its direction (and its two
// neighbours, as the C1's sample angles move a little from turn to turn) is
// something new in the room: a person, or a chair moved since. A return clearly
// farther than the empty room is something people cannot cause: when many
// directions are farther, the LiDAR itself has been moved or turned.
//
// Plain functions: no database, no clock.
// =============================================================================
const { BINS } = require('./scan_frame');

const MODEL_VERSION = 1;
const MIN_HIT_PCT = 30;            // fewer returns than this: no empty-room surface in this direction
const FOREGROUND_MARGIN_MM = 100;  // closer than the empty room by more than this: something new
const FARTHER_MARGIN_MM = 150;     // farther than the empty room by more than this (or twice its spread)
const MOVED_MIN_HIT_PCT = 60;      // only steady directions take part in the moved check
const UNSTEADY_SPREAD_MM = 250;    // median minus near larger than this: the direction changed while learning
const MIN_COVERAGE_PCT = 50;
const MAX_UNSTEADY_PCT = 5;

function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo));
}

/**
 * The empty-room model from a set of turns.
 * @param {Array<ArrayLike<number>>} turns  each 720 distances in mm (0 = no return)
 * @param {{minTurns?: number}} [options]
 * @returns {{ok: true, model: object, warnings: string[]} | {ok: false, reason: string}}
 */
function learnBackground(turns, { minTurns = 20 } = {}) {
  const n = turns.length;
  if (n < minTurns) return { ok: false, reason: `only ${n} turns arrived; at least ${minTurns} are needed` };
  const median = new Array(BINS).fill(0);
  const near = new Array(BINS).fill(0);
  const hit = new Array(BINS).fill(0);
  const values = [];
  let covered = 0;
  let unsteady = 0;
  for (let i = 0; i < BINS; i++) {
    values.length = 0;
    for (const t of turns) {
      const d = t[i];
      if (d > 0) values.push(d);
    }
    hit[i] = Math.round((100 * values.length) / n);
    if (values.length === 0) continue;
    values.sort((a, b) => a - b);
    median[i] = quantile(values, 0.5);
    near[i] = quantile(values, 0.1);
    if (hit[i] >= MIN_HIT_PCT) {
      covered++;
      if (median[i] - near[i] > UNSTEADY_SPREAD_MM) unsteady++;
    }
  }
  const coveragePct = Math.round((1000 * covered) / BINS) / 10;
  const unsteadyPct = covered ? Math.round((1000 * unsteady) / covered) / 10 : 0;
  const warnings = [];
  if (coveragePct < MIN_COVERAGE_PCT) {
    warnings.push(`The LiDAR saw a surface in only ${coveragePct}% of directions. Is something covering its window?`);
  }
  if (unsteadyPct > MAX_UNSTEADY_PCT) {
    warnings.push(`${unsteadyPct}% of directions changed while learning: was someone in the room or the door moving? If so, learn again.`);
  }
  return {
    ok: true,
    model: {
      version: MODEL_VERSION, bins: BINS, turns: n,
      coverage_pct: coveragePct, unsteady_pct: unsteadyPct,
      median_mm: median, near_mm: near, hit_pct: hit
    },
    warnings
  };
}

/** A stored model, checked; null when it is not one this server can use. */
function checkModel(model) {
  if (!model || typeof model !== 'object' || model.version !== MODEL_VERSION || model.bins !== BINS) return null;
  for (const key of ['median_mm', 'near_mm', 'hit_pct']) {
    const list = model[key];
    if (!Array.isArray(list) || list.length !== BINS || !list.every(v => Number.isFinite(v) && v >= 0 && v <= 65535)) return null;
  }
  return model;
}

/**
 * Nearest distance (mm) at which a return in direction i is still "the empty
 * room": the nearest empty-room surface of i and its neighbours, less the
 * margin. null when none of the three had a surface (nothing to compare with).
 */
function emptyRoomLimit(model, i) {
  let limit = Infinity;
  for (let k = i - 1; k <= i + 1; k++) {
    const j = (k + BINS) % BINS;
    if (model.hit_pct[j] >= MIN_HIT_PCT && model.near_mm[j] > 0) limit = Math.min(limit, model.near_mm[j]);
  }
  return limit === Infinity ? null : limit - FOREGROUND_MARGIN_MM;
}

/**
 * The directions of a turn whose return is new in the room: closer than the
 * empty room, or where the empty room had no surface.
 */
function foregroundBins(distancesMm, model) {
  const found = [];
  for (let i = 0; i < BINS; i++) {
    const d = distancesMm[i];
    if (!d) continue;
    const limit = emptyRoomLimit(model, i);
    if (limit === null || d < limit) found.push(i);
  }
  return found;
}

/**
 * How a turn compares with the empty room in its steady directions: how many
 * returns are clearly closer (people, things put down) and clearly farther
 * (only a moved LiDAR or removed furniture does that).
 */
function compareWithBackground(distancesMm, model) {
  let comparable = 0;
  let farther = 0;
  let closer = 0;
  for (let i = 0; i < BINS; i++) {
    const d = distancesMm[i];
    if (!d || model.hit_pct[i] < MOVED_MIN_HIT_PCT || !model.median_mm[i]) continue;
    comparable++;
    let farthest = model.median_mm[i];
    for (const j of [(i + BINS - 1) % BINS, (i + 1) % BINS]) {
      if (model.hit_pct[j] >= MIN_HIT_PCT) farthest = Math.max(farthest, model.median_mm[j]);
    }
    const spread = model.median_mm[i] - model.near_mm[i];
    if (d > farthest + Math.max(FARTHER_MARGIN_MM, 2 * spread)) farther++;
    else if (d < model.near_mm[i] - FOREGROUND_MARGIN_MM) closer++;
  }
  const pct = (k) => (comparable ? Math.round((1000 * k) / comparable) / 10 : 0);
  return { comparable, farther, closer, farther_pct: pct(farther), closer_pct: pct(closer) };
}

module.exports = {
  MODEL_VERSION,
  MIN_HIT_PCT,
  FOREGROUND_MARGIN_MM,
  learnBackground,
  checkModel,
  emptyRoomLimit,
  foregroundBins,
  compareWithBackground
};
