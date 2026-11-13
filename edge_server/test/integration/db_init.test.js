// Integration tests: database initialisation and restart safety (uses shiro_test)
const { db, freshDatabase, restart } = require('./helper');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const EXPECTED_TABLES = [
  'devices',
  'emergency_incident_logs',
  'patient_bindings',
  'patients',
  'ward_anchors',
  'ward_beds',
  'ward_boundary_points',
  'ward_obstacles',
  'ward_rooms'
];

async function count(pool, table, where = '1=1') {
  const [rows] = await pool.query(`SELECT COUNT(*) AS n FROM \`${table}\` WHERE ${where}`);
  return Number(rows[0].n);
}

describe('fresh install', () => {
  let pool;
  before(async () => { pool = await freshDatabase(); });
  after(async () => { await db.closePool(); });

  test('creates all nine tables, including patient_bindings', async () => {
    const [rows] = await pool.query('SHOW TABLES');
    const names = rows.map(r => Object.values(r)[0]).sort();
    assert.deepEqual(names, EXPECTED_TABLES);
  });

  test('loads the sample wards and patients into the empty database', async () => {
    assert.equal(await count(pool, 'ward_rooms'), 3);
    assert.equal(await count(pool, 'ward_beds'), 10);
    assert.equal(await count(pool, 'ward_anchors'), 9);
    assert.equal(await count(pool, 'patients'), 5);
  });

  test('marks exactly the beds of admitted sample patients as OCCUPIED', async () => {
    const [rows] = await pool.query("SELECT ward_id, bed_id FROM ward_beds WHERE status = 'OCCUPIED' ORDER BY ward_id, bed_id");
    assert.deepEqual(rows.map(r => `${r.ward_id}/${r.bed_id}`), [
      'WARD-001/BED-001-01',
      'WARD-001/BED-001-02',
      'WARD-001/BED-001-03',
      'WARD-002/BED-002-01'
    ]);
  });

  test('starts with no devices and no bindings', async () => {
    assert.equal(await count(pool, 'devices'), 0);
    assert.equal(await count(pool, 'patient_bindings'), 0);
  });
});

describe('restart never changes existing data', () => {
  let pool;
  before(async () => {
    pool = await freshDatabase();
    // Edits a user could make through the dashboard
    await pool.query("UPDATE ward_rooms SET room_title = 'Edited Title', length_x = 9.99, width_y = 8.88, door_x = 1.11 WHERE ward_id = 'WARD-001'");
    await pool.query("UPDATE ward_beds SET x = 3.33, y = 2.22, status = 'AVAILABLE' WHERE ward_id = 'WARD-001' AND bed_id = 'BED-001-01'");
    await pool.query("UPDATE ward_beds SET status = 'OCCUPIED' WHERE ward_id = 'WARD-002' AND bed_id = 'BED-002-03'");
    await pool.query("UPDATE ward_anchors SET x = 1.11, y = 2.22, z = 2.50, status = 'OFFLINE' WHERE ward_id = 'WARD-001' AND anchor_id = 'anchor-A'");
    await pool.query("UPDATE ward_obstacles SET label = 'Edited Obstacle', x = 0.50 WHERE ward_id = 'WARD-001' AND obstacle_id = 'OBS-001-01'");
    await pool.query("INSERT INTO ward_rooms (ward_id, room_title) VALUES ('WARD-900', 'User Created Ward')");
    await pool.query("UPDATE patients SET status = 'DISCHARGED', assigned_ward_id = NULL, assigned_bed_id = NULL WHERE patient_id = 'P-001'");
    pool = await restart();
    pool = await restart(); // twice, to be sure
  });
  after(async () => { await db.closePool(); });

  test('room edits are kept', async () => {
    const [[room]] = await pool.query("SELECT room_title, length_x, width_y, door_x FROM ward_rooms WHERE ward_id = 'WARD-001'");
    assert.equal(room.room_title, 'Edited Title');
    assert.equal(Number(room.length_x), 9.99);
    assert.equal(Number(room.width_y), 8.88);
    assert.equal(Number(room.door_x), 1.11);
  });

  test('a freed bed stays AVAILABLE and keeps its new position', async () => {
    const [[bed]] = await pool.query("SELECT x, y, status FROM ward_beds WHERE ward_id = 'WARD-001' AND bed_id = 'BED-001-01'");
    assert.equal(bed.status, 'AVAILABLE');
    assert.equal(Number(bed.x), 3.33);
    assert.equal(Number(bed.y), 2.22);
  });

  test('a bed occupied after install stays OCCUPIED', async () => {
    const [[bed]] = await pool.query("SELECT status FROM ward_beds WHERE ward_id = 'WARD-002' AND bed_id = 'BED-002-03'");
    assert.equal(bed.status, 'OCCUPIED');
  });

  test('anchor position and status are kept', async () => {
    const [[a]] = await pool.query("SELECT x, y, z, status FROM ward_anchors WHERE ward_id = 'WARD-001' AND anchor_id = 'anchor-A'");
    assert.deepEqual([Number(a.x), Number(a.y), Number(a.z), a.status], [1.11, 2.22, 2.5, 'OFFLINE']);
  });

  test('obstacle edits are kept', async () => {
    const [[o]] = await pool.query("SELECT label, x FROM ward_obstacles WHERE ward_id = 'WARD-001' AND obstacle_id = 'OBS-001-01'");
    assert.equal(o.label, 'Edited Obstacle');
    assert.equal(Number(o.x), 0.5);
  });

  test('a discharged sample patient stays discharged', async () => {
    const [[p]] = await pool.query("SELECT status, assigned_bed_id FROM patients WHERE patient_id = 'P-001'");
    assert.equal(p.status, 'DISCHARGED');
    assert.equal(p.assigned_bed_id, null);
  });

  test('row counts are unchanged and the user-created ward is still there', async () => {
    assert.equal(await count(pool, 'ward_rooms'), 4);
    assert.equal(await count(pool, 'ward_rooms', "ward_id = 'WARD-900'"), 1);
    assert.equal(await count(pool, 'ward_beds'), 10);
    assert.equal(await count(pool, 'ward_anchors'), 9);
    assert.equal(await count(pool, 'patients'), 5);
  });
});

describe('seed data is only for an empty database', () => {
  after(async () => { await db.closePool(); });

  test('wards deleted by the user are not brought back while patients exist', async () => {
    let pool = await freshDatabase();
    await pool.query('DELETE FROM ward_rooms');
    pool = await restart();
    assert.equal(await count(pool, 'ward_rooms'), 0);
    assert.equal(await count(pool, 'patients'), 5);
  });

  test('isDatabaseEmpty is true only with no wards and no patients', async () => {
    const pool = await freshDatabase();
    assert.equal(await db.isDatabaseEmpty(), false);
    await pool.query('DELETE FROM patients');
    await pool.query('DELETE FROM ward_rooms');
    assert.equal(await db.isDatabaseEmpty(), true);
  });
});
