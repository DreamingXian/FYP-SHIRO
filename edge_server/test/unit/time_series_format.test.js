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

describe('vitals points', () => {
  test('an unknown value is left out, never written as 0', () => {
    const line = timeSeries.buildVitalsLine({ patientId: 'P-007', wristbandMac: 'AA:BB', bpm: 72, spo2: null });
    assert.match(line, /heart_rate=72i/);
    assert.doesNotMatch(line, /spo2_percentage/);
  });

  test('no measured value means no point at all', () => {
    assert.equal(timeSeries.buildVitalsLine({ patientId: 'P-007', bpm: null, spo2: null }), null);
    assert.equal(timeSeries.buildVitalsLine({ patientId: 'P-007', bpm: 0, spo2: 0 }), null);
  });
});

describe('fall vector points', () => {
  test('only measured values are written', () => {
    const line = timeSeries.buildFallVectorLine({ wristbandMac: 'AA:BB', minG: 0, impactG: 4.371, stillG: null });
    assert.match(line, /accel_freefall_min_g=0\.00/);
    assert.match(line, /accel_impact_max_g=4\.37/);
    assert.doesNotMatch(line, /post_impact_motion_g/);
  });

  test('a fall with no measurements stores no point (no invented defaults)', () => {
    assert.equal(timeSeries.buildFallVectorLine({ wristbandMac: 'AA:BB' }), null);
  });
});

describe('vitals history parsing', () => {
  test('a point without heart rate comes back with heart_rate null', () => {
    const csv = [',result,table,_time,spo2_percentage', ',_result,0,2026-11-13T08:00:00Z,97.5'].join('\r\n');
    assert.deepEqual(timeSeries.parseVitalsCsv(csv), [{ time: '2026-11-13T08:00:00Z', heart_rate: null, spo2: 97.5 }]);
  });

  test('empty answers give no points', () => {
    assert.deepEqual(timeSeries.parseVitalsCsv(''), []);
    assert.deepEqual(timeSeries.parseVitalsCsv(null), []);
  });
});
