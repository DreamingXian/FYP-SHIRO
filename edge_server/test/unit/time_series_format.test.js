// Unit tests: time-series timestamps and the vitals history query (no network)
process.env.INFLUX_TOKEN = '';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const timeSeries = require('../../services/time_series_service');

describe('point timestamps', () => {
  test('are in milliseconds and close to the current time', () => {
    const ts = timeSeries.nextTimestampMs();
    assert.ok(Math.abs(ts - Date.now()) < 2000, `unexpected timestamp ${ts}`);
  });

  test('are strictly increasing, even within the same millisecond', () => {
    let prev = timeSeries.nextTimestampMs();
    for (let i = 0; i < 5000; i++) {
      const ts = timeSeries.nextTimestampMs();
      assert.ok(ts > prev, 'two points must never share a timestamp');
      prev = ts;
    }
  });
});

describe('vitals history query', () => {
  test('filters on the patient ID and the requested range', () => {
    const flux = timeSeries.buildVitalsHistoryQuery('P-007', '-6h');
    assert.match(flux, /r\.patient_id == "P-007"/);
    assert.match(flux, /range\(start: -6h\)/);
    assert.match(flux, /_measurement == "patient_vitals"/);
  });

  test('never matches on the wristband, so a reused wristband cannot leak history', () => {
    const flux = timeSeries.buildVitalsHistoryQuery('P-007', '-24h');
    assert.doesNotMatch(flux, /wristband_mac/);
    assert.doesNotMatch(flux, / or r\.patient_id/);
  });
});
