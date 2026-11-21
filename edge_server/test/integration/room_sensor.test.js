// Integration test: a LiDAR room sensor node (Phase 10) logs in to the broker
// with the anchors' login, sends its status and scans, appears on the API and
// the dashboard, can be enrolled as a ROOM_SENSOR, and may use its own topics
// only. Starts the real server on spare ports against shiro_test.
process.env.INFLUX_TOKEN = '';

const { db, freshDatabase, startServer, connectMqtt, anchorClientId, signIn } = require('./helper');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { encodeScanFrame, BINS } = require('../../services/room_sensor/scan_frame');

const HTTP_PORT = 3986;
const MQTT_PORT = 1876;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const LIDAR = '10:00:00:00:00:41';
const ANCHOR = 'A0:00:00:00:00:41';
const SCAN_TOPIC = 'shiro/ward-A1/lidar/scan';
const STATUS_TOPIC = 'shiro/ward-A1/lidar/status';

const lidarClientId = (mac) => `SHIRO_Lidar_${mac.replace(/:/g, '')}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function statusOf(mac, overrides = {}) {
  return {
    lidar_mac: mac, state: 'SCANNING', node_fw: '1.0.0', model: 65, lidar_fw: '1.01', lidar_hw: 18, serial: '00112233445566778899AABBCCDDEEFF',
    health: 'OK', health_code: 0, turns_per_s: 10, points_per_turn: 500, valid_per_turn: 480, turn_ms: 100,
    sent: 5, send_failed: 0, overwritten: 0, bad_bytes: 0, restarts: 0, wifi_rssi: -50, uptime_s: 12, ...overrides
  };
}

function room(distanceMm = 2500) {
  return new Array(BINS).fill(distanceMm);
}

describe('LiDAR room sensor node', () => {
  let server;
  let ws;
  let cookie;
  const received = [];

  const getJson = async (path) => (await fetch(`${BASE}${path}`, { headers: { Cookie: cookie } })).json();

  before(async () => {
    await freshDatabase();
    await db.closePool();
    server = startServer({ HTTP_PORT: String(HTTP_PORT), MQTT_PORT: String(MQTT_PORT) });
    await server.ready;
    cookie = await signIn(BASE);
    ws = new WebSocket(`ws://127.0.0.1:${HTTP_PORT}`, { headers: { Cookie: cookie } });
    ws.on('message', (data) => { received.push(JSON.parse(data.toString())); });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  });

  after(async () => {
    if (ws) ws.close();
    if (server) await server.stop();
  });

  test('the node logs in, and its status and turns arrive at about the rate they are sent', async () => {
    const node = await connectMqtt(MQTT_PORT, lidarClientId(LIDAR));
    try {
      node.publish(statusOf(LIDAR), STATUS_TOPIC);
      for (let sequence = 0; sequence < 12; sequence++) {
        node.publish(encodeScanFrame({ sequence, turnMs: 100, samples: 500 }, room()), SCAN_TOPIC);
        await sleep(100);
      }
      await sleep(200);
      const body = await getJson('/api/room-sensors/status');
      assert.equal(body.success, true);
      const s = body.sensors.find(x => x.mac === LIDAR);
      assert.ok(s, 'the node is listed');
      assert.equal(s.online, true);
      assert.equal(s.scanning, true);
      assert.equal(s.frames, 12);
      assert.equal(s.lost_turns, 0);
      assert.ok(s.turns_per_s > 7 && s.turns_per_s < 12, `turns_per_s ${s.turns_per_s}`);
      assert.equal(s.node.health, 'OK');
      assert.equal(s.last_frame.valid, BINS);
      assert.equal(s.device_id, null, 'not enrolled yet');

      assert.ok(received.some(m => m.type === 'ROOM_SENSOR_STATUS' && m.sensor.mac === LIDAR), 'the dashboard is told');
      const radar = received.find(m => m.type === 'DISCOVERY_RADAR' && m.device.mac === LIDAR);
      assert.ok(radar, 'the node appears on the discovery radar');
      assert.equal(radar.device.device_type, 'ROOM_SENSOR');
      assert.equal(radar.device.suggested_id, 'lidar-001');
      assert.equal(radar.device.hardware_model, 'ESP32-S3 + RPLIDAR C1');
    } finally {
      node.close();
    }
  });

  test('the node is enrolled as a ROOM_SENSOR and is then reported by its device ID', async () => {
    const res = await fetch(`${BASE}/api/devices/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ device_id: 'lidar-001', mac_address: LIDAR, device_type: 'ROOM_SENSOR', hardware_model: 'ESP32-S3 + RPLIDAR C1' })
    });
    assert.equal(res.status, 201, await res.clone().text());
    const list = await getJson('/api/devices/list?type=ROOM_SENSOR');
    assert.deepEqual(list.devices.map(d => d.device_id), ['lidar-001']);

    const node = await connectMqtt(MQTT_PORT, lidarClientId(LIDAR));
    try {
      node.publish(statusOf(LIDAR), STATUS_TOPIC);
      node.publish(encodeScanFrame({ sequence: 100 }, room()), SCAN_TOPIC);
      await sleep(400);
      const s = (await getJson('/api/room-sensors/status')).sensors.find(x => x.mac === LIDAR);
      assert.equal(s.device_id, 'lidar-001');
      const next = await getJson('/api/devices/next-id?type=ROOM_SENSOR');
      assert.equal(next.nextId, 'lidar-002');
    } finally {
      node.close();
    }
  });

  test('a status about another MAC address and a damaged scan are refused with a warning', async () => {
    const node = await connectMqtt(MQTT_PORT, lidarClientId(LIDAR));
    try {
      node.publish(statusOf('10:00:00:00:00:99'), STATUS_TOPIC);
      node.publish(Buffer.from('SL-not-a-full-turn'), SCAN_TOPIC);
      await sleep(400);
      assert.match(server.output, /lidar_mac is not the MAC address of this node's client ID/);
      assert.match(server.output, /scan message of 18 bytes, expected 1452/);
    } finally {
      node.close();
    }
  });

  test('a LiDAR node may not send anchor telemetry: the connection is closed', async () => {
    const node = await connectMqtt(MQTT_PORT, lidarClientId(LIDAR));
    const from = received.length;
    node.publish({ anchor_mac: LIDAR, tag_mac: 'B0:00:00:00:00:41', rssi: -60, v: 2, bpm: 70, ts: 1 });
    const closedInTime = await Promise.race([node.closed.then(() => true), sleep(2000).then(() => false)]);
    assert.equal(closedInTime, true);
    assert.equal(received.slice(from).filter(m => m.type === 'TELEMETRY').length, 0);
    assert.match(server.output, /SHIRO_Lidar_100000000041 may not publish to "shiro\/ward-A1\/anchor\/telemetry"/);
  });

  test('an anchor may not send LiDAR scans: the connection is closed', async () => {
    const anchor = await connectMqtt(MQTT_PORT, anchorClientId(ANCHOR));
    anchor.publish(encodeScanFrame({ sequence: 1 }, room()), SCAN_TOPIC);
    const closedInTime = await Promise.race([anchor.closed.then(() => true), sleep(2000).then(() => false)]);
    assert.equal(closedInTime, true);
    assert.match(server.output, /SHIRO_Anchor_A00000000041 may not publish to "shiro\/ward-A1\/lidar\/scan"/);
  });

  test('the live status needs a signed-in clinician', async () => {
    const res = await fetch(`${BASE}/api/room-sensors/status`);
    assert.equal(res.status, 401);
  });
});
