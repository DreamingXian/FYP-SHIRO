const { getPool } = require('./db');

async function migrate() {
  const pool = getPool();
  try {
    await pool.query('SELECT availability_status FROM devices LIMIT 1');
    console.log('[DB MIGRATION] availability_status column already exists.');
  } catch (err) {
    if (err.code === 'ER_BAD_FIELD_ERROR' || (err.message && err.message.includes("Unknown column 'availability_status'"))) {
      await pool.query("ALTER TABLE devices ADD COLUMN availability_status ENUM('AVAILABLE', 'IN_USE', 'UNAVAILABLE', 'MAINTENANCE') NOT NULL DEFAULT 'AVAILABLE' AFTER status");
      console.log('[DB MIGRATION] Successfully added availability_status column to devices table.');
    } else {
      console.error('[DB MIGRATION] Error:', err.message);
    }
  }
}

module.exports = { migrate };

if (require.main === module) {
  migrate().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}

