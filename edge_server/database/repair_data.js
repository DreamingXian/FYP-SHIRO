// =============================================================================
// SHIRO - repair inconsistent ("ghost") data (Phase 11 review)
//
//   node database/repair_data.js            shows what is wrong, changes nothing
//   node database/repair_data.js --apply    repairs it, in one transaction
//
// Uses the database of .env (DB_NAME; a DB_NAME set when starting wins). With
// --apply it first writes an undo file (SQL that puts every changed value back)
// to edge_server/data/repairs/ (git-ignored). Prints IDs only, never names.
//
// What it repairs (each one was found in the project database on 22 Nov 2026,
// left by bugs fixed in Phase 11):
//   1. a bed marked TAKEN with no admitted patient in it         -> FREE
//   2. a bed with an admitted patient in it, not marked TAKEN    -> TAKEN
//   3. a wristband a patient wears, marked FREE                   -> IN USE
//   4. a wristband marked IN USE that nobody wears                -> FREE
//   5. an admitted patient with a discharge date (admitted again
//      before re-admission cleared it)                            -> no discharge date
//   6. a discharged patient still holding a ward or bed           -> kept as "discharged from"
//   7. a wristband still bound to a discharged patient            -> binding ended (DISCHARGED)
//   8. a wall sensor or LiDAR marked in use or in a ward, but in no
//      ward place                                                 -> FREE, no ward
// Only reported (a person decides): an admitted patient whose bed does not exist.
// =============================================================================
const fs = require('fs');
const path = require('path');
const { getPool, closePool } = require('./db');

const APPLY = process.argv.includes('--apply');

// Each repair: what is wrong (rows with a key), how to repair one row, how to undo it
const REPAIRS = [
  {
    name: 'Bed marked TAKEN, nobody in it -> FREE',
    find: `SELECT b.ward_id, b.bed_id, b.status FROM ward_beds b
           WHERE b.status = 'OCCUPIED' AND NOT EXISTS (SELECT 1 FROM patients p
             WHERE p.status = 'ADMITTED' AND p.assigned_ward_id = b.ward_id AND p.assigned_bed_id = b.bed_id)`,
    label: r => `${r.ward_id} ${r.bed_id}`,
    fix: r => ["UPDATE ward_beds SET status = 'AVAILABLE' WHERE ward_id = ? AND bed_id = ?", [r.ward_id, r.bed_id]],
    undo: r => ['UPDATE ward_beds SET status = ? WHERE ward_id = ? AND bed_id = ?', [r.status, r.ward_id, r.bed_id]]
  },
  {
    name: 'Bed with an admitted patient, not marked TAKEN -> TAKEN',
    find: `SELECT b.ward_id, b.bed_id, b.status, p.patient_id FROM ward_beds b
           JOIN patients p ON p.assigned_ward_id = b.ward_id AND p.assigned_bed_id = b.bed_id
           WHERE p.status = 'ADMITTED' AND b.status <> 'OCCUPIED'`,
    label: r => `${r.ward_id} ${r.bed_id} (${r.patient_id})`,
    fix: r => ["UPDATE ward_beds SET status = 'OCCUPIED' WHERE ward_id = ? AND bed_id = ?", [r.ward_id, r.bed_id]],
    undo: r => ['UPDATE ward_beds SET status = ? WHERE ward_id = ? AND bed_id = ?', [r.status, r.ward_id, r.bed_id]]
  },
  {
    name: 'Wristband worn by a patient, marked FREE -> IN USE',
    find: `SELECT d.device_id, d.availability_status, pb.patient_id FROM devices d
           JOIN patient_bindings pb ON pb.device_id = d.device_id AND pb.status = 'ACTIVE'
           WHERE d.availability_status = 'AVAILABLE'`,
    label: r => `${r.device_id} (${r.patient_id})`,
    fix: r => ["UPDATE devices SET availability_status = 'IN_USE' WHERE device_id = ?", [r.device_id]],
    undo: r => ['UPDATE devices SET availability_status = ? WHERE device_id = ?', [r.availability_status, r.device_id]]
  },
  {
    name: 'Wristband marked IN USE, nobody wears it -> FREE',
    find: `SELECT d.device_id, d.availability_status FROM devices d
           WHERE d.device_type = 'WRISTBAND' AND d.availability_status = 'IN_USE'
             AND NOT EXISTS (SELECT 1 FROM patient_bindings pb WHERE pb.device_id = d.device_id AND pb.status = 'ACTIVE')`,
    label: r => r.device_id,
    fix: r => ["UPDATE devices SET availability_status = 'AVAILABLE' WHERE device_id = ?", [r.device_id]],
    undo: r => ['UPDATE devices SET availability_status = ? WHERE device_id = ?', [r.availability_status, r.device_id]]
  },
  {
    name: 'Admitted patient with a discharge date -> no discharge date',
    // The date as the database holds it (text): the undo file writes it back unchanged
    find: "SELECT patient_id, DATE_FORMAT(discharge_date, '%Y-%m-%d %H:%i:%s') AS discharge_date FROM patients WHERE status = 'ADMITTED' AND discharge_date IS NOT NULL",
    label: r => r.patient_id,
    fix: r => ['UPDATE patients SET discharge_date = NULL WHERE patient_id = ?', [r.patient_id]],
    undo: r => ['UPDATE patients SET discharge_date = ? WHERE patient_id = ?', [r.discharge_date, r.patient_id]]
  },
  {
    name: 'Discharged patient still holding a ward or bed -> kept as "discharged from"',
    find: `SELECT patient_id, assigned_ward_id, assigned_bed_id, discharged_from_ward_id, discharged_from_bed_id FROM patients
           WHERE status = 'DISCHARGED' AND (assigned_ward_id IS NOT NULL OR assigned_bed_id IS NOT NULL)`,
    label: r => `${r.patient_id} (${r.assigned_ward_id || '-'} ${r.assigned_bed_id || '-'})`,
    fix: r => [`UPDATE patients SET discharged_from_ward_id = COALESCE(discharged_from_ward_id, assigned_ward_id),
                discharged_from_bed_id = COALESCE(discharged_from_bed_id, assigned_bed_id),
                assigned_ward_id = NULL, assigned_bed_id = NULL WHERE patient_id = ?`, [r.patient_id]],
    undo: r => [`UPDATE patients SET assigned_ward_id = ?, assigned_bed_id = ?, discharged_from_ward_id = ?, discharged_from_bed_id = ?
                 WHERE patient_id = ?`, [r.assigned_ward_id, r.assigned_bed_id, r.discharged_from_ward_id, r.discharged_from_bed_id, r.patient_id]]
  },
  {
    name: 'Wristband still bound to a discharged patient -> binding ended',
    find: `SELECT pb.binding_id, pb.patient_id, pb.device_id FROM patient_bindings pb JOIN patients p ON p.patient_id = pb.patient_id
           WHERE pb.status = 'ACTIVE' AND p.status = 'DISCHARGED'`,
    label: r => `binding ${r.binding_id}: ${r.device_id || 'deleted wristband'} (${r.patient_id})`,
    fix: r => ["UPDATE patient_bindings SET status = 'DISCHARGED', unbound_at = NOW(), unbound_by = 'Data repair' WHERE binding_id = ?", [r.binding_id]],
    undo: r => ["UPDATE patient_bindings SET status = 'ACTIVE', unbound_at = NULL, unbound_by = NULL WHERE binding_id = ?", [r.binding_id]]
  },
  {
    name: 'Wall sensor or LiDAR in use or in a ward, but in no ward place -> FREE, no ward',
    find: `SELECT d.device_id, d.assigned_ward_id, d.availability_status FROM devices d
           WHERE d.device_type IN ('ANCHOR', 'ROOM_SENSOR') AND (d.availability_status = 'IN_USE' OR d.assigned_ward_id IS NOT NULL)
             AND NOT EXISTS (SELECT 1 FROM ward_anchors wa WHERE wa.device_id = d.device_id)
             AND NOT EXISTS (SELECT 1 FROM ward_room_sensors rs WHERE rs.device_id = d.device_id)`,
    label: r => r.device_id,
    fix: r => [`UPDATE devices SET assigned_ward_id = NULL,
                availability_status = IF(availability_status = 'IN_USE', 'AVAILABLE', availability_status) WHERE device_id = ?`, [r.device_id]],
    undo: r => ['UPDATE devices SET assigned_ward_id = ?, availability_status = ? WHERE device_id = ?', [r.assigned_ward_id, r.availability_status, r.device_id]]
  }
];

// Only reported: needs a person (give the patient a bed, or discharge them)
const REPORT_ONLY = {
  name: 'Admitted patient whose bed does not exist (give them a bed on the Patients page)',
  find: `SELECT p.patient_id, p.assigned_ward_id, p.assigned_bed_id FROM patients p
         WHERE p.status = 'ADMITTED' AND p.assigned_bed_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM ward_beds b WHERE b.ward_id = p.assigned_ward_id AND b.bed_id = p.assigned_bed_id)`,
  label: r => `${r.patient_id} (${r.assigned_ward_id} ${r.assigned_bed_id})`
};

/** A value written into the undo file as SQL. */
function sqlValue(pool, v) {
  if (v instanceof Date) return pool.escape(v.toISOString().slice(0, 19).replace('T', ' '));
  return pool.escape(v === undefined ? null : v);
}

async function main() {
  const pool = getPool();
  const [[{ db }]] = await pool.query('SELECT DATABASE() AS db');
  console.log(`Database: ${db}. ${APPLY ? 'Repairing.' : 'Showing only (add --apply to repair).'}\n`);

  const found = [];
  for (const repair of REPAIRS) {
    const [rows] = await pool.query(repair.find);
    console.log(`${rows.length ? '✗' : '✓'} ${repair.name}: ${rows.length}`);
    rows.forEach(r => console.log(`    ${repair.label(r)}`));
    if (rows.length) found.push({ repair, rows });
  }
  const [orphans] = await pool.query(REPORT_ONLY.find);
  console.log(`${orphans.length ? '!' : '✓'} ${REPORT_ONLY.name}: ${orphans.length}`);
  orphans.forEach(r => console.log(`    ${REPORT_ONLY.label(r)}`));

  const total = found.reduce((n, f) => n + f.rows.length, 0);
  if (!total) {
    console.log('\nNothing to repair.');
    return;
  }
  if (!APPLY) {
    console.log(`\n${total} row${total === 1 ? '' : 's'} to repair. Run again with --apply to repair them.`);
    return;
  }

  // Undo file first: every changed value can be put back
  const dir = process.env.SHIRO_REPAIR_DIR || path.join(__dirname, '..', 'data', 'repairs');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const undoFile = path.join(dir, `repair-${db}-${stamp}-undo.sql`);
  const lines = [`-- Undo of the data repair of ${new Date().toISOString()} on ${db}`, `USE \`${db}\`;`];
  for (const { repair, rows } of found) {
    lines.push(`-- ${repair.name}`);
    for (const r of rows) {
      const [sql, params] = repair.undo(r);
      let i = 0;
      lines.push(`${sql.replace(/\s+/g, ' ').replace(/\?/g, () => sqlValue(pool, params[i++]))};`);
    }
  }
  fs.writeFileSync(undoFile, lines.join('\n') + '\n');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const { repair, rows } of found) {
      for (const r of rows) {
        const [sql, params] = repair.fix(r);
        await conn.query(sql, params);
      }
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  console.log(`\nRepaired ${total} row${total === 1 ? '' : 's'}. To undo: run the SQL in ${undoFile}`);
  console.log('Restart the edge server so it reloads the wristband bindings.');
}

main()
  .then(async () => { await closePool(); process.exit(0); })
  .catch(async (err) => { console.error('Repair failed, nothing changed:', err.message); try { await closePool(); } catch (e) { /* closed */ } process.exit(1); });
