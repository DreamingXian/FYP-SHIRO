// Unit tests: time-series service with no InfluxDB token configured.
// An empty value set in the real environment takes precedence over .env.
process.env.INFLUX_TOKEN = '';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const timeSeries = require('../../services/time_series_service');

describe('time_series_service without INFLUX_TOKEN', () => {
  test('reports itself as disabled', () => {
    assert.equal(timeSeries.isEnabled(), false);
  });

  test('log calls are skipped without throwing', async () => {
    timeSeries.logVitals({ patientId: 'P-001', wristbandMac: 'AA:BB:CC:DD:EE:FF', bpm: 72, spo2: 98 });
    timeSeries.logTrajectory({ patientId: 'P-001', wristbandMac: 'AA:BB:CC:DD:EE:FF', posX: 1.2, posY: 3.4 });
    timeSeries.logFallVector({ wristbandMac: 'AA:BB:CC:DD:EE:FF', minG: 0.2, impactG: 3.1 });
    await timeSeries.flushBuffer();
  });

  test('history query returns no points and makes no network call', async () => {
    const points = await timeSeries.queryVitalsHistory('P-001', '-24h');
    assert.deepEqual(points, []);
  });
});
