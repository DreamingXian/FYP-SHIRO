// Unit tests: the check every MQTT message passes before anything is looked up or stored.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { checkAnchorMessage, checkDiscoveryMessage } = require('../../services/telemetry/anchor_message');

const ANCHOR = 'A4:CF:12:01:F8:2C';
const TAG = '58:E6:C5:1B:80:4E';

describe('anchor message', () => {
  test('a message of the anchor firmware is accepted', () => {
    const result = checkAnchorMessage({ anchor_mac: ANCHOR, tag_mac: TAG, rssi: -58, v: 2, bpm: 72 });
    assert.deepEqual(result, { ok: true, anchorMac: ANCHOR, rssi: -58, standby: false, tagMac: TAG, tagMacInvalid: false });
  });

  test('MAC addresses are brought into one form', () => {
    const result = checkAnchorMessage({ anchor_mac: 'a4:cf:12:01:f8:2c', tag_mac: '58-e6-c5-1b-80-4e', rssi: '-60' });
    assert.equal(result.anchorMac, ANCHOR);
    assert.equal(result.tagMac, TAG);
    assert.equal(result.rssi, -60);
  });

  test('the standby heartbeat is accepted and carries no wristband', () => {
    const result = checkAnchorMessage({ anchor_mac: ANCHOR, status: 'STANDBY', rssi: 0, ts: 5 });
    assert.equal(result.ok, true);
    assert.equal(result.standby, true);
    assert.equal(result.tagMac, null);
  });

  test('a message without a valid anchor address is refused', () => {
    for (const anchorMac of [undefined, null, '', 'anchor-001', '<img src=x onerror=alert(1)>', 'A4:CF:12:01:F8', 42, {}]) {
      const result = checkAnchorMessage({ anchor_mac: anchorMac, tag_mac: TAG, rssi: -58 });
      assert.equal(result.ok, false, String(anchorMac));
      assert.match(result.reason, /anchor_mac/);
    }
  });

  test('a signal strength outside what a radio can report is refused', () => {
    for (const rssi of [undefined, null, 'strong', NaN, 5, 120, -121, -1e9, [], {}]) {
      const result = checkAnchorMessage({ anchor_mac: ANCHOR, tag_mac: TAG, rssi });
      assert.equal(result.ok, false, String(rssi));
      assert.match(result.reason, /rssi/);
    }
  });

  test('a wristband address that is not a MAC address is dropped, the anchor part is kept', () => {
    const result = checkAnchorMessage({ anchor_mac: ANCHOR, tag_mac: '<script>alert(1)</script>', rssi: -58 });
    assert.equal(result.ok, true);
    assert.equal(result.tagMac, null);
    assert.equal(result.tagMacInvalid, true);
  });

  test('anything that is not a JSON object is refused', () => {
    for (const message of [null, undefined, 'text', 5, true, [], [{ anchor_mac: ANCHOR, rssi: -50 }]]) {
      assert.equal(checkAnchorMessage(message).ok, false);
    }
  });
});

describe('device announcement', () => {
  test('known fields are kept when they are valid', () => {
    assert.deepEqual(checkDiscoveryMessage({
      type: 'ANNOUNCE', mac: 'a4:cf:12:01:f8:2c', suggested_id: 'anchor-004', device_type: 'ANCHOR',
      hardware_model: 'ESP32-WROOM-32E', rssi: -40, battery_level: 80.4, is_charging: false
    }), {
      mac: ANCHOR, suggested_id: 'anchor-004', device_type: 'ANCHOR',
      hardware_model: 'ESP32-WROOM-32E', rssi: -40, battery_level: 80, is_charging: false
    });
  });

  test('invalid fields are left out, never passed on', () => {
    const result = checkDiscoveryMessage({
      mac: ANCHOR, suggested_id: '<b>x</b>', device_type: 'TOASTER', hardware_model: '<img src=x onerror=alert(1)>'.repeat(4),
      rssi: 999, battery_level: 500, is_charging: 'yes', ip_address: '<script>', status_text: '<script>'
    });
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { mac: ANCHOR });
  });

  test('an announcement without a valid MAC address is refused', () => {
    for (const message of [null, 'x', [], {}, { mac: 'nope' }, { mac: 5 }]) {
      assert.equal(checkDiscoveryMessage(message), null);
    }
  });
});
