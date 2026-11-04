// =============================================================================
// Migration: Add Calibration Columns to ward_anchors table
// =============================================================================
const { getPool } = require('./db');

async function migrate() {
  const pool = getPool();
  try {
    await pool.query('SELECT calibrated_a, calibrated_n, last_calibrated_at FROM ward_anchors LIMIT 1');
    console.log('[DB MIGRATION] Anchor calibration columns already exist in ward_anchors.');
  } catch (err) {
    if (err.code === 'ER_BAD_FIELD_ERROR' || (err.message && err.message.includes("Unknown column 'calibrated_a'"))) {
      await pool.query(`
        ALTER TABLE ward_anchors 
        ADD COLUMN calibrated_a DECIMAL(5,2) NULL DEFAULT NULL AFTER z,
        ADD COLUMN calibrated_n DECIMAL(4,2) NULL DEFAULT NULL AFTER calibrated_a,
        ADD COLUMN last_calibrated_at TIMESTAMP NULL DEFAULT NULL AFTER calibrated_n
      `);
      console.log('[DB MIGRATION] Successfully added calibrated_a, calibrated_n, and last_calibrated_at to ward_anchors.');
    } else {
      console.error('[DB MIGRATION] Error checking/adding calibration columns:', err.message);
    }
  }
}

module.exports = { migrate };

if (require.main === module) {
  migrate().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}

