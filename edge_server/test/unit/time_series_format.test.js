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

  test('covers the whole range with one point per window instead of cutting the list', () => {
    const windows = { '-1h': '10s', '-6h': '1m', '-24h': '5m', '-7d': '30m', '-30d': '2h' };
    for (const [range, every] of Object.entries(windows)) {
      const flux = timeSeries.buildVitalsHistoryQuery('P-007', range);
      assert.ok(flux.includes(`aggregateWindow(every: ${every},`), range);
      assert.ok(!flux.includes('limit(') && !flux.includes('tail('), 'a cut would hide one end of the range');
    }
  });

  test('merges the series of one patient before sorting by time', () => {
    // Readings of one patient are stored in one series per wristband and
    // sampling mode; sorted separately they come back as blocks, not in time order.
    const flux = timeSeries.buildVitalsHistoryQuery('P-007', '-1h');
    assert.ok(flux.indexOf('|> group()') !== -1 && flux.indexOf('|> group()') < flux.lastIndexOf('|> sort('));
  });

  test('a range that is not in the list is answered with the default range', () => {
    for (const range of ['-99y', '', null, undefined, 'constructor', '-1h) |> drop(']) {
      assert.deepEqual(timeSeries.resolveHistoryRange(range), { range: '-24h', window: '5m' }, String(range));
      assert.ok(timeSeries.buildVitalsHistoryQuery('P-007', range).includes('range(start: -24h)'), String(range));
    }
    assert.deepEqual(timeSeries.resolveHistoryRange('-1h'), { range: '-1h', window: '10s' });
  });

  test('raw readings: the newest points of the merged series, range format checked', () => {
    const flux = timeSeries.buildVitalsHistoryQuery('P-007', '-10m', { raw: true });
    assert.ok(flux.includes('range(start: -10m)'));
    assert.ok(flux.includes('tail(n: 1000)'));
    assert.ok(!flux.includes('aggregateWindow'));
    assert.ok(flux.indexOf('|> group()') !== -1 && flux.indexOf('|> group()') < flux.indexOf('|> sort('));
    const bad = timeSeries.buildVitalsHistoryQuery('P-007', '-1h) |> drop(', { raw: true });
    assert.ok(bad.includes('range(start: -24h)'));
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
