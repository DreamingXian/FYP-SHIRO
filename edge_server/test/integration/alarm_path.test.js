// Integration tests: the alarm path from telemetry to the incident audit log (uses shiro_test).
// Time-series logging is switched off for this file, so nothing is written to InfluxDB.
process.env.INFLUX_TOKEN = '';

const { db, freshDatabase, restart } = require('./helper');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const alertService = require('../../services/alert_service');
const thresholds = require('../../config/clinical_thresholds');
const { normalizeTelemetry } = require('../../services/telemetry/normalize');

/** Telemetry as the server sees it after an anchor publishes a protocol 2 packet. */
function telemetry(extra = {}) {
  return normalizeTelemetry({
    v: 2, bpm: 76, spo2: 98, battery: 90, charging: false, motion: 'STATIONARY', g: 1.0,
    touch: 1, active: false, fall: false, fall_seq: 0,
    impact_g: 0, freefall_g: 0, still_g: 0, imu_fault: false, ppg_fault: false,
    ...extra
  });
}

function fall(seq, extra = {}) {
  return telemetry({ fall: true, motion: 'FALL_EMERGENCY', fall_seq: seq, impact_g: 4.2, freefall_g: 0.15, still_g: 0.07, ...extra });
}

describe('alarm path', () => {
  let pool;

  async function incidentsFor(mac) {
    const [rows] = await pool.query(
      'SELECT * FROM emergency_incident_logs WHERE wristband_mac = ? ORDER BY trigger_timestamp, incident_id', [mac]
    );
    return rows;
  }

  before(async () => { pool = await freshDatabase(); });
  after(async () => { await db.closePool(); });

  test('one fall heard by three anchors at the same moment is stored once', async () => {
    const mac = 'IT:FA:11:00:00:01';
    // Three anchors, same instant, then the 45-second repeat stream
    const first = await Promise.all([
      alertService.evaluateTelemetry(fall(21), 'IT-WB-1', mac),
      alertService.evaluateTelemetry(fall(21), 'IT-WB-1', mac),
      alertService.evaluateTelemetry(fall(21), 'IT-WB-1', mac)
    ]);
    const repeats = await Promise.all(
      Array.from({ length: 60 }, () => alertService.evaluateTelemetry(fall(21), 'IT-WB-1', mac))
    );

    assert.equal(first.filter(Boolean).length, 1, 'exactly one of the three packets opens the incident');
    assert.equal(repeats.filter(Boolean).length, 0);

    const rows = await incidentsFor(mac);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].incident_category, 'FALL_ACCIDENT');
  });

  test('the measured fall values are stored as reported by the wristband', async () => {
    const mac = 'IT:FA:11:00:00:02';
    const incident = await alertService.evaluateTelemetry(fall(5, { bpm: 104, spo2: 95 }), 'IT-WB-2', mac);
    assert.equal(incident.persisted, true);

    const [row] = await incidentsFor(mac);
    assert.ok(Math.abs(row.kinematic_impact_force - 4.2) < 0.001);
    assert.ok(Math.abs(row.post_impact_stillness - 0.07) < 0.001);
    assert.ok(Math.abs(row.freefall_min_g - 0.15) < 0.001);
    assert.equal(incident.freefall_min_g, 0.15, 'the live alert carries the free-fall minimum for the pop-up');
    assert.match(row.alert_message, /free-fall minimum 0\.15 g/);
    assert.equal(row.heart_rate, 104);
    assert.equal(Number(row.spo2), 95);
    assert.equal(row.is_simulated, 0);
    assert.match(row.alert_message, /impact 4\.2 g/);
  });

  test('values that were not measured are stored as NULL, never invented', async () => {
    const mac = 'IT:FA:11:00:00:03';
    // Old firmware: a fall flag with no measurements, from a wristband the system does not know
    const oldFirmwareFall = normalizeTelemetry({ bpm: 0, spo2: 0, battery: 80, motion: 'FALL_EMERGENCY', g: 1.02, touch: 0, active: true });
    await alertService.evaluateTelemetry(oldFirmwareFall, 'IT-WB-3', mac);

    const [row] = await incidentsFor(mac);
    for (const column of ['patient_id', 'ward_id', 'bed_id', 'pos_x', 'pos_y',
      'kinematic_impact_force', 'post_impact_stillness', 'freefall_min_g', 'heart_rate', 'spo2']) {
      assert.equal(row[column], null, `${column} must be NULL when unknown`);
    }
    assert.match(row.patient_name, /Unassigned Wristband/);
    assert.match(row.alert_message, /impact not reported/);
    assert.match(row.alert_message, /location unknown/);
  });

  test('a second fall (next counter) is a second incident', async () => {
    const mac = 'IT:FA:11:00:00:04';
    await alertService.evaluateTelemetry(fall(8), 'IT-WB-4', mac);
    await alertService.evaluateTelemetry(fall(8), 'IT-WB-4', mac);
    await alertService.evaluateTelemetry(fall(9), 'IT-WB-4', mac);
    await alertService.evaluateTelemetry(fall(9), 'IT-WB-4', mac);
    assert.equal((await incidentsFor(mac)).length, 2);
  });

  test('a fall that already has its incident from before a server restart is not raised again', async () => {
    // Bench finding of 14 Nov 2026: restarting the server during the 45-second fall
    // hold created a second incident for the same fall.
    const mac = 'IT:FA:11:00:00:09';
    await pool.query(`
      INSERT INTO emergency_incident_logs (incident_id, wristband_mac, incident_category, kinematic_impact_force, resolution_status)
      VALUES ('INC-BEFORE-RESTART', ?, 'FALL_ACCIDENT', 6.1, 'PENDING')
    `, [mac]);

    // This process has never seen the wristband, exactly like a freshly started server
    assert.equal(await alertService.evaluateTelemetry(fall(77), 'IT-WB-9', mac), null);
    assert.equal(await alertService.evaluateTelemetry(fall(77), 'IT-WB-9', mac), null);
    assert.equal((await incidentsFor(mac)).length, 1);

    // The next fall of the same wristband is a new incident again
    assert.ok(await alertService.evaluateTelemetry(fall(78), 'IT-WB-9', mac));
    assert.equal((await incidentsFor(mac)).length, 2);
  });

  test('an old incident of the same wristband does not swallow a new fall after a restart', async () => {
    const mac = 'IT:FA:11:00:00:10';
    await pool.query(`
      INSERT INTO emergency_incident_logs (incident_id, wristband_mac, incident_category, trigger_timestamp, resolution_status)
      VALUES ('INC-LONG-AGO', ?, 'FALL_ACCIDENT', NOW() - INTERVAL 10 MINUTE, 'ACKNOWLEDGED')
    `, [mac]);
    assert.ok(await alertService.evaluateTelemetry(fall(5), 'IT-WB-10', mac));
    assert.equal((await incidentsFor(mac)).length, 2);
  });

  test('extreme vitals alarm after they persist, and a fall right afterwards is not delayed', async (t) => {
    const mac = 'IT:FA:11:00:00:05';
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });

    const extreme = telemetry({ bpm: 185, spo2: 97 });
    assert.equal(await alertService.evaluateTelemetry(extreme, 'IT-WB-5', mac), null, 'the first extreme reading only starts the timer');

    t.mock.timers.tick(thresholds.vitals.extreme.persistMs);
    const vitalsIncident = await alertService.evaluateTelemetry(extreme, 'IT-WB-5', mac);
    assert.ok(vitalsIncident);
    assert.equal(vitalsIncident.incident_category, 'CRITICAL_VITALS');
    assert.equal(vitalsIncident.heart_rate, 185);

    // One second later, well inside the vitals quiet period, the patient falls
    t.mock.timers.tick(1000);
    const fallIncident = await alertService.evaluateTelemetry(fall(3), 'IT-WB-5', mac);
    assert.ok(fallIncident, 'a fall must never wait for the vitals quiet period');
    assert.equal(fallIncident.incident_category, 'FALL_ACCIDENT');

    const rows = await incidentsFor(mac);
    assert.deepEqual(rows.map(r => r.incident_category).sort(), ['CRITICAL_VITALS', 'FALL_ACCIDENT']);
  });

  test('readings without skin contact never raise a vitals alarm', async (t) => {
    const mac = 'IT:FA:11:00:00:06';
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const noContact = telemetry({ bpm: 185, spo2: 97, touch: 0 });
    for (let i = 0; i < 20; i++) {
      assert.equal(await alertService.evaluateTelemetry(noContact, 'IT-WB-6', mac), null);
      t.mock.timers.tick(1000);
    }
    assert.equal((await incidentsFor(mac)).length, 0);
  });

  test('low SpO2 alone raises no incident while the measurement is not calibrated', async (t) => {
    const mac = 'IT:FA:11:00:00:11';
    assert.equal(thresholds.vitals.spo2AlarmsEnabled, false);
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const lowSpo2 = telemetry({ bpm: 74, spo2: 78 });
    for (let i = 0; i < 120; i++) {
      assert.equal(await alertService.evaluateTelemetry(lowSpo2, 'IT-WB-11', mac), null);
      t.mock.timers.tick(1000);
    }
    assert.equal((await incidentsFor(mac)).length, 0);
  });

  test('a simulated incident is marked as simulated in the audit log', async () => {
    const mac = 'IT:FA:11:00:00:07';
    const incident = await alertService.recordIncident({
      incident_category: 'FALL_ACCIDENT', wristband_mac: mac, device_id: 'IT-WB-7',
      kinematic_impact_force: 3.42, is_simulated: true
    });
    assert.equal(incident.is_simulated, true);

    const [row] = await incidentsFor(mac);
    assert.equal(row.is_simulated, 1);
    assert.match(row.alert_message, /^\[SIMULATION\]/);
  });

  test('acknowledging without a clinician records an honest placeholder, not a made-up doctor', async () => {
    const mac = 'IT:FA:11:00:00:08';
    const incident = await alertService.evaluateTelemetry(fall(1), 'IT-WB-8', mac);
    await alertService.acknowledgeIncident(incident.incident_id);

    const [row] = await incidentsFor(mac);
    assert.equal(row.resolution_status, 'ACKNOWLEDGED');
    assert.equal(row.attending_clinician, alertService.UNVERIFIED_CLINICIAN);

    // The wristband is still repeating its flag: no second incident
    assert.equal(await alertService.evaluateTelemetry(fall(1), 'IT-WB-8', mac), null);
    assert.equal((await incidentsFor(mac)).length, 1);
  });

  test('a database from before this change gains the is_simulated column and keeps its rows', async () => {
    const [[before]] = await pool.query('SELECT COUNT(*) AS n FROM emergency_incident_logs');
    await pool.query('ALTER TABLE emergency_incident_logs DROP COLUMN is_simulated');

    pool = await restart();

    const [columns] = await pool.query("SHOW COLUMNS FROM emergency_incident_logs LIKE 'is_simulated'");
    assert.equal(columns.length, 1);
    const [[afterRestart]] = await pool.query('SELECT COUNT(*) AS n, SUM(is_simulated) AS simulated FROM emergency_incident_logs');
    assert.equal(Number(afterRestart.n), Number(before.n), 'no incident may be lost by the migration');
    assert.equal(Number(afterRestart.simulated), 0, 'existing incidents default to "not simulated"');
  });

  test('a database from before this change gains the freefall_min_g column and keeps its rows', async () => {
    const [[before]] = await pool.query('SELECT COUNT(*) AS n FROM emergency_incident_logs');
    await pool.query('ALTER TABLE emergency_incident_logs DROP COLUMN freefall_min_g');

    pool = await restart();

    const [columns] = await pool.query("SHOW COLUMNS FROM emergency_incident_logs LIKE 'freefall_min_g'");
    assert.equal(columns.length, 1);
    const [[afterRestart]] = await pool.query('SELECT COUNT(*) AS n, COUNT(freefall_min_g) AS withValue FROM emergency_incident_logs');
    assert.equal(Number(afterRestart.n), Number(before.n), 'no incident may be lost by the migration');
    assert.equal(Number(afterRestart.withValue), 0, 'old incidents have no free-fall value: it stays unknown');
  });
});
