// Unit tests: anchor JSON -> validated telemetry. Unknown stays unknown (null).
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const thresholds = require('../../config/clinical_thresholds');
const { normalizeTelemetry } = require('../../services/telemetry/normalize');

const VALID = thresholds.vitals.valid;

/** A complete protocol 2 message as the anchor firmware publishes it. */
function v2(extra = {}) {
  return {
    anchor_mac: 'AA:AA:AA:AA:AA:01', tag_mac: 'BB:BB:BB:BB:BB:01', rssi: -61, v: 2,
    bpm: 72, spo2: 98, battery: 88, charging: false, motion: 'STATIONARY', g: 1.01,
    touch: 1, active: false, fall: false, fall_seq: 12,
    impact_g: 0, freefall_g: 0, still_g: 0, imu_fault: false, ppg_fault: false, ts: 1234,
    ...extra
  };
}

describe('protocol 2 packets', () => {
  test('a normal packet is passed through unchanged', () => {
    const t = normalizeTelemetry(v2());
    assert.equal(t.protocolVersion, 2);
    assert.equal(t.hasTelemetry, true);
    assert.deepEqual(
      { bpm: t.bpm, spo2: t.spo2, g: t.g, motion: t.motion, touch: t.touch, battery: t.battery, fall: t.fall },
      { bpm: 72, spo2: 98, g: 1.01, motion: 'STATIONARY', touch: true, battery: 88, fall: false }
    );
  });

  test('no fall: fall measurements and counter are null, not zero', () => {
    const t = normalizeTelemetry(v2());
    assert.equal(t.fallSeq, null);
    assert.equal(t.impactG, null);
    assert.equal(t.freefallG, null);
    assert.equal(t.stillG, null);
  });

  test('a fall carries its counter and measured values', () => {
    const t = normalizeTelemetry(v2({ fall: true, motion: 'FALL_EMERGENCY', fall_seq: 13, impact_g: 4.37, freefall_g: 0.12, still_g: 0.06 }));
    assert.equal(t.fall, true);
    assert.equal(t.fallSeq, 13);
    assert.equal(t.impactG, 4.37);
    assert.equal(t.freefallG, 0.12);
    assert.equal(t.stillG, 0.06);
    assert.equal(t.active, true, 'a fall always counts as active streaming');
  });

  test('a free-fall minimum of exactly 0 g is a real measurement', () => {
    const t = normalizeTelemetry(v2({ fall: true, fall_seq: 1, impact_g: 3.1, freefall_g: 0, still_g: 0.05 }));
    assert.equal(t.freefallG, 0);
  });

  test('the fall flag alone marks a fall, whatever the motion text says', () => {
    assert.equal(normalizeTelemetry(v2({ fall: true, motion: 'STATIONARY' })).motion, 'FALL_EMERGENCY');
  });
});

describe('vitals validity range', () => {
  test('0 means no reading', () => {
    const t = normalizeTelemetry(v2({ bpm: 0, spo2: 0 }));
    assert.equal(t.bpm, null);
    assert.equal(t.spo2, null);
  });

  test('range limits are inclusive', () => {
    assert.equal(normalizeTelemetry(v2({ bpm: VALID.bpmMin })).bpm, VALID.bpmMin);
    assert.equal(normalizeTelemetry(v2({ bpm: VALID.bpmMax })).bpm, VALID.bpmMax);
    assert.equal(normalizeTelemetry(v2({ bpm: VALID.bpmMin - 1 })).bpm, null);
    assert.equal(normalizeTelemetry(v2({ bpm: VALID.bpmMax + 1 })).bpm, null);
    assert.equal(normalizeTelemetry(v2({ spo2: VALID.spo2Min })).spo2, VALID.spo2Min);
    assert.equal(normalizeTelemetry(v2({ spo2: VALID.spo2Min - 1 })).spo2, null);
    assert.equal(normalizeTelemetry(v2({ spo2: 101 })).spo2, null);
  });

  test('dangerous but plausible readings are kept (they are what the alarms need)', () => {
    const t = normalizeTelemetry(v2({ bpm: 35, spo2: 78 }));
    assert.equal(t.bpm, 35);
    assert.equal(t.spo2, 78);
  });

  test('text and garbage never become numbers', () => {
    const t = normalizeTelemetry(v2({ bpm: 'abc', spo2: {}, battery: 'NaN', g: 'x' }));
    assert.equal(t.bpm, null);
    assert.equal(t.spo2, null);
    assert.equal(t.battery, null);
    assert.equal(t.g, null);
  });
});

describe('sensor faults', () => {
  test('accelerometer fault: g and motion are unknown', () => {
    const t = normalizeTelemetry(v2({ imu_fault: true, g: 0, motion: 'STATIONARY' }));
    assert.equal(t.imuFault, true);
    assert.equal(t.g, null);
    assert.equal(t.motion, null);
  });

  test('pulse sensor fault: vitals are unknown', () => {
    const t = normalizeTelemetry(v2({ ppg_fault: true, bpm: 72, spo2: 98 }));
    assert.equal(t.ppgFault, true);
    assert.equal(t.bpm, null);
    assert.equal(t.spo2, null);
  });

  test('an implausible acceleration is discarded', () => {
    assert.equal(normalizeTelemetry(v2({ g: 99 })).g, null);
    assert.equal(normalizeTelemetry(v2({ g: -1 })).g, null);
  });
});

describe('other packet versions', () => {
  test('v = 0 (packet the anchor could not decode): position only, no telemetry', () => {
    const t = normalizeTelemetry({ anchor_mac: 'AA', tag_mac: 'BB', rssi: -70, v: 0, ts: 1 });
    assert.equal(t.protocolVersion, 0);
    assert.equal(t.hasTelemetry, false);
    assert.equal(t.fall, false);
    assert.equal(t.bpm, null);
  });

  test('old firmware (no version field) is still understood', () => {
    const t = normalizeTelemetry({
      anchor_mac: 'AA', tag_mac: 'BB', rssi: -60, bpm: 80, spo2: 97, battery: 55,
      charging: true, motion: 'FALL_EMERGENCY', g: 0.98, touch: 1, active: true, ts: 1
    });
    assert.equal(t.protocolVersion, 1);
    assert.equal(t.hasTelemetry, true);
    assert.equal(t.fall, true);
    assert.equal(t.fallSeq, null, 'old firmware has no fall counter');
    assert.equal(t.impactG, null, 'old firmware does not report the impact');
    assert.equal(t.charging, true);
    assert.equal(t.bpm, 80);
  });

  test('empty or missing input gives an all-unknown result', () => {
    for (const input of [null, undefined, {}]) {
      const t = normalizeTelemetry(input);
      assert.equal(t.hasTelemetry, false);
      assert.equal(t.fall, false);
      assert.equal(t.bpm, null);
      assert.equal(t.g, null);
    }
  });
});
