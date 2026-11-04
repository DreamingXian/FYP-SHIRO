// =============================================================================
// SHIRO Hospital Edge Server - Patient-to-Wristband Binding Service
// Manages Real-Time Telemetry Pairing, Active Bindings & Unpaired Candidate Discovery
// =============================================================================

const { getPool } = require('../database/db');
const { broadcastToClients } = require('./websocket_service');

/**
 * Calculates patient age from Date of Birth.
 */
function calculateAge(dobString) {
  if (!dobString) return null;
  const dob = new Date(dobString);
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const m = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) {
    age--;
  }
  return age >= 0 ? age : 0;
}

/**
 * Retrieves all active patient-wristband bindings with joined patient, bed, and device telemetry.
 */
async function getActiveBindings() {
  const pool = getPool();
  const query = `
    SELECT 
      pb.binding_id,
      pb.patient_id,
      pb.device_id,
      DATE_FORMAT(pb.bound_at, '%Y-%m-%d %H:%i') AS bound_at,
      pb.bound_at AS raw_bound_at,
      pb.bound_by,
      pb.stream_rate,
      pb.status AS binding_status,
      p.full_name AS patient_name,
      p.nric_passport,
      p.gender,
      DATE_FORMAT(p.dob, '%Y-%m-%d') AS dob,
      p.fall_risk_score,
      p.photo_url,
      p.assigned_ward_id,
      p.assigned_bed_id,
      w.room_title AS ward_title,
      b.bed_code,
      d.mac_address,
      d.hardware_model,
      d.battery_level,
      d.status AS device_status,
      d.last_seen
    FROM patient_bindings pb
    JOIN patients p ON pb.patient_id = p.patient_id
    JOIN devices d ON pb.device_id = d.device_id
    LEFT JOIN ward_rooms w ON p.assigned_ward_id = w.ward_id
    LEFT JOIN ward_beds b ON p.assigned_ward_id = b.ward_id AND p.assigned_bed_id = b.bed_id
    WHERE pb.status = 'ACTIVE'
    ORDER BY pb.bound_at DESC, pb.binding_id DESC
  `;
  const [rows] = await pool.query(query);
  return rows.map(r => ({
    ...r,
    age: calculateAge(r.dob)
  }));
}

/**
 * Retrieves lists of admitted patients and wristbands that are NOT yet paired.
 * Results are sorted strictly newest-first (most recently registered first).
 */
async function getUnpairedCandidates() {
  const pool = getPool();

  // 1. Unpaired Admitted Patients (ordered newest admission first)
  const patientSql = `
    SELECT 
      p.patient_id,
      p.full_name,
      p.nric_passport,
      DATE_FORMAT(p.dob, '%Y-%m-%d') AS dob,
      p.gender,
      p.phone_number,
      p.assigned_ward_id,
      p.assigned_bed_id,
      p.fall_risk_score,
      p.photo_url,
      p.created_at,
      DATE_FORMAT(p.admission_date, '%Y-%m-%d %H:%i') AS admission_date,
      w.room_title AS ward_title,
      b.bed_code
    FROM patients p
    LEFT JOIN ward_rooms w ON p.assigned_ward_id = w.ward_id
    LEFT JOIN ward_beds b ON p.assigned_ward_id = b.ward_id AND p.assigned_bed_id = b.bed_id
    WHERE p.status = 'ADMITTED'
      AND p.patient_id NOT IN (SELECT patient_id FROM patient_bindings WHERE status = 'ACTIVE')
    ORDER BY p.admission_date DESC, p.created_at DESC, p.patient_id DESC
  `;
  const [patients] = await pool.query(patientSql);

  // 2. Unpaired Available Wristbands (ordered newest enrolled first)
  const wristbandSql = `
    SELECT 
      d.device_id,
      d.mac_address,
      d.hardware_model,
      d.firmware_version,
      d.battery_level,
      d.status AS device_status,
      d.availability_status,
      d.created_at,
      d.last_seen
    FROM devices d
    WHERE d.device_type = 'WRISTBAND'
      AND d.availability_status != 'UNAVAILABLE'
      AND d.availability_status != 'NOT_AVAILABLE'
      AND d.availability_status != 'MAINTENANCE'
      AND d.device_id NOT IN (SELECT device_id FROM patient_bindings WHERE status = 'ACTIVE')
    ORDER BY d.created_at DESC, d.device_id DESC
  `;
  const [wristbands] = await pool.query(wristbandSql);

  return {
    patients: patients.map(p => ({
      ...p,
      age: calculateAge(p.dob)
    })),
    wristbands
  };
}

/**
 * Creates an atomic patient-to-wristband binding.
 */
async function bindPatientWristband(patientId, deviceId, boundBy = 'DOC-8821') {
  if (!patientId || !deviceId) {
    throw new Error('Both Patient ID and Device ID are required for binding.');
  }

  const pool = getPool();
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    // 1. Verify patient is admitted
    const [patientRows] = await conn.query(
      `SELECT patient_id, full_name, status FROM patients WHERE patient_id = ? FOR UPDATE`,
      [patientId]
    );
    if (!patientRows || patientRows.length === 0) {
      throw new Error(`Patient ${patientId} not found.`);
    }
    if (patientRows[0].status !== 'ADMITTED') {
      throw new Error(`Cannot bind: Patient ${patientRows[0].full_name} is ${patientRows[0].status}.`);
    }

    // 2. Verify patient is not already bound
    const [existingPatientBind] = await conn.query(
      `SELECT binding_id, device_id FROM patient_bindings WHERE patient_id = ? AND status = 'ACTIVE'`,
      [patientId]
    );
    if (existingPatientBind.length > 0) {
      throw new Error(`Patient ${patientRows[0].full_name} is already bound to wristband ${existingPatientBind[0].device_id}.`);
    }

    // 3. Verify device is an available wristband
    const [devRows] = await conn.query(
      `SELECT device_id, mac_address, device_type, availability_status FROM devices WHERE device_id = ? FOR UPDATE`,
      [deviceId]
    );
    if (!devRows || devRows.length === 0) {
      throw new Error(`Wristband ${deviceId} not found.`);
    }
    if (devRows[0].device_type !== 'WRISTBAND') {
      throw new Error(`Device ${deviceId} is of type ${devRows[0].device_type}, not WRISTBAND.`);
    }

    // 4. Verify wristband is not already bound
    const [existingDevBind] = await conn.query(
      `SELECT binding_id, patient_id FROM patient_bindings WHERE device_id = ? AND status = 'ACTIVE'`,
      [deviceId]
    );
    if (existingDevBind.length > 0) {
      throw new Error(`Wristband ${deviceId} is already bound to patient ${existingDevBind[0].patient_id}.`);
    }

    // 5. Insert active binding
    const [insertResult] = await conn.query(
      `INSERT INTO patient_bindings (patient_id, device_id, bound_at, bound_by, stream_rate, status)
       VALUES (?, ?, NOW(), ?, '5 Hz Live Stream', 'ACTIVE')`,
      [patientId, deviceId, boundBy || 'DOC-8821']
    );

    // 6. Update device availability status to IN_USE
    await conn.query(
      `UPDATE devices SET availability_status = 'IN_USE' WHERE device_id = ?`,
      [deviceId]
    );

    await conn.commit();

    // 7. Broadcast over WebSocket
    broadcastToClients({
      type: 'PATIENT_BOUND',
      binding_id: insertResult.insertId,
      patient_id: patientId,
      patient_name: patientRows[0].full_name,
      device_id: deviceId,
      bound_by: boundBy,
      timestamp: new Date().toLocaleTimeString()
    });

    return {
      success: true,
      binding_id: insertResult.insertId,
      patient_id: patientId,
      device_id: deviceId,
      message: `Successfully paired Patient ${patientRows[0].full_name} (${patientId}) with Wristband ${deviceId}.`
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Unbinds an active patient-wristband pairing and releases the wristband back to AVAILABLE.
 */
async function unbindPatientWristband(identifier) {
  if (!identifier) {
    throw new Error('Binding identifier is required.');
  }

  const pool = getPool();
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    // 1. Locate active binding by binding_id, patient_id, or device_id
    const [bindRows] = await conn.query(
      `SELECT pb.binding_id, pb.patient_id, pb.device_id, p.full_name AS patient_name
       FROM patient_bindings pb
       JOIN patients p ON pb.patient_id = p.patient_id
       WHERE (pb.binding_id = ? OR pb.patient_id = ? OR pb.device_id = ?) AND pb.status = 'ACTIVE'
       LIMIT 1
       FOR UPDATE`,
      [identifier, identifier, identifier]
    );

    if (!bindRows || bindRows.length === 0) {
      throw new Error(`Active binding not found for "${identifier}".`);
    }

    const b = bindRows[0];

    // 2. Remove binding record
    await conn.query(`DELETE FROM patient_bindings WHERE binding_id = ?`, [b.binding_id]);

    // 3. Mark wristband as AVAILABLE
    await conn.query(`UPDATE devices SET availability_status = 'AVAILABLE' WHERE device_id = ?`, [b.device_id]);

    await conn.commit();

    // 4. Broadcast over WebSocket
    broadcastToClients({
      type: 'PATIENT_UNBOUND',
      binding_id: b.binding_id,
      patient_id: b.patient_id,
      patient_name: b.patient_name,
      device_id: b.device_id,
      timestamp: new Date().toLocaleTimeString()
    });

    return {
      success: true,
      binding_id: b.binding_id,
      patient_id: b.patient_id,
      device_id: b.device_id,
      message: `Wearable tag ${b.device_id} successfully unbound from ${b.patient_name}.`
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = {
  getActiveBindings,
  getUnpairedCandidates,
  bindPatientWristband,
  unbindPatientWristband,
  calculateAge
};
