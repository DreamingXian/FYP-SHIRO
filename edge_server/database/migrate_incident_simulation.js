// =============================================================================
// Migration: add is_simulated to emergency_incident_logs
// Marks incidents created by the Live Lab test bench, so the audit log can
// always tell a simulated alarm from a real one. Existing rows are not changed
// (they keep the default 0).
// =============================================================================
const { getPool } = require('./db');

async function migrate() {
  const pool = getPool();
  const [rows] = await pool.query("SHOW COLUMNS FROM emergency_incident_logs LIKE 'is_simulated'");
  if (rows.length > 0) return false;

  await pool.query(`
    ALTER TABLE emergency_incident_logs
    ADD COLUMN is_simulated TINYINT(1) NOT NULL DEFAULT 0 AFTER alert_message
  `);
  console.log('[DB MIGRATION] Added is_simulated to emergency_incident_logs.');
  return true;
}

module.exports = { migrate };

if (require.main === module) {
  migrate().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
