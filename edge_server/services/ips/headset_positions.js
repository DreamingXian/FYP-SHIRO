// =============================================================================
// SHIRO IPS - Positions of patients seen by a headset (8D)
//
// A headset that has linked a wristband to a person its depth sensor sees sends
// that person's position in ward coordinates a few times a second (WebSocket
// command PATIENT_SEEN). While such a position is fresh, it is the patient's
// position on every map and for alerts: the Bluetooth position is often 1-3 m
// off, the depth position is about as good as the headset's room alignment.
// The Bluetooth position is always sent along (ble_x, ble_y): a headset keeps
// its own decisions (bed rule, linking) on Bluetooth. If it got its own depth
// position back as "the wristband's position", the wristband would always seem
// to be right at the linked person, and a wrong link could never be noticed.
//
// Pure in-memory store with no database, network or timer side effects, so it
// can be unit tested on its own. Times are passed in (milliseconds).
// =============================================================================

// A position not renewed for this long is stale: the headset looked away, lost
// the person, lost its connection or stopped linking. The map falls back to
// Bluetooth. The headset sends 5 times a second.
const FRESH_MS = 1500;
// A position this far outside the ward (metres) is not used: the person is in
// the corridor, or the headset's room alignment is wrong.
const OUTSIDE_MARGIN_M = 0.5;

const positions = new Map(); // tagId -> { x, y, wardId, heightM, manual, headsetId, at, lastBroadcast }

/** Stores a headset's position of a tag's patient. Returns true when it is new (not a renewal). */
function set(tagId, { x, y, wardId, heightM = null, manual = false, headsetId }, now) {
  const prev = positions.get(tagId);
  positions.set(tagId, {
    x, y, wardId, heightM, manual, headsetId, at: now,
    lastBroadcast: prev ? prev.lastBroadcast : 0
  });
  return !prev || now - prev.at > FRESH_MS || prev.headsetId !== headsetId;
}

/** The position while fresh, else null. */
function fresh(tagId, now) {
  const p = positions.get(tagId);
  return p && now - p.at <= FRESH_MS ? p : null;
}

/** Ends a tag's headset position, only when it came from this headset. Returns true when it ended. */
function end(tagId, headsetId) {
  const p = positions.get(tagId);
  if (!p || (headsetId && p.headsetId !== headsetId)) return false;
  positions.delete(tagId);
  return true;
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

/** Removes and returns the tags a headset was giving positions for (it disconnected). */
function takeFromHeadset(headsetId) {
  const taken = [];
  for (const [tagId, p] of positions) {
    if (p.headsetId === headsetId) {
      positions.delete(tagId);
      taken.push(tagId);
    }
  }
  return taken;
}

/** At most one broadcast per interval per tag for headset positions. Returns true when one is due now. */
function broadcastDue(tagId, now, minIntervalMs) {
  const p = positions.get(tagId);
  if (!p || now - p.lastBroadcast < minIntervalMs) return false;
  p.lastBroadcast = now;
  return true;
}

/** Inside the ward (length_x by width_y metres from its corner), with a small margin. */
function insideWard(x, y, dim, margin = OUTSIDE_MARGIN_M) {
  if (!dim) return false;
  return x >= -margin && y >= -margin && x <= dim.length_x + margin && y <= dim.width_y + margin;
}

/**
 * The fields of a position message: the headset's position while fresh (source
 * HEADSET), else the LiDAR's while fresh (source LIDAR, lidar_positions.js),
 * else the Bluetooth position (source BLE). The Bluetooth position is always
 * included as ble_x / ble_y when known (has_ble).
 */
function positionFields(ble, headset, lidar = null) {
  const fields = {
    source: headset ? 'HEADSET' : lidar ? 'LIDAR' : 'BLE',
    has_ble: !!ble,
    ble_x: ble ? ble.x : 0,
    ble_y: ble ? ble.y : 0
  };
  if (headset) {
    fields.x = headset.x;
    fields.y = headset.y;
    fields.ward_id = headset.wardId;
    fields.seen_by = headset.headsetId;
    fields.seen_manual = !!headset.manual;
  } else if (lidar) {
    fields.x = Math.round(lidar.x * 100) / 100;
    fields.y = Math.round(lidar.y * 100) / 100;
    fields.ward_id = lidar.wardId;
    fields.lidar_person = lidar.key;
    fields.lidar_held = !!lidar.held;
    fields.lidar_in_bed = !!lidar.inBed;
  } else if (ble) {
    fields.x = ble.x;
    fields.y = ble.y;
  }
  return fields;
}

/** Only for tests: forget everything. */
function clearAll() {
  positions.clear();
}

module.exports = {
  FRESH_MS,
  OUTSIDE_MARGIN_M,
  set,
  fresh,
  end,
  takeStale,
  takeFromHeadset,
  broadcastDue,
  insideWard,
  positionFields,
  clearAll
};
