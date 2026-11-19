// Integration test: the nursing shift summary report (GET /api/reports/shift-summary),
// on the running server against shiro_test. A test ward with patients, wristbands and
// incidents around yesterday's morning shift: who is in the census, admissions and
// discharges, bindings in the shift, incidents and ATTN, vitals "not available"
// (the test server runs without InfluxDB), parameter checks, sign-in and the audit.
// The InfluxDB vitals summary is tested in-process when InfluxDB is running.
const { db, freshDatabase, startServer, signIn, pairHeadset, TEST_NURSE, influxAvailable, deleteInfluxPatientPoints } = require('./helper');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const shifts = require('../../config/shifts');
const { shiftWindow, dayText } = require('../../services/reports/shift_rules');
const patientService = require('../../services/patient_service');
const timeSeries = require('../../services/time_series_service');

const HTTP_PORT = 3987;
const MQTT_PORT = 1877;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const WARD = 'WARD-ITS';
const OTHER_WARD = 'WARD-ITS2';

const H = 3600 * 1000;
const yesterday = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return dayText(d); })();
const win = shiftWindow(shifts, yesterday, 'MORNING');
const at = (hoursFromStart) => new Date(win.start.getTime() + hoursFromStart * H);

function call(path, { cookie, bearer } = {}) {
  return fetch(BASE + path, {
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }
  });
}

async function addWard(pool, id, title) {
  await pool.query('INSERT INTO ward_rooms (ward_id, room_title) VALUES (?, ?)', [id, title]);
  for (const [bed, code] of [['B1', 'BED-1'], ['B2', 'BED-2'], ['B3', 'BED-3']]) {
    await pool.query('INSERT INTO ward_beds (bed_id, ward_id, bed_code, x, y) VALUES (?, ?, ?, 1, 1)', [bed, id, code]);
  }
}

async function addPatient(pool, { id, name, ward, bed, admitted, discharged = null, dischargedFromWard = null, risk = 'LOW' }) {
  await pool.query(
    `INSERT INTO patients (patient_id, full_name, nric_passport, dob, gender, phone_number, status,
       assigned_ward_id, assigned_bed_id, admission_date, discharge_date, discharged_from_ward_id, discharged_from_bed_id, fall_risk_score)
     VALUES (?, ?, ?, '1950-01-01', 'OTHER', '0123456789', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name, `NRIC-${id}`, discharged ? 'DISCHARGED' : 'ADMITTED',
      discharged ? null : ward, discharged ? null : bed, admitted, discharged,
      dischargedFromWard, dischargedFromWard ? bed : null, risk]
  );
}

async function addIncident(pool, { id, patient, name, ward, hours, category = 'FALL_ACCIDENT', simulated = 0, ackSeconds = null, by = null, notes = null }) {
  const time = at(hours);
  await pool.query(
    `INSERT INTO emergency_incident_logs (incident_id, patient_id, patient_name, ward_id, incident_category, trigger_timestamp,
       is_simulated, resolution_status, acknowledgment_time, response_latency_seconds, attending_clinician, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, patient, name, ward, category, time, simulated, ackSeconds === null ? 'PENDING' : 'ACKNOWLEDGED',
      ackSeconds === null ? null : new Date(time.getTime() + ackSeconds * 1000), ackSeconds, by, notes]
  );
}

describe('shift summary report', () => {
  let server;
  let pool;
  let nurse;
  let headsetToken;

  before(async () => {
    pool = await freshDatabase();
    await addWard(pool, WARD, 'Report Test Ward');
    await addWard(pool, OTHER_WARD, 'Other Test Ward');
    await pool.query("INSERT INTO ward_anchors (anchor_id, ward_id, device_id, x, y) VALUES ('ITS-A1', ?, NULL, 0, 0)", [WARD]);

    // In the ward during the whole shift
    await addPatient(pool, { id: 'ITS-P1', name: 'Present All Shift', ward: WARD, bed: 'B1', admitted: at(-48), risk: 'HIGH' });
    // Admitted during the shift
    await addPatient(pool, { id: 'ITS-P2', name: 'Admitted In Shift', ward: WARD, bed: 'B2', admitted: at(1) });
    // Discharged during the shift (its ward is kept as "discharged from")
    await addPatient(pool, { id: 'ITS-P3', name: 'Discharged In Shift', ward: WARD, bed: 'B3', admitted: at(-30), discharged: at(2), dischargedFromWard: WARD });
    // Not in the census: discharged before the shift, admitted after it, another ward
    await addPatient(pool, { id: 'ITS-P4', name: 'Gone Before', ward: WARD, bed: 'B3', admitted: at(-50), discharged: at(-1), dischargedFromWard: WARD });
    await addPatient(pool, { id: 'ITS-P5', name: 'Came After', ward: WARD, bed: 'B3', admitted: at(9) });
    await addPatient(pool, { id: 'ITS-P6', name: 'Other Ward', ward: OTHER_WARD, bed: 'B1', admitted: at(-48) });

    // Wristbands: P1 bound before the shift and still bound; P2 bound and unbound during it
    for (const [id, mac] of [['ITS-TAG1', 'AA:BB:CC:00:20:01'], ['ITS-TAG2', 'AA:BB:CC:00:20:02']]) {
      await pool.query("INSERT INTO devices (device_id, mac_address, device_type, hardware_model, battery_level) VALUES (?, ?, 'WRISTBAND', 'TEST', 77)", [id, mac]);
    }
    await pool.query("INSERT INTO patient_bindings (patient_id, device_id, wristband_mac, bound_at, status) VALUES ('ITS-P1', 'ITS-TAG1', 'AA:BB:CC:00:20:01', ?, 'ACTIVE')", [at(-24)]);
    await pool.query("INSERT INTO patient_bindings (patient_id, device_id, wristband_mac, bound_at, unbound_at, status) VALUES ('ITS-P2', 'ITS-TAG2', 'AA:BB:CC:00:20:02', ?, ?, 'UNBOUND')", [at(1.5), at(5)]);

    // Incidents
    await addIncident(pool, { id: 'ITS-I1', patient: 'ITS-P1', name: 'Present All Shift', ward: WARD, hours: 3, ackSeconds: 45, by: 'Nurse Lim (CLN-002)', notes: 'helped back to bed' });
    await addIncident(pool, { id: 'ITS-I2', patient: 'ITS-P2', name: 'Admitted In Shift', ward: WARD, hours: 4, category: 'CRITICAL_VITALS' });
    await addIncident(pool, { id: 'ITS-I3', patient: 'ITS-P1', name: 'Present All Shift', ward: WARD, hours: 5, simulated: 1, ackSeconds: 10, by: 'x' });
    await addIncident(pool, { id: 'ITS-I4', patient: 'ITS-P6', name: 'Other Ward', ward: OTHER_WARD, hours: 3 });
    await addIncident(pool, { id: 'ITS-I5', patient: 'ITS-P1', name: 'Present All Shift', ward: WARD, hours: -2 });
    await db.closePool();

    server = startServer({ HTTP_PORT: String(HTTP_PORT), MQTT_PORT: String(MQTT_PORT) });
    await server.ready;
    nurse = await signIn(BASE, TEST_NURSE);
    headsetToken = await pairHeadset(BASE, await signIn(BASE), 'QUEST3-ITS001', 'AA:BB:CC:DD:EE:92');
    pool = db.getPool();
  });

  after(async () => {
    if (server) await server.stop();
    await db.closePool();
  });

  async function report(query = `ward_id=${WARD}&date=${yesterday}&shift=MORNING`) {
    const res = await call(`/api/reports/shift-summary?${query}`, { cookie: nurse });
    const data = await res.json();
    return { status: res.status, data };
  }

  test('the shifts and the one running now', async () => {
    const res = await call('/api/reports/shifts', { cookie: nurse });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data.shifts.map(s => s.key), ['MORNING', 'EVENING', 'NIGHT']);
    assert.ok(['MORNING', 'EVENING', 'NIGHT'].includes(data.current.shift));
    assert.match(data.current.day, /^\d{4}-\d{2}-\d{2}$/);
  });

  test('header: ward, shift window (a finished shift), who made it', async () => {
    const { status, data } = await report();
    assert.equal(status, 200);
    const r = data.report;
    assert.equal(r.ward.ward_id, WARD);
    assert.equal(r.ward.beds_total, 3);
    assert.equal(r.shift.key, 'MORNING');
    assert.equal(r.shift.day, yesterday);
    assert.equal(new Date(r.shift.start).getTime(), win.start.getTime());
    assert.equal(new Date(r.shift.end).getTime(), win.end.getTime());
    assert.equal(r.shift.in_progress, false);
    assert.match(r.generated.by, /^Integration Nurse \(CLN-\d+\)$/);
  });

  test('census: present all shift, admitted and discharged in the shift; not the others', async () => {
    const r = (await report()).data.report;
    assert.deepEqual(r.patients.map(p => p.patient_id).sort(), ['ITS-P1', 'ITS-P2', 'ITS-P3']);
    const byId = Object.fromEntries(r.patients.map(p => [p.patient_id, p]));
    assert.equal(byId['ITS-P2'].admitted_in_shift, true);
    assert.equal(byId['ITS-P3'].discharged_in_shift, true);
    assert.equal(byId['ITS-P3'].in_ward_at_end, false);
    assert.equal(byId['ITS-P3'].bed_code, 'BED-3');            // the bed it was discharged from
    assert.equal(r.census.patients_during_shift, 3);
    assert.equal(r.census.in_ward_at_end, 2);
    assert.equal(r.census.beds_occupied_at_end, 2);
    assert.equal(r.census.admissions, 1);
    assert.equal(r.census.discharges, 1);
  });

  test('wristbands of the shift come from the binding history', async () => {
    const r = (await report()).data.report;
    const byId = Object.fromEntries(r.patients.map(p => [p.patient_id, p]));
    assert.deepEqual(byId['ITS-P1'].wristbands.map(w => [w.device_id, w.status]), [['ITS-TAG1', 'ACTIVE']]);
    assert.deepEqual(byId['ITS-P2'].wristbands.map(w => [w.device_id, w.status]), [['ITS-TAG2', 'UNBOUND']]);
    assert.equal(r.census.bindings_started, 1);
    assert.equal(r.census.bindings_ended, 1);
    assert.equal(r.census.wristbands_bound_now, 1);
    assert.deepEqual(r.devices_now.wristbands.map(w => [w.device_id, w.battery_level]), [['ITS-TAG1', 77]]);
    assert.deepEqual(r.devices_now.anchors.map(a => [a.anchor_id, a.status]), [['ITS-A1', 'NO DEVICE']]);
  });

  test('incidents of the shift and ward; Live Lab tests listed but not counted; ATTN with reasons', async () => {
    const r = (await report()).data.report;
    assert.deepEqual(r.incidents.list.map(i => i.incident_id), ['ITS-I1', 'ITS-I2', 'ITS-I3']);
    assert.equal(r.incidents.list.find(i => i.incident_id === 'ITS-I3').simulated, true);
    const s = r.incidents.summary;
    assert.deepEqual([s.total, s.falls, s.critical_vitals, s.pending, s.live_lab_tests], [2, 1, 1, 1, 1]);
    assert.equal(s.avg_response_seconds, 45);
    const byId = Object.fromEntries(r.patients.map(p => [p.patient_id, p]));
    assert.equal(byId['ITS-P1'].attention.length, 1);
    assert.match(byId['ITS-P1'].attention[0], /^fall at \d{2}:\d{2}$/);
    assert.deepEqual(byId['ITS-P2'].attention.map(a => a.replace(/\d{2}:\d{2}/, 'HH:MM')),
      ['critical vitals alarm at HH:MM', 'alert of HH:MM still waiting for a response']);
    assert.deepEqual(byId['ITS-P3'].attention, []);
  });

  test('without InfluxDB the vitals are "not available" with the reason, never zeros', async () => {
    const r = (await report()).data.report;
    assert.equal(r.vitals_source.available, false);
    assert.match(r.vitals_source.reason, /InfluxDB/);
    for (const p of r.patients) {
      assert.equal(p.heart_rate, null);
      assert.equal(p.spo2, null);
    }
  });

  test('bad requests: 400 with a message', async () => {
    const expect400 = async (query, pattern) => {
      const { status, data } = await report(query);
      assert.equal(status, 400, query);
      assert.match(data.error, pattern);
    };
    await expect400(`ward_id=NO-SUCH-WARD&date=${yesterday}&shift=MORNING`, /not found/);
    await expect400(`ward_id=${WARD}&date=2026-02-30&shift=MORNING`, /YYYY-MM-DD/);
    await expect400(`ward_id=${WARD}&date=${yesterday}&shift=LUNCH`, /shift/);
    await expect400(`date=${yesterday}&shift=MORNING`, /ward_id/);
    const nextYear = `${new Date().getFullYear() + 1}-01-01`;
    await expect400(`ward_id=${WARD}&date=${nextYear}&shift=MORNING`, /has not started/);
  });

  test('without a date and shift: the shift running now (in progress)', async () => {
    const { status, data } = await report(`ward_id=${WARD}`);
    assert.equal(status, 200);
    assert.equal(data.report.shift.in_progress, true);
  });

  test('not signed in: 401; a headset: 403', async () => {
    assert.equal((await call(`/api/reports/shift-summary?ward_id=${WARD}`)).status, 401);
    assert.equal((await call(`/api/reports/shift-summary?ward_id=${WARD}`, { bearer: headsetToken })).status, 403);
  });

  test('each report is in the audit log', async () => {
    await report();
    await new Promise(r => setTimeout(r, 300));
    const [rows] = await pool.query("SELECT target_type, target_id, details FROM audit_log WHERE action = 'SHIFT_REPORT' ORDER BY audit_id DESC LIMIT 1");
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].target_type, rows[0].target_id], ['WARD', WARD]);
    assert.deepEqual(JSON.parse(rows[0].details), { date: yesterday, shift: 'MORNING', patients: 3 });
  });
});

describe('discharge keeps the ward for the shift report', () => {
  after(async () => { await db.closePool(); });

  test('discharging records the ward and bed the patient left', async () => {
    const pool = await freshDatabase();
    await addWard(pool, WARD, 'Report Test Ward');
    await addPatient(pool, { id: 'ITS-D1', name: 'To Discharge', ward: WARD, bed: 'B2', admitted: at(-5) });
    await patientService.dischargePatient('ITS-D1', 'Nurse Test (CLN-009)');
    const [[p]] = await pool.query('SELECT assigned_ward_id, assigned_bed_id, discharged_from_ward_id, discharged_from_bed_id FROM patients WHERE patient_id = ?', ['ITS-D1']);
    assert.deepEqual([p.assigned_ward_id, p.assigned_bed_id], [null, null]);
    assert.deepEqual([p.discharged_from_ward_id, p.discharged_from_bed_id], [WARD, 'B2']);
  });

  test('a database from before gains the two columns; earlier discharges stay "not recorded"', async () => {
    let pool = await freshDatabase();
    await pool.query('ALTER TABLE patients DROP COLUMN discharged_from_ward_id, DROP COLUMN discharged_from_bed_id');
    pool = await require('./helper').restart();
    const [cols] = await pool.query("SHOW COLUMNS FROM patients WHERE Field IN ('discharged_from_ward_id', 'discharged_from_bed_id')");
    assert.equal(cols.length, 2);
  });
});

describe('vitals summary from InfluxDB (in-process, when InfluxDB is running)', () => {
  const A = 'ITEST-SHIFT-A';
  const B = 'ITEST-SHIFT-B';
  let available = false;
  before(async () => {
    available = await influxAvailable();
    if (available) await deleteInfluxPatientPoints([A, B]);
  });
  after(async () => {
    if (available) await deleteInfluxPatientPoints([A, B]);
    await timeSeries.closeTimeSeries();
  });

  test('min, mean, max and count per patient; a patient with no readings has none', async (t) => {
    if (!available) return t.skip('InfluxDB is not configured or not running');
    const start = new Date(Date.now() - 60 * 1000);
    for (const [bpm, spo2] of [[60, 95], [80, 97], [100, 96]]) {
      timeSeries.logVitals({ patientId: A, wristbandMac: 'AA:BB:CC:00:30:01', bpm, spo2, mode: 'ITEST' });
    }
    await timeSeries.flushBuffer();
    await new Promise(r => setTimeout(r, 300));
    const result = await timeSeries.queryVitalsStats([A, B], start, new Date(Date.now() + 60 * 1000));
    assert.equal(result.available, true);
    assert.deepEqual(result.stats[A].heart_rate, { min: 60, max: 100, mean: 80, count: 3 });
    assert.equal(result.stats[A].spo2.min, 95);
    assert.equal(result.stats[A].spo2.max, 97);
    assert.equal(result.stats[B], undefined);
  });
});
