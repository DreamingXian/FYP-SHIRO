// Unit tests: LiDAR scan messages and the live picture of the LiDAR nodes
// (services/room_sensor/scan_frame.js, services/room_sensor/room_sensor_service.js)
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { decodeScanFrame, encodeScanFrame, FRAME_SIZE, BINS } = require('../../services/room_sensor/scan_frame');
const { createRoomSensorService, checkStatusMessage } = require('../../services/room_sensor/room_sensor_service');

const MAC = '10:B2:C3:D4:E5:F6';
const SCAN_TOPIC = 'shiro/ward-A1/lidar/scan';
const STATUS_TOPIC = 'shiro/ward-A1/lidar/status';

function distances(fill = 0) {
  return new Array(BINS).fill(fill);
}

function statusPayload(overrides = {}) {
  return Buffer.from(JSON.stringify({
    lidar_mac: MAC, state: 'SCANNING', node_fw: '1.0.0', model: 65, lidar_fw: '1.01', lidar_hw: 18,
    serial: 'A1B2C3D4E5F60718293A4B5C6D7E8F90', health: 'OK', health_code: 0,
    turns_per_s: 10.1, points_per_turn: 498, valid_per_turn: 470, turn_ms: 99,
    sent: 20, send_failed: 0, overwritten: 0, bad_bytes: 3, restarts: 0, wifi_rssi: -55, uptime_s: 30,
    ...overrides
  }));
}

/** A service with a hand-moved clock that records what it reports. */
function setup({ enrolled = null } = {}) {
  let now = 1_000_000;
  const traffic = [];
  const broadcasts = [];
  const service = createRoomSensorService({
    recordTraffic: (id, type, meta) => traffic.push({ id, type, meta }),
    findEnrolled: (mac) => (enrolled && mac === MAC ? { device_id: enrolled } : null),
    broadcast: (msg) => broadcasts.push(msg),
    now: () => now
  });
  return {
    service, traffic, broadcasts,
    advance: (ms) => { now += ms; },
    scan: (sequence, dist = distances(2000)) => service.handleMessage({
      mac: MAC, topic: SCAN_TOPIC, payload: encodeScanFrame({ sequence, turnMs: 100, samples: 500 }, dist), ip: '192.168.1.80', clientId: 'SHIRO_Lidar_10B2C3D4E5F6'
    })
  };
}

describe('scan message', () => {
  test('a message built like the node builds it is read back unchanged', () => {
    const dist = distances(0);
    dist[0] = 1000;
    dist[719] = 4321;
    dist[360] = 65535;
    const buf = encodeScanFrame({ sequence: 0x1234, turnMs: 101, samples: 2 }, dist);
    assert.equal(buf.length, FRAME_SIZE);
    assert.equal(FRAME_SIZE, 1452);
    // Same bytes as the firmware host test (firmware/tests/host_tests.cpp, testLidarFrame)
    assert.deepEqual([...buf.subarray(0, 14)], [0x53, 0x4C, 1, 0, 0x34, 0x12, 101, 0, 2, 0, 3, 0, 1000 & 0xFF, 1000 >> 8]);
    const decoded = decodeScanFrame(buf);
    assert.equal(decoded.ok, true);
    assert.equal(decoded.frame.sequence, 0x1234);
    assert.equal(decoded.frame.turnMs, 101);
    assert.equal(decoded.frame.samples, 2);
    assert.equal(decoded.frame.valid, 3);
    assert.equal(decoded.frame.distancesMm[0], 1000);
    assert.equal(decoded.frame.distancesMm[719], 4321);
    assert.equal(decoded.frame.distancesMm[1], 0);
  });

  test('a message of the wrong size, kind or version is refused with the reason', () => {
    const good = encodeScanFrame({ sequence: 1 }, distances(1500));
    assert.match(decodeScanFrame(good.subarray(0, FRAME_SIZE - 1)).reason, /1451 bytes, expected 1452/);
    assert.match(decodeScanFrame('text').reason, /not binary/);
    const wrongMagic = Buffer.from(good);
    wrongMagic[0] = 0x41;
    assert.match(decodeScanFrame(wrongMagic).reason, /does not start with "SL"/);
    const wrongVersion = Buffer.from(good);
    wrongVersion[2] = 2;
    assert.match(decodeScanFrame(wrongVersion).reason, /version 2/);
  });
});

describe('status report of a node', () => {
  test('known fields are kept, implausible values become null or UNKNOWN', () => {
    const checked = checkStatusMessage({
      lidar_mac: MAC.toLowerCase(), state: 'SCANNING', health: 'BROKEN', turns_per_s: 500, wifi_rssi: -55,
      serial: '<script>', node_fw: '1.0.0', extra: 'ignored'
    }, MAC);
    assert.equal(checked.ok, true);
    assert.equal(checked.status.state, 'SCANNING');
    assert.equal(checked.status.health, 'UNKNOWN');
    assert.equal(checked.status.turns_per_s, null);
    assert.equal(checked.status.wifi_rssi, -55);
    assert.equal(checked.status.serial, null);
    assert.equal(checked.status.node_fw, '1.0.0');
    assert.equal('extra' in checked.status, false);
  });

  test('a report about another MAC address is refused', () => {
    assert.equal(checkStatusMessage({ lidar_mac: 'AA:BB:CC:DD:EE:FF', state: 'SCANNING' }, MAC).ok, false);
    assert.equal(checkStatusMessage([1, 2], MAC).ok, false);
    assert.equal(checkStatusMessage(null, MAC).ok, false);
  });
});

describe('live picture of the LiDAR nodes', () => {
  test('turns are counted and the turn rate is measured over the last 5 s', () => {
    const t = setup();
    for (let seq = 0; seq < 21; seq++) {
      assert.deepEqual(t.scan(seq), { ok: true });
      t.advance(100);
    }
    const [s] = t.service.getStatuses();
    assert.equal(s.mac, MAC);
    assert.equal(s.frames, 21);
    assert.equal(s.lost_turns, 0);
    assert.equal(s.scanning, true);
    assert.equal(s.online, true);
    assert.ok(Math.abs(s.turns_per_s - 10) < 0.05, `turns_per_s ${s.turns_per_s}`);
    assert.equal(s.last_frame.samples, 500);
    assert.equal(s.ip, '192.168.1.80');
  });

  test('a gap in the sequence numbers counts as lost turns; a restarted node does not', () => {
    const t = setup();
    t.scan(10);
    t.scan(13);          // 11 and 12 lost
    t.scan(14);
    t.scan(65535);
    t.scan(1);           // wraps: 0 lost
    t.scan(40000);       // node restarted: not counted
    assert.equal(t.service.getStatuses()[0].lost_turns, 3);
  });

  test('scanning and online end when the messages stop', () => {
    const t = setup();
    t.scan(1);
    t.advance(2500);
    let [s] = t.service.getStatuses();
    assert.equal(s.scanning, false);
    assert.equal(s.online, true);
    t.advance(4000);
    [s] = t.service.getStatuses();
    assert.equal(s.online, false);
  });

  test('a bad scan is counted and refused; a good status is stored', () => {
    const t = setup();
    const result = t.service.handleMessage({ mac: MAC, topic: SCAN_TOPIC, payload: Buffer.alloc(10) });
    assert.equal(result.ok, false);
    assert.equal(t.service.handleMessage({ mac: MAC, topic: STATUS_TOPIC, payload: statusPayload() }).ok, true);
    const [s] = t.service.getStatuses();
    assert.equal(s.bad_frames, 1);
    assert.equal(s.node.health, 'OK');
    assert.equal(s.node.serial, 'A1B2C3D4E5F60718293A4B5C6D7E8F90');
    assert.equal(t.service.handleMessage({ mac: MAC, topic: STATUS_TOPIC, payload: Buffer.from('{not json') }).ok, false);
    assert.equal(t.service.handleMessage({ mac: MAC, topic: STATUS_TOPIC, payload: Buffer.alloc(2000, 0x20) }).ok, false);
    assert.equal(t.service.handleMessage({ mac: MAC, topic: 'shiro/ward-A1/lidar/other', payload: Buffer.from('{}') }).ok, false);
  });

  test('presence on the Devices page and dashboard updates happen at most once a second', () => {
    const t = setup();
    for (let seq = 0; seq < 10; seq++) {
      t.scan(seq);
      t.advance(100);
    }
    assert.equal(t.traffic.length, 1);
    assert.equal(t.broadcasts.length, 1);
    assert.deepEqual({ id: t.traffic[0].id, type: t.traffic[0].type, model: t.traffic[0].meta.model }, { id: MAC, type: 'ROOM_SENSOR', model: 'ESP32-S3 + RPLIDAR C1' });
    assert.equal(t.broadcasts[0].type, 'ROOM_SENSOR_STATUS');
    assert.equal(JSON.stringify(t.broadcasts[0]).includes('distancesMm'), false, 'the dashboard update carries no scan data');
    t.advance(100);
    t.scan(10);
    assert.equal(t.traffic.length, 2);
  });

  test('an enrolled node is reported by its device ID', () => {
    const t = setup({ enrolled: 'lidar-001' });
    t.service.noteConnected({ mac: MAC, ip: '192.168.1.80', clientId: 'SHIRO_Lidar_10B2C3D4E5F6' });
    assert.equal(t.traffic[0].id, 'lidar-001');
    assert.equal(t.service.getStatuses()[0].device_id, 'lidar-001');
  });

  test('every turn reaches the listeners; a failing listener does not stop the others', () => {
    const t = setup({ enrolled: 'lidar-001' });
    const seen = [];
    t.service.onFrame(() => { throw new Error('listener failed'); });
    const stop = t.service.onFrame((turn) => seen.push(turn));
    const dist = distances(3000);
    dist[100] = 1200;
    t.scan(5, dist);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].mac, MAC);
    assert.equal(seen[0].deviceId, 'lidar-001');
    assert.equal(seen[0].frame.distancesMm[100], 1200);
    stop();
    t.scan(6, dist);
    assert.equal(seen.length, 1);
    assert.equal(t.service.getLatestFrame(MAC).frame.sequence, 6);
  });
});
