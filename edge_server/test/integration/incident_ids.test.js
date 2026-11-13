// Integration tests: incident IDs are unique and sequential in MySQL (uses shiro_test)
const { db, freshDatabase } = require('./helper');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const alertService = require('../../services/alert_service');
const { createIncidentIdGenerator, loadMaxSequenceFromDatabase, dateKey, formatIncidentId } = require('../../services/alerts/incident_id');

function incident(extra = {}) {
  return {
    incident_category: 'FALL_ACCIDENT',
    patient_id: 'P-001',            // sample patient in the test database
    patient_name: 'Integration Test',
    ward_id: 'WARD-001',
    bed_id: 'BED-001-01',
    wristband_mac: 'AA:BB:CC:00:00:99',
    pos_x: 1.0,
    pos_y: 2.0,
    kinematic_impact_force: 3.0,
    post_impact_stillness: 0.1,
    heart_rate: 80,
    spo2: 98,
    alert_message: 'integration test incident',
    ...extra
  };
}

describe('incident IDs', () => {
  let pool;
  const today = dateKey(new Date());

  before(async () => { pool = await freshDatabase(); });
  after(async () => { await db.closePool(); });

  test('100 incidents raised at the same moment are all stored with distinct IDs', async () => {
    const results = await Promise.all(Array.from({ length: 100 }, () => alertService.recordIncident(incident())));
    const ids = results.map(r => r.incident_id);

    assert.equal(new Set(ids).size, 100);
    assert.ok(results.every(r => r.persisted === true), 'every incident must be written to the audit log');
    assert.ok(ids.every(id => /^INC-\d{8}-\d{4}$/.test(id)));

    const [[row]] = await pool.query('SELECT COUNT(*) AS n, COUNT(DISTINCT incident_id) AS d FROM emergency_incident_logs');
    assert.equal(Number(row.n), 100);
    assert.equal(Number(row.d), 100);
    assert.deepEqual(ids.slice().sort()[0], formatIncidentId(today, 1));
    assert.deepEqual(ids.slice().sort()[99], formatIncidentId(today, 100));
  });

  test('after a restart the sequence continues from the highest stored number', async () => {
    const afterRestart = createIncidentIdGenerator({ loadMaxSequence: loadMaxSequenceFromDatabase });
    assert.equal(await afterRestart(), formatIncidentId(today, 101));
  });

  test('an ID already taken by another writer is skipped, not lost', async () => {
    // Another process stores number 101 behind this server's back
    await pool.query(
      "INSERT INTO emergency_incident_logs (incident_id, incident_category, alert_message) VALUES (?, 'FALL_ACCIDENT', 'written elsewhere')",
      [formatIncidentId(today, 101)]
    );
    const created = await alertService.recordIncident(incident());
    assert.equal(created.persisted, true);
    assert.equal(created.incident_id, formatIncidentId(today, 102));
    const [[row]] = await pool.query('SELECT COUNT(*) AS n FROM emergency_incident_logs');
    assert.equal(Number(row.n), 102);
  });

  test('a caller-supplied ID that already exists is reported as not persisted', async () => {
    const created = await alertService.recordIncident(incident({ incident_id: formatIncidentId(today, 1) }));
    assert.equal(created.persisted, false);
    assert.equal(created.incident_id, formatIncidentId(today, 1));
  });
});
