// =============================================================================
// Migration: a paired headset can be assigned to a clinician
// Adds assigned_clinician_id, assigned_at and assigned_by to headset_pairings
// in databases created before. Existing pairings stay unassigned.
// =============================================================================
const logger = require('../utils/logger');
const { getPool } = require('./db');

async function migrate() {
  const pool = getPool();
  const [rows] = await pool.query("SHOW COLUMNS FROM headset_pairings LIKE 'assigned_clinician_id'");
  if (rows.length > 0) return false;

  await pool.query(`ALTER TABLE headset_pairings
    ADD COLUMN assigned_clinician_id VARCHAR(16) NULL,
    ADD COLUMN assigned_at DATETIME NULL,
    ADD COLUMN assigned_by VARCHAR(16) NULL`);
  logger.info('[DB MIGRATION] headset_pairings can now record the clinician a headset is assigned to.');
  return true;
}

module.exports = { migrate };

if (require.main === module) {
  migrate().then(() => process.exit(0)).catch(e => { logger.error(e); process.exit(1); });
}
