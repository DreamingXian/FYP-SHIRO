// =============================================================================
// Migration: optional patient height and weight
// Adds height_cm and weight_kg to patients in databases created before.
// Existing patients get NULL ("not recorded"); no value is invented.
// =============================================================================
const logger = require('../utils/logger');
const { getPool } = require('./db');

async function migrate() {
  const pool = getPool();
  const [rows] = await pool.query("SHOW COLUMNS FROM patients LIKE 'height_cm'");
  if (rows.length > 0) return false;

  await pool.query(`ALTER TABLE patients
    ADD COLUMN height_cm SMALLINT UNSIGNED NULL AFTER fall_risk_score,
    ADD COLUMN weight_kg DECIMAL(4,1) NULL AFTER height_cm`);
  logger.info('[DB MIGRATION] patients can now record height (cm) and weight (kg).');
  return true;
}

module.exports = { migrate };

if (require.main === module) {
  migrate().then(() => process.exit(0)).catch(e => { logger.error(e); process.exit(1); });
}
