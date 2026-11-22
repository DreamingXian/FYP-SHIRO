// Integration test (Phase 11, review fixes): a discharged patient is admitted
// again with a bed; the ward save keeps the layout rules and the headset room
// anchor; the device list says who wears a wristband and where a sensor is;
// the live map gets the bed occupants and the positions when it opens.
// Starts the real server on spare ports against shiro_test.
process.env.INFLUX_TOKEN = '';

const { db, freshDatabase, startServer, signIn } = require('./helper');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const HTTP_PORT = 3982;
const MQTT_PORT = 1889;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const WARD = 'WARD-001';
const BED_WARD = 'WARD-002';   // the sample patients have beds 1-3 of WARD-001 and bed 1 here
const PATIENT = 'ITEST-P11';
const TAG = 'ITEST-TAG-11';
const ANCHOR = 'ITEST-ANC-11';

describe('Phase 11 review fixes', () => {
  let server;
  let admin;
  let pool;

  const call = async (path, { method = 'GET', body } = {}) => fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: admin },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = async (res) => res.json();
  const wardConfig = async () => (await json(await call(`/api/ward/config?ward_id=${WARD}`))).ward;

  before(async () => {
    pool = await freshDatabase();
    await pool.query(
      `INSERT INTO patients (patient_id, full_name, nric_passport, dob, gender, phone_number, status, admission_date)
       VALUES (?, 'Review Patient', 'ITESTP11001', '1980-05-05', 'OTHER', '0123456789', 'ADMITTED', NOW() - INTERVAL 2 DAY)`,
      [PATIENT]
    );
    await pool.query("INSERT INTO devices (device_id, mac_address, device_type, hardware_model) VALUES (?, 'AA:BB:CC:00:11:01', 'WRISTBAND', 'TEST')", [TAG]);
    await pool.query("INSERT INTO devices (device_id, mac_address, device_type, hardware_model) VALUES (?, 'AA:BB:CC:00:11:02', 'ANCHOR', 'TEST')", [ANCHOR]);
    await pool.query("UPDATE ward_anchors SET device_id = ? WHERE ward_id = ? AND anchor_id = 'anchor-B'", [ANCHOR, WARD]);
    await pool.query("UPDATE ward_rooms SET spatial_anchor_uuid = 'anchor-set-by-headset' WHERE ward_id = ?", [WARD]);
    await db.closePool();
    server = startServer({ HTTP_PORT: String(HTTP_PORT), MQTT_PORT: String(MQTT_PORT) });
    await server.ready;
    admin = await signIn(BASE);
    pool = db.getPool();
  });

  after(async () => {
    if (server) await server.stop();
    await db.closePool();
  });

  test('the device list says who wears a wristband and which ward place a wall sensor fills', async () => {
    let res = await call('/api/patients/assign-bed', { method: 'POST', body: { patient_id: PATIENT, ward_id: BED_WARD, bed_id: 'BED-002-02' } });
    assert.equal(res.status, 200, await res.clone().text());
    res = await call('/api/bindings/bind', { method: 'POST', body: { patient_id: PATIENT, device_id: TAG } });
    assert.ok(res.ok, await res.clone().text());

    const devices = (await json(await call('/api/devices/list'))).devices;
    const tag = devices.find(d => d.device_id === TAG);
    assert.equal(tag.bound_patient_id, PATIENT);
    assert.equal(tag.bound_patient_name, 'Review Patient');
    const anchor = devices.find(d => d.device_id === ANCHOR);
    assert.equal(anchor.anchor_slot, `${WARD} · anchor-B`);
    assert.equal(anchor.bound_patient_name, null);
  });

  test('the live map gets who has which bed, and the positions known now', async () => {
    const data = await json(await call(`/api/ward/ips-init?ward_id=${BED_WARD}`));
    assert.equal(data.success, true);
    assert.deepEqual(data.bed_occupants.find(o => o.patient_id === PATIENT), { bed_id: 'BED-002-02', patient_id: PATIENT, full_name: 'Review Patient' });
    assert.ok(data.bed_occupants.every(o => o.bed_id.startsWith('BED-002-')), 'only the beds of this ward');
    assert.ok(Array.isArray(data.positions), 'positions is a list (empty: no wristband heard yet)');
    const subject = data.tracked_subjects.find(s => s.device_id === TAG);
    assert.equal(subject.located_ward_id, null, 'not heard yet');
    assert.equal(subject.assigned_ward_id, BED_WARD);
  });

  test('a discharged patient is admitted again with a bed: a new stay starts', async () => {
    let res = await call('/api/patients/discharge', { method: 'POST', body: { patient_id: PATIENT } });
    assert.equal(res.status, 200, await res.clone().text());
    let [[p]] = await pool.query('SELECT status, discharge_date, discharged_from_bed_id FROM patients WHERE patient_id = ?', [PATIENT]);
    assert.equal(p.status, 'DISCHARGED');
    assert.equal(p.discharged_from_bed_id, 'BED-002-02');

    res = await call('/api/patients/assign-bed', { method: 'POST', body: { patient_id: PATIENT, ward_id: BED_WARD, bed_id: 'BED-002-03' } });
    const body = await json(res);
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.readmitted, true);
    [[p]] = await pool.query(
      'SELECT status, assigned_ward_id, assigned_bed_id, discharge_date, discharged_from_bed_id, TIMESTAMPDIFF(SECOND, admission_date, NOW()) AS since FROM patients WHERE patient_id = ?',
      [PATIENT]
    );
    assert.equal(p.status, 'ADMITTED');
    assert.equal(p.assigned_bed_id, 'BED-002-03');
    assert.equal(p.discharge_date, null);
    assert.equal(p.discharged_from_bed_id, null);
    assert.ok(Number(p.since) < 60, 'the new stay starts now');
    const [[bed]] = await pool.query("SELECT status FROM ward_beds WHERE bed_id = 'BED-002-03'");
    assert.equal(bed.status, 'OCCUPIED');
  });

  test('a layout with a bed outside the room or two LiDARs is not saved', async () => {
    const ward = await wardConfig();
    let res = await call('/api/ward/config', { method: 'POST', body: { ...ward, beds: [...ward.beds, { bed_id: 'BED-001-09', bed_code: 'Bed 9', x: 6.0, y: 1.0, width: 0.9, length: 2.0, rotation_deg: 0, status: 'AVAILABLE' }] } });
    assert.equal(res.status, 400);
    assert.match((await json(res)).error, /Bed 9 is partly outside the room/);

    res = await call('/api/ward/config', { method: 'POST', body: { ...ward, room_sensors: [{ sensor_id: 'LiDAR 1', x: 1, y: 1 }, { sensor_id: 'LiDAR 2', x: 2, y: 2 }] } });
    assert.equal(res.status, 400);
    assert.match((await json(res)).error, /one LiDAR/);

    const [[count]] = await pool.query("SELECT COUNT(*) AS n FROM ward_beds WHERE ward_id = ? AND bed_id = 'BED-001-09'", [WARD]);
    assert.equal(Number(count.n), 0, 'nothing of the refused layout was stored');
  });

  test('saving a layout keeps the beds of admitted patients taken, and refuses to remove one', async () => {
    const ward = await wardConfig();
    assert.equal(ward.beds.find(b => b.bed_id === 'BED-001-01').status, 'OCCUPIED', 'the editor sees a taken bed as taken');
    // The editor used to send it back as AVAILABLE: it stays OCCUPIED
    let res = await call('/api/ward/config', { method: 'POST', body: { ...ward, beds: ward.beds.map(b => ({ ...b, status: b.status === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'AVAILABLE' })) } });
    assert.equal(res.status, 200, await res.clone().text());
    const [rows] = await pool.query("SELECT bed_id, status FROM ward_beds WHERE ward_id = ? ORDER BY bed_id", [WARD]);
    assert.deepEqual(rows.map(r => `${r.bed_id}=${r.status}`), ['BED-001-01=OCCUPIED', 'BED-001-02=OCCUPIED', 'BED-001-03=OCCUPIED', 'BED-001-04=UNAVAILABLE']);
    const free = (await json(await call('/api/patients/available-beds'))).availableBeds.map(b => b.bed_id);
    assert.ok(!free.includes('BED-001-01'), 'a taken bed is never offered to another patient');
    // The patients keep their ward and bed (before, the save cleared them through the foreign key)
    const [kept] = await pool.query("SELECT patient_id, assigned_ward_id, assigned_bed_id FROM patients WHERE patient_id IN ('P-001', 'P-002', 'P-003') ORDER BY patient_id");
    assert.deepEqual(kept.map(p => `${p.patient_id}:${p.assigned_ward_id}/${p.assigned_bed_id}`), ['P-001:WARD-001/BED-001-01', 'P-002:WARD-001/BED-001-02', 'P-003:WARD-001/BED-001-03']);

    // Moving a bed keeps its patient
    const moved = ward.beds.map(b => (b.bed_id === 'BED-001-01' ? { ...b, x: 1.0 } : b));
    res = await call('/api/ward/config', { method: 'POST', body: { ...ward, beds: moved } });
    assert.equal(res.status, 200, await res.clone().text());
    const [[p1]] = await pool.query("SELECT assigned_bed_id FROM patients WHERE patient_id = 'P-001'");
    assert.equal(p1.assigned_bed_id, 'BED-001-01');
    const [[b1]] = await pool.query("SELECT x, status FROM ward_beds WHERE ward_id = ? AND bed_id = 'BED-001-01'", [WARD]);
    assert.equal(Number(b1.x), 1.0);
    assert.equal(b1.status, 'OCCUPIED');

    // Removing the bed of an admitted patient: refused, saying who has it
    res = await call('/api/ward/config', { method: 'POST', body: { ...ward, beds: ward.beds.filter(b => b.bed_id !== 'BED-001-01') } });
    assert.equal(res.status, 400);
    assert.match((await json(res)).error, /BED-001-01 is given to Tan Ah Kow \(P-001\)/);
  });

  test('saving the layout keeps the headset room anchor, whatever the editor sends', async () => {
    const ward = await wardConfig();
    const res = await call('/api/ward/config', { method: 'POST', body: { ...ward, room_title: 'Renamed in review', spatial_anchor_uuid: '' } });
    assert.equal(res.status, 200, await res.clone().text());
    const [[room]] = await pool.query('SELECT room_title, spatial_anchor_uuid FROM ward_rooms WHERE ward_id = ?', [WARD]);
    assert.equal(room.room_title, 'Renamed in review');
    assert.equal(room.spatial_anchor_uuid, 'anchor-set-by-headset');
  });

  test('saving a layout leaves a worn wristband IN USE, even one carrying the ward', async () => {
    // A wristband enrolled with a ward (older dashboards did that), worn by a patient
    await pool.query("UPDATE devices SET assigned_ward_id = ?, availability_status = 'IN_USE' WHERE device_id = ?", [BED_WARD, TAG]);
    const ward2 = (await json(await call(`/api/ward/config?ward_id=${BED_WARD}`))).ward;
    const res = await call('/api/ward/config', { method: 'POST', body: ward2 });
    assert.equal(res.status, 200, await res.clone().text());
    const [[tag]] = await pool.query('SELECT availability_status FROM devices WHERE device_id = ?', [TAG]);
    assert.equal(tag.availability_status, 'IN_USE', 'the patient still wears it');
  });

  test('a ward with patients is not deleted; an empty one is', async () => {
    let res = await call(`/api/ward/config?ward_id=${BED_WARD}`, { method: 'DELETE' });
    assert.equal(res.status, 409);
    const body = await json(res);
    assert.match(body.error, /WARD-002 still has 2 patients: .*Review Patient \(ITEST-P11\)/);
    const [[stillThere]] = await pool.query('SELECT assigned_ward_id, assigned_bed_id FROM patients WHERE patient_id = ?', [PATIENT]);
    assert.equal(stillThere.assigned_bed_id, 'BED-002-03', 'nothing changed');

    const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM patients WHERE status = 'ADMITTED' AND assigned_ward_id = 'WARD-003'");
    assert.equal(Number(n), 0, 'the sample WARD-003 has no patient');
    res = await call('/api/ward/config?ward_id=WARD-003', { method: 'DELETE' });
    assert.equal(res.status, 200, await res.clone().text());
  });
});
