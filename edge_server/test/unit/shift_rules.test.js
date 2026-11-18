// Unit tests: shift windows, the shift running now, ATTN reasons (services/reports/shift_rules.js),
// and the InfluxDB vitals summary query and its parsing (services/time_series_service.js).
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { checkShifts, parseDay, shiftWindow, currentShift, roundStats, attentionReasons } = require('../../services/reports/shift_rules');
const shifts = require('../../config/shifts');
const thresholds = require('../../config/clinical_thresholds');
const ts = require('../../services/time_series_service');

const local = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi);

describe('shifts', () => {
  test('the configured shifts cover 24 hours', () => {
    assert.doesNotThrow(() => checkShifts(shifts));
  });

  test('a gap or an overlap is refused', () => {
    assert.throws(() => checkShifts([{ key: 'A', start: '07:00', end: '15:00' }, { key: 'B', start: '15:00', end: '23:00' }]), /16 hours/);
    assert.throws(() => checkShifts([{ key: 'A', start: '07:00', end: '19:00' }, { key: 'B', start: '15:00', end: '07:00' }]), /not 24/);
    assert.throws(() => checkShifts([{ key: 'A', start: '7:00', end: '07:00' }]), /HH:MM/);
  });

  test('morning and evening start and end on the same day', () => {
    const m = shiftWindow(shifts, '2026-11-19', 'MORNING');
    assert.deepEqual([m.start, m.end], [local(2026, 11, 19, 7), local(2026, 11, 19, 15)]);
    const e = shiftWindow(shifts, '2026-11-19', 'EVENING');
    assert.deepEqual([e.start, e.end], [local(2026, 11, 19, 15), local(2026, 11, 19, 23)]);
  });

  test('the night shift ends the next morning, also across a month and a year', () => {
    const n = shiftWindow(shifts, '2026-11-30', 'NIGHT');
    assert.deepEqual([n.start, n.end], [local(2026, 11, 30, 23), local(2026, 12, 1, 7)]);
    const ny = shiftWindow(shifts, '2026-12-31', 'NIGHT');
    assert.deepEqual(ny.end, local(2027, 1, 1, 7));
  });

  test('unknown shift or a date that is not a calendar day is refused', () => {
    assert.throws(() => shiftWindow(shifts, '2026-11-19', 'LUNCH'), /Unknown shift/);
    assert.throws(() => shiftWindow(shifts, '2026-02-30', 'MORNING'), /not a date/);
    assert.equal(parseDay('2026-11-19').d, 19);
    assert.equal(parseDay('19/11/2026'), null);
    assert.equal(parseDay('2026-13-01'), null);
  });

  test('the shift running now; after midnight it is the night shift of the day before', () => {
    assert.equal(currentShift(shifts, local(2026, 11, 19, 7, 0)).shift.key, 'MORNING');
    assert.equal(currentShift(shifts, local(2026, 11, 19, 14, 59)).shift.key, 'MORNING');
    assert.equal(currentShift(shifts, local(2026, 11, 19, 15, 0)).shift.key, 'EVENING');
    const late = currentShift(shifts, local(2026, 11, 19, 23, 30));
    assert.deepEqual([late.shift.key, late.day], ['NIGHT', '2026-11-19']);
    const early = currentShift(shifts, local(2026, 11, 20, 2, 0));
    assert.deepEqual([early.shift.key, early.day], ['NIGHT', '2026-11-19']);
    assert.equal(currentShift(shifts, local(2026, 11, 20, 6, 59)).day, '2026-11-19');
  });
});

describe('ATTN reasons', () => {
  const v = thresholds.vitals;
  const at = (d) => d;

  test('nothing in the shift: no flag', () => {
    assert.deepEqual(attentionReasons({ incidents: [], heartRate: { min: 60, max: 95 } }, v, at), []);
    assert.deepEqual(attentionReasons({}, v, at), []);
  });

  test('a fall, a critical vitals alarm, a ward exit and an unanswered alert are named', () => {
    const reasons = attentionReasons({
      incidents: [
        { incident_category: 'FALL_ACCIDENT', trigger_timestamp: '09:05', resolution_status: 'ACKNOWLEDGED' },
        { incident_category: 'CRITICAL_VITALS', trigger_timestamp: '10:00', resolution_status: 'PENDING' },
        { incident_category: 'GEOFENCE_BREACH', trigger_timestamp: '11:30', resolution_status: 'RESOLVED' }
      ]
    }, v, at);
    assert.deepEqual(reasons, [
      'fall at 09:05',
      'critical vitals alarm at 10:00',
      'alert of 10:00 still waiting for a response',
      'left the ward at 11:30'
    ]);
  });

  test('Live Lab tests never flag a patient', () => {
    assert.deepEqual(attentionReasons({ incidents: [{ incident_category: 'FALL_ACCIDENT', trigger_timestamp: 'x', is_simulated: 1, resolution_status: 'PENDING' }] }, v, at), []);
  });

  test('heart rate outside the abnormal limits of the alarm settings', () => {
    const high = attentionReasons({ heartRate: { min: 70, max: v.moderate.bpmHigh + 14 } }, v, at);
    assert.deepEqual(high, [`heart rate up to ${v.moderate.bpmHigh + 14} bpm (above ${v.moderate.bpmHigh})`]);
    const low = attentionReasons({ heartRate: { min: v.moderate.bpmLow - 5, max: 80 } }, v, at);
    assert.deepEqual(low, [`heart rate down to ${v.moderate.bpmLow - 5} bpm (below ${v.moderate.bpmLow})`]);
    assert.deepEqual(attentionReasons({ heartRate: { min: v.moderate.bpmLow, max: v.moderate.bpmHigh } }, v, at), []);
  });

  test('a low SpO2 flags only when SpO2 alarms are switched on (it is indicative)', () => {
    const low = { spo2: { min: 80, max: 95 } };
    assert.deepEqual(attentionReasons(low, { ...v, spo2AlarmsEnabled: false }, at), []);
    assert.deepEqual(attentionReasons(low, { ...v, spo2AlarmsEnabled: true }, at), [`SpO2 down to 80 % (below ${v.moderate.spo2Low})`]);
  });

  test('statistics: rounded; no readings stays "not measured" (null)', () => {
    assert.deepEqual(roundStats({ min: 61.2, mean: 74.46, max: 98.9, count: 120 }, 0), { min: 61, mean: 74, max: 99, count: 120 });
    assert.equal(roundStats(undefined, 0), null);
    assert.equal(roundStats({ count: 0 }, 0), null);
  });
});

describe('vitals summary query (InfluxDB)', () => {
  const start = new Date('2026-11-19T07:00:00Z');
  const end = new Date('2026-11-19T15:00:00Z');

  test('names each patient, the time range and both fields', () => {
    const q = ts.buildVitalsStatsQuery(['P-001', 'P-002'], start, end);
    assert.match(q, /range\(start: 2026-11-19T07:00:00\.000Z, stop: 2026-11-19T15:00:00\.000Z\)/);
    assert.match(q, /r\.patient_id == "P-001" or r\.patient_id == "P-002"/);
    assert.match(q, /r\._field == "heart_rate" or r\._field == "spo2_percentage"/);
    for (const stat of ['min', 'max', 'mean', 'count']) assert.match(q, new RegExp(`value: "${stat}"`));
  });

  test('an ID that could change the query is refused; so is an empty list or a reversed range', () => {
    assert.throws(() => ts.buildVitalsStatsQuery(['P-001" or r._measurement == "x'], start, end), /valid patient ID/);
    assert.throws(() => ts.buildVitalsStatsQuery([], start, end), /At least one/);
    assert.throws(() => ts.buildVitalsStatsQuery(['P-001'], end, start), /start before its end/);
  });

  test('the CSV answer becomes min, mean, max and count per patient and field', () => {
    const csv = [
      '#group,false,false,false,false,false,false',
      ',result,table,_field,_value,patient_id,stat',
      ',_result,0,heart_rate,61,P-001,min',
      ',_result,0,heart_rate,99,P-001,max',
      ',_result,0,heart_rate,74.46,P-001,mean',
      ',_result,0,heart_rate,120,P-001,count',
      ',_result,0,spo2_percentage,93.5,P-001,min',
      ',_result,0,heart_rate,70,P-002,min',
      ''
    ].join('\r\n');
    const parsed = ts.parseVitalsStatsCsv(csv);
    assert.deepEqual(parsed['P-001'].heart_rate, { min: 61, max: 99, mean: 74.46, count: 120 });
    assert.deepEqual(parsed['P-001'].spo2, { min: 93.5 });
    assert.deepEqual(parsed['P-002'].heart_rate, { min: 70 });
    assert.deepEqual(ts.parseVitalsStatsCsv(''), {});
  });
});
