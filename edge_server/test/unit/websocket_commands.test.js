// Unit tests: the check every WebSocket command passes before it is carried out.
require('./no_database');

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { validateCommand } = require('../../services/websocket_service');
const { HttpError } = require('../../utils/http');

function refuses(cmd, field) {
  assert.throws(() => validateCommand(cmd), (err) => err instanceof HttpError && err.status === 400 && (!field || err.message.includes(field)), JSON.stringify(cmd));
}

describe('1 Hz activation (SET_ACTIVE_MODE)', () => {
  test('the command of the live map is accepted', () => {
    assert.deepEqual(
      validateCommand({ action: 'SET_ACTIVE_MODE', data: { tagId: 'TAG-002', targetMac: '58:e6:c5:1b:80:4e', duration: 60 } }),
      { action: 'SET_ACTIVE_MODE', tagId: 'TAG-002', targetMac: '58:E6:C5:1B:80:4E', duration: 60 }
    );
  });

  test('a wristband that is not enrolled is named by its MAC address', () => {
    const cmd = validateCommand({ action: 'SET_ACTIVE_MODE', tag_id: '58:E6:C5:1B:80:4E' });
    assert.equal(cmd.tagId, '58:E6:C5:1B:80:4E');
    assert.equal(cmd.targetMac, null);
    assert.equal(cmd.duration, 60);
  });

  test('a command without a wristband is refused: no wristband is assumed', () => {
    refuses({ action: 'SET_ACTIVE_MODE' }, 'tag_id');
    refuses({ action: 'SET_ACTIVE_MODE', data: { duration: 60 } }, 'tag_id');
  });

  test('invalid fields are refused', () => {
    refuses({ action: 'SET_ACTIVE_MODE', tag_id: '<img src=x>' }, 'tag_id');
    refuses({ action: 'SET_ACTIVE_MODE', tag_id: 'TAG-002', target_mac: 'FF:FF' }, 'target_mac');
    refuses({ action: 'SET_ACTIVE_MODE', tag_id: 'TAG-002', duration: 100000 }, 'duration');
    refuses({ action: 'SET_ACTIVE_MODE', tag_id: 'TAG-002', duration: 'long' }, 'duration');
  });
});

describe('calibration (UPDATE_CALIBRATION)', () => {
  test('global and per-anchor values are accepted', () => {
    assert.deepEqual(validateCommand({ action: 'UPDATE_CALIBRATION', A: -59, n: 2.4 }), { action: 'UPDATE_CALIBRATION', anchorId: null, A: -59, n: 2.4 });
    assert.equal(validateCommand({ action: 'UPDATE_CALIBRATION', anchor_id: 'Anchor A', A: '-61.5' }).A, -61.5);
  });

  test('values a radio model cannot have are refused', () => {
    refuses({ action: 'UPDATE_CALIBRATION', A: 20, n: 2 }, 'A');
    refuses({ action: 'UPDATE_CALIBRATION', A: -60, n: 0 }, 'n');
    refuses({ action: 'UPDATE_CALIBRATION', A: 'x' }, 'A');
    refuses({ action: 'UPDATE_CALIBRATION' });
    refuses({ action: 'UPDATE_CALIBRATION', anchor_id: '<b>', A: -60 }, 'anchor_id');
  });
});

describe('headset presence (DEVICE_HANDSHAKE, DEVICE_HEARTBEAT)', () => {
  const handshake = {
    action: 'DEVICE_HANDSHAKE', device_id: 'QUEST3-001', mac_address: '02:00:00:51:55:01', device_type: 'HEADSET',
    model: 'Meta Quest 3 (MR)', assigned_ward_id: 'WARD-004', battery_level: 80
  };

  test('the handshake of the headset is accepted', () => {
    assert.deepEqual(validateCommand(handshake), {
      action: 'DEVICE_HANDSHAKE', deviceId: 'QUEST3-001', mac: '02:00:00:51:55:01', deviceType: 'HEADSET',
      battery: 80, model: 'Meta Quest 3 (MR)', assignedWardId: 'WARD-004'
    });
  });

  test('an unknown battery level stays unknown', () => {
    const { battery_level, ...withoutBattery } = handshake;
    assert.equal(validateCommand({ ...withoutBattery, action: 'DEVICE_HEARTBEAT' }).battery, null);
  });

  test('a device without an ID or MAC address is refused: none is assumed', () => {
    refuses({ action: 'DEVICE_HANDSHAKE' }, 'device_id');
    refuses({ ...handshake, mac_address: undefined }, 'mac_address');
    refuses({ ...handshake, mac_address: 'x' }, 'mac_address');
    refuses({ ...handshake, device_id: "x' OR '1'='1" }, 'device_id');
    refuses({ ...handshake, battery_level: 400 }, 'battery_level');
    refuses({ ...handshake, device_type: 'ANCHOR' }, 'device_type');
    refuses({ ...handshake, model: 'x'.repeat(65) }, 'model');
  });
});

describe('anything else', () => {
  test('unknown actions and non-objects are refused', () => {
    for (const cmd of [{}, { action: 'DROP_ALL' }, { action: 5 }, null, 'text', 7, [], [{ action: 'SET_ACTIVE_MODE', tag_id: 'TAG-002' }]]) {
      refuses(cmd);
    }
  });
});
