// Integration test (Phase 10, step 5a): a LiDAR placed in a ward sends turns
// over MQTT; the ward editor sees its live scan, an admin learns the empty
// room (stored, and still there after a restart), and Align to walls finds
// where the LiDAR really is from that empty room. Simulated turns of the
// ward's own layout. Starts the real server on spare ports against shiro_test.
process.env.INFLUX_TOKEN = '';

const { db, freshDatabase, startServer, connectMqtt, signIn, TEST_NURSE } = require('./helper');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { encodeScanFrame } = require('../../services/room_sensor/scan_frame');
const { simulateTurn, rng } = require('../unit/lidar_scene');

const HTTP_PORT = 3983;
const MQTT_PORT = 1873;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const WARD = 'WARD-001';
const LIDAR_MAC = '10:00:00:00:00:61';
const SCAN_TOPIC = 'shiro/ward-A1/lidar/scan';
const PLACED = { sensor_id: 'LiDAR 1', device_id: 'lidar-001', x: 0.30, y: 2.00, base_height: 0.92, heading_deg: 90, wall_location: 'west wall' };
const REAL = { x: 0.32, y: 1.98, heading_deg: 91.5, base_height: 0.92 };   // where it "really" stands

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

describe('LiDAR tools in the ward editor', () => {
  let server;
  let admin;
  let nurse;
  let layout;

  const call = async (path, { method = 'GET', body, cookie = admin } = {}) => fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const scanView = async () => (await call(`/api/room-sensors/scan?ward_id=${WARD}&device_id=lidar-001`)).json();

  /** Sends simulated turns of the ward at 10 a second for ms milliseconds, with people [{x, y, r}] in it. */
  async function sendTurns(ms, people = []) {
    const node = await connectMqtt(MQTT_PORT, `SHIRO_Lidar_${LIDAR_MAC.replace(/:/g, '')}`);
    const random = rng(17);
    try {
      for (let t = 0, sequence = 0; t < ms; t += 100, sequence++) {
        node.publish(encodeScanFrame({ sequence, turnMs: 100, samples: 500 }, simulateTurn(layout, REAL, { random, people })), SCAN_TOPIC);
        await sleep(100);
      }
    } finally {
      node.close();
    }
  }

  async function start() {
    server = startServer({ HTTP_PORT: String(HTTP_PORT), MQTT_PORT: String(MQTT_PORT) });
    await server.ready;
    admin = await signIn(BASE);
    nurse = await signIn(BASE, TEST_NURSE);
  }

  before(async () => {
    await freshDatabase();
    await db.closePool();
    await start();
    const enrolled = await call('/api/devices/enroll', {
      method: 'POST',
      body: { device_id: 'lidar-001', mac_address: LIDAR_MAC, device_type: 'ROOM_SENSOR', hardware_model: 'ESP32-S3 + RPLIDAR C1' }
    });
    assert.equal(enrolled.status, 201, await enrolled.clone().text());
    const ward = (await (await call(`/api/ward/config?ward_id=${WARD}`)).json()).ward;
    ward.room_sensors = [PLACED];
    const saved = await call('/api/ward/config', { method: 'POST', body: ward });
    assert.equal(saved.status, 200, await saved.clone().text());
    layout = (await (await call(`/api/ward/config?ward_id=${WARD}`)).json()).ward;
  });

  after(async () => {
    if (server) await server.stop();
  });

  test('the live scan reaches the ward editor; without an empty room nothing is marked new', async () => {
    await sendTurns(1500);
    const view = await scanView();
    assert.equal(view.success, true);
    assert.equal(view.placed_in_ward, true);
    assert.equal(view.scan.distances_mm.length, 720);
    assert.ok(view.scan.distances_mm.filter(d => d > 0).length > 400);
    assert.equal(view.scan.foreground_bins, null);
    assert.equal(view.background, null);
    assert.equal(view.learning, null);
  });

  test('learning the empty room: admin only, only where the node is placed', async () => {
    const asNurse = await call('/api/room-sensors/learn', { method: 'POST', cookie: nurse, body: { ward_id: WARD, device_id: 'lidar-001' } });
    assert.equal(asNurse.status, 403);
    const elsewhere = await call('/api/room-sensors/learn', { method: 'POST', body: { ward_id: 'WARD-002', device_id: 'lidar-001' } });
    assert.equal(elsewhere.status, 409);
    assert.match((await elsewhere.json()).error, /not in the saved setup of WARD-002/);
    const badId = await call('/api/room-sensors/learn', { method: 'POST', body: { ward_id: WARD, device_id: '<x>' } });
    assert.equal(badId.status, 400);
  });

  test('the empty room is learned from the turns, stored, and marks a scan without people as the empty room', async () => {
    const sending = sendTurns(7000);
    await sleep(800);
    const started = await call('/api/room-sensors/learn', { method: 'POST', body: { ward_id: WARD, device_id: 'lidar-001', countdown_s: 0, duration_s: 5 } });
    assert.equal(started.status, 200, await started.clone().text());
    const again = await call('/api/room-sensors/learn', { method: 'POST', body: { ward_id: WARD, device_id: 'lidar-001', countdown_s: 0, duration_s: 5 } });
    assert.equal(again.status, 409, 'one learning at a time');
    await sending;

    const view = await scanView();
    assert.equal(view.learning.state, 'DONE', view.learning.error);
    assert.ok(view.background.turns >= 40 && view.background.turns <= 52, `turns ${view.background.turns}`);
    assert.ok(view.background.coverage_pct > 90, `coverage ${view.background.coverage_pct}`);
    assert.match(view.background.learned_by, /Integration Admin/);
    assert.ok(view.scan.foreground_bins.length <= 3, `${view.scan.foreground_bins.length} directions new in an empty room`);
    assert.equal(view.moved.suspected, false);

    const [rows] = await db.getPool().query("SELECT ward_id, device_id, turns, model FROM room_sensor_backgrounds WHERE device_id = 'lidar-001'");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ward_id, WARD);
    assert.equal(JSON.parse(rows[0].model).median_mm.length, 720);
  });

  test('Align to walls (any clinician) finds where the LiDAR really is from the empty room', async () => {
    const res = await call('/api/room-sensors/align', {
      method: 'POST', cookie: nurse,
      body: { layout, sensor: { device_id: 'lidar-001', x: PLACED.x, y: PLACED.y, heading_deg: PLACED.heading_deg, base_height: 0.92 } }
    });
    assert.equal(res.status, 200, await res.clone().text());
    const a = (await res.json()).alignment;
    assert.equal(a.scan_source, 'EMPTY_ROOM');
    assert.ok(Math.abs(a.pose.x - REAL.x) <= 0.015 && Math.abs(a.pose.y - REAL.y) <= 0.015, JSON.stringify(a.pose));
    assert.ok(Math.abs(a.pose.heading_deg - REAL.heading_deg) <= 0.4, `heading ${a.pose.heading_deg}`);
    assert.equal(a.quality, 'GOOD', JSON.stringify(a.warnings));
    assert.ok(a.after.on_surface_pct > a.before.on_surface_pct);

    const unknown = await call('/api/room-sensors/align', { method: 'POST', body: { layout, sensor: { device_id: 'lidar-404', x: 1, y: 1, heading_deg: 0 } } });
    assert.equal(unknown.status, 409);
    assert.match((await unknown.json()).error, /Nothing to align with/);
    const noLayout = await call('/api/room-sensors/align', { method: 'POST', body: { sensor: { device_id: 'lidar-001', x: 1, y: 1, heading_deg: 0 } } });
    assert.equal(noLayout.status, 400);
  });

  test('with the empty room learned, a person walking in is followed (no wristband: shown without one)', async () => {
    const empty = await (await call(`/api/room-sensors/people?ward_id=${WARD}`, { cookie: nurse })).json();
    assert.equal(empty.success, true);
    assert.deepEqual(empty.people, []);

    const spot = { x: Math.min(1.5, Number(layout.length_x) - 0.5), y: REAL.y + 0.3 };
    await sendTurns(2000, [{ ...spot, r: 0.17 }]);
    const seen = await (await call(`/api/room-sensors/people?ward_id=${WARD}`, { cookie: nurse })).json();
    assert.equal(seen.people.length, 1, JSON.stringify(seen));
    assert.ok(Math.hypot(seen.people[0].x - spot.x, seen.people[0].y - spot.y) < 0.1, JSON.stringify(seen.people[0]));
    assert.equal(seen.people[0].tag_id, null);

    const signedOut = await call(`/api/room-sensors/people?ward_id=${WARD}`, { cookie: null });
    assert.equal(signedOut.status, 401);
  });

  test('after a restart the empty room is read back from the database', async () => {
    await server.stop();
    server = null;
    await start();
    const view = await scanView();
    assert.ok(view.background && view.background.turns >= 40, JSON.stringify(view.background));
    assert.equal(view.scan, null, 'no turn since the restart');
  });
});
