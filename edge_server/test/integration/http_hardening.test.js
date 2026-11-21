// Integration test: input validation and web hardening on the running server.
// Starts the real server on spare ports against shiro_test and sends it requests,
// WebSocket commands and MQTT messages that must be refused, next to valid ones
// that must still work. Time-series logging is off, so nothing reaches InfluxDB.
process.env.INFLUX_TOKEN = '';

const { db, freshDatabase, startServer, connectMqtt, anchorClientId, signIn } = require('./helper');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');

const HTTP_PORT = 3994;
const MQTT_PORT = 1884;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const SERVER_DIR = path.resolve(__dirname, '..', '..');
const UPLOAD_DIR = path.join(SERVER_DIR, 'public', 'uploads', 'patients');
const ANCHOR = 'A0:00:00:00:00:11';
const ANCHOR_2 = 'A0:00:00:00:00:12';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(64, 7)]);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Session cookie of the test admin, set in before()
let cookie = '';
const get = (url) => fetch(url, { headers: { Cookie: cookie } });

const post = (pathname, body, headers = {}) => fetch(BASE + pathname, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: cookie, ...headers },
  body: JSON.stringify(body)
});

async function expectStatus(res, status) {
  const data = await res.json();
  assert.equal(res.status, status, JSON.stringify(data));
  return data;
}

describe('input validation and web hardening', () => {
  let server;
  let ws;
  let mqtt;
  let pool;
  const received = [];
  const uploaded = [];

  const ofType = (type) => received.filter(m => m.type === type);

  /** Sends one WebSocket command and returns the messages that arrive in the next 300 ms. */
  async function sendCommand(command) {
    const from = received.length;
    ws.send(typeof command === 'string' ? command : JSON.stringify(command));
    await sleep(300);
    return received.slice(from);
  }

  before(async () => {
    pool = await freshDatabase();
    server = startServer({ HTTP_PORT: String(HTTP_PORT), MQTT_PORT: String(MQTT_PORT) });
    await server.ready;
    cookie = await signIn(BASE);

    ws = new WebSocket(`ws://127.0.0.1:${HTTP_PORT}`, { headers: { Cookie: cookie } });
    ws.on('message', (data) => { received.push(JSON.parse(data.toString())); });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });

    mqtt = await connectMqtt(MQTT_PORT, anchorClientId(ANCHOR));
  });

  after(async () => {
    for (const file of uploaded) fs.rmSync(file, { force: true });
    if (mqtt) mqtt.close();
    if (ws) ws.close();
    if (server) await server.stop();
    await db.closePool();
  });

  // ----- photo upload -----
  test('a photo is stored inside the upload folder under a server-built name and served as an image', async () => {
    const res = await post('/api/patients/upload-photo', { patient_id: 'ITEST-PHOTO', image_data: `data:image/png;base64,${PNG.toString('base64')}` });
    const data = await expectStatus(res, 200);
    assert.match(data.photo_url, /^\/uploads\/patients\/ITEST-PHOTO_\d+_[0-9a-f]{8}\.png$/);

    const stored = path.join(UPLOAD_DIR, path.basename(data.photo_url));
    uploaded.push(stored);
    assert.deepEqual(fs.readFileSync(stored), PNG);

    const anonymous = await fetch(BASE + data.photo_url);
    assert.equal(anonymous.status, 401, 'a patient photo is not served without sign-in');
    const served = await get(BASE + data.photo_url);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'image/png');
    assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG);
  });

  test('an upload with ../ in the patient ID writes nothing, inside or outside the upload folder', async () => {
    const listing = (dir) => fs.readdirSync(dir).sort();
    const before = [UPLOAD_DIR, path.join(SERVER_DIR, 'public'), SERVER_DIR, path.dirname(SERVER_DIR)].map(listing);

    for (const patientId of ['../../evil', '..\\..\\evil', '../evil', 'x/../../evil', '/tmp/evil']) {
      const res = await post('/api/patients/upload-photo', { patient_id: patientId, image_data: `data:image/png;base64,${PNG.toString('base64')}` });
      await expectStatus(res, 400);
    }

    const afterwards = [UPLOAD_DIR, path.join(SERVER_DIR, 'public'), SERVER_DIR, path.dirname(SERVER_DIR)].map(listing);
    assert.deepEqual(afterwards, before);
  });

  test('an upload that is not a PNG, JPEG or WebP is refused, and an oversized one is a 413', async () => {
    const html = Buffer.from('<html><body><script>alert(1)</script></body></html>').toString('base64');
    await expectStatus(await post('/api/patients/upload-photo', { patient_id: 'ITEST-PHOTO', image_data: `data:image/html;base64,${html}` }), 415);
    await expectStatus(await post('/api/patients/upload-photo', { patient_id: 'ITEST-PHOTO', image_data: `data:image/png;base64,${html}` }), 415);

    const tooLarge = Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)]).toString('base64');
    await expectStatus(await post('/api/patients/upload-photo', { patient_id: 'ITEST-PHOTO', image_data: `data:image/png;base64,${tooLarge}` }), 413);

    const overBodyLimit = 'A'.repeat(6 * 1024 * 1024);
    await expectStatus(await post('/api/patients/upload-photo', { patient_id: 'ITEST-PHOTO', image_data: `data:image/png;base64,${overBodyLimit}` }), 413);

    assert.deepEqual(fs.readdirSync(UPLOAD_DIR).filter(f => f.startsWith('ITEST-PHOTO')).length, uploaded.length);
  });

  // ----- vitals history -----
  test('the vitals history answers a listed range and refuses a query injection', async () => {
    const ok = await expectStatus(await get(`${BASE}/api/patients/vitals-history?id=P-001&range=-1h`), 200);
    assert.equal(ok.range, '-1h');
    assert.equal(ok.window, '10s');
    assert.deepEqual(ok.vitals, []);

    const byDefault = await expectStatus(await get(`${BASE}/api/patients/vitals-history?id=P-001`), 200);
    assert.equal(byDefault.range, '-24h');

    const range = encodeURIComponent('-1h) |> drop(columns: ["_value"]) //');
    await expectStatus(await get(`${BASE}/api/patients/vitals-history?id=P-001&range=${range}`), 400);
    await expectStatus(await get(`${BASE}/api/patients/vitals-history?id=${encodeURIComponent('P-001" or true or "')}&range=-1h`), 400);
    await expectStatus(await get(`${BASE}/api/patients/vitals-history`), 400);
  });

  // ----- no silent defaults -----
  test('a ward request without a ward ID is refused, and an unknown ward is a 404', async () => {
    await expectStatus(await get(`${BASE}/api/ward/config`), 400);
    await expectStatus(await get(`${BASE}/api/ward/ips-init`), 400);
    await expectStatus(await get(`${BASE}/api/ward/config?ward_id=WARD-999`), 404);
    const ward = await expectStatus(await get(`${BASE}/api/ward/config?ward_id=WARD-001`), 200);
    assert.equal(ward.ward.ward_id, 'WARD-001');
  });

  test('a ward plan without a ward ID changes no ward', async () => {
    const [[before]] = await pool.query("SELECT room_title, length_x FROM ward_rooms WHERE ward_id = 'WARD-001'");
    await expectStatus(await post('/api/ward/config', { room_title: 'Overwritten', length_x: 99, beds: [], anchors: [], obstacles: [] }), 400);
    const [[afterwards]] = await pool.query("SELECT room_title, length_x FROM ward_rooms WHERE ward_id = 'WARD-001'");
    assert.deepEqual(afterwards, before);
    const [[beds]] = await pool.query("SELECT COUNT(*) AS n FROM ward_beds WHERE ward_id = 'WARD-001'");
    assert.ok(Number(beds.n) > 0, 'the beds of WARD-001 are still there');
  });

  test('the headset can store its spatial anchor only for an existing ward', async () => {
    await expectStatus(await post('/api/ward/save-anchor', { spatial_anchor_uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }), 400);
    await expectStatus(await post('/api/ward/save-anchor', { ward_id: 'WARD-999', spatial_anchor_uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }), 404);
    await expectStatus(await post('/api/ward/save-anchor', { ward_id: 'WARD-002', spatial_anchor_uuid: '"><script>alert(1)</script>' }), 400);

    await expectStatus(await post('/api/ward/save-anchor', { ward_id: 'WARD-002', spatial_anchor_uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }), 200);
    const [[row]] = await pool.query("SELECT spatial_anchor_uuid FROM ward_rooms WHERE ward_id = 'WARD-002'");
    assert.equal(row.spatial_anchor_uuid, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });

  // ----- errors -----
  test('a rule broken by the request is explained, without database details', async () => {
    const data = await expectStatus(await post('/api/bindings/bind', { patient_id: 'P-404', device_id: 'TAG-404' }), 400);
    assert.match(data.error, /P-404/);
    assert.doesNotMatch(JSON.stringify(data), /SELECT|ER_|sqlMessage|at .*\.js/);
  });

  // ----- simulation -----
  test('a simulation needs an existing patient and takes the name, ward and bed from the database', async () => {
    const [[before]] = await pool.query('SELECT COUNT(*) AS n FROM emergency_incident_logs');

    await expectStatus(await post('/api/alerts/trigger-simulation', { category: 'FALL_ACCIDENT' }), 400);
    await expectStatus(await post('/api/alerts/trigger-simulation', { category: 'EARTHQUAKE', patient_id: 'P-001' }), 400);
    await expectStatus(await post('/api/alerts/trigger-simulation', { category: 'FALL_ACCIDENT', patient_id: 'P-404' }), 404);
    await expectStatus(await post('/api/alerts/trigger-simulation', { category: 'FALL_ACCIDENT', patient_id: 'P-001', heart_rate: 9999 }), 400);

    const [[unchanged]] = await pool.query('SELECT COUNT(*) AS n FROM emergency_incident_logs');
    assert.equal(Number(unchanged.n), Number(before.n), 'refused requests create no incident');

    const created = await expectStatus(await post('/api/alerts/trigger-simulation', {
      category: 'FALL_ACCIDENT', patient_id: 'P-002', patient_name: 'Somebody Else', ward_id: 'WARD-777', bed_id: 'BED-777'
    }), 201);
    assert.equal(created.incident.patient_name, 'Siti Nurhaliza');
    assert.equal(created.incident.ward_id, 'WARD-001');
    assert.equal(created.incident.bed_id, 'BED-001-02');
    assert.equal(created.incident.is_simulated, true);
  });

  // ----- WebSocket -----
  test('an invalid WebSocket command is answered with an error and carried out by nobody', async () => {
    for (const command of ['not json', '[1,2]', { action: 'DROP_ALL' }, { action: 'SET_ACTIVE_MODE' }, { action: 'SET_ACTIVE_MODE', tag_id: '<img src=x onerror=alert(1)>' },
      { action: 'UPDATE_CALIBRATION', A: 'x' }, { action: 'DEVICE_HANDSHAKE' }]) {
      const answers = await sendCommand(command);
      assert.equal(answers.filter(m => m.type === 'ERROR').length, 1, JSON.stringify(command));
      assert.equal(answers.filter(m => m.type !== 'ERROR' && m.type !== 'DEVICE_STATUS_UPDATE').length, 0, JSON.stringify(answers));
    }
    assert.equal(ofType('ACTIVE_MODE_ENGAGED').length, 0);
    assert.equal(ofType('CALIBRATION_SYNC').length, 0);
  });

  test('a 1 Hz activation goes out through the anchor that hears the wristband best', async () => {
    const tag = 'B0:00:00:00:00:21';
    const second = await connectMqtt(MQTT_PORT, anchorClientId(ANCHOR_2));
    try {
      assert.equal(await mqtt.subscribe('shiro/control/mode'), 0x00);
      assert.equal(await second.subscribe('shiro/control/#'), 0x00);
      // ANCHOR hears the wristband weakly, ANCHOR_2 strongly
      for (let i = 0; i < 3; i++) {
        mqtt.publish({ anchor_mac: ANCHOR, tag_mac: tag, rssi: -78 });
        second.publish({ anchor_mac: ANCHOR_2, tag_mac: tag, rssi: -55 });
      }
      await sleep(300);

      const answers = await sendCommand({ action: 'SET_ACTIVE_MODE', data: { tagId: tag, targetMac: tag, duration: 60 } });
      const engaged = answers.find(m => m.type === 'ACTIVE_MODE_ENGAGED');
      assert.ok(engaged, JSON.stringify(answers));
      assert.equal(engaged.tag_id, tag);
      assert.equal(engaged.duration, 120);
      assert.equal(engaged.anchor_mac, ANCHOR_2);

      // Every anchor receives the command; it names the one that must carry it out
      for (const client of [mqtt, second]) {
        const commands = client.messages.filter(m => m.topic === 'shiro/control/mode').map(m => JSON.parse(m.payload));
        assert.equal(commands.length, 1, JSON.stringify(client.messages));
        assert.deepEqual(commands[0], { cmd: 'SET_ACTIVE', target_tag: tag, target_mac: tag, target_anchor: ANCHOR_2, duration: 120 });
      }
    } finally {
      second.close();
    }
  });

  test('a 1 Hz activation for a wristband no anchor hears is refused, nothing is sent', async () => {
    const before = mqtt.messages.length;
    const answers = await sendCommand({ action: 'SET_ACTIVE_MODE', data: { tagId: 'B0:00:00:00:00:29', targetMac: 'B0:00:00:00:00:29' } });
    const error = answers.find(m => m.type === 'ERROR');
    assert.ok(error, JSON.stringify(answers));
    assert.equal(error.action, 'SET_ACTIVE_MODE');
    assert.match(error.error, /No anchor has heard wristband/);
    assert.equal(answers.filter(m => m.type === 'ACTIVE_MODE_ENGAGED').length, 0);
    assert.equal(mqtt.messages.length, before, 'no command reached the anchors');
  });

  test('a headset without an ID is not registered under an assumed one', async () => {
    await sendCommand({ action: 'DEVICE_HEARTBEAT', device_type: 'HEADSET', battery_level: 90 });
    const [rows] = await pool.query("SELECT device_id FROM devices WHERE device_id = 'QUEST3-001'");
    assert.equal(rows.length, 0);
    assert.equal(ofType('DISCOVERY_RADAR').filter(m => m.device && m.device.suggested_id === 'QUEST3-001').length, 0);
  });

  test('a WebSocket message over the size limit closes that connection only', async () => {
    const big = new WebSocket(`ws://127.0.0.1:${HTTP_PORT}`, { headers: { Cookie: cookie } });
    await new Promise((resolve, reject) => { big.once('open', resolve); big.once('error', reject); });
    const closed = new Promise((resolve) => big.once('close', (code) => resolve(code)));
    big.on('error', () => {});
    big.send(JSON.stringify({ action: 'SET_ACTIVE_MODE', tag_id: 'TAG-001', padding: 'x'.repeat(64 * 1024) }));
    assert.equal(await closed, 1009);
    assert.equal(ws.readyState, WebSocket.OPEN, 'other connections stay open');
  });

  test('a page of another website cannot open a WebSocket', async () => {
    const foreign = new WebSocket(`ws://127.0.0.1:${HTTP_PORT}`, { origin: 'http://evil.example' });
    const outcome = await new Promise((resolve) => {
      foreign.once('open', () => { foreign.close(); resolve('open'); });
      foreign.once('unexpected-response', (req, res) => resolve(res.statusCode));
      foreign.once('error', () => resolve('error'));
    });
    assert.equal(outcome, 403);

    const own = new WebSocket(`ws://127.0.0.1:${HTTP_PORT}`, { origin: `http://127.0.0.1:${HTTP_PORT}`, headers: { Cookie: cookie } });
    const opened = await new Promise((resolve) => {
      own.once('open', () => { own.close(); resolve(true); });
      own.once('error', () => resolve(false));
    });
    assert.equal(opened, true, 'the dashboard itself still connects');
  });

  // ----- MQTT -----
  test('MQTT messages with invalid addresses or content reach no screen', async () => {
    const from = received.length;
    const hostile = '<img src=x onerror=alert(1)>';

    mqtt.publish({ anchor_mac: hostile, tag_mac: 'B0:00:00:00:00:22', rssi: -50, v: 2, bpm: 70 });
    mqtt.publish({ anchor: hostile, tag: hostile, rssi: -50, bpm: 70, battery: 50 });
    mqtt.publish({ anchor_mac: ANCHOR, tag_mac: 'B0:00:00:00:00:22', rssi: 500, v: 2, bpm: 70 });
    mqtt.publish({ bpm: 70, battery: 50, g: 1.0, note: hostile });
    mqtt.publish(`plain text ${hostile}`);
    mqtt.publish('[1,2,3]');
    mqtt.publish({ anchor_mac: ANCHOR, tag_mac: 'B0:00:00:00:00:22', rssi: -50, v: 2, bpm: 70, padding: 'x'.repeat(4000) });
    mqtt.publish({ mac: hostile, device_type: 'WRISTBAND' }, 'shiro/discovery');
    await sleep(600);

    const arrived = received.slice(from);
    assert.equal(arrived.filter(m => ['TELEMETRY', 'RAW', 'ANCHOR_RSSI', 'DISCOVERY_RADAR', 'IPS_POSITION_UPDATE'].includes(m.type)).length, 0, JSON.stringify(arrived));
    assert.doesNotMatch(JSON.stringify(arrived), /onerror/);
    assert.match(server.output, /\[MQTT\] Message from "SHIRO_Anchor_A00000000011".*ignored/);
  });

  test('a wristband address that is not a MAC address is dropped, the anchor signal is kept', async () => {
    const from = received.length;
    mqtt.publish({ anchor_mac: ANCHOR, tag_mac: '<script>alert(1)</script>', rssi: -55, v: 2, bpm: 70, spo2: 98, battery: 50 });
    await sleep(400);

    const arrived = received.slice(from);
    assert.equal(arrived.filter(m => m.type === 'TELEMETRY').length, 0);
    assert.equal(arrived.filter(m => m.type === 'ANCHOR_RSSI' && m.anchor_mac === ANCHOR).length, 1);
    assert.doesNotMatch(JSON.stringify(arrived), /script/);
  });

  test('refused messages are logged once per reason, not once per message', async () => {
    const countBefore = (server.output.match(/not valid JSON/g) || []).length;
    for (let i = 0; i < 30; i++) mqtt.publish(`garbage ${i}`);
    await sleep(400);
    const countAfter = (server.output.match(/not valid JSON/g) || []).length;
    assert.ok(countAfter - countBefore <= 1, `${countAfter - countBefore} warnings for 30 messages`);
  });

  test('a valid anchor message still reaches the dashboard, and the server is still running', async () => {
    const from = received.length;
    const tag = 'B0:00:00:00:00:23';
    mqtt.publish({
      anchor_mac: ANCHOR, tag_mac: tag, rssi: -58, v: 2, bpm: 72, spo2: 98, battery: 87, charging: false,
      motion: 'STATIONARY', g: 1.01, touch: 1, active: false, fall: false, fall_seq: 1,
      impact_g: 0, freefall_g: 0, still_g: 0, imu_fault: false, ppg_fault: false, ts: 1
    });
    await sleep(400);

    const telemetry = received.slice(from).find(m => m.type === 'TELEMETRY' && m.data.tag_mac === tag);
    assert.ok(telemetry);
    assert.equal(telemetry.data.bpm, 72);
    assert.equal(telemetry.data.tag_id, tag, 'a wristband that is not enrolled is known by its MAC address');
    assert.equal(server.child.exitCode, null);
    assert.doesNotMatch(server.output, /UnhandledPromiseRejection|TypeError|ReferenceError/);
  });
});
