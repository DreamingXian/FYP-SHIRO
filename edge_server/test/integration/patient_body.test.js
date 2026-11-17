// Integration test: optional patient height and weight (8D-1), on the running
// server against shiro_test: admission, update, clearing, and the headset's
// ward data (/api/ward/ips-init) that the person linking uses.
process.env.INFLUX_TOKEN = '';

const { db, freshDatabase, restart, startServer, signIn, TEST_NURSE } = require('./helper');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const HTTP_PORT = 3993;
const MQTT_PORT = 1883;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;

function call(path, { method = 'GET', cookie, body } = {}) {
  return fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

const NEW_PATIENT = {
  patient_id: 'P-950',
  full_name: 'Body Measure',
  nric_passport: 'A9500950',
  dob: '1990-01-01',
  gender: 'FEMALE',
  phone_number: '0123456789'
};

describe('patient height and weight', () => {
  let server;
  let pool;
  let nurse;

  before(async () => {
    pool = await freshDatabase();
    server = startServer({ HTTP_PORT: String(HTTP_PORT), MQTT_PORT: String(MQTT_PORT) });
    await server.ready;
    nurse = await signIn(BASE, TEST_NURSE);
  });

  after(async () => {
    if (server) await server.stop();
    await db.closePool();
  });

  async function getPatient(id) {
    const res = await call(`/api/patients/get?id=${id}`, { cookie: nurse });
    assert.equal(res.status, 200);
    return (await res.json()).patient;
  }

  test('sample patients have no recorded height or weight (nothing invented)', async () => {
    const p = await getPatient('P-001');
    assert.equal(p.height_cm, null);
    assert.equal(p.weight_kg, null);
  });

  test('a patient admitted with height and weight keeps them, weight to 0.1 kg', async () => {
    const res = await call('/api/patients/admit', { method: 'POST', cookie: nurse, body: { ...NEW_PATIENT, height_cm: 152, weight_kg: 48.26 } });
    assert.equal(res.status, 201, await res.text());
    const p = await getPatient('P-950');
    assert.equal(p.height_cm, 152);
    assert.equal(p.weight_kg, 48.3);
  });

  test('an update without them keeps them; null clears one; a number replaces it', async () => {
    let res = await call('/api/patients/update', { method: 'POST', cookie: nurse, body: { patient_id: 'P-950', medical_history: 'Asthma' } });
    assert.equal(res.status, 200);
    let p = await getPatient('P-950');
    assert.equal(p.height_cm, 152);
    assert.equal(p.weight_kg, 48.3);

    res = await call('/api/patients/update', { method: 'POST', cookie: nurse, body: { patient_id: 'P-950', weight_kg: null } });
    assert.equal(res.status, 200);
    p = await getPatient('P-950');
    assert.equal(p.height_cm, 152);
    assert.equal(p.weight_kg, null);

    res = await call('/api/patients/update', { method: 'POST', cookie: nurse, body: { patient_id: 'P-950', height_cm: 149, weight_kg: '50' } });
    assert.equal(res.status, 200);
    p = await getPatient('P-950');
    assert.equal(p.height_cm, 149);
    assert.equal(p.weight_kg, 50);
  });

  test('an admission with a height out of range is refused and stores nothing', async () => {
    const res = await call('/api/patients/admit', { method: 'POST', cookie: nurse, body: { ...NEW_PATIENT, patient_id: 'P-951', nric_passport: 'A9510951', height_cm: 300 } });
    assert.equal(res.status, 400);
    const [rows] = await pool.query("SELECT 1 FROM patients WHERE patient_id = 'P-951'");
    assert.equal(rows.length, 0);
  });

  test('the headset\'s ward data carries height and weight of bound patients (null when not recorded)', async () => {
    await pool.query("INSERT INTO devices (device_id, mac_address, device_type) VALUES ('TAG-950', 'AA:BB:CC:00:09:50', 'WRISTBAND'), ('TAG-001', 'AA:BB:CC:00:00:01', 'WRISTBAND')");
    await pool.query("INSERT INTO patient_bindings (patient_id, device_id) VALUES ('P-950', 'TAG-950'), ('P-001', 'TAG-001')");

    const res = await call('/api/ward/ips-init?ward_id=WARD-001', { cookie: nurse });
    assert.equal(res.status, 200);
    const data = await res.json();
    const byId = Object.fromEntries(data.tracked_subjects.map(s => [s.patient_id, s]));
    assert.equal(byId['P-950'].height_cm, 149);
    assert.equal(byId['P-950'].weight_kg, 50);
    assert.equal(byId['P-001'].height_cm, null);
    assert.equal(byId['P-001'].weight_kg, null);
  });
});

describe('patient height and weight columns', () => {
  after(async () => { await db.closePool(); });

  test('a database from before gains the columns; existing patients stay "not recorded"', async () => {
    let pool = await freshDatabase();
    await pool.query('ALTER TABLE patients DROP COLUMN height_cm, DROP COLUMN weight_kg');

    pool = await restart();

    const [cols] = await pool.query("SHOW COLUMNS FROM patients WHERE Field IN ('height_cm', 'weight_kg')");
    assert.deepEqual(cols.map(c => c.Field).sort(), ['height_cm', 'weight_kg']);
    const [[row]] = await pool.query("SELECT height_cm, weight_kg FROM patients WHERE patient_id = 'P-001'");
    assert.equal(row.height_cm, null);
    assert.equal(row.weight_kg, null);
  });
});
