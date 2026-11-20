// =============================================================================
// SHIRO Edge Server - Following people from turn to turn (Phase 10, step 5b)
// One tracker per LiDAR. Each turn's people (people.js) are matched to the
// people already followed, nearest first, within a gate. Someone counts once
// seen in 3 of the last 5 turns (a single stray group never shows), and is let
// go after 1.5 s without being seen (walked out, lay down, or hidden behind
// someone else). Positions are smoothed a little; at 10 turns a second the
// delay is about a tenth of a second.
// Plain functions: no database, no clock (times are passed in, milliseconds).
// =============================================================================

const DEFAULTS = Object.freeze({
  gateM: 0.6,          // farthest a person moves between two turns that are matched
  window: 5,           // turns looked back on for confirming
  confirmHits: 3,      // ... seen in at least this many of them
  dropAfterMs: 1500,   // not seen for this long: let go
  smoothing: 0.5       // share of the new position taken each turn
});

function createPeopleTracker(options = {}) {
  const o = { ...DEFAULTS, ...options };
  let nextId = 1;
  let tracks = [];   // { id, x, y, seen: [bool], firstAt, lastAt, confirmed, width_m }

  function view(tr) {
    return {
      id: tr.id, x: tr.x, y: tr.y, first_at: tr.firstAt, last_at: tr.lastAt,
      width_m: tr.width_m
    };
  }

  return {
    /**
     * Feeds the people of one turn. Returns the confirmed people afterwards,
     * including those not seen in this turn but within dropAfterMs.
     * @param {Array<{x, y, width_m?}>} people
     * @param {number} t  time of the turn (ms)
     */
    update(people, t) {
      const pairs = [];
      tracks.forEach((tr, a) => {
        people.forEach((p, b) => {
          const d = Math.hypot(p.x - tr.x, p.y - tr.y);
          if (d <= o.gateM) pairs.push({ a, b, d });
        });
      });
      pairs.sort((p, q) => p.d - q.d);
      const usedTracks = new Set();
      const usedPeople = new Set();
      for (const pr of pairs) {
        if (usedTracks.has(pr.a) || usedPeople.has(pr.b)) continue;
        usedTracks.add(pr.a);
        usedPeople.add(pr.b);
        const tr = tracks[pr.a];
        const p = people[pr.b];
        tr.x += o.smoothing * (p.x - tr.x);
        tr.y += o.smoothing * (p.y - tr.y);
        tr.width_m = p.width_m;
        tr.lastAt = t;
      }
      tracks.forEach((tr, a) => {
        tr.seen.push(usedTracks.has(a));
        if (tr.seen.length > o.window) tr.seen.shift();
        if (!tr.confirmed && tr.seen.filter(Boolean).length >= o.confirmHits) tr.confirmed = true;
      });
      people.forEach((p, b) => {
        if (usedPeople.has(b)) return;
        tracks.push({
          id: nextId++, x: p.x, y: p.y, seen: [true], firstAt: t, lastAt: t,
          confirmed: o.confirmHits <= 1, width_m: p.width_m
        });
      });
      tracks = tracks.filter(tr => t - tr.lastAt <= o.dropAfterMs);
      return this.people();
    },

    /** The confirmed people. */
    people() {
      return tracks.filter(tr => tr.confirmed).map(view);
    },

    /** Forgets everyone (the LiDAR was moved, or its empty room learned again). */
    clear() {
      tracks = [];
    }
  };
}

module.exports = { DEFAULTS, createPeopleTracker };
