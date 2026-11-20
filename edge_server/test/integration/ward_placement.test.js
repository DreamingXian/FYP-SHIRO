// Integration test (Phase 10): a ward stores its LiDAR room sensor (position,
// base height, heading, bound node), and the placement planner answers for the
// layout in the ward editor. Starts the real server on spare ports against shiro_test.
process.env.INFLUX_TOKEN = '';

const { db, freshDatabase, startServer, signIn, TEST_NURSE } = require('./helper');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const HTTP_PORT = 3984;
const MQTT_PORT = 1874;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const WARD = 'WARD-001';

describe('ward room sensors and the placement planner', () => {
  let server;
  let admin;

  const call = async (path, { method = 'GET', body, cookie = admin } = {}) => fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const wardConfig = async () => (await (await call(`/api/ward/config?ward_id=${WARD}`)).json()).ward;

  before(async () => {
    await freshDatabase();
    await db.closePool();
    server = startServer({ HTTP_PORT: String(HTTP_PORT), MQTT_PORT: String(MQTT_PORT) });
    await server.ready;
    admin = await signIn(BASE);
    const enrolled = await call('/api/devices/enroll', {
      method: 'POST',
      body: { device_id: 'lidar-001', mac_address: '10:00:00:00:00:51', device_type: 'ROOM_SENSOR', hardware_model: 'ESP32-S3 + RPLIDAR C1' }
    });
    assert.equal(enrolled.status, 201, await enrolled.clone().text());
  });

  after(async () => {
    if (server) await server.stop();
  });

  test('a ward is saved with its LiDAR, which binds the node to the ward', async () => {
    const ward = await wardConfig();
    assert.deepEqual(ward.room_sensors, [], 'a sample ward has no LiDAR yet');
    ward.room_sensors = [{ sensor_id: 'LiDAR 1', device_id: 'lidar-001', x: 0.98, y: 0.18, base_height: 0.92, heading_deg: -90, wall_location: 'S wall · 0.98 m from SW' }];
    const saved = await call('/api/ward/config', { method: 'POST', body: ward });
    assert.equal(saved.status, 200, await saved.clone().text());

    const again = await wardConfig();
    assert.deepEqual(again.room_sensors, [{ sensor_id: 'LiDAR 1', device_id: 'lidar-001', x: 0.98, y: 0.18, base_height: 0.92, heading_deg: 270, wall_location: 'S wall · 0.98 m from SW' }]);
    const [rows] = await db.getPool().query("SELECT assigned_ward_id, availability_status FROM devices WHERE device_id = 'lidar-001'");
    assert.deepEqual({ ...rows[0] }, { assigned_ward_id: WARD, availability_status: 'IN_USE' });

    const list = await (await call('/api/ward/list')).json();
    assert.equal(list.wards.find(w => w.ward_id === WARD).room_sensor_count, 1);
  });

  test('a save without room_sensors (an older JSON file) keeps the LiDAR and its binding', async () => {
    const ward = await wardConfig();
    delete ward.room_sensors;
    ward.room_title = 'Renamed without the LiDAR list';
    const saved = await call('/api/ward/config', { method: 'POST', body: ward });
    assert.equal(saved.status, 200);
    const again = await wardConfig();
    assert.equal(again.room_sensors.length, 1);
    const [rows] = await db.getPool().query("SELECT assigned_ward_id FROM devices WHERE device_id = 'lidar-001'");
    assert.equal(rows[0].assigned_ward_id, WARD);
  });

  test('an empty list removes the LiDAR and frees the node', async () => {
    const ward = await wardConfig();
    ward.room_sensors = [];
    assert.equal((await call('/api/ward/config', { method: 'POST', body: ward })).status, 200);
    assert.deepEqual((await wardConfig()).room_sensors, []);
    const [rows] = await db.getPool().query("SELECT assigned_ward_id, availability_status FROM devices WHERE device_id = 'lidar-001'");
    assert.deepEqual({ ...rows[0] }, { assigned_ward_id: null, availability_status: 'AVAILABLE' });
  });

  test('a ward with fewer than 3 anchors is not stored; the planner still plans it', async () => {
    const ward = await wardConfig();
    const saved = await call('/api/ward/config', { method: 'POST', body: { ...ward, anchors: ward.anchors.slice(0, 2) } });
    assert.equal(saved.status, 400);
    assert.match((await saved.json()).error, /at least 3 anchors/);
    assert.equal((await wardConfig()).anchors.length, ward.anchors.length, 'nothing changed');
    const planned = await call('/api/ward/placement-plan', { method: 'POST', body: { layout: { ...ward, anchors: [] } } });
    assert.equal(planned.status, 200, 'a layout still being drawn can be planned');
  });

  test('the planner answers for an unsaved layout and stores nothing', async () => {
    const stored = await wardConfig();
    const layout = { ...stored, anchors: stored.anchors.slice(0, 3) };
    const res = await call('/api/ward/placement-plan', { method: 'POST', body: { layout, options: { anchor_count: 5, keep_existing: true, include_lidar: true } } });
    assert.equal(res.status, 200, await res.clone().text());
    const { plan } = await res.json();
    assert.equal(plan.suggested.anchors.length, 5);
    assert.equal(plan.suggested.anchors.filter(a => a.action === 'KEEP').length, 3);
    assert.ok(plan.lidar.suggested.instruction.includes('▲'));
    assert.equal(plan.settings.mount_height, Math.min(2.4, Math.round((layout.height_z - 0.15) * 100) / 100));
    assert.deepEqual((await wardConfig()).anchors, stored.anchors, 'nothing stored');
  });

  test('bad requests to the planner are refused with a reason', async () => {
    const layout = await wardConfig();
    const status = async (body) => (await call('/api/ward/placement-plan', { method: 'POST', body })).status;
    assert.equal(await status({ options: {} }), 400, 'no layout');
    assert.equal(await status({ layout: { ...layout, length_x: 'wide' } }), 400);
    assert.equal(await status({ layout, options: { anchor_count: 40 } }), 400);
    assert.equal(await status({ layout, options: { keep_existing: 'yes' } }), 400);
    assert.equal(await status({ layout: { ...layout, length_x: 0.6 } }), 400, 'a room too small to plan');
  });

  test('a signed-in clinician may plan; without signing in it is refused', async () => {
    const layout = await wardConfig();
    const nurse = await signIn(BASE, TEST_NURSE);
    assert.equal((await call('/api/ward/placement-plan', { method: 'POST', body: { layout }, cookie: nurse })).status, 200);
    assert.equal((await call('/api/ward/placement-plan', { method: 'POST', body: { layout }, cookie: null })).status, 401);
  });
});
