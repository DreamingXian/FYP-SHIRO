// =============================================================================
// Migration: binding history (thesis Table 4.8)
// Older databases deleted a binding when it ended, and allowed only one row per
// patient and per wristband (UNIQUE patient_id, UNIQUE device_id). This keeps
// every binding instead:
//   - unbound_at, unbound_by and the status DISCHARGED are added;
//   - wristband_mac is added and copied from the devices table, so the history
//     keeps the wristband after it is deleted from the registry (device_id then
//     becomes NULL: the foreign key changes from CASCADE to SET NULL);
//   - "one ACTIVE binding per patient and per wristband" moves from the two
//     unique keys to unique virtual columns that are NULL once a binding ends.
// Existing bindings are all kept unchanged (ACTIVE). Runs once; each step checks
// whether it is needed, so a migration interrupted halfway finishes next time.
// =============================================================================
const logger = require('../utils/logger');
const { getPool } = require('./db');

async function columnExists(pool, column) {
  const [rows] = await pool.query('SHOW COLUMNS FROM patient_bindings LIKE ?', [column]);
  return rows.length > 0 ? rows[0] : null;
}

async function indexColumns(pool, indexName) {
  const [rows] = await pool.query('SHOW INDEX FROM patient_bindings WHERE Key_name = ?', [indexName]);
  return rows.map(r => r.Column_name);
}

/** The foreign key from patient_bindings.device_id to devices, with its delete rule, or null. */
async function deviceForeignKey(pool) {
  const [rows] = await pool.query(
    `SELECT rc.CONSTRAINT_NAME AS name, rc.DELETE_RULE AS deleteRule
     FROM information_schema.REFERENTIAL_CONSTRAINTS rc
     JOIN information_schema.KEY_COLUMN_USAGE k
       ON k.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA AND k.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
      AND k.TABLE_NAME = rc.TABLE_NAME
     WHERE rc.CONSTRAINT_SCHEMA = DATABASE() AND rc.TABLE_NAME = 'patient_bindings'
       AND k.COLUMN_NAME = 'device_id'
     LIMIT 1`
  );
  return rows.length > 0 ? rows[0] : null;
}

async function migrate() {
  const pool = getPool();
  if (await columnExists(pool, 'active_device_id')) return false;

  // 1. New columns; DISCHARGED as a status
  if (!(await columnExists(pool, 'wristband_mac'))) {
    await pool.query('ALTER TABLE patient_bindings ADD COLUMN wristband_mac VARCHAR(32) NULL AFTER device_id');
  }
  if (!(await columnExists(pool, 'unbound_at'))) {
    await pool.query(`ALTER TABLE patient_bindings
      ADD COLUMN unbound_at TIMESTAMP NULL DEFAULT NULL AFTER status,
      ADD COLUMN unbound_by VARCHAR(64) NULL DEFAULT NULL AFTER unbound_at`);
  }
  await pool.query(
    "ALTER TABLE patient_bindings MODIFY status ENUM('ACTIVE', 'UNBOUND', 'DISCHARGED') NOT NULL DEFAULT 'ACTIVE'"
  );
  await pool.query(
    `UPDATE patient_bindings pb JOIN devices d ON pb.device_id = d.device_id
     SET pb.wristband_mac = d.mac_address WHERE pb.wristband_mac IS NULL`
  );

  // 2. Plain indexes first: the foreign keys need one once the unique keys are gone
  if ((await indexColumns(pool, 'idx_binding_patient')).length === 0) {
    await pool.query('ALTER TABLE patient_bindings ADD INDEX idx_binding_patient (patient_id)');
  }
  if ((await indexColumns(pool, 'idx_binding_device')).length === 0) {
    await pool.query('ALTER TABLE patient_bindings ADD INDEX idx_binding_device (device_id)');
  }
  if ((await indexColumns(pool, 'idx_binding_bound_at')).length === 0) {
    await pool.query('ALTER TABLE patient_bindings ADD INDEX idx_binding_bound_at (bound_at)');
  }

  // 3. Deleting a wristband keeps its history: device_id may become NULL
  const fk = await deviceForeignKey(pool);
  if (!fk || fk.deleteRule !== 'SET NULL') {
    if (fk) await pool.query(`ALTER TABLE patient_bindings DROP FOREIGN KEY \`${fk.name}\``);
    await pool.query('ALTER TABLE patient_bindings MODIFY device_id VARCHAR(32) NULL');
    await pool.query(`ALTER TABLE patient_bindings ADD CONSTRAINT fk_binding_device
      FOREIGN KEY (device_id) REFERENCES devices (device_id) ON DELETE SET NULL`);
  }

  // 4. One ACTIVE binding per patient and per wristband, instead of one row each
  for (const name of ['uk_active_patient', 'uk_active_device']) {
    const cols = await indexColumns(pool, name);
    if (cols.length > 0 && !cols[0].startsWith('active_')) {
      await pool.query(`ALTER TABLE patient_bindings DROP INDEX \`${name}\``);
    }
  }
  await pool.query(`ALTER TABLE patient_bindings
    ADD COLUMN active_patient_id VARCHAR(32) GENERATED ALWAYS AS (IF(status = 'ACTIVE', patient_id, NULL)) VIRTUAL,
    ADD COLUMN active_device_id VARCHAR(32) GENERATED ALWAYS AS (IF(status = 'ACTIVE', device_id, NULL)) VIRTUAL,
    ADD UNIQUE KEY uk_active_patient (active_patient_id),
    ADD UNIQUE KEY uk_active_device (active_device_id)`);

  logger.info('[DB MIGRATION] patient_bindings keeps every binding (binding history); a wristband deleted from the registry keeps its history.');
  return true;
}

module.exports = { migrate };

if (require.main === module) {
  migrate().then(() => process.exit(0)).catch(e => { logger.error(e); process.exit(1); });
}
