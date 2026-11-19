// =============================================================================
// Migration: the ward and bed a patient was discharged from
// Discharge clears assigned_ward_id and assigned_bed_id, so a shift report could
// not list a patient discharged during the shift. Two columns keep them.
// Patients discharged before this change get NULL ("not recorded"): their ward
// is not known any more and is never guessed.
// =============================================================================
const logger = require('../utils/logger');
const { getPool } = require('./db');

async function migrate() {
  const pool = getPool();
  const [rows] = await pool.query("SHOW COLUMNS FROM patients LIKE 'discharged_from_ward_id'");
  if (rows.length > 0) return false;

  await pool.query(`ALTER TABLE patients
    ADD COLUMN discharged_from_ward_id VARCHAR(32) NULL AFTER discharge_date,
    ADD COLUMN discharged_from_bed_id VARCHAR(32) NULL AFTER discharged_from_ward_id`);
  logger.info('[DB MIGRATION] patients keep the ward and bed they were discharged from (shift report).');
  return true;
}

module.exports = { migrate };

if (require.main === module) {
  migrate().then(() => process.exit(0)).catch(e => { logger.error(e); process.exit(1); });
}
