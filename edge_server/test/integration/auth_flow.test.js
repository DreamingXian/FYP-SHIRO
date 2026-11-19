// Integration test: clinician accounts, roles, the audit trail and headset pairing
// on the running server against shiro_test.
process.env.INFLUX_TOKEN = '';

const { db, freshDatabase, startServer, signIn, pairHeadset, TEST_NURSE } = require('./helper');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');

const HTTP_PORT = 3991;
const MQTT_PORT = 1881;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const WS_URL = `ws://127.0.0.1:${HTTP_PORT}`;
const HEADSET_ID = 'QUEST3-A1B2C3';
const HEADSET_MAC = '02:A1:B2:C3:D4:E5';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function call(path, { method = 'GET', cookie, bearer, body } = {}) {
  return fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

/** Opens a WebSocket. Resolves with { socket, messages } or with the HTTP status of a refusal. */
function openSocket(headers = {}) {
  return new Promise((resolve) => {
    const socket = new WebSocket(WS_URL, { headers });
    const messages = [];
    socket.on('message', (d) => messages.push(JSON.parse(d.toString())));
    socket.once('open', () => resolve({ socket, messages }));
    socket.once('unexpected-response', (req, res) => resolve({ refused: res.statusCode }));
    socket.once('error', () => resolve({ refused: 'error' }));
  });
}

describe('clinician sign-in, roles and audit trail', () => {
  let server;
  let pool;
  let admin;
  let nurse;

  before(async () => {
    pool = await freshDatabase();
    server = startServer({ HTTP_PORT: String(HTTP_PORT), MQTT_PORT: String(MQTT_PORT), ENABLE_SIMULATION: 'true' });
    await server.ready;
    admin = await signIn(BASE);
    nurse = await signIn(BASE, TEST_NURSE);
  });

  after(async () => {
    if (server) await server.stop();
    await db.closePool();
  });

  test('without a session the API and the WebSocket are refused', async () => {
    assert.equal((await call('/api/patients/list')).status, 401);
    assert.equal((await openSocket()).refused, 401);
    const withSession = await openSocket({ Cookie: nurse });
    assert.ok(withSession.socket, 'a signed-in clinician connects');
    withSession.socket.close();
  });

  test('a clinician cannot enroll devices or read the audit log; an admin can', async () => {
    assert.equal((await call('/api/devices/enroll', { method: 'POST', cookie: nurse, body: { device_id: 'ITEST-TAG-90', mac_address: 'B0:00:00:00:00:90', device_type: 'WRISTBAND' } })).status, 403);
    assert.equal((await call('/api/admin/audit', { cookie: nurse })).status, 403);
    const enrolled = await call('/api/devices/enroll', { method: 'POST', cookie: admin, body: { device_id: 'ITEST-TAG-90', mac_address: 'B0:00:00:00:00:90', device_type: 'WRISTBAND' } });
    assert.ok(enrolled.status < 300, `enroll answered ${enrolled.status}`);
  });

  test('a binding and an acknowledgement record the signed-in clinician, not a name sent by the browser', async () => {
    const [[patient]] = await pool.query(`
      SELECT patient_id FROM patients
      WHERE patient_id NOT IN (SELECT patient_id FROM patient_bindings WHERE status = 'ACTIVE')
      ORDER BY patient_id LIMIT 1`);
    const bind = await call('/api/bindings/bind', { method: 'POST', cookie: nurse, body: { patient_id: patient.patient_id, device_id: 'ITEST-TAG-90', bound_by: 'DOC-FAKE' } });
    assert.equal(bind.status, 200, await bind.clone().text());
    const [[binding]] = await pool.query("SELECT bound_by FROM patient_bindings WHERE device_id = 'ITEST-TAG-90' AND status = 'ACTIVE'");
    assert.equal(binding.bound_by, 'Integration Nurse (CLN-002)');

    const sim = await call('/api/alerts/trigger-simulation', { method: 'POST', cookie: nurse, body: { category: 'FALL_ACCIDENT', patient_id: patient.patient_id } });
    const { incident } = await sim.json();
    const ack = await call('/api/alerts/acknowledge', { method: 'POST', cookie: nurse, body: { incident_id: incident.incident_id, attending_clinician: 'Somebody Else' } });
    assert.equal(ack.status, 200);
    const [[row]] = await pool.query('SELECT attending_clinician FROM emergency_incident_logs WHERE incident_id = ?', [incident.incident_id]);
    assert.equal(row.attending_clinician, 'Integration Nurse (CLN-002)');
  });

  test('the audit log lists who did what', async () => {
    await sleep(200); // records are written after the answer
    const res = await call('/api/admin/audit?limit=50', { cookie: admin });
    const { entries } = await res.json();
    const find = (action) => entries.find(e => e.action === action);
    assert.equal(find('DEVICE_ENROLL').actor_id, 'CLN-001');
    assert.equal(find('DEVICE_ENROLL').target_id, 'ITEST-TAG-90');
    assert.equal(find('BINDING_CREATE').actor_label, 'Integration Nurse (CLN-002)');
    assert.equal(find('ALERT_ACKNOWLEDGE').actor_id, 'CLN-002');
    assert.ok(find('LOGIN'));
    assert.equal(entries.some(e => e.action === 'DEVICE_ENROLL' && e.actor_id === 'CLN-002'), false, 'the refused attempt is not recorded as done');
  });

  test('a deactivated clinician is signed out at once', async () => {
    const extra = await call('/api/admin/clinicians/create', { method: 'POST', cookie: admin, body: { username: 'itest-temp', full_name: 'Temporary Nurse', role: 'CLINICIAN', password: 'temporary-password-9' } });
    assert.equal(extra.status, 201);
    const { clinician } = await extra.json();
    const temp = await signIn(BASE, { username: 'itest-temp', password: 'temporary-password-9' });
    assert.equal((await call('/api/patients/list', { cookie: temp })).status, 200);
    await call('/api/admin/clinicians/set-active', { method: 'POST', cookie: admin, body: { clinician_id: clinician.clinician_id, active: false } });
    assert.equal((await call('/api/patients/list', { cookie: temp })).status, 401);
  });

  test('a paired headset connects with its token, reports only itself, and is cut off when revoked', async () => {
    const token = await pairHeadset(BASE, admin, HEADSET_ID, HEADSET_MAC);
    const [[device]] = await pool.query('SELECT device_type FROM devices WHERE device_id = ?', [HEADSET_ID]);
    assert.equal(device.device_type, 'HEADSET', 'pairing enrolls the headset');

    const { socket, messages } = await openSocket({ Authorization: `Bearer ${token}` });
    assert.ok(socket, 'the paired headset connects');
    socket.send(JSON.stringify({ action: 'DEVICE_HANDSHAKE', device_id: 'QUEST3-OTHER1', mac_address: '02:00:00:00:00:01', device_type: 'HEADSET' }));
    await sleep(300);
    assert.ok(messages.some(m => m.type === 'ERROR' && /paired as QUEST3-A1B2C3/.test(m.error)), 'it cannot report another headset');

    assert.equal((await call('/api/ward/list', { bearer: token })).status, 200, 'it may read wards');
    assert.equal((await call('/api/patients/admit', { method: 'POST', bearer: token, body: {} })).status, 403, 'it may not admit patients');

    const closed = new Promise((resolve) => socket.once('close', (code) => resolve(code)));
    assert.equal((await call('/api/admin/headsets/revoke', { method: 'POST', cookie: admin, body: { device_id: HEADSET_ID } })).status, 200);
    assert.equal(await closed, 4001);
    assert.equal((await openSocket({ Authorization: `Bearer ${token}` })).refused, 401);
  });

  test('the admin sees the server addresses for the headset app; a clinician and a headset do not', async () => {
    const res = await call('/api/admin/server-address', { cookie: admin });
    assert.equal(res.status, 200);
    const { port, addresses } = await res.json();
    assert.equal(port, HTTP_PORT);
    assert.ok(Array.isArray(addresses));
    for (const a of addresses) assert.match(a.address, /^\d+\.\d+\.\d+\.\d+$/);
    assert.equal((await call('/api/admin/server-address', { cookie: nurse })).status, 403);
    assert.equal((await call('/api/admin/server-address')).status, 401);
    const token = await pairHeadset(BASE, admin, 'QUEST3-D4E5F6', '02:D4:E5:F6:00:01');
    assert.equal((await call('/api/admin/server-address', { bearer: token })).status, 403);
  });

  test('signing out ends the session', async () => {
    const own = await signIn(BASE, TEST_NURSE);
    assert.equal((await call('/api/auth/logout', { method: 'POST', cookie: own })).status, 200);
    assert.equal((await call('/api/patients/list', { cookie: own })).status, 401);
  });
});
