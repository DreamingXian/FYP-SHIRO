// Integration tests: wristband bindings decide which patient a reading belongs to.
// Uses shiro_test for MySQL. The InfluxDB part writes only points tagged
// patient_id=ITEST-* and deletes them afterwards; it is skipped when InfluxDB
// is not configured or not running.
const { db, freshDatabase, influxAvailable, deleteInfluxPatientPoints } = require('./helper');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const bindingService = require('../../services/binding_service');
const patientService = require('../../services/patient_service');
const deviceService = require('../../services/device_service');
const bindingCache = require('../../services/binding_cache');
const timeSeries = require('../../services/time_series_service');

const TAG = 'ITEST-TAG';
const MAC = 'AA:BB:CC:00:00:01';
const PATIENT_A = 'ITEST-A';
const PATIENT_B = 'ITEST-B';

async function addPatient(pool, id, nric) {
  await pool.query(
    `INSERT INTO patients (patient_id, full_name, nric_passport, dob, gender, phone_number, status)
     VALUES (?, ?, ?, '1990-01-01', 'OTHER', '0123456789', 'ADMITTED')`,
    [id, `Test ${id}`, nric]
  );
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

describe('binding cache follows bind, unbind, discharge and device removal', () => {
  let pool;
  before(async () => {
    pool = await freshDatabase();
    await addPatient(pool, PATIENT_A, 'ITESTA0001');
    await addPatient(pool, PATIENT_B, 'ITESTB0002');
    await pool.query(
      "INSERT INTO devices (device_id, mac_address, device_type, hardware_model) VALUES (?, ?, 'WRISTBAND', 'TEST')",
      [TAG, MAC]
    );
    await bindingCache.refresh();
  });
  after(async () => { await db.closePool(); });

  test('an unbound wristband belongs to nobody', () => {
    assert.equal(bindingCache.getPatientIdForDevice(TAG), null);
  });

  test('binding maps the wristband to patient A', async () => {
    await bindingService.bindPatientWristband(PATIENT_A, TAG, 'ITEST');
    assert.equal(bindingCache.getPatientIdForDevice(TAG), PATIENT_A);
    assert.equal(bindingCache.getPatientIdForDevice(TAG.toLowerCase()), PATIENT_A);
  });

  test('unbinding clears it immediately', async () => {
    await bindingService.unbindPatientWristband(TAG);
    assert.equal(bindingCache.getPatientIdForDevice(TAG), null);
  });

  test('rebinding to patient B maps to B only', async () => {
    await bindingService.bindPatientWristband(PATIENT_B, TAG, 'ITEST');
    assert.equal(bindingCache.getPatientIdForDevice(TAG), PATIENT_B);
  });

  test('discharging the patient releases the wristband', async () => {
    await patientService.dischargePatient(PATIENT_B);
    assert.equal(bindingCache.getPatientIdForDevice(TAG), null);
    const [[dev]] = await pool.query('SELECT availability_status FROM devices WHERE device_id = ?', [TAG]);
    assert.equal(dev.availability_status, 'AVAILABLE');
  });

  test('deleting a bound wristband removes the mapping', async () => {
    await bindingService.bindPatientWristband(PATIENT_A, TAG, 'ITEST');
    assert.equal(bindingCache.getPatientIdForDevice(TAG), PATIENT_A);
    await deviceService.deleteDevice(TAG);
    assert.equal(bindingCache.getPatientIdForDevice(TAG), null);
  });
});

describe('vitals history belongs to the patient, not the wristband (InfluxDB)', () => {
  let available = false;
  before(async () => {
    available = await influxAvailable();
    if (available) await deleteInfluxPatientPoints([PATIENT_A, PATIENT_B]);
  });
  after(async () => {
    if (available) await deleteInfluxPatientPoints([PATIENT_A, PATIENT_B]);
  });

  test('a reused wristband does not carry the previous patient\'s readings', async (t) => {
    if (!available) return t.skip('InfluxDB is not configured or not running');

    // The same wristband MAC is worn first by patient A, then by patient B
    for (const bpm of [70, 71, 72]) {
      timeSeries.logVitals({ patientId: PATIENT_A, wristbandMac: MAC, bpm, spo2: 98, mode: 'ITEST' });
    }
    await timeSeries.flushBuffer();
    for (const bpm of [90, 91]) {
      timeSeries.logVitals({ patientId: PATIENT_B, wristbandMac: MAC, bpm, spo2: 96, mode: 'ITEST' });
    }
    await timeSeries.flushBuffer();
    await sleep(300);

    const historyA = await timeSeries.queryVitalsHistory(PATIENT_A, '-10m');
    const historyB = await timeSeries.queryVitalsHistory(PATIENT_B, '-10m');

    assert.deepEqual(historyA.map(p => p.heart_rate), [70, 71, 72]);
    assert.deepEqual(historyB.map(p => p.heart_rate), [90, 91]);
  });

  test('readings sent in the same second are all stored', async (t) => {
    if (!available) return t.skip('InfluxDB is not configured or not running');
    // Covered by the assertions above (3 and 2 points written within one batch each);
    // this test states the requirement explicitly for the report.
    const historyA = await timeSeries.queryVitalsHistory(PATIENT_A, '-10m');
    assert.equal(historyA.length, 3);
  });
});
