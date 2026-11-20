// =============================================================================
// SHIRO Edge Server - The people of one ward from its LiDARs (Phase 10, step 5b)
// Runs the three steps for every turn of a LiDAR in the ward:
//   people.js          the people in the turn
//   people_tracker.js  followed from turn to turn (one tracker per LiDAR)
//   lidar_linker.js    which of them wears which wristband
// The live server (people_service.js) and the replay of recorded runs
// (tools/replay_lidar_runs.js) both use this, so a replay shows what the
// server would have done.
// Plain functions: no database, no clock (times passed in, milliseconds).
// =============================================================================
const { findPeople } = require('./people');
const { createPeopleTracker } = require('./people_tracker');
const { createLidarLinker } = require('./lidar_linker');

// Two LiDARs that see the same person: one entry within this distance
const SAME_PERSON_M = 0.4;

/** One entry per person when several LiDARs see the same one: the most recently seen. */
function mergeAcrossLidars(people) {
  const sorted = [...people].sort((a, b) => b.last_at - a.last_at);
  const kept = [];
  for (const p of sorted) {
    if (kept.some(k => k.device_id !== p.device_id && Math.hypot(k.x - p.x, k.y - p.y) <= SAME_PERSON_M)) continue;
    kept.push(p);
  }
  return kept;
}

/**
 * @param {object} [options]  { finder, tracker, linker }: overrides of each step's DEFAULTS
 */
function createWardPeople(options = {}) {
  const trackers = new Map();   // device_id -> tracker
  const seen = new Map();       // device_id -> confirmed people of its last turn (with key)
  const linker = createLidarLinker(options.linker);

  return {
    /**
     * One turn of one LiDAR of the ward.
     * @param {object} input
     * @param {string} input.deviceId
     * @param {ArrayLike<number>} input.distancesMm
     * @param {object} input.model       the LiDAR's empty room
     * @param {{x, y, heading_deg}} input.pose
     * @param {{length_x, width_y}} input.room
     * @param {Array<object>} [input.beds]
     * @param {number} input.t
     * @param {Array<{tagId, x, y, at}>} input.wristbands  unsmoothed Bluetooth positions of the wristbands in the ward
     * @returns {{people: Array, positions: Array, ended: string[], others: Array}}
     *   people: everyone the ward's LiDARs follow now, with tag_id when linked;
     *   positions / ended: as lidar_linker.update; others: groups too small to be a person
     */
    turn({ deviceId, distancesMm, model, pose, room, beds = [], t, wristbands }) {
      const { people: found, others } = findPeople(distancesMm, model, pose, room, options.finder);
      let tracker = trackers.get(deviceId);
      if (!tracker) trackers.set(deviceId, (tracker = createPeopleTracker(options.tracker)));
      seen.set(deviceId, tracker.update(found, t).map(p => ({ ...p, key: `${deviceId}#${p.id}`, device_id: deviceId })));
      const people = mergeAcrossLidars([...seen.values()].flat());
      const { positions, ended } = linker.update({ t, people, wristbands, beds });
      const linkedTo = new Map(positions.filter(p => !p.held).map(p => [p.key, p.tagId]));
      return {
        people: people.map(p => ({ ...p, tag_id: linkedTo.get(p.key) || null })),
        positions,
        ended,
        others
      };
    },

    /** A LiDAR left the ward, was moved or relearned: forget whom it was following. */
    dropLidar(deviceId) {
      trackers.delete(deviceId);
      seen.delete(deviceId);
    },

    /** Forgets everything. Returns the wristbands that had a LiDAR position. */
    clear() {
      trackers.clear();
      seen.clear();
      return linker.clear();
    }
  };
}

module.exports = { createWardPeople, mergeAcrossLidars, SAME_PERSON_M };
