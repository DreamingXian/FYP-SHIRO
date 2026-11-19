// Integration tests: binding history (thesis Table 4.8), on shiro_test.
// Unbinding, discharging and deleting a wristband keep the binding as history;
// the database allows one ACTIVE binding per patient and per wristband; an older
// database is upgraded; the history API answers signed-in clinicians only.
process.env.INFLUX_TOKEN = '';

const { db, freshDatabase, restart, startServer, signIn, TEST_NURSE } = require('./helper');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const bindingService = require('../../services/binding_service');
const patientService = require('../../services/patient_service');
const deviceService = require('../../services/device_service');
const bindingCache = require('../../services/binding_cache');

const HTTP_PORT = 3989;
const MQTT_PORT = 1879;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;

const TAG_1 = 'ITEST-HIST-1';
const MAC_1 = 'AA:BB:CC:00:10:01';
const TAG_2 = 'ITEST-HIST-2';
const MAC_2 = 'AA:BB:CC:00:10:02';
const PATIENT_A = 'ITEST-HA';
const PATIENT_B = 'ITEST-HB';

async function addPatient(pool, id, nric) {
  await pool.query(
    `INSERT INTO patients (patient_id, full_name, nric_passport, dob, gender, phone_number, status)
     VALUES (?, ?, ?, '1990-01-01', 'OTHER', '0123456789', 'ADMITTED')`,
    [id, `History ${id}`, nric]
  );
}

async function addWristband(pool, id, mac) {
  await pool.query(
    "INSERT INTO devices (device_id, mac_address, device_type, hardware_model) VALUES (?, ?, 'WRISTBAND', 'TEST')",
    [id, mac]
  );
}

async function rowsOf(pool, patientId) {
  const [rows] = await pool.query(
    'SELECT binding_id, device_id, wristband_mac, status, bound_by, unbound_at, unbound_by FROM patient_bindings WHERE patient_id = ? ORDER BY binding_id',
    [patientId]
  );
  return rows;
}

describe('binding history in the services', () => {
  let pool;
  before(async () => {
    pool = await freshDatabase();
    await addPatient(pool, PATIENT_A, 'ITESTHA001');
    await addPatient(pool, PATIENT_B, 'ITESTHB002');
    await addWristband(pool, TAG_1, MAC_1);
    await addWristband(pool, TAG_2, MAC_2);
    await bindingCache.refresh();
  });
  after(async () => { await db.closePool(); });

  test('unbinding keeps the binding as UNBOUND, with the time and who unbound it', async () => {
    await bindingService.bindPatientWristband(PATIENT_A, TAG_1, 'Nurse Test (CLN-009)');
    await bindingService.unbindPatientWristband(TAG_1, 'Nurse Other (CLN-010)');
    const rows = await rowsOf(pool, PATIENT_A);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'UNBOUND');
    assert.equal(rows[0].wristband_mac, MAC_1);
    assert.equal(rows[0].bound_by, 'Nurse Test (CLN-009)');
    assert.equal(rows[0].unbound_by, 'Nurse Other (CLN-010)');
    assert.ok(rows[0].unbound_at instanceof Date);
    assert.equal(bindingCache.getPatientIdForDevice(TAG_1), null);
  });

  test('the same patient and the same wristband can be bound again; both bindings are in the history', async () => {
    await bindingService.bindPatientWristband(PATIENT_A, TAG_1, 'Nurse Test (CLN-009)');
    const rows = await rowsOf(pool, PATIENT_A);
    assert.deepEqual(rows.map(r => r.status), ['UNBOUND', 'ACTIVE']);
    assert.equal(bindingCache.getPatientIdForDevice(TAG_1), PATIENT_A);

    const history = await bindingService.getBindingHistory({ patientId: PATIENT_A });
    assert.equal(history.length, 2);
    assert.equal(history[0].status, 'ACTIVE');            // newest first
    assert.equal(history[0].unbound_at, null);
    assert.equal(history[1].status, 'UNBOUND');
    assert.equal(history[1].mac_address, MAC_1);
    assert.equal(typeof history[1].duration_minutes, 'number');
  });

  test('no bound_by given: recorded as unknown (null), never a made-up clinician', async () => {
    await bindingService.bindPatientWristband(PATIENT_B, TAG_2);
    const rows = await rowsOf(pool, PATIENT_B);
    assert.equal(rows[rows.length - 1].bound_by, null);
    await bindingService.unbindPatientWristband(TAG_2);
  });

  test('the database refuses a second ACTIVE binding for one patient or one wristband', async () => {
    // TAG_1 is bound to PATIENT_A: straight inserts, past the service's own checks
    await assert.rejects(
      pool.query("INSERT INTO patient_bindings (patient_id, device_id, status) VALUES (?, ?, 'ACTIVE')", [PATIENT_A, TAG_2]),
      (err) => err.code === 'ER_DUP_ENTRY'
    );
    await assert.rejects(
      pool.query("INSERT INTO patient_bindings (patient_id, device_id, status) VALUES (?, ?, 'ACTIVE')", [PATIENT_B, TAG_1]),
      (err) => err.code === 'ER_DUP_ENTRY'
    );
    // Ended bindings do not count
    await pool.query("INSERT INTO patient_bindings (patient_id, device_id, status) VALUES (?, ?, 'UNBOUND')", [PATIENT_A, TAG_2]);
  });

  test('the service refuses to bind a patient who already has a wristband', async () => {
    await assert.rejects(bindingService.bindPatientWristband(PATIENT_A, TAG_2, 'x'), /already bound/);
  });

  test('discharging keeps the binding as DISCHARGED and frees the wristband', async () => {
    await patientService.dischargePatient(PATIENT_A, 'Nurse Test (CLN-009)');
    const rows = await rowsOf(pool, PATIENT_A);
    const last = rows.filter(r => r.device_id === TAG_1).pop();
    assert.equal(last.status, 'DISCHARGED');
    assert.equal(last.unbound_by, 'Nurse Test (CLN-009)');
    assert.ok(last.unbound_at instanceof Date);
    const [[dev]] = await pool.query('SELECT availability_status FROM devices WHERE device_id = ?', [TAG_1]);
    assert.equal(dev.availability_status, 'AVAILABLE');
    assert.equal(bindingCache.getPatientIdForDevice(TAG_1), null);
  });

  test('deleting a bound wristband ends its binding and keeps the history with the MAC address', async () => {
    await bindingService.bindPatientWristband(PATIENT_B, TAG_2, 'Nurse Test (CLN-009)');
    await deviceService.deleteDevice(TAG_2, 'Admin Test (CLN-001)');
    assert.equal(bindingCache.getPatientIdForDevice(TAG_2), null);

    const rows = await rowsOf(pool, PATIENT_B);
    assert.ok(rows.length >= 2);
    for (const r of rows) {
      assert.equal(r.device_id, null);               // the device is gone ...
      assert.equal(r.wristband_mac, MAC_2);          // ... its MAC address is kept
      assert.notEqual(r.status, 'ACTIVE');
    }
    assert.equal(rows[rows.length - 1].unbound_by, 'Admin Test (CLN-001)');

    const history = await bindingService.getBindingHistory({ patientId: PATIENT_B });
    assert.equal(history[0].device_deleted, true);
    assert.equal(history[0].mac_address, MAC_2);

    // PATIENT_B can be bound to another wristband at once
    await addWristband(pool, TAG_2, MAC_2);
    await bindingService.bindPatientWristband(PATIENT_B, TAG_2, 'Nurse Test (CLN-009)');
    assert.equal(bindingCache.getPatientIdForDevice(TAG_2), PATIENT_B);
  });

  test('deleting a patient frees their wristband (it no longer stays IN USE)', async () => {
    await patientService.deletePatient(PATIENT_B);
    const [[dev]] = await pool.query('SELECT availability_status FROM devices WHERE device_id = ?', [TAG_2]);
    assert.equal(dev.availability_status, 'AVAILABLE');
    assert.equal(bindingCache.getPatientIdForDevice(TAG_2), null);
  });

  test('history filters by wristband; the limit is respected', async () => {
    const byTag = await bindingService.getBindingHistory({ deviceId: TAG_1 });
    assert.ok(byTag.length >= 2);
    assert.ok(byTag.every(b => b.device_id === TAG_1));
    const one = await bindingService.getBindingHistory({ limit: 1 });
    assert.equal(one.length, 1);
  });
});

describe('binding history migration', () => {
  after(async () => { await db.closePool(); });

  test('a database from before (one row per patient and wristband, deleted on unbind) is upgraded; its bindings stay', async () => {
    let pool = await freshDatabase();
    await addPatient(pool, PATIENT_A, 'ITESTHA001');
    await addWristband(pool, TAG_1, MAC_1);

    // The table as older versions created it
    await pool.query('DROP TABLE patient_bindings');
    await pool.query(`CREATE TABLE patient_bindings (
      binding_id INT AUTO_INCREMENT PRIMARY KEY,
      patient_id VARCHAR(32) NOT NULL,
      device_id VARCHAR(32) NOT NULL,
      bound_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      bound_by VARCHAR(64) NULL DEFAULT NULL,
      stream_rate VARCHAR(32) DEFAULT '5 Hz Live Stream',
      status ENUM('ACTIVE', 'UNBOUND') NOT NULL DEFAULT 'ACTIVE',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_active_patient (patient_id),
      UNIQUE KEY uk_active_device (device_id),
      CONSTRAINT fk_binding_patient FOREIGN KEY (patient_id) REFERENCES patients (patient_id) ON DELETE CASCADE,
      CONSTRAINT fk_binding_device FOREIGN KEY (device_id) REFERENCES devices (device_id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await pool.query("INSERT INTO patient_bindings (patient_id, device_id, bound_by, status) VALUES (?, ?, 'Old Nurse', 'ACTIVE')", [PATIENT_A, TAG_1]);

    pool = await restart();

    const [[row]] = await pool.query('SELECT status, wristband_mac, bound_by, unbound_at FROM patient_bindings WHERE patient_id = ?', [PATIENT_A]);
    assert.equal(row.status, 'ACTIVE');
    assert.equal(row.wristband_mac, MAC_1);   // copied from the devices table
    assert.equal(row.bound_by, 'Old Nurse');
    assert.equal(row.unbound_at, null);

    // Now it keeps history: unbind and bind again
    await bindingService.unbindPatientWristband(TAG_1, 'x');
    await bindingService.bindPatientWristband(PATIENT_A, TAG_1, 'y');
    const [rows] = await pool.query('SELECT status FROM patient_bindings WHERE patient_id = ? ORDER BY binding_id', [PATIENT_A]);
    assert.deepEqual(rows.map(r => r.status), ['UNBOUND', 'ACTIVE']);

    // ... and deleting the wristband keeps it
    await deviceService.deleteDevice(TAG_1, 'z');
    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM patient_bindings WHERE patient_id = ?', [PATIENT_A]);
    assert.equal(Number(n), 2);

    // A second start changes nothing
    pool = await restart();
    const [[{ m }]] = await pool.query('SELECT COUNT(*) AS m FROM patient_bindings');
    assert.equal(Number(m), 2);
  });
});

describe('binding history API', () => {
  let server;
  let nurse;
  before(async () => {
    const pool = await freshDatabase();
    await addPatient(pool, PATIENT_A, 'ITESTHA001');
    await addWristband(pool, TAG_1, MAC_1);
    await db.closePool();
    server = startServer({ HTTP_PORT: String(HTTP_PORT), MQTT_PORT: String(MQTT_PORT) });
    await server.ready;
    nurse = await signIn(BASE, TEST_NURSE);
  });
  after(async () => {
    if (server) await server.stop();
    await db.closePool();
  });

  const call = (path, cookie, method = 'GET', body) => fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  test('bind and unbind over the API: the history names the signed-in clinician for both', async () => {
    let res = await call('/api/bindings/bind', nurse, 'POST', { patient_id: PATIENT_A, device_id: TAG_1 });
    assert.equal(res.status, 200);
    res = await call(`/api/bindings/unbind?id=${TAG_1}`, nurse, 'POST', {});
    assert.equal(res.status, 200);

    res = await call(`/api/bindings/history?patient_id=${PATIENT_A}`, nurse);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.count, 1);
    const b = data.history[0];
    assert.equal(b.status, 'UNBOUND');
    assert.match(b.bound_by, /^Integration Nurse \(CLN-\d+\)$/);
    assert.match(b.unbound_by, /^Integration Nurse \(CLN-\d+\)$/);
    assert.equal(b.mac_address, MAC_1);
  });

  test('not signed in: 401', async () => {
    const res = await call('/api/bindings/history', null);
    assert.equal(res.status, 401);
  });

  test('a bad filter or limit is refused with 400', async () => {
    assert.equal((await call('/api/bindings/history?patient_id=%3Cscript%3E', nurse)).status, 400);
    assert.equal((await call('/api/bindings/history?limit=0', nurse)).status, 400);
    assert.equal((await call('/api/bindings/history?limit=5000', nurse)).status, 400);
  });
});
