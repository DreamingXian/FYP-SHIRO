// Unit tests: 1D Kalman filter and log-distance path loss model
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  KalmanFilter1D,
  calculateDistance,
  getCalibration,
  setAnchorCalibration,
  clearAnchorCalibration,
  updateCalibration
} = require('../../services/kalman_filter');
const defaults = require('../../config/calibration_config');

describe('KalmanFilter1D', () => {
  test('first measurement initialises the state', () => {
    const kf = new KalmanFilter1D(4.0, 0.05, -60);
    assert.equal(kf.update(-70), -70);
  });

  test('a constant input stays constant', () => {
    const kf = new KalmanFilter1D(4.0, 0.05);
    let out;
    for (let i = 0; i < 50; i++) out = kf.update(-65);
    assert.equal(out, -65);
  });

  test('converges to a new level after a step change, without overshoot', () => {
    const kf = new KalmanFilter1D(4.0, 0.05);
    kf.update(-60);
    let prev = -60;
    let out;
    for (let i = 0; i < 200; i++) {
      out = kf.update(-70);
      assert.ok(out <= prev + 1e-9, 'output must move monotonically toward the new level');
      assert.ok(out >= -70 - 1e-9, 'output must not overshoot the new level');
      prev = out;
    }
    assert.ok(Math.abs(out - -70) < 0.1, `expected about -70, got ${out}`);
  });

  test('reduces the spread of a noisy signal', () => {
    const kf = new KalmanFilter1D(4.0, 0.05);
    const outputs = [];
    for (let i = 0; i < 200; i++) {
      outputs.push(kf.update(i % 2 === 0 ? -60 : -70)); // raw spread = 10 dB
    }
    const tail = outputs.slice(-50);
    const spread = Math.max(...tail) - Math.min(...tail);
    const mean = tail.reduce((a, b) => a + b, 0) / tail.length;
    assert.ok(spread < 2, `filtered spread ${spread} should be far below the raw 10 dB`);
    assert.ok(Math.abs(mean - -65) < 0.5, `filtered mean ${mean} should be about -65`);
  });
});

describe('calculateDistance (log-distance path loss)', () => {
  test('RSSI equal to A gives 1 metre', () => {
    assert.equal(calculateDistance(-52, -52, 3.2), 1);
  });

  test('a drop of 10*n dB gives 10 metres', () => {
    assert.equal(calculateDistance(-84, -52, 3.2), 10);
  });

  test('weaker signal means larger distance', () => {
    const near = calculateDistance(-55, -52, 3.2);
    const far = calculateDistance(-75, -52, 3.2);
    assert.ok(far > near);
  });

  test('uses the default calibration when A and n are not given', () => {
    assert.equal(calculateDistance(defaults.A), 1);
  });
});

describe('per-anchor calibration', () => {
  const globalBefore = { ...getCalibration() };

  afterEach(() => {
    clearAnchorCalibration('anchor-x');
    updateCalibration(globalBefore.A, globalBefore.n);
  });

  test('an anchor override is used, case-insensitively', () => {
    setAnchorCalibration('Anchor-X', -60, 2.0);
    assert.deepEqual(getCalibration('ANCHOR-X'), { A: -60, n: 2.0 });
    assert.equal(calculateDistance(-60, null, null, 'anchor-x'), 1);
    assert.equal(calculateDistance(-80, null, null, 'anchor-x'), 10);
  });

  test('clearing the override falls back to the global calibration', () => {
    setAnchorCalibration('anchor-x', -60, 2.0);
    clearAnchorCalibration('anchor-x');
    assert.deepEqual(getCalibration('anchor-x'), getCalibration());
  });

  test('non-numeric values are ignored', () => {
    const before = { ...getCalibration() };
    updateCalibration('abc', undefined);
    assert.deepEqual({ ...getCalibration() }, before);
  });
});
