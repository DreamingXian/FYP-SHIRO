// =============================================================================
// SHIRO Edge Server - Stored LiDAR placements and empty rooms (Phase 10)
// Reads where each enrolled LiDAR node stands (ward_room_sensors, saved with
// the ward) and the empty room learned for it (room_sensor_backgrounds).
// =============================================================================
const { getPool } = require('../../database/db');
const { checkModel } = require('./background');

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/** Every LiDAR placed in a ward with a node assigned. */
async function loadPlacements() {
  const [rows] = await getPool().query(
    'SELECT ward_id, sensor_id, device_id, x, y, base_height, heading_deg FROM ward_room_sensors WHERE device_id IS NOT NULL'
  );
  return rows.map(r => ({
    ward_id: r.ward_id, sensor_id: r.sensor_id, device_id: r.device_id,
    x: num(r.x), y: num(r.y), base_height: num(r.base_height, 0.92), heading_deg: num(r.heading_deg)
  }));
}

/** Every stored empty room that this server can read. */
async function loadBackgrounds() {
  const [rows] = await getPool().query(
    'SELECT ward_id, device_id, learned_at, learned_by, model FROM room_sensor_backgrounds'
  );
  const list = [];
  for (const r of rows) {
    let model = null;
    try {
      model = checkModel(JSON.parse(r.model));
    } catch {
      model = null;
    }
    if (model) {
      list.push({ ward_id: r.ward_id, device_id: r.device_id, learned_at: new Date(r.learned_at).getTime(), learned_by: r.learned_by, model });
    }
  }
  return list;
}

/** Stores (or replaces) the empty room of a node in a ward. */
async function saveBackground({ ward_id, device_id, learned_by, model }) {
  await getPool().query(
    `INSERT INTO room_sensor_backgrounds (ward_id, device_id, learned_at, learned_by, turns, coverage_pct, unsteady_pct, model)
     VALUES (?, ?, NOW(), ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE learned_at = NOW(), learned_by = VALUES(learned_by), turns = VALUES(turns),
       coverage_pct = VALUES(coverage_pct), unsteady_pct = VALUES(unsteady_pct), model = VALUES(model)`,
    [ward_id, device_id, learned_by || null, model.turns, model.coverage_pct, model.unsteady_pct, JSON.stringify(model)]
  );
}

module.exports = { loadPlacements, loadBackgrounds, saveBackground };
