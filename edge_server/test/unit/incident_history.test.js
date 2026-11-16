// Unit tests: the incident history filter (services/alerts/incident_history.js)
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { HISTORY_RANGES, buildHistoryFilter, normalizeSummary } = require('../../services/alerts/incident_history');

describe('incident history filter', () => {
  test('no filter: every incident', () => {
    assert.deepEqual(buildHistoryFilter(), { where: '', params: [] });
  });

  test('one patient in the last 7 days, falls only, without Live Lab tests', () => {
    const { where, params } = buildHistoryFilter({ patientId: 'P-007', range: '7d', category: 'FALL_ACCIDENT', includeSimulated: false });
    assert.equal(where, 'WHERE patient_id = ? AND trigger_timestamp >= NOW() - INTERVAL ? HOUR AND incident_category = ? AND is_simulated = 0');
    assert.deepEqual(params, ['P-007', 168, 'FALL_ACCIDENT']);
  });

  test('every value goes in as a parameter, never into the SQL text', () => {
    const { where } = buildHistoryFilter({ patientId: "P-1' OR '1'='1", range: '24h' });
    assert.ok(!where.includes('P-1'));
  });

  test('ranges are the ones the dashboard offers', () => {
    assert.deepEqual(Object.keys(HISTORY_RANGES), ['24h', '7d', '30d', 'all']);
    assert.equal(buildHistoryFilter({ range: '30d' }).params[0], 720);
    assert.equal(buildHistoryFilter({ range: 'all' }).where, '');
  });

  test('an unknown range or category is refused', () => {
    assert.throws(() => buildHistoryFilter({ range: '1y' }), /range/);
    assert.throws(() => buildHistoryFilter({ range: 'constructor' }), /range/);
    assert.throws(() => buildHistoryFilter({ category: 'FIRE' }), /category/);
  });
});

describe('incident history summary', () => {
  test('MySQL strings become numbers', () => {
    const s = normalizeSummary({
      total: 5, falls: '3', critical_vitals: '1', geofence: '1', pending: '1', acknowledged: '4',
      simulated: '2', avg_response_seconds: '42.3333', max_response_seconds: 90
    });
    assert.deepEqual(s, {
      total: 5, falls: 3, critical_vitals: 1, geofence: 1, pending: 1, acknowledged: 4,
      simulated: 2, avg_response_seconds: 42.3, max_response_seconds: 90
    });
  });

  test('no incidents: counts are 0, response times stay unknown (null), not 0 s', () => {
    const s = normalizeSummary({ total: 0, falls: null, pending: null, avg_response_seconds: null, max_response_seconds: null });
    assert.equal(s.total, 0);
    assert.equal(s.falls, 0);
    assert.equal(s.avg_response_seconds, null);
    assert.equal(s.max_response_seconds, null);
  });
});
