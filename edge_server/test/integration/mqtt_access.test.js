// Integration test: only logged-in anchors may use the MQTT broker, and only
// their own topics. Starts the real server on spare ports against shiro_test.
// The lockout test runs last: it locks 127.0.0.1 out of this server for a minute.
process.env.INFLUX_TOKEN = '';

const { db, freshDatabase, startServer, connectMqtt, anchorClientId, TEST_MQTT_LOGIN } = require('./helper');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { MAX_FAILURES_PER_WINDOW } = require('../../services/mqtt_access');

const HTTP_PORT = 3998;
const MQTT_PORT = 1888;
const ANCHOR = 'A0:00:00:00:00:31';
const OTHER_ANCHOR = 'A0:00:00:00:00:32';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Resolves with the CONNACK return code of a refused connection (fails if it is accepted). */
async function refusedWith(clientId, login) {
  try {
    const client = await connectMqtt(MQTT_PORT, clientId, login);
    client.close();
  } catch (err) {
    return err.returnCode;
  }
  assert.fail(`the broker accepted ${clientId} with ${JSON.stringify(login)}`);
}

describe('MQTT broker access', () => {
  let server;
  let ws;
  const received = [];

  before(async () => {
    await freshDatabase();
    await db.closePool();
    server = startServer({ HTTP_PORT: String(HTTP_PORT), MQTT_PORT: String(MQTT_PORT) });
    await server.ready;
    ws = new WebSocket(`ws://127.0.0.1:${HTTP_PORT}`);
    ws.on('message', (data) => { received.push(JSON.parse(data.toString())); });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  });

  after(async () => {
    if (ws) ws.close();
    if (server) await server.stop();
  });

  test('a client without a login is refused', async () => {
    assert.equal(await refusedWith(anchorClientId(ANCHOR), null), 4);
  });

  test('a wrong password or username is refused', async () => {
    assert.equal(await refusedWith(anchorClientId(ANCHOR), { username: TEST_MQTT_LOGIN.username, password: 'wrong-password-0123456789' }), 4);
    assert.equal(await refusedWith(anchorClientId(ANCHOR), { username: 'someone-else', password: TEST_MQTT_LOGIN.password }), 4);
    assert.equal(await refusedWith(anchorClientId(ANCHOR), { username: TEST_MQTT_LOGIN.username, password: '' }), 4);
  });

  test('the right login with a client ID that is not an anchor ID is refused', async () => {
    for (const clientId of ['mqttx_1234', 'SHIRO_Anchor_', 'SHIRO_Anchor_A0000000003Z', 'SHIRO_Anchor_A0000000003100']) {
      assert.equal(await refusedWith(clientId, TEST_MQTT_LOGIN), 2, clientId);
    }
  });

  test('a refused login is logged without the password', () => {
    assert.match(server.output, /\[MQTT SECURITY\] Refused SHIRO_Anchor_A00000000031 from 127\.0\.0\.1: (no username or password|wrong username or password)/);
    assert.doesNotMatch(server.output, /wrong-password-0123456789/);
    assert.doesNotMatch(server.output, new RegExp(TEST_MQTT_LOGIN.password));
  });

  test('an anchor with the right login connects, publishes and its message arrives', async () => {
    const anchor = await connectMqtt(MQTT_PORT, anchorClientId(ANCHOR));
    try {
      const from = received.length;
      anchor.publish({ anchor_mac: ANCHOR, tag_mac: 'B0:00:00:00:00:31', rssi: -60, v: 2, bpm: 70, spo2: 97, battery: 80, ts: 1 });
      await sleep(400);
      assert.ok(received.slice(from).some(m => m.type === 'TELEMETRY' && m.data.tag_mac === 'B0:00:00:00:00:31'));
    } finally {
      anchor.close();
    }
  });

  test('subscribing outside shiro/control is refused, the connection stays open', async () => {
    const anchor = await connectMqtt(MQTT_PORT, anchorClientId(ANCHOR));
    try {
      assert.equal(await anchor.subscribe('#'), 0x80);
      assert.equal(await anchor.subscribe('shiro/+/anchor/telemetry'), 0x80);
      assert.equal(await anchor.subscribe('$SYS/#'), 0x80);
      assert.equal(await anchor.subscribe('shiro/control/mode'), 0x00);
      assert.equal(await anchor.subscribe('shiro/control/#'), 0x00);
    } finally {
      anchor.close();
    }
  });

  test('an anchor cannot read what other anchors send', async () => {
    const listener = await connectMqtt(MQTT_PORT, anchorClientId(OTHER_ANCHOR));
    const anchor = await connectMqtt(MQTT_PORT, anchorClientId(ANCHOR));
    try {
      await listener.subscribe('shiro/+/anchor/telemetry');
      anchor.publish({ anchor_mac: ANCHOR, tag_mac: 'B0:00:00:00:00:32', rssi: -60 });
      await sleep(300);
      assert.equal(listener.messages.length, 0);
    } finally {
      listener.close();
      anchor.close();
    }
  });

  test('publishing to a forbidden topic ends the connection and the message is not used', async () => {
    const anchor = await connectMqtt(MQTT_PORT, anchorClientId(ANCHOR));
    const from = received.length;
    anchor.publish({ cmd: 'SET_ACTIVE', target_mac: 'B0:00:00:00:00:33', target_anchor: ANCHOR }, 'shiro/control/mode');
    const closedInTime = await Promise.race([anchor.closed.then(() => true), sleep(2000).then(() => false)]);
    assert.equal(closedInTime, true, 'the broker must close the connection');
    assert.equal(received.slice(from).length, 0);
    assert.match(server.output, /may not publish to "shiro\/control\/mode"/);
  });

  test('an anchor cannot report under the MAC address of another anchor', async () => {
    const anchor = await connectMqtt(MQTT_PORT, anchorClientId(ANCHOR));
    try {
      const from = received.length;
      anchor.publish({ anchor_mac: OTHER_ANCHOR, tag_mac: 'B0:00:00:00:00:34', rssi: -60, v: 2, bpm: 70, ts: 1 });
      await sleep(400);
      assert.equal(received.slice(from).filter(m => m.type === 'TELEMETRY' || m.type === 'ANCHOR_RSSI').length, 0);
      assert.match(server.output, /anchor_mac A0:00:00:00:00:32 is not the MAC address of this anchor's client ID/);
    } finally {
      anchor.close();
    }
  });

  test(`after ${MAX_FAILURES_PER_WINDOW} failed logins the address is locked out, even with the right login`, async () => {
    for (let i = 0; i < MAX_FAILURES_PER_WINDOW; i++) {
      await refusedWith(anchorClientId(ANCHOR), { username: TEST_MQTT_LOGIN.username, password: `guess-number-${i}-0123456789` });
    }
    assert.equal(await refusedWith(anchorClientId(ANCHOR), TEST_MQTT_LOGIN), 5);
    assert.match(server.output, /failed logins from 127\.0\.0\.1: refused for 60 s/);
  });
});

describe('MQTT login setting', () => {
  test('the server does not start without the anchor login, and says what is missing', async () => {
    for (const env of [{ MQTT_ANCHOR_PASSWORD: '' }, { MQTT_ANCHOR_USER: '' }, { MQTT_ANCHOR_PASSWORD: 'short' }]) {
      const server = startServer({ HTTP_PORT: '3999', MQTT_PORT: '1889', ...env });
      await assert.rejects(server.ready);
      await server.stop();
      assert.equal(server.child.exitCode, 1);
      assert.match(server.output, /FATAL STARTUP ERROR.*MQTT_ANCHOR_(USER|PASSWORD)/);
      assert.doesNotMatch(server.output, /MQTT BROKER\] Listening/);
    }
  });
});
