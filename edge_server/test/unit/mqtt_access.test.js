// Unit tests: MQTT login check and topic rules (services/mqtt_access.js)
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  readAnchorCredentials, createAccessControl, anchorMacFromClientId, lidarMacFromClientId, nodeKindOf,
  mayPublish, maySubscribe, secretEquals, MAX_FAILURES_PER_WINDOW, LOCKOUT_MS
} = require('../../services/mqtt_access');

const LOGIN = { username: 'shiro-anchor', password: 'a-long-test-password-123' };
const ANCHOR_ID = 'SHIRO_Anchor_A0B1C2D3E4F5';
const LIDAR_ID = 'SHIRO_Lidar_10B2C3D4E5F6';

function fakeClient(id = ANCHOR_ID, address = '::ffff:192.168.1.50') {
  return { id, conn: { remoteAddress: address } };
}

/** Runs authenticate and returns { ok, code }. */
function login(access, client, username, password) {
  let result;
  access.authenticate(client, username, password === undefined ? undefined : Buffer.from(password), (err, ok) => {
    result = { ok, code: err ? err.returnCode : 0 };
  });
  return result;
}

describe('reading the anchor login from the environment', () => {
  test('a valid login is returned', () => {
    assert.deepEqual(readAnchorCredentials({ MQTT_ANCHOR_USER: ' shiro-anchor ', MQTT_ANCHOR_PASSWORD: LOGIN.password }), LOGIN);
  });

  test('a missing value stops the server with a message naming both settings', () => {
    for (const env of [{}, { MQTT_ANCHOR_USER: 'shiro-anchor' }, { MQTT_ANCHOR_PASSWORD: LOGIN.password }, { MQTT_ANCHOR_USER: '', MQTT_ANCHOR_PASSWORD: '' }]) {
      assert.throws(() => readAnchorCredentials(env), /MQTT_ANCHOR_USER and MQTT_ANCHOR_PASSWORD must be set/);
    }
  });

  test('a weak or malformed value is refused', () => {
    assert.throws(() => readAnchorCredentials({ MQTT_ANCHOR_USER: 'shiro-anchor', MQTT_ANCHOR_PASSWORD: 'short' }), /16 to 128/);
    assert.throws(() => readAnchorCredentials({ MQTT_ANCHOR_USER: 'shiro-anchor', MQTT_ANCHOR_PASSWORD: 'has a space in it 1234' }), /without spaces/);
    assert.throws(() => readAnchorCredentials({ MQTT_ANCHOR_USER: 'a b', MQTT_ANCHOR_PASSWORD: LOGIN.password }), /MQTT_ANCHOR_USER must be/);
    assert.throws(() => readAnchorCredentials({ MQTT_ANCHOR_USER: 'ab', MQTT_ANCHOR_PASSWORD: LOGIN.password }), /MQTT_ANCHOR_USER must be/);
  });
});

describe('secret comparison', () => {
  test('equal only for the same text, whatever the lengths', () => {
    assert.equal(secretEquals('abc', 'abc'), true);
    assert.equal(secretEquals('abc', Buffer.from('abc')), true);
    assert.equal(secretEquals('abc', 'abd'), false);
    assert.equal(secretEquals('abc', 'abcd'), false);
    assert.equal(secretEquals('abc', undefined), false);
    assert.equal(secretEquals('abc', null), false);
  });
});

describe('anchor client IDs', () => {
  test('the MAC address is read from a valid ID', () => {
    assert.equal(anchorMacFromClientId('SHIRO_Anchor_a0b1c2d3e4f5'), 'A0:B1:C2:D3:E4:F5');
  });

  test('anything else gives null', () => {
    for (const id of ['', 'SHIRO_Anchor_', 'SHIRO_Anchor_A0B1C2D3E4', 'SHIRO_Anchor_A0B1C2D3E4F5G', 'xSHIRO_Anchor_A0B1C2D3E4F5', 'SHIRO_Anchor_A0B1C2D3E4FZ', null, 5]) {
      assert.equal(anchorMacFromClientId(id), null, String(id));
    }
  });
});

describe('topic rules', () => {
  test('anchors may publish to their telemetry topic and the discovery topic only', () => {
    assert.equal(mayPublish('shiro/ward-A1/anchor/telemetry'), true);
    assert.equal(mayPublish('shiro/WARD_002/anchor/telemetry'), true);
    assert.equal(mayPublish('shiro/discovery'), true);
    for (const topic of ['shiro/control/mode', 'shiro/ward-A1/anchor/telemetry/x', 'shiro/a/b/anchor/telemetry', 'shiro//anchor/telemetry',
      'shiro/discovery/x', '$SYS/x', 'other', '', null]) {
      assert.equal(mayPublish(topic), false, String(topic));
    }
  });

  test('anchors may subscribe under shiro/control/ only', () => {
    for (const topic of ['shiro/control/mode', 'shiro/control/#', 'shiro/control/+', 'shiro/control/+/mode']) {
      assert.equal(maySubscribe(topic), true, topic);
    }
    for (const topic of ['#', '+/control/mode', 'shiro/#', 'shiro/+/anchor/telemetry', 'shiro/control', 'shiro/control/#/x', 'shiro/control/a/b/c/d/e',
      'shiro/control/mo#de', '$SYS/#', '', null]) {
      assert.equal(maySubscribe(topic), false, String(topic));
    }
  });
});

describe('login check', () => {
  test('the right login with an anchor ID is accepted', () => {
    const access = createAccessControl(LOGIN, { warn: () => {} });
    assert.deepEqual(login(access, fakeClient(), LOGIN.username, LOGIN.password), { ok: true, code: 0 });
  });

  test('a wrong or missing login is refused with "bad username or password"', () => {
    const access = createAccessControl(LOGIN, { warn: () => {} });
    assert.deepEqual(login(access, fakeClient(), LOGIN.username, 'wrong'), { ok: false, code: 4 });
    assert.deepEqual(login(access, fakeClient(), 'other', LOGIN.password), { ok: false, code: 4 });
    assert.deepEqual(login(access, fakeClient(), undefined, undefined), { ok: false, code: 4 });
  });

  test('a client ID that is not an anchor ID is refused with "identifier rejected"', () => {
    const access = createAccessControl(LOGIN, { warn: () => {} });
    assert.deepEqual(login(access, fakeClient('mqtt-explorer'), LOGIN.username, LOGIN.password), { ok: false, code: 2 });
  });

  test('warnings never contain the password and repeat at most every 10 s per address', () => {
    const lines = [];
    const access = createAccessControl(LOGIN, { warn: (line) => lines.push(line) });
    for (let i = 0; i < 5; i++) login(access, fakeClient(), LOGIN.username, 'guess-1234567890');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /Refused SHIRO_Anchor_A0B1C2D3E4F5 from 192\.168\.1\.50: wrong username or password/);
    assert.doesNotMatch(lines.join('\n'), /guess-1234567890|a-long-test-password-123/);
  });

  test(`after ${MAX_FAILURES_PER_WINDOW} failures an address is locked out, then allowed again`, () => {
    let now = 1000000;
    const access = createAccessControl(LOGIN, { warn: () => {}, now: () => now });
    for (let i = 0; i < MAX_FAILURES_PER_WINDOW; i++) login(access, fakeClient(), LOGIN.username, 'wrong');
    assert.deepEqual(login(access, fakeClient(), LOGIN.username, LOGIN.password), { ok: false, code: 5 });
    // Another address is not affected
    assert.deepEqual(login(access, fakeClient(ANCHOR_ID, '192.168.1.51'), LOGIN.username, LOGIN.password), { ok: true, code: 0 });
    now += LOCKOUT_MS + 1;
    assert.deepEqual(login(access, fakeClient(), LOGIN.username, LOGIN.password), { ok: true, code: 0 });
  });

  test('a successful login clears the failure count', () => {
    const access = createAccessControl(LOGIN, { warn: () => {} });
    for (let i = 0; i < MAX_FAILURES_PER_WINDOW - 1; i++) login(access, fakeClient(), LOGIN.username, 'wrong');
    assert.equal(login(access, fakeClient(), LOGIN.username, LOGIN.password).ok, true);
    for (let i = 0; i < MAX_FAILURES_PER_WINDOW - 1; i++) login(access, fakeClient(), LOGIN.username, 'wrong');
    assert.equal(login(access, fakeClient(), LOGIN.username, LOGIN.password).ok, true);
  });
});

describe('publish and subscribe checks', () => {
  const access = createAccessControl(LOGIN, { warn: () => {} });

  test('an allowed publish passes, a forbidden one gets an error', () => {
    let error = 'not called';
    access.authorizePublish(fakeClient(), { topic: 'shiro/ward-A1/anchor/telemetry' }, (err) => { error = err; });
    assert.equal(error, null);
    access.authorizePublish(fakeClient(), { topic: 'shiro/control/mode' }, (err) => { error = err; });
    assert.ok(error instanceof Error);
  });

  test('a forbidden subscription is negated, an allowed one returned unchanged', () => {
    const sub = { topic: 'shiro/control/mode', qos: 0 };
    let granted = 'not called';
    access.authorizeSubscribe(fakeClient(), sub, (err, s) => { granted = s; });
    assert.equal(granted, sub);
    access.authorizeSubscribe(fakeClient(), { topic: '#', qos: 0 }, (err, s) => { granted = s; });
    assert.equal(granted, null);
  });
});

describe('LiDAR room sensor nodes (Phase 10)', () => {
  test('the MAC address is read from a LiDAR ID; anchor and LiDAR IDs are told apart', () => {
    assert.equal(lidarMacFromClientId('SHIRO_Lidar_10b2c3d4e5f6'), '10:B2:C3:D4:E5:F6');
    assert.equal(lidarMacFromClientId(ANCHOR_ID), null);
    assert.equal(anchorMacFromClientId(LIDAR_ID), null);
    assert.equal(nodeKindOf(ANCHOR_ID), 'ANCHOR');
    assert.equal(nodeKindOf(LIDAR_ID), 'ROOM_SENSOR');
    for (const id of ['SHIRO_Lidar_', 'SHIRO_Lidar_10B2C3D4E5', 'SHIRO_LIDAR_10B2C3D4E5F6', 'xSHIRO_Lidar_10B2C3D4E5F6', 'mqtt-explorer', null]) {
      assert.equal(nodeKindOf(id), null, String(id));
    }
  });

  test('a LiDAR node logs in with the same login; with a wrong one it is refused', () => {
    const access = createAccessControl(LOGIN, { warn: () => {} });
    assert.deepEqual(login(access, fakeClient(LIDAR_ID), LOGIN.username, LOGIN.password), { ok: true, code: 0 });
    assert.deepEqual(login(access, fakeClient(LIDAR_ID), LOGIN.username, 'wrong'), { ok: false, code: 4 });
  });

  test('each kind of node may publish to its own topics only', () => {
    assert.equal(mayPublish('shiro/ward-A1/lidar/scan', 'ROOM_SENSOR'), true);
    assert.equal(mayPublish('shiro/ward-A1/lidar/status', 'ROOM_SENSOR'), true);
    for (const topic of ['shiro/ward-A1/anchor/telemetry', 'shiro/discovery', 'shiro/ward-A1/lidar/other', 'shiro/ward-A1/lidar/scan/x', 'shiro/control/mode']) {
      assert.equal(mayPublish(topic, 'ROOM_SENSOR'), false, topic);
    }
    // Anchors may not send LiDAR scans; an unknown kind may publish nothing
    assert.equal(mayPublish('shiro/ward-A1/lidar/scan'), false);
    assert.equal(mayPublish('shiro/ward-A1/lidar/scan', 'ANCHOR'), false);
    assert.equal(mayPublish('shiro/ward-A1/anchor/telemetry', 'OTHER'), false);
  });

  test('the publish check uses the kind in the client ID', () => {
    const access = createAccessControl(LOGIN, { warn: () => {} });
    const result = (client, topic) => {
      let error = 'not called';
      access.authorizePublish(client, { topic }, (err) => { error = err; });
      return error === null ? 'allowed' : 'refused';
    };
    assert.equal(result(fakeClient(LIDAR_ID), 'shiro/ward-A1/lidar/scan'), 'allowed');
    assert.equal(result(fakeClient(LIDAR_ID), 'shiro/ward-A1/anchor/telemetry'), 'refused');
    assert.equal(result(fakeClient(ANCHOR_ID), 'shiro/ward-A1/lidar/scan'), 'refused');
    assert.equal(result(fakeClient('mqtt-explorer'), 'shiro/ward-A1/anchor/telemetry'), 'refused');
  });
});
