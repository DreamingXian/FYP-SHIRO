// =============================================================================
// Migration: LiDAR room sensors can be enrolled (Phase 10)
// Adds ROOM_SENSOR to devices.device_type in databases created before.
// Existing devices are not changed.
// =============================================================================
const logger = require('../utils/logger');
const { getPool } = require('./db');

async function migrate() {
  const pool = getPool();
  const [rows] = await pool.query("SHOW COLUMNS FROM devices LIKE 'device_type'");
  if (rows.length === 0 || String(rows[0].Type).includes("'ROOM_SENSOR'")) return false;

  await pool.query(`ALTER TABLE devices
    MODIFY COLUMN device_type ENUM('WRISTBAND', 'ANCHOR', 'HEADSET', 'ROOM_SENSOR') NOT NULL`);
  logger.info('[DB MIGRATION] devices can now hold LiDAR room sensors (device type ROOM_SENSOR).');
  return true;
}

module.exports = { migrate };

if (require.main === module) {
  migrate().then(() => process.exit(0)).catch(e => { logger.error(e); process.exit(1); });
}
