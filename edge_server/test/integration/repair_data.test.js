// Integration test (Phase 11 review): database/repair_data.js finds the ghost
// data the earlier bugs left (beds taken by nobody, a worn wristband marked free,
// an admitted patient with a discharge date, ...), repairs it only with --apply,
// writes an undo file first, and the undo file puts the values back.
const { db, freshDatabase } = require('./helper');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', '..', 'database', 'repair_data.js');
const UNDO_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'shiro-repair-'));

function runRepair(...args) {
  return execFileSync(process.execPath, [SCRIPT, ...args], {
    cwd: path.join(__dirname, '..', '..'),
    env: { ...process.env, DB_NAME: process.env.DB_NAME, SHIRO_REPAIR_DIR: UNDO_DIR, INFLUX_TOKEN: '' },
    encoding: 'utf8'
  });
}

describe('repair of ghost data', () => {
  let pool;

  before(async () => {
    pool = await freshDatabase();
    // Ghosts as found in the project database on 22 Nov 2026:
    // P-001 lost its bed (the old layout save), the bed stayed TAKEN
    await pool.query("UPDATE patients SET assigned_ward_id = NULL, assigned_bed_id = NULL WHERE patient_id = 'P-001'");
    // A worn wristband marked FREE
    await pool.query("INSERT INTO devices (device_id, mac_address, device_type, hardware_model, availability_status) VALUES ('ITEST-RP-1', 'AA:BB:CC:00:12:01', 'WRISTBAND', 'TEST', 'AVAILABLE')");
    await pool.query("INSERT INTO patient_bindings (patient_id, device_id, status, bound_by) VALUES ('P-002', 'ITEST-RP-1', 'ACTIVE', 'Test')");
    // An admitted patient still carrying a discharge date
    await pool.query("UPDATE patients SET discharge_date = '2026-11-08 16:26:41' WHERE patient_id = 'P-003'");
  });

  after(async () => {
    await db.closePool();
    fs.rmSync(UNDO_DIR, { recursive: true, force: true });
  });

  test('without --apply it only shows the problems', async () => {
    const out = runRepair();
    assert.match(out, /Bed marked TAKEN, nobody in it -> FREE: 1\s+WARD-001 BED-001-01/);
    assert.match(out, /Wristband worn by a patient, marked FREE -> IN USE: 1\s+ITEST-RP-1 \(P-002\)/);
    assert.match(out, /Admitted patient with a discharge date -> no discharge date: 1\s+P-003/);
    assert.match(out, /3 rows to repair/);
    assert.doesNotMatch(out, /Tan Ah Kow|Siti|Kavitha/, 'IDs only, never names');
    const [[bed]] = await pool.query("SELECT status FROM ward_beds WHERE bed_id = 'BED-001-01'");
    assert.equal(bed.status, 'OCCUPIED', 'nothing changed');
  });

  test('--apply repairs them, writes an undo file, and a second run finds nothing', async () => {
    const out = runRepair('--apply');
    assert.match(out, /Repaired 3 rows/);
    const [[bed]] = await pool.query("SELECT status FROM ward_beds WHERE bed_id = 'BED-001-01'");
    assert.equal(bed.status, 'AVAILABLE');
    const [[tag]] = await pool.query("SELECT availability_status FROM devices WHERE device_id = 'ITEST-RP-1'");
    assert.equal(tag.availability_status, 'IN_USE');
    const [[p3]] = await pool.query("SELECT status, discharge_date FROM patients WHERE patient_id = 'P-003'");
    assert.equal(p3.status, 'ADMITTED');
    assert.equal(p3.discharge_date, null);
    assert.match(runRepair(), /Nothing to repair/);

    // The undo file puts every value back
    const files = fs.readdirSync(UNDO_DIR).filter(f => f.endsWith('-undo.sql'));
    assert.equal(files.length, 1);
    const sql = fs.readFileSync(path.join(UNDO_DIR, files[0]), 'utf8');
    for (const statement of sql.split('\n').filter(l => l.startsWith('UPDATE'))) await pool.query(statement);
    const [[bedBack]] = await pool.query("SELECT status FROM ward_beds WHERE bed_id = 'BED-001-01'");
    assert.equal(bedBack.status, 'OCCUPIED');
    const [[p3Back]] = await pool.query("SELECT DATE_FORMAT(discharge_date, '%Y-%m-%d %H:%i:%s') AS d FROM patients WHERE patient_id = 'P-003'");
    assert.equal(p3Back.d, '2026-11-08 16:26:41');
  });
});
