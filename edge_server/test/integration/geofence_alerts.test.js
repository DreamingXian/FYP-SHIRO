// Integration tests: door events to geofence incidents in MySQL (Phase 10; uses shiro_test).
// Time-series logging is switched off for this file, so nothing is written to InfluxDB.
process.env.INFLUX_TOKEN = '';

const { db, freshDatabase } = require('./helper');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const alertService = require('../../services/alert_service');
const { createGeofenceAlerts, findActiveBindingInDb } = require('../../services/alerts/geofence_alerts');
const { migrate } = require('../../database/migrate_incident_geofence_kind');

const PATIENT = 'ITEST-GEO';
const TAG = 'IT-GEO-1';
const MAC = 'IT:GE:00:00:00:01';
const SPARE_TAG = 'IT-GEO-2';
const SPARE_MAC = 'IT:GE:00:00:00:02';

describe('geofence alerts in the incident log', () => {
  let pool;
  let alerts;

  before(async () => {
    pool = await freshDatabase();
    await pool.query(
      `INSERT INTO patients (patient_id, full_name, nric_passport, dob, gender, phone_number, status, assigned_ward_id)
       VALUES (?, 'Test Geofence', 'ITESTG0001', '1990-01-01', 'OTHER', '0123456789', 'ADMITTED', NULL)`,
      [PATIENT]
    );
    for (const [id, mac] of [[TAG, MAC], [SPARE_TAG, SPARE_MAC]]) {
      await pool.query("INSERT INTO devices (device_id, mac_address, device_type, hardware_model) VALUES (?, ?, 'WRISTBAND', 'TEST')", [id, mac]);
    }
    await pool.query("INSERT INTO patient_bindings (patient_id, device_id, status) VALUES (?, ?, 'ACTIVE')", [PATIENT, TAG]);
    alerts = createGeofenceAlerts({
      getPosition: () => null,
      findActiveBinding: findActiveBindingInDb,
      recordIncident: (data) => alertService.recordIncident(data),
      log: { info: () => {} }
    });
  });
  after(async () => { await db.closePool(); });

  const rowsFor = async (mac) => {
    const [rows] = await pool.query('SELECT * FROM emergency_incident_logs WHERE wristband_mac = ? ORDER BY incident_id', [mac]);
    return rows;
  };

  test('an older database gets the geofence_kind column once', async () => {
    await pool.query('ALTER TABLE emergency_incident_logs DROP COLUMN geofence_kind');
    assert.equal(await migrate(), true);
    assert.equal(await migrate(), false, 'already there');
    const [cols] = await pool.query("SHOW COLUMNS FROM emergency_incident_logs LIKE 'geofence_kind'");
    assert.equal(cols.length, 1);
    assert.match(cols[0].Type, /enum\('LEFT_WARD','AT_DOOR'\)/i);
  });

  test('left the ward: one incident with its kind, the patient, the ward and where last seen', async () => {
    const created = await alerts.raise({ kind: 'LEFT_WARD', tagId: TAG, wardId: 'WARD-005', x: 1.9, y: 3.0, seconds: 11 });
    assert.ok(created && created.incident_id);
    const rows = await rowsFor(MAC);
    assert.equal(rows.length, 1);
    const r = rows[0];
    assert.deepEqual(
      [r.incident_category, r.geofence_kind, r.patient_id, r.ward_id, r.pos_x, r.pos_y, r.resolution_status, r.is_simulated],
      ['GEOFENCE_BREACH', 'LEFT_WARD', PATIENT, 'WARD-005', 1.9, 3.0, 'PENDING', 0]
    );
    assert.match(r.alert_message, /^LEFT THE WARD: last seen at the door, not seen in the room for 11 s; WARD-005/);
  });

  test('at the door: its own kind', async () => {
    await alerts.raise({ kind: 'AT_DOOR', tagId: TAG, wardId: 'WARD-005', x: 1.8, y: 2.9, seconds: 10 });
    const rows = await rowsFor(MAC);
    assert.deepEqual(rows.map(r => r.geofence_kind), ['LEFT_WARD', 'AT_DOOR']);
    assert.match(rows[1].alert_message, /^AT THE DOOR: standing at the door for 10 s/);
  });

  test('a wristband bound to nobody raises nothing', async () => {
    assert.equal(await alerts.raise({ kind: 'LEFT_WARD', tagId: SPARE_TAG, wardId: 'WARD-005', x: 1.9, y: 3.0, seconds: 11 }), null);
    assert.deepEqual(await rowsFor(SPARE_MAC), []);
  });

  // Found 22 Nov 2026: a fall of a patient without a bed was stored with a position but no ward
  test('a patient without a bed: the incident takes the ward the wristband is in', async () => {
    const ips = require('../../services/ips_service');
    const original = ips.getTagPosition;
    ips.getTagPosition = (tagId) => (tagId === SPARE_TAG ? { x: 0.83, y: 2.45, ward_id: 'WARD-001' } : null);
    try {
      await alertService.recordIncident({ incident_category: 'FALL_ACCIDENT', device_id: SPARE_TAG, wristband_mac: SPARE_MAC });
    } finally {
      ips.getTagPosition = original;
    }
    const rows = await rowsFor(SPARE_MAC);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].ward_id, rows[0].pos_x, rows[0].pos_y], ['WARD-001', 0.83, 2.45]);
    assert.match(rows[0].alert_message, /WARD-001/);
    await pool.query('DELETE FROM emergency_incident_logs WHERE wristband_mac = ?', [SPARE_MAC]);
  });

  test('the incident history gives the kind; other incidents have none', async () => {
    await alertService.recordIncident({ incident_category: 'FALL_ACCIDENT', device_id: TAG, wristband_mac: MAC, geofence_kind: 'AT_DOOR' });
    const { history, summary } = await alertService.getIncidentHistory({ patientId: PATIENT, limit: 10 });
    const kinds = history.map(h => [h.incident_category, h.geofence_kind]).sort();
    assert.deepEqual(kinds, [['FALL_ACCIDENT', null], ['GEOFENCE_BREACH', 'AT_DOOR'], ['GEOFENCE_BREACH', 'LEFT_WARD']]);
    assert.equal(summary.geofence, 2);
  });
});
