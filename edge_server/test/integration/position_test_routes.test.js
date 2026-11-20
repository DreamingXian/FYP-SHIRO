// Integration test: the position test API (Phase 10) on the real server against
// shiro_test. Sessions go to a temporary folder (POSITION_TEST_DIR), never to
// edge_server/data. The recorder itself is covered by test/unit/position_test.test.js.
process.env.INFLUX_TOKEN = '';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { db, freshDatabase, startServer, signIn } = require('./helper');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const HTTP_PORT = 3985;
const MQTT_PORT = 1875;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'shiro-position-test-'));

describe('position test API', () => {
  let server;
  let cookie;

  const call = async (method, route, body) => {
    const res = await fetch(`${BASE}${route}`, {
      method,
      headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: res.status, body: await res.json() };
  };

  before(async () => {
    await freshDatabase();
    await db.closePool();
    server = startServer({ HTTP_PORT: String(HTTP_PORT), MQTT_PORT: String(MQTT_PORT), POSITION_TEST_DIR: DATA_DIR });
    await server.ready;
    cookie = await signIn(BASE);
  });

  after(async () => {
    if (server) await server.stop();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  });

  test('nothing runs and no session exists at first', async () => {
    const status = await call('GET', '/api/ips/position-test/status');
    assert.equal(status.status, 200);
    assert.equal(status.body.active, null);
    const sessions = await call('GET', '/api/ips/position-test/sessions');
    assert.deepEqual(sessions.body.sessions, []);
  });

  test('a run for a wristband without a position is refused with a reason, and nothing is saved', async () => {
    const res = await call('POST', '/api/ips/position-test/start', { ward_id: 'WARD-001', tag_id: 'TAG-404', x: 1, y: 1 });
    assert.ok([404, 409].includes(res.status), `status ${res.status}: ${JSON.stringify(res.body)}`);
    assert.match(res.body.error, /has no position yet|is not known/);
    assert.deepEqual(fs.readdirSync(DATA_DIR), []);
  });

  test('wrong input is a 400 with the reason', async () => {
    assert.equal((await call('POST', '/api/ips/position-test/start', { tag_id: 'TAG-002', x: 1, y: 1 })).status, 400);
    assert.equal((await call('GET', '/api/ips/position-test/session?id=../../etc')).status, 400);
    assert.equal((await call('GET', '/api/ips/position-test/samples.csv?id=PT-20000101-000000')).status, 404);
    assert.equal((await call('POST', '/api/ips/position-test/discard', { session_id: 'PT-20000101-000000', run: 0 })).status, 400);
  });

  test('cancelling with no run in progress is harmless', async () => {
    const res = await call('POST', '/api/ips/position-test/cancel', {});
    assert.equal(res.status, 200);
    assert.equal(res.body.cancelled, false);
  });

  test('the API needs a signed-in clinician', async () => {
    const res = await fetch(`${BASE}/api/ips/position-test/status`);
    assert.equal(res.status, 401);
  });
});
