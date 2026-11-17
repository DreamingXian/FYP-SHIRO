// =============================================================================
// SHIRO Edge Server - Spatial anchors per headset and ward
// A headset can only load the spatial anchors it saved itself, so the anchor
// reference is kept per headset: each headset gets back its own anchor for a
// ward, and two headsets never overwrite each other's.
// =============================================================================
const { getPool } = require('../database/db');
const { HttpError } = require('../utils/http');

/** Stores (or, with an empty reference, removes) a headset's anchor for a ward. */
async function saveAnchor(deviceId, wardId, anchorUuid) {
  const pool = getPool();
  const [ward] = await pool.query('SELECT 1 FROM ward_rooms WHERE ward_id = ? LIMIT 1', [wardId]);
  if (ward.length === 0) throw new HttpError(404, 'Ward not found');

  if (!anchorUuid) {
    await pool.query('DELETE FROM headset_ward_anchors WHERE device_id = ? AND ward_id = ?', [deviceId, wardId]);
    return;
  }
  await pool.query(
    `INSERT INTO headset_ward_anchors (device_id, ward_id, anchor_uuid, saved_at) VALUES (?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE anchor_uuid = VALUES(anchor_uuid), saved_at = NOW()`,
    [deviceId, wardId, anchorUuid]
  );
}

/** Map ward_id -> anchor reference of one headset. */
async function anchorsOf(deviceId) {
  const [rows] = await getPool().query('SELECT ward_id, anchor_uuid FROM headset_ward_anchors WHERE device_id = ?', [deviceId]);
  return new Map(rows.map(r => [r.ward_id, r.anchor_uuid]));
}

/**
 * The ward data as a headset must see it: spatial_anchor_uuid is that
 * headset's own anchor for the ward ('' when it has none), never another
 * headset's. Staff get the ward data unchanged.
 */
async function forViewer(actor, wards) {
  if (!actor || actor.type !== 'HEADSET') return wards;
  const own = await anchorsOf(actor.id);
  const adjust = w => (w ? { ...w, spatial_anchor_uuid: own.get(w.ward_id) || '' } : w);
  return Array.isArray(wards) ? wards.map(adjust) : adjust(wards);
}

module.exports = { saveAnchor, anchorsOf, forViewer };
