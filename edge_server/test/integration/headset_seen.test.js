// Integration test: a patient seen by a headset (PATIENT_SEEN). Starts the real server
// on spare ports against shiro_test. Three anchors of WARD-001 hear a wristband, so it
// has a Bluetooth position; a paired headset then reports where its depth sensor sees
// the patient, and the dashboard's position messages are checked: the headset's
// position with the Bluetooth one alongside, and back to Bluetooth when it ends.
process.env.INFLUX_TOKEN = '';

const { db, freshDatabase, startServer, connectMqtt, anchorClientId, signIn, pairHeadset } = require('./helper');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const HTTP_PORT = 3997;
const MQTT_PORT = 1887;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const WARD = 'WARD-001';                                                  // 6.40 m x 4.80 m
const ANCHORS = ['C4:DE:E2:10:01:AB', 'C4:DE:E2:10:01:AC', 'C4:DE:E2:10:01:AD']; // its three anchors (seed)
const TAG = 'B0:00:00:00:00:51';                                          // a wristband, not enrolled
const HEADSET_ID = 'QUEST3-SEEN01';

function openSocket(headers) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${HTTP_PORT}`, { headers });
    const messages = [];
    socket.on('message', (d) => messages.push(JSON.parse(d.toString())));
    socket.once('open', () => resolve({ socket, messages }));
    socket.once('error', reject);
  });
}

function anchorMessage(anchorMac, rssi) {
  return {
    anchor_mac: anchorMac, tag_mac: TAG, rssi, v: 2,
    bpm: 72, spo2: 98, battery: 87, charging: false, motion: 'STATIONARY', g: 1.0,
    touch: 1, active: false, fall: false, fall_seq: 1,
    impact_g: 0, freefall_g: 0, still_g: 0, imu_fault: false, ppg_fault: false, ts: 1
  };
}

describe('a patient seen by a headset (PATIENT_SEEN)', () => {
  let server;
  let anchors;
  let dashboard;
  let headset;

  const positions = () => dashboard.messages.filter(m => m.type === 'IPS_POSITION_UPDATE' && m.tag_id === TAG);
  const last = () => positions().at(-1);

  before(async () => {
    const pool = await freshDatabase();
    // Only anchors bound to an enrolled device take part in positioning
    for (let k = 0; k < ANCHORS.length; k++) {
      await pool.query("INSERT INTO devices (device_id, mac_address, device_type, hardware_model) VALUES (?, ?, 'ANCHOR', 'TEST')", [`ANC-SEEN${k}`, ANCHORS[k]]);
      await pool.query('UPDATE ward_anchors SET device_id = ? WHERE mac_address = ?', [`ANC-SEEN${k}`, ANCHORS[k]]);
    }
    server = startServer({ HTTP_PORT: String(HTTP_PORT), MQTT_PORT: String(MQTT_PORT) });
    await server.ready;
    const admin = await signIn(BASE);
    dashboard = await openSocket({ Cookie: admin });
    anchors = await Promise.all(ANCHORS.map(mac => connectMqtt(MQTT_PORT, anchorClientId(mac))));

    // The anchors hear the wristband for a while: it gets a Bluetooth position in WARD-001
    for (let i = 0; i < 8; i++) {
      anchors.forEach((a, k) => a.publish(anchorMessage(ANCHORS[k], [-60, -70, -66][k])));
      await sleep(150);
    }
    await sleep(300);

    const token = await pairHeadset(BASE, admin, HEADSET_ID, '02:5E:E2:00:00:01');
    headset = await openSocket({ Authorization: `Bearer ${token}` });
  });

  after(async () => {
    if (anchors) anchors.forEach(c => c.close());
    if (dashboard) dashboard.socket.close();
    if (headset && headset.socket.readyState === WebSocket.OPEN) headset.socket.close();
    if (server) await server.stop();
    await db.closePool();
  });

  test('before: the Bluetooth position, marked as such', () => {
    const p = last();
    assert.ok(p, 'a position of the wristband is expected');
    assert.equal(p.ward_id, WARD);
    assert.equal(p.source, 'BLE');
    assert.equal(p.has_ble, true);
    assert.equal(p.x, p.ble_x);
  });

  test('while the headset sees the patient, the maps get its position, with Bluetooth alongside', async () => {
    headset.socket.send(JSON.stringify({ action: 'PATIENT_SEEN', tag_id: TAG, ward_id: WARD, seen: true, x: 2.0, y: 1.5, height_m: 1.62, manual: false }));
    await sleep(400);
    const p = last();
    assert.equal(p.source, 'HEADSET');
    assert.equal(p.x, 2.0);
    assert.equal(p.y, 1.5);
    assert.equal(p.ward_id, WARD);
    assert.equal(p.seen_by, HEADSET_ID);
    // The Bluetooth position is still the wristband's own (the newest one, not the headset's)
    assert.equal(p.has_ble, true);
    assert.ok(p.ble_x >= 0 && p.ble_x <= 6.4 && p.ble_y >= 0 && p.ble_y <= 4.8, `Bluetooth position in the ward (${p.ble_x}, ${p.ble_y})`);
    assert.notDeepEqual([p.ble_x, p.ble_y], [2.0, 1.5]);
  });

  test('Bluetooth updates meanwhile keep the headset position on the map', async () => {
    headset.socket.send(JSON.stringify({ action: 'PATIENT_SEEN', tag_id: TAG, ward_id: WARD, x: 2.1, y: 1.5 }));
    const before = positions().length;
    anchors.forEach((a, k) => a.publish(anchorMessage(ANCHORS[k], [-60, -70, -66][k])));
    await sleep(400);
    const fromBle = positions().slice(before).filter(m => Array.isArray(m.anchors_used) && m.anchors_used.length > 0);
    assert.ok(fromBle.length > 0, 'a Bluetooth update is expected');
    for (const m of fromBle) {
      assert.equal(m.source, 'HEADSET');
      assert.equal(m.x, 2.1);
    }
  });

  test('a position outside the ward is not used: back to Bluetooth', async () => {
    headset.socket.send(JSON.stringify({ action: 'PATIENT_SEEN', tag_id: TAG, ward_id: WARD, x: 9.5, y: 1.5 }));
    await sleep(300);
    assert.equal(last().source, 'BLE');
  });

  test('"no longer seen" goes back to Bluetooth at once', async () => {
    headset.socket.send(JSON.stringify({ action: 'PATIENT_SEEN', tag_id: TAG, ward_id: WARD, x: 2.0, y: 1.5 }));
    await sleep(300);
    assert.equal(last().source, 'HEADSET');
    headset.socket.send(JSON.stringify({ action: 'PATIENT_SEEN', tag_id: TAG, ward_id: WARD, seen: false }));
    await sleep(300);
    assert.equal(last().source, 'BLE');
    assert.equal(last().x, last().ble_x);
  });

  test('a headset that stops sending: back to Bluetooth after a few seconds', async () => {
    headset.socket.send(JSON.stringify({ action: 'PATIENT_SEEN', tag_id: TAG, ward_id: WARD, x: 2.0, y: 1.5 }));
    await sleep(300);
    assert.equal(last().source, 'HEADSET');
    await sleep(4000); // fresh for 1.5 s, checked every 2 s
    assert.equal(last().source, 'BLE');
  });

  test('a wristband that is not tracked is refused, and a dashboard cannot send this', async () => {
    headset.socket.send(JSON.stringify({ action: 'PATIENT_SEEN', tag_id: 'B0:00:00:00:00:99', ward_id: WARD, x: 2.0, y: 1.5 }));
    await sleep(300);
    assert.ok(headset.messages.some(m => m.type === 'ERROR' && m.action === 'PATIENT_SEEN' && /not being tracked/.test(m.error)));

    dashboard.socket.send(JSON.stringify({ action: 'PATIENT_SEEN', tag_id: TAG, ward_id: WARD, x: 2.0, y: 1.5 }));
    await sleep(300);
    assert.ok(dashboard.messages.some(m => m.type === 'ERROR' && m.action === 'PATIENT_SEEN'), 'refused for a signed-in account');
    assert.equal(last().source, 'BLE', 'and the map is unchanged');
  });

  test('when the headset disconnects, the patients it saw go back to Bluetooth at once', async () => {
    headset.socket.send(JSON.stringify({ action: 'PATIENT_SEEN', tag_id: TAG, ward_id: WARD, x: 2.0, y: 1.5 }));
    await sleep(300);
    assert.equal(last().source, 'HEADSET');
    headset.socket.close();
    await sleep(400);
    assert.equal(last().source, 'BLE');
  });
});
