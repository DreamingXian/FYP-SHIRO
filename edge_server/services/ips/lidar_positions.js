// =============================================================================
// SHIRO IPS - Positions of patients seen by a LiDAR (Phase 10, step 5b)
//
// When the LiDAR linker (room_sensor/lidar_linker.js) has linked a wristband to
// a person the LiDAR follows, that person's position is the patient's position
// on the maps and for alerts, unless a headset sees the patient (the headset
// comes first). It is renewed with every turn (10 a second); one not renewed
// for a second is stale and the map falls back to Bluetooth. A held position
// (patient lying in bed, below the scan slice) is renewed the same way while
// the linker holds it.
//
// Pure in-memory store with no database, network or timer side effects.
// Times are passed in (milliseconds).
// =============================================================================

const FRESH_MS = 1000;

const positions = new Map(); // tagId -> { x, y, wardId, key, held, inBed, at, lastBroadcast }

/** Stores a LiDAR position of a tag's patient. Returns true when it is new or its kind changed (seen / held). */
function set(tagId, { x, y, wardId, key = null, held = false, inBed = false }, now) {
  const prev = positions.get(tagId);
  positions.set(tagId, {
    x, y, wardId, key, held: !!held, inBed: !!inBed, at: now,
    lastBroadcast: prev ? prev.lastBroadcast : 0
  });
  return !prev || now - prev.at > FRESH_MS || prev.held !== !!held || prev.key !== key;
}

/** The position while fresh, else null. */
function fresh(tagId, now) {
  const p = positions.get(tagId);
  return p && now - p.at <= FRESH_MS ? p : null;
}

/** Ends a tag's LiDAR position. Returns true when there was one. */
function end(tagId) {
  return positions.delete(tagId);
}

/** Removes and returns the tags whose position is no longer fresh. */
function takeStale(now) {
  const stale = [];
  for (const [tagId, p] of positions) {
    if (now - p.at > FRESH_MS) {
      positions.delete(tagId);
      stale.push(tagId);
    }
  }
  return stale;
}

/** At most one broadcast per interval per tag. Returns true when one is due now. */
function broadcastDue(tagId, now, minIntervalMs) {
  const p = positions.get(tagId);
  if (!p || now - p.lastBroadcast < minIntervalMs) return false;
  p.lastBroadcast = now;
  return true;
}

/** Only for tests: forget everything. */
function clearAll() {
  positions.clear();
}

module.exports = { FRESH_MS, set, fresh, end, takeStale, broadcastDue, clearAll };
