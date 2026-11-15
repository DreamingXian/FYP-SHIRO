// Unit tests: choice of the anchor that carries the 1 Hz command (services/telemetry/tag_hearing.js)
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { recordHearing, strongestAnchor, clear, HEARD_WITHIN_MS } = require('../../services/telemetry/tag_hearing');

const TAG = 'B0:00:00:00:00:01';
const A1 = 'A0:00:00:00:00:01';
const A2 = 'A0:00:00:00:00:02';
const A3 = 'A0:00:00:00:00:03';

describe('strongest anchor for a wristband', () => {
  beforeEach(() => clear());

  test('nobody has heard the wristband: null, never a guess', () => {
    assert.equal(strongestAnchor(TAG, 1000), null);
  });

  test('the anchor with the strongest signal is chosen', () => {
    recordHearing(TAG, A1, -75, 1000);
    recordHearing(TAG, A2, -52, 1000);
    recordHearing(TAG, A3, -68, 1000);
    assert.deepEqual(strongestAnchor(TAG, 1100), { anchorMac: A2, rssi: -52, heardBy: 3 });
  });

  test('one strong outlier does not decide: the median of recent readings does', () => {
    for (const rssi of [-70, -71, -40, -72, -70]) recordHearing(TAG, A1, rssi, 1000);
    for (const rssi of [-60, -61, -59, -60, -62]) recordHearing(TAG, A2, rssi, 1000);
    assert.equal(strongestAnchor(TAG, 1100).anchorMac, A2);
  });

  test(`a reading older than ${HEARD_WITHIN_MS} ms is not used`, () => {
    recordHearing(TAG, A1, -50, 1000);
    recordHearing(TAG, A2, -70, 1000 + HEARD_WITHIN_MS);
    assert.deepEqual(strongestAnchor(TAG, 1000 + HEARD_WITHIN_MS + 1), { anchorMac: A2, rssi: -70, heardBy: 1 });
    assert.equal(strongestAnchor(TAG, 1000 + 2 * HEARD_WITHIN_MS + 1), null);
  });

  test('readings from an earlier visit are forgotten when the wristband returns', () => {
    for (let i = 0; i < 5; i++) recordHearing(TAG, A1, -45, 1000);
    recordHearing(TAG, A1, -80, 1000 + HEARD_WITHIN_MS + 500);
    recordHearing(TAG, A2, -60, 1000 + HEARD_WITHIN_MS + 500);
    assert.equal(strongestAnchor(TAG, 1000 + HEARD_WITHIN_MS + 600).anchorMac, A2);
  });

  test('equal signals: the same anchor is chosen every time', () => {
    recordHearing(TAG, A2, -60, 1000);
    recordHearing(TAG, A1, -60, 1000);
    assert.equal(strongestAnchor(TAG, 1100).anchorMac, A1);
    assert.equal(strongestAnchor(TAG, 1200).anchorMac, A1);
  });

  test('another wristband is not affected', () => {
    recordHearing(TAG, A1, -50, 1000);
    assert.equal(strongestAnchor('B0:00:00:00:00:02', 1100), null);
  });

  test('invalid input is ignored', () => {
    recordHearing(TAG, A1, NaN, 1000);
    recordHearing(TAG, null, -50, 1000);
    recordHearing(null, A1, -50, 1000);
    assert.equal(strongestAnchor(TAG, 1100), null);
  });
});
