// =============================================================================
// Migration: patient_bindings.bound_by has no invented default
// Older databases gave every binding the made-up clinician "DOC-8821" when no
// name was supplied. The column now defaults to NULL; bindings record the
// signed-in clinician. Existing rows are not changed.
// =============================================================================
const logger = require('../utils/logger');
const { getPool } = require('./db');

async function migrate() {
  const pool = getPool();
  const [rows] = await pool.query("SHOW COLUMNS FROM patient_bindings LIKE 'bound_by'");
  if (rows.length === 0 || rows[0].Default === null) return false;

  await pool.query('ALTER TABLE patient_bindings MODIFY bound_by VARCHAR(64) NULL DEFAULT NULL');
  logger.info('[DB MIGRATION] patient_bindings.bound_by no longer defaults to a made-up clinician.');
  return true;
}

module.exports = { migrate };

if (require.main === module) {
  migrate().then(() => process.exit(0)).catch(e => { logger.error(e); process.exit(1); });
}
