// Integration test: spatial anchors per headset and ward (8D-2), on the running
// server against shiro_test. Two headsets calibrated in the same ward each get
// back their own anchor; staff see the ward unchanged.
process.env.INFLUX_TOKEN = '';

const { db, freshDatabase, startServer, signIn, pairHeadset } = require('./helper');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const HTTP_PORT = 3990;
const MQTT_PORT = 1880;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;

const ANCHOR_A = 'aaaaaaaa-1111-2222-3333-444444444444';
const ANCHOR_B = 'bbbbbbbb-1111-2222-3333-444444444444';
const ANCHOR_A2 = 'aaaaaaaa-5555-6666-7777-888888888888';

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

describe('spatial anchors per headset', () => {
  let server;
  let pool;
  let admin;
  let headsetA;
  let headsetB;

  before(async () => {
    pool = await freshDatabase();
    await pool.query("UPDATE ward_rooms SET spatial_anchor_uuid = 'legacy-shared-anchor' WHERE ward_id = 'WARD-001'");
    server = startServer({ HTTP_PORT: String(HTTP_PORT), MQTT_PORT: String(MQTT_PORT) });
    await server.ready;
    admin = await signIn(BASE);
    headsetA = await pairHeadset(BASE, admin, 'QUEST3-AAAA01', 'AA:AA:AA:00:00:01');
    headsetB = await pairHeadset(BASE, admin, 'QUEST3-BBBB02', 'BB:BB:BB:00:00:02');
  });

  after(async () => {
    if (server) await server.stop();
    await db.closePool();
  });

  async function wardAsSeenBy(bearer, wardId = 'WARD-001') {
    const list = await (await call('/api/ward/list', { bearer })).json();
    const config = await (await call(`/api/ward/config?ward_id=${wardId}`, { bearer })).json();
    const ips = await (await call(`/api/ward/ips-init?ward_id=${wardId}`, { bearer })).json();
    const fromList = list.wards.find(w => w.ward_id === wardId).spatial_anchor_uuid;
    assert.equal(config.ward.spatial_anchor_uuid, fromList, 'config and list agree');
    assert.equal(ips.ward.spatial_anchor_uuid, fromList, 'ips-init and list agree');
    return fromList;
  }

  test('a headset that never saved an anchor gets none (not another headset\'s, not the old shared one)', async () => {
    assert.equal(await wardAsSeenBy(headsetA), '');
  });

  test('two headsets saving for the same ward each get back their own anchor', async () => {
    let res = await call('/api/ward/save-anchor', { method: 'POST', bearer: headsetA, body: { ward_id: 'WARD-001', spatial_anchor_uuid: ANCHOR_A } });
    assert.equal(res.status, 200);
    res = await call('/api/ward/save-anchor', { method: 'POST', bearer: headsetB, body: { ward_id: 'WARD-001', spatial_anchor_uuid: ANCHOR_B } });
    assert.equal(res.status, 200);

    assert.equal(await wardAsSeenBy(headsetA), ANCHOR_A);
    assert.equal(await wardAsSeenBy(headsetB), ANCHOR_B);
    assert.equal(await wardAsSeenBy(headsetA, 'WARD-002'), '', 'only for the ward it was saved for');
  });

  test('saving again replaces only that headset\'s anchor; an empty one removes only it', async () => {
    await call('/api/ward/save-anchor', { method: 'POST', bearer: headsetA, body: { ward_id: 'WARD-001', spatial_anchor_uuid: ANCHOR_A2 } });
    assert.equal(await wardAsSeenBy(headsetA), ANCHOR_A2);
    assert.equal(await wardAsSeenBy(headsetB), ANCHOR_B);

    const res = await call('/api/ward/save-anchor', { method: 'POST', bearer: headsetA, body: { ward_id: 'WARD-001', spatial_anchor_uuid: '' } });
    assert.equal(res.status, 200);
    assert.equal(await wardAsSeenBy(headsetA), '');
    assert.equal(await wardAsSeenBy(headsetB), ANCHOR_B);
  });

  test('staff see the ward\'s own reference field, which headsets no longer change', async () => {
    const config = await (await call('/api/ward/config?ward_id=WARD-001', { cookie: admin })).json();
    assert.equal(config.ward.spatial_anchor_uuid, 'legacy-shared-anchor');
  });

  test('a headset cannot save for a ward that does not exist, and a bad reference is refused', async () => {
    assert.equal((await call('/api/ward/save-anchor', { method: 'POST', bearer: headsetA, body: { ward_id: 'WARD-999', spatial_anchor_uuid: ANCHOR_A } })).status, 404);
    assert.equal((await call('/api/ward/save-anchor', { method: 'POST', bearer: headsetA, body: { ward_id: 'WARD-001', spatial_anchor_uuid: '"><script>' } })).status, 400);
    const [rows] = await pool.query("SELECT COUNT(*) AS n FROM headset_ward_anchors WHERE device_id = 'QUEST3-AAAA01'");
    assert.equal(Number(rows[0].n), 0);
  });

  test('deleting a ward removes the headsets\' anchors for it', async () => {
    await pool.query("INSERT INTO ward_rooms (ward_id, room_title, length_x, width_y, height_z) VALUES ('WARD-077', 'Temp', 4, 4, 3)");
    await call('/api/ward/save-anchor', { method: 'POST', bearer: headsetB, body: { ward_id: 'WARD-077', spatial_anchor_uuid: ANCHOR_B } });
    await pool.query("DELETE FROM ward_rooms WHERE ward_id = 'WARD-077'");
    const [rows] = await pool.query("SELECT COUNT(*) AS n FROM headset_ward_anchors WHERE ward_id = 'WARD-077'");
    assert.equal(Number(rows[0].n), 0);
  });
});
