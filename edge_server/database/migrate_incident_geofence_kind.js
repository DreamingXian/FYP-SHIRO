// =============================================================================
// Migration: add geofence_kind to emergency_incident_logs (Phase 10)
// A geofence alert is one of two kinds: LEFT_WARD (the patient left through
// the door) or AT_DOOR (the patient has stood at the door for 10 s). Other
// incidents, and geofence alerts stored before this column, keep NULL.
// =============================================================================
const logger = require('../utils/logger');
const { getPool } = require('./db');

async function migrate() {
  const pool = getPool();
  const [rows] = await pool.query("SHOW COLUMNS FROM emergency_incident_logs LIKE 'geofence_kind'");
  if (rows.length > 0) return false;

  await pool.query(`
    ALTER TABLE emergency_incident_logs
    ADD COLUMN geofence_kind ENUM('LEFT_WARD', 'AT_DOOR') NULL AFTER incident_category
  `);
  logger.info('[DB MIGRATION] Added geofence_kind to emergency_incident_logs.');
  return true;
}

module.exports = { migrate };

if (require.main === module) {
  migrate().then(() => process.exit(0)).catch(e => { logger.error(e); process.exit(1); });
}
