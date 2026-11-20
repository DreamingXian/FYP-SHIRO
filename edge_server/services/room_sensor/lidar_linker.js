// =============================================================================
// SHIRO Edge Server - Which person the LiDAR sees wears which wristband
// (Phase 10, step 5b)
//
// The LiDAR knows where people are, to a few centimetres, but not who they are.
// Bluetooth knows whose wristband it is, but only roughly where (about 1 m off
// on average in WARD-005). One linker per ward joins the two, by position only:
// the wristband's motion state is not used (not reliable enough, user decision
// of 21 Nov 2026).
//
//   Link     A wristband whose Bluetooth position (the unsmoothed estimate,
//            averaged over the last 5 s) has one person within 2 m, or one
//            clearly nearer than any other (at most 0.6 of the next distance),
//            for 1 s, is linked to that person. A person carries one wristband.
//   Keep     The link holds while the LiDAR follows the person. It ends when the
//            Bluetooth position stays more than 2.5 m away for 5 s.
//   Hold     When the LiDAR loses the linked person, the last position is kept:
//            - near a bed (0.5 m around it): as long as Bluetooth does not leave
//              (the patient lay down, below the scan slice)
//            - elsewhere: for 10 s (someone in front of them, or they fell)
//            A person who appears (after the patient was last seen) within 0.8 m
//            of a held position is the same person again; someone who was
//            already in the room, such as a nurse at the bedside, is not. A held
//            position ends when the Bluetooth position stays more than 2 m away
//            from it for 5 s.
//   Nothing  Otherwise the wristband keeps its Bluetooth position, and the
//            people the LiDAR sees are shown without a name.
//
// Plain functions: no database, no clock (times passed in, milliseconds).
// =============================================================================
const { bedFootprint } = require('../ips/zones');

const DEFAULTS = Object.freeze({
  bleWindowMs: 5000,       // Bluetooth positions averaged over this time
  bleFreshMs: 3500,        // a wristband not heard for longer takes no part
  minBleSamples: 3,        // fewer positions in the window: too noisy to link
  linkGateM: 2.0,          // a person farther than this from the Bluetooth position is not considered
  ambiguityRatio: 0.6,     // with several people, the nearest must be at most this share of the next distance
  linkSettleMs: 1000,      // the same choice for this long before a link is made
  unlinkM: 2.5,            // Bluetooth this far from the linked person ...
  unlinkMs: 5000,          // ... for this long ends the link
  bedMarginM: 0.5,         // lost this close to a bed: held as lying in bed
  lostHoldMs: 10000,       // lost elsewhere: held this long
  reacquireM: 0.8,         // a person this close to a held position is the same person
  leaveM: 2.0,             // Bluetooth this far from a held position ...
  leaveMs: 5000            // ... for this long ends the hold
});

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function nearBed(beds, x, y, margin) {
  for (const bed of beds) {
    const f = bedFootprint(bed);
    if (x >= f.x - margin && x <= f.x + f.w + margin && y >= f.y - margin && y <= f.y + f.l + margin) return true;
  }
  return false;
}

/**
 * @param {object} [options] overrides of DEFAULTS
 */
function createLidarLinker(options = {}) {
  const o = { ...DEFAULTS, ...options };
  const ble = new Map();      // tagId -> [{ at, x, y }]
  const links = new Map();    // tagId -> { key, x, y, since, farSince }
  const holds = new Map();    // tagId -> { x, y, since, inBed, farSince, key }
  const pending = new Map();  // tagId -> { key, since }

  function bleAverage(tagId) {
    const list = ble.get(tagId);
    if (!list || list.length < o.minBleSamples) return null;
    return {
      x: list.reduce((s, p) => s + p.x, 0) / list.length,
      y: list.reduce((s, p) => s + p.y, 0) / list.length,
      samples: list.length
    };
  }

  function forget(tagId) {
    links.delete(tagId);
    holds.delete(tagId);
    pending.delete(tagId);
    ble.delete(tagId);
  }

  return {
    /**
     * One step, after a LiDAR turn.
     * @param {object} input
     * @param {number} input.t
     * @param {Array<{key: string, x: number, y: number, first_at?: number, last_at?: number}>} input.people
     *        confirmed people of the ward's LiDARs; first_at: first seen, last_at: last seen
     * @param {Array<{tagId: string, x: number, y: number, at: number}>} input.wristbands
     *        each wristband in the ward with its newest unsmoothed Bluetooth position and when it was worked out
     * @param {Array<object>} [input.beds]  the ward's beds (x, y, width, length, rotation_deg)
     * @returns {{positions: Array<{tagId, x, y, key, held, in_bed, reason}>, ended: string[]}}
     *          positions: the wristbands that have a LiDAR position now; ended: those that lost it in this step
     */
    update({ t, people, wristbands, beds = [] }) {
      const ended = [];
      const present = new Set();
      const byKey = new Map(people.map(p => [p.key, p]));

      // Bluetooth positions of the wristbands in the ward
      for (const w of wristbands) {
        if (!Number.isFinite(w.x) || !Number.isFinite(w.y) || t - w.at > o.bleFreshMs) continue;
        present.add(w.tagId);
        let list = ble.get(w.tagId);
        if (!list) ble.set(w.tagId, (list = []));
        if (!list.length || w.at > list[list.length - 1].at) list.push({ at: w.at, x: w.x, y: w.y });
        while (list.length && t - list[0].at > o.bleWindowMs) list.shift();
      }
      // Wristbands no longer in the ward (or not heard): everything about them ends
      for (const tagId of new Set([...links.keys(), ...holds.keys(), ...pending.keys(), ...ble.keys()])) {
        if (present.has(tagId)) continue;
        if (links.has(tagId) || holds.has(tagId)) ended.push(tagId);
        forget(tagId);
      }

      // Links: follow the person, or hold when the LiDAR lost them
      for (const [tagId, link] of [...links]) {
        const avg = bleAverage(tagId);
        const p = byKey.get(link.key);
        if (p) {
          link.x = p.x;
          link.y = p.y;
          link.lastSeenAt = Number.isFinite(p.last_at) ? p.last_at : t;
          if (avg && dist(avg, p) > o.unlinkM) {
            if (link.farSince === null) link.farSince = t;
            if (t - link.farSince >= o.unlinkMs) {
              links.delete(tagId);
              ended.push(tagId);
            }
          } else {
            link.farSince = null;
          }
        } else {
          links.delete(tagId);
          holds.set(tagId, {
            x: link.x, y: link.y, since: t, farSince: null, key: link.key,
            lastSeenAt: link.lastSeenAt,
            inBed: nearBed(beds, link.x, link.y, o.bedMarginM)
          });
        }
      }

      const taken = new Set([...links.values()].map(l => l.key));

      // Held positions: the same person again, Bluetooth left, or time is up
      for (const [tagId, hold] of [...holds]) {
        let again = null;
        for (const p of people) {
          if (taken.has(p.key)) continue;
          // Only someone who appeared after the patient was last seen
          if (Number.isFinite(p.first_at) && p.first_at < hold.lastSeenAt) continue;
          const d = dist(p, hold);
          if (d <= o.reacquireM && (!again || d < again.d)) again = { p, d };
        }
        if (again) {
          holds.delete(tagId);
          links.set(tagId, { key: again.p.key, x: again.p.x, y: again.p.y, since: t, farSince: null, lastSeenAt: t });
          taken.add(again.p.key);
          continue;
        }
        const avg = bleAverage(tagId);
        if (avg && dist(avg, hold) > o.leaveM) {
          if (hold.farSince === null) hold.farSince = t;
        } else {
          hold.farSince = null;
        }
        const left = hold.farSince !== null && t - hold.farSince >= o.leaveMs;
        const expired = !hold.inBed && t - hold.since >= o.lostHoldMs;
        if (left || expired) {
          holds.delete(tagId);
          ended.push(tagId);
        }
      }

      // New links: wristbands with neither link nor hold, nearest choice first
      const choices = [];
      for (const tagId of present) {
        if (links.has(tagId) || holds.has(tagId)) continue;
        const avg = bleAverage(tagId);
        if (!avg) continue;
        const near = people
          .filter(p => !taken.has(p.key))
          .map(p => ({ p, d: dist(p, avg) }))
          .filter(c => c.d <= o.linkGateM)
          .sort((a, b) => a.d - b.d);
        if (!near.length) {
          pending.delete(tagId);
          continue;
        }
        const clear = near.length === 1 || near[0].d <= o.ambiguityRatio * near[1].d;
        choices.push({ tagId, best: clear ? near[0] : null });
      }
      choices.sort((a, b) => (a.best ? a.best.d : Infinity) - (b.best ? b.best.d : Infinity));
      for (const { tagId, best } of choices) {
        if (!best || taken.has(best.p.key)) {
          pending.delete(tagId);
          continue;
        }
        const pend = pending.get(tagId);
        if (!pend || pend.key !== best.p.key) {
          pending.set(tagId, { key: best.p.key, since: t });
          if (o.linkSettleMs > 0) continue;
        } else if (t - pend.since < o.linkSettleMs) {
          continue;
        }
        pending.delete(tagId);
        links.set(tagId, { key: best.p.key, x: best.p.x, y: best.p.y, since: t, farSince: null, lastSeenAt: t });
        taken.add(best.p.key);
      }

      const positions = [];
      for (const [tagId, l] of links) positions.push({ tagId, x: l.x, y: l.y, key: l.key, held: false, in_bed: false, reason: 'seen' });
      for (const [tagId, h] of holds) {
        positions.push({ tagId, x: h.x, y: h.y, key: h.key, held: true, in_bed: h.inBed, reason: h.inBed ? 'in bed' : 'lost' });
      }
      return { positions, ended };
    },

    /** The person a wristband is linked to (key), or null. */
    linkOf(tagId) {
      const l = links.get(tagId);
      return l ? l.key : null;
    },

    /** Forgets everything (LiDAR moved or relearned, ward changed). Returns the wristbands that had a position. */
    clear() {
      const had = [...new Set([...links.keys(), ...holds.keys()])];
      links.clear();
      holds.clear();
      pending.clear();
      ble.clear();
      return had;
    }
  };
}

module.exports = { DEFAULTS, createLidarLinker, nearBed };
