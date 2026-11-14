// Integration test: the whole path from an anchor's MQTT message to the dashboard.
// Starts the real server on spare ports against shiro_test, publishes the JSON the
// anchor firmware sends, and checks the WebSocket broadcasts and the audit log.
// Time-series logging is off for this file, so nothing is written to InfluxDB.
process.env.INFLUX_TOKEN = '';

const { db, freshDatabase, startServer, connectMqtt } = require('./helper');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** The message the anchor firmware builds for a decoded protocol 2 packet. */
function anchorMessage(anchorMac, tagMac, extra = {}) {
  return {
    anchor_mac: anchorMac, tag_mac: tagMac, rssi: -58, v: 2,
    bpm: 72, spo2: 98, battery: 87, charging: false, motion: 'STATIONARY', g: 1.01,
    touch: 1, active: false, fall: false, fall_seq: 40,
    impact_g: 0, freefall_g: 0, still_g: 0, imu_fault: false, ppg_fault: false, ts: 123456,
    ...extra
  };
}

describe('telemetry pipeline (MQTT -> server -> WebSocket and audit log)', () => {
  const HTTP_PORT = 3996;
  const MQTT_PORT = 1886;
  const ANCHORS = ['A0:00:00:00:00:01', 'A0:00:00:00:00:02', 'A0:00:00:00:00:03'];
  let server;
  let ws;
  let mqtt;
  let pool;
  const received = [];

  const telemetryFor = (tagMac) => received.filter(m => m.type === 'TELEMETRY' && m.data && m.data.tag_mac === tagMac);
  const alertsFor = (tagMac) => received.filter(m => m.type === 'EMERGENCY_ALERT' && m.incident.wristband_mac === tagMac);

  before(async () => {
    pool = await freshDatabase();
    server = startServer({ HTTP_PORT: String(HTTP_PORT), MQTT_PORT: String(MQTT_PORT) });
    await server.ready;

    ws = new WebSocket(`ws://127.0.0.1:${HTTP_PORT}`);
    ws.on('message', (data) => { received.push(JSON.parse(data.toString())); });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });

    mqtt = await connectMqtt(MQTT_PORT, 'SHIRO_Anchor_A00000000001');
  });

  after(async () => {
    if (mqtt) mqtt.close();
    if (ws) ws.close();
    if (server) await server.stop();
    await db.closePool();
  });

  test('a protocol 2 packet reaches the dashboard with its real values', async () => {
    const tag = 'B0:00:00:00:00:01';
    mqtt.publish(anchorMessage(ANCHORS[0], tag));
    await sleep(400);

    const [msg] = telemetryFor(tag);
    assert.ok(msg, 'a TELEMETRY broadcast is expected');
    assert.equal(msg.data.bpm, 72);
    assert.equal(msg.data.spo2, 98);
    assert.equal(msg.data.g, 1.01);
    assert.equal(msg.data.battery, 87);
    assert.equal(msg.data.protocol_version, 2);
    assert.equal(msg.data.imu_fault, false);
    assert.equal(msg.data.fall, false);
  });

  test('an accelerometer fault is passed on and no acceleration value is made up', async () => {
    const tag = 'B0:00:00:00:00:02';
    mqtt.publish(anchorMessage(ANCHORS[0], tag, { imu_fault: true, g: 0 }));
    await sleep(400);

    const [msg] = telemetryFor(tag);
    assert.ok(msg);
    assert.equal(msg.data.imu_fault, true);
    assert.equal('g' in msg.data, false, 'g must be absent, not 1.0');
    assert.equal('motion' in msg.data, false);
  });

  test('one fall forwarded by three anchors raises one alert and one audit record', async () => {
    const tag = 'B0:00:00:00:00:03';
    const fall = { fall: true, motion: 'FALL_EMERGENCY', active: true, fall_seq: 41, impact_g: 4.37, freefall_g: 0.12, still_g: 0.06, bpm: 0, spo2: 0, touch: 0 };
    // Ten rounds of all three anchors, as fast as the socket takes them
    for (let round = 0; round < 10; round++) {
      for (const anchor of ANCHORS) mqtt.publish(anchorMessage(anchor, tag, fall));
    }
    await sleep(800);

    assert.equal(alertsFor(tag).length, 1, 'exactly one EMERGENCY_ALERT broadcast');
    const [rows] = await pool.query('SELECT * FROM emergency_incident_logs WHERE wristband_mac = ?', [tag]);
    assert.equal(rows.length, 1);
    assert.ok(Math.abs(rows[0].kinematic_impact_force - 4.37) < 0.001);
    assert.ok(Math.abs(rows[0].post_impact_stillness - 0.06) < 0.001);
    assert.ok(Math.abs(rows[0].freefall_min_g - 0.12) < 0.001);
    // The pop-up reads these three values from the live alert
    const [alert] = alertsFor(tag);
    assert.equal(alert.incident.freefall_min_g, 0.12);
    assert.equal(alert.incident.kinematic_impact_force, 4.37);
    assert.equal(alert.incident.post_impact_stillness, 0.06);
    assert.equal(rows[0].heart_rate, null, 'no pulse reading was available: stored as NULL');
    assert.equal(rows[0].ward_id, null);
    assert.equal(rows[0].is_simulated, 0);
  });

  test('a wristband with an unreadable packet version is tracked but gives no telemetry', async () => {
    const tag = 'B0:00:00:00:00:04';
    mqtt.publish({ anchor_mac: ANCHORS[0], tag_mac: tag, rssi: -66, v: 0, ts: 1 });
    await sleep(400);

    assert.equal(telemetryFor(tag).length, 0);
    assert.match(server.output, /\[PROTOCOL\] Wristband B0:00:00:00:00:04/);
  });

  test('firmware from before protocol 2 is still understood', async () => {
    const tag = 'B0:00:00:00:00:05';
    mqtt.publish({
      anchor_mac: ANCHORS[0], tag_mac: tag, rssi: -60, bpm: 81, spo2: 97, battery: 60,
      charging: false, motion: 'WALKING', g: 1.12, touch: 1, active: false, ts: 5
    });
    await sleep(400);

    const [msg] = telemetryFor(tag);
    assert.ok(msg);
    assert.equal(msg.data.bpm, 81);
    assert.equal(msg.data.motion, 'WALKING');
    assert.equal(msg.data.protocol_version, 1);
  });

  test('a damaged message does not stop the server', async () => {
    mqtt.publish('{"anchor_mac":"A0:00:00:00:00:01","tag_mac":"B0:00:00:00');
    mqtt.publish(JSON.stringify({ anchor_mac: ANCHORS[0], tag_mac: 'B0:00:00:00:00:06', rssi: -60, v: 2, bpm: 'x', spo2: [], g: {}, motion: 7, fall: 'maybe' }));
    await sleep(400);

    const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/alerts/active`);
    assert.equal(res.status, 200);
    assert.equal(server.child.exitCode, null, 'the server must still be running');
    assert.doesNotMatch(server.output, /ALERT PIPELINE ERROR|UnhandledPromiseRejection/);
  });

  test('the Live Lab test bench creates incidents that are marked as simulated', async () => {
    const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/alerts/trigger-simulation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: 'FALL_ACCIDENT', patient_id: 'P-001', wristband_mac: 'B0:00:00:00:00:07' })
    });
    const body = await res.json();
    assert.equal(res.status, 201);
    assert.equal(body.incident.is_simulated, true);

    const [rows] = await pool.query('SELECT is_simulated, alert_message FROM emergency_incident_logs WHERE incident_id = ?', [body.incident.incident_id]);
    assert.equal(rows[0].is_simulated, 1);
    assert.match(rows[0].alert_message, /^\[SIMULATION\]/);
  });
});

describe('simulation switch', () => {
  test('with ENABLE_SIMULATION=false the test bench endpoint refuses to create incidents', async () => {
    const pool = await freshDatabase();
    const server = startServer({ HTTP_PORT: '3995', MQTT_PORT: '1885', ENABLE_SIMULATION: 'false' });
    try {
      await server.ready;
      const res = await fetch('http://127.0.0.1:3995/api/alerts/trigger-simulation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: 'FALL_ACCIDENT' })
      });
      assert.equal(res.status, 403);
      const [[row]] = await pool.query('SELECT COUNT(*) AS n FROM emergency_incident_logs');
      assert.equal(Number(row.n), 0);
    } finally {
      await server.stop();
      await db.closePool();
    }
  });
});
