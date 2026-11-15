// =============================================================================
// Migration: add freefall_min_g to emergency_incident_logs
// Stores the lowest acceleration the wristband measured during the free-fall
// phase of a fall, next to the impact and the post-impact motion it already
// stores. Existing rows keep NULL: the value was not recorded for them.
// =============================================================================
const logger = require('../utils/logger');
const { getPool } = require('./db');

async function migrate() {
  const pool = getPool();
  const [rows] = await pool.query("SHOW COLUMNS FROM emergency_incident_logs LIKE 'freefall_min_g'");
  if (rows.length > 0) return false;

  await pool.query(`
    ALTER TABLE emergency_incident_logs
    ADD COLUMN freefall_min_g FLOAT NULL AFTER post_impact_stillness
  `);
  logger.info('[DB MIGRATION] Added freefall_min_g to emergency_incident_logs.');
  return true;
}

module.exports = { migrate };

if (require.main === module) {
  migrate().then(() => process.exit(0)).catch(e => { logger.error(e); process.exit(1); });
}
