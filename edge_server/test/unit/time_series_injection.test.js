// Unit tests: no value from outside can change a time-series query or add a point (no network).
process.env.INFLUX_TOKEN = '';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const timeSeries = require('../../services/time_series_service');

describe('vitals history query', () => {
  test('a patient ID that is not a plain identifier never reaches the query text', () => {
    const attempts = [
      'P-001" or r._measurement == "spatial_trajectories',
      'P-001") |> drop(columns: ["_value"]) //',
      'P-001\n  |> yield()',
      '', null, undefined, {}, 7
    ];
    for (const id of attempts) {
      assert.throws(() => timeSeries.buildVitalsHistoryQuery(id, '-1h'), /valid patient ID/, String(id));
      assert.throws(() => timeSeries.buildVitalsHistoryQuery(id, '-10m', { raw: true }), /valid patient ID/, String(id));
    }
  });

  test('an invalid patient ID is refused even when time-series logging is off', async () => {
    await assert.rejects(timeSeries.queryVitalsHistory('P-001" or true or "', '-1h'), /valid patient ID/);
  });

  test('only the listed ranges are known', () => {
    for (const range of ['-1h', '-6h', '-24h', '-7d', '-30d']) assert.equal(timeSeries.isHistoryRange(range), true, range);
    for (const range of ['-2h', '1h', '-1h) |> drop(', 'constructor', 'toString', '', null, undefined, 5]) {
      assert.equal(timeSeries.isHistoryRange(range), false, String(range));
    }
  });
});

describe('tag values of a stored point', () => {
  test('plain values are unchanged', () => {
    assert.equal(timeSeries.escapeTag('P-001', 'X'), 'P-001');
    assert.equal(timeSeries.escapeTag('58:E6:C5:1B:80:4E', 'X'), '58:E6:C5:1B:80:4E');
    assert.equal(timeSeries.escapeTag('PASSIVE_3MIN', 'X'), 'PASSIVE_3MIN');
  });

  test('commas, equals signs and spaces are escaped', () => {
    assert.equal(timeSeries.escapeTag('a b,c=d', 'X'), 'a\\ b\\,c\\=d');
  });

  test('line breaks, control characters and backslashes are removed', () => {
    assert.equal(timeSeries.escapeTag('P-001\nfake_measurement value=1', 'X'), 'P-001fake_measurement\\ value\\=1');
    assert.equal(timeSeries.escapeTag('a\r\n\t\u0000b\\', 'X'), 'ab');
  });

  test('an empty or missing value becomes the fallback', () => {
    for (const value of ['', '   ', null, undefined, '\n']) assert.equal(timeSeries.escapeTag(value, 'UNKNOWN_MAC'), 'UNKNOWN_MAC');
  });

  test('a hostile value cannot add a tag, a field or a second point to a line', () => {
    const line = timeSeries.buildVitalsLine({
      patientId: 'P-001,sampling_mode=FAKE heart_rate=250i\nother,patient_id=P-002 heart_rate=1i',
      wristbandMac: 'AA BB',
      bpm: 72,
      mode: 'PASSIVE_3MIN'
    });
    assert.equal(line.split('\n').length, 1, 'one point only');
    // Unescaped spaces separate the tags, the fields and nothing else
    const parts = line.split(/(?<!\\) /);
    assert.equal(parts.length, 2, 'tags and fields');
    assert.match(parts[1], /^heart_rate=72i,ppg_signal_quality=0\.95$/);
    // Unescaped commas separate the measurement and its three tags
    assert.equal(parts[0].split(/(?<!\\),/).length, 4);
  });

  test('positions and fall measurements escape their tags too', () => {
    const fall = timeSeries.buildFallVectorLine({ wristbandMac: 'AA,x=1 y', impactG: 4.2 });
    assert.match(fall, /^kinematic_fall_vectors,wristband_mac=AA\\,x\\=1\\ y,alert_level=CRITICAL accel_impact_max_g=4\.20$/);
  });
});
