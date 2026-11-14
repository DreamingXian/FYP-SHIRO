// Unit tests: the firmware and the server agree on the telemetry contract.
// These read the firmware sources as text; no board or compiler is involved.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const thresholds = require('../../config/clinical_thresholds');

const FIRMWARE = path.join(__dirname, '..', '..', '..', 'firmware');
const read = (...parts) => fs.readFileSync(path.join(FIRMWARE, ...parts), 'utf8').replace(/\r\n/g, '\n');

describe('firmware and server contract', () => {
  test('the anchor publishes every JSON field the server reads', () => {
    const anchor = read('shiro_anchor_node', 'shiro_anchor_node.ino');
    const fields = [
      'anchor_mac', 'tag_mac', 'rssi', 'v', 'bpm', 'spo2', 'battery', 'charging', 'motion', 'g',
      'touch', 'active', 'fall', 'fall_seq', 'impact_g', 'freefall_g', 'still_g', 'imu_fault', 'ppg_fault'
    ];
    for (const field of fields) {
      assert.ok(anchor.includes(`\\"${field}\\":`), `anchor firmware does not publish "${field}"`);
    }
  });

  test('wristband and anchor use the same packet definition', () => {
    assert.equal(
      read('shiro_wristband_vitals', 'shiro_packet.h'),
      read('shiro_anchor_node', 'shiro_packet.h'),
      'the two copies of shiro_packet.h differ: copy one over the other'
    );
  });

  test('the wristband accepts the same vitals range as the server', () => {
    const filter = read('shiro_wristband_vitals', 'vitals_filter.h');
    const constant = (name) => {
      const match = filter.match(new RegExp(`${name}\\s*=\\s*([0-9.]+)f`));
      assert.ok(match, `${name} not found in vitals_filter.h`);
      return Number(match[1]);
    };
    const valid = thresholds.vitals.valid;
    assert.equal(constant('BPM_VALID_MIN'), valid.bpmMin);
    assert.equal(constant('BPM_VALID_MAX'), valid.bpmMax);
    assert.equal(constant('SPO2_VALID_MIN'), valid.spo2Min);
    assert.equal(constant('SPO2_VALID_MAX'), valid.spo2Max);
  });

  test('the server keeps a fall session open longer than the wristband repeats its flag', () => {
    const detector = read('shiro_wristband_vitals', 'fall_detector.h');
    const match = detector.match(/alertHoldMs\s*=\s*(\d+)/);
    assert.ok(match, 'alertHoldMs not found in fall_detector.h');
    assert.ok(thresholds.fall.sessionTtlMs > Number(match[1]),
      'fall.sessionTtlMs must exceed the wristband alert hold, or one fall could be raised twice');
  });
});
