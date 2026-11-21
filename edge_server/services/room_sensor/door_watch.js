// =============================================================================
// SHIRO Edge Server - A patient standing at the door (Phase 10)
// A patient whom the LiDAR follows (a linked wristband, not a held position)
// and who stays in the door zone (zones.js) for 10 s gives one "at the door"
// event: they may be about to leave the ward. Short steps out of the zone do
// not count: a visit to the door ends after 3 s seen outside it, or when the
// LiDAR loses the patient (then the "left the ward" rule of lidar_linker.js
// applies). At most one event per wristband a minute.
// Plain functions: no database, no clock (times passed in, milliseconds).
// =============================================================================
const { inDoorZone } = require('./lidar_linker');

const DEFAULTS = Object.freeze({
  dwellMs: 10000,    // seen in the door zone this long: at the door
  awayMs: 3000,      // seen outside the door zone this long: the visit is over
  repeatMs: 60000    // at most one event per wristband in this time
});

/**
 * @param {object} [options] overrides of DEFAULTS
 */
function createDoorWatch(options = {}) {
  const o = { ...DEFAULTS, ...options };
  const visits = new Map();      // tagId -> { since, awaySince, raised }
  const lastRaised = new Map();  // tagId -> t of the last event

  return {
    /**
     * One step, after the linker.
     * @param {object} input
     * @param {number} input.t
     * @param {Array<{tagId, x, y, held}>} input.positions  lidar_linker.update positions
     * @param {{x, y, w, l}|null} input.door  the ward's door zone; without it nothing happens
     * @returns {Array<{tagId, x, y, since}>} the patients at the door for 10 s, raised in this step
     */
    update({ t, positions, door }) {
      const events = [];
      const seen = new Set();
      for (const p of positions) {
        if (p.held) continue;
        seen.add(p.tagId);
        let visit = visits.get(p.tagId);
        if (inDoorZone(door, p.x, p.y)) {
          if (!visit) visits.set(p.tagId, (visit = { since: t, awaySince: null, raised: false }));
          visit.awaySince = null;
          const last = lastRaised.get(p.tagId);
          if (!visit.raised && t - visit.since >= o.dwellMs && (last === undefined || t - last >= o.repeatMs)) {
            visit.raised = true;
            lastRaised.set(p.tagId, t);
            events.push({ tagId: p.tagId, x: p.x, y: p.y, since: visit.since });
          }
        } else if (visit) {
          if (visit.awaySince === null) visit.awaySince = t;
          if (t - visit.awaySince >= o.awayMs) visits.delete(p.tagId);
        }
      }
      // Lost or no longer linked: the visit is over
      for (const tagId of [...visits.keys()]) if (!seen.has(tagId)) visits.delete(tagId);
      return events;
    },

    /** Forgets everything (LiDAR moved or relearned). */
    clear() {
      visits.clear();
      lastRaised.clear();
    }
  };
}

module.exports = { DEFAULTS, createDoorWatch };
