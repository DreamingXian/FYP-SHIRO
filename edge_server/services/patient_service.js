// =============================================================================
// SHIRO Hospital Edge Server - Patient Service
// Manages Inpatient Records, Atomic Bed Allocation & Bed Release Synchronization
// =============================================================================
const { getPool } = require('../database/db');
const fs = require('fs');
const path = require('path');
const config = require('../config/app_config');

/**
 * Calculates real-time age in years from date of birth.
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
 * Retrieves all patients with joined ward titles, bed codes, and calculated ages.
 * @param {string} filterStatus - 'ALL' | 'ADMITTED' | 'DISCHARGED'
 */
async function getAllPatients(filterStatus = 'ALL') {
  const pool = getPool();
  let query = `
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
      p.medical_history,
      p.photo_url,
      DATE_FORMAT(p.admission_date, '%Y-%m-%d %H:%i') AS admission_date,
      DATE_FORMAT(p.discharge_date, '%Y-%m-%d %H:%i') AS discharge_date,
      p.status,
      w.room_title AS ward_title,
      b.bed_code
    FROM patients p
    LEFT JOIN ward_rooms w ON p.assigned_ward_id = w.ward_id
    LEFT JOIN ward_beds b ON p.assigned_ward_id = b.ward_id AND p.assigned_bed_id = b.bed_id
  `;

  const params = [];
  if (filterStatus && filterStatus.toUpperCase() !== 'ALL') {
    query += ` WHERE p.status = ?`;
    params.push(filterStatus.toUpperCase());
  }

  query += ` ORDER BY p.admission_date DESC, p.patient_id DESC`;

  const [rows] = await pool.query(query, params);
  return rows.map(r => ({
    ...r,
    age: calculateAge(r.dob)
  }));
}

/**
 * Retrieves a single patient by ID.
 */
async function getPatientById(patientId) {
  const pool = getPool();
  const query = `
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
      p.medical_history,
      p.photo_url,
      DATE_FORMAT(p.admission_date, '%Y-%m-%d %H:%i') AS admission_date,
      DATE_FORMAT(p.discharge_date, '%Y-%m-%d %H:%i') AS discharge_date,
      p.status,
      w.room_title AS ward_title,
      b.bed_code
    FROM patients p
    LEFT JOIN ward_rooms w ON p.assigned_ward_id = w.ward_id
    LEFT JOIN ward_beds b ON p.assigned_ward_id = b.ward_id AND p.assigned_bed_id = b.bed_id
    WHERE p.patient_id = ?
    LIMIT 1
  `;
  const [rows] = await pool.query(query, [patientId]);
  if (!rows || rows.length === 0) return null;
  return {
    ...rows[0],
    age: calculateAge(rows[0].dob)
  };
}

/**
 * Auto-generates the next sequential patient ID (e.g. P-001, P-002, P-006).
 */
async function getNextPatientId() {
  const pool = getPool();
  const query = `
    SELECT patient_id 
    FROM patients 
    WHERE patient_id REGEXP '^P-[0-9]+$' 
    ORDER BY CAST(SUBSTRING(patient_id, 3) AS UNSIGNED) DESC 
    LIMIT 1
  `;
  const [rows] = await pool.query(query);
  if (!rows || rows.length === 0) {
    return 'P-001';
  }
  const maxId = rows[0].patient_id;
  const numPart = parseInt(maxId.substring(2), 10);
  const nextNum = isNaN(numPart) ? 1 : numPart + 1;
  return `P-${String(nextNum).padStart(3, '0')}`;
}

/**
 * Retrieves available wards and currently AVAILABLE beds for patient assignment.
 * @param {string|null} wardId - If supplied, filters available beds for this specific ward.
 */
async function getAvailableBeds(wardId = null) {
  const pool = getPool();

  // 1. Get all active wards
  const [wards] = await pool.query(`
    SELECT ward_id, room_title 
    FROM ward_rooms 
    ORDER BY ward_id ASC
  `);

  // 2. Query available beds (status = 'AVAILABLE')
  let bedQuery = `
    SELECT 
      b.bed_id,
      b.ward_id,
      b.bed_code,
      b.status,
      w.room_title AS ward_title
    FROM ward_beds b
    JOIN ward_rooms w ON b.ward_id = w.ward_id
    WHERE b.status = 'AVAILABLE'
  `;
  const params = [];
  if (wardId) {
    bedQuery += ` AND b.ward_id = ?`;
    params.push(wardId);
  }
  bedQuery += ` ORDER BY b.ward_id ASC, b.bed_id ASC`;

  const [availableBeds] = await pool.query(bedQuery, params);

  return {
    wards,
    availableBeds
  };
}

/**
 * Admits a new patient into MySQL within an atomic transaction.
 * Synchronously marks the assigned bed as OCCUPIED.
 */
async function admitPatient(patientData) {
  const pool = getPool();
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    // 1. Resolve Patient ID
    let patientId = patientData.patient_id;
    if (!patientId || patientId.trim() === '') {
      const [rows] = await conn.query(`
        SELECT patient_id 
        FROM patients 
        WHERE patient_id REGEXP '^P-[0-9]+$' 
        ORDER BY CAST(SUBSTRING(patient_id, 3) AS UNSIGNED) DESC 
        LIMIT 1
      `);
      if (!rows || rows.length === 0) {
        patientId = 'P-001';
      } else {
        const num = parseInt(rows[0].patient_id.substring(2), 10);
        patientId = `P-${String(isNaN(num) ? 1 : num + 1).padStart(3, '0')}`;
      }
    }

    // 1.5 Strict Field Validations
    if (!patientData.full_name || patientData.full_name.trim().length < 2) {
      throw new Error('Validation Error: Legal full name must be at least 2 characters.');
    }

    const dob = patientData.dob;
    if (!dob) {
      throw new Error('Validation Error: Date of birth is required.');
    }
    const todayStr = new Date().toISOString().split('T')[0];
    if (dob > todayStr) {
      throw new Error('Validation Error: Date of birth cannot be in the future.');
    }

    const cleanNric = patientData.nric_passport ? patientData.nric_passport.replace(/[-\s]/g, '').toUpperCase() : '';
    if (!cleanNric) {
      throw new Error('Validation Error: National ID / NRIC or Passport is required.');
    }
    const isPureDigits = /^\d+$/.test(cleanNric);
    if (isPureDigits) {
      if (cleanNric.length !== 12) {
        throw new Error(`Validation Error: Malaysian NRIC must be exactly 12 digits (received ${cleanNric.length} digits).`);
      }
      // Cross check prefix with DOB
      const dobParts = dob.split('-');
      if (dobParts.length === 3) {
        const expectedPrefix = `${dobParts[0].substring(2)}${dobParts[1]}${dobParts[2]}`;
        const actualPrefix = cleanNric.substring(0, 6);
        if (actualPrefix !== expectedPrefix) {
          throw new Error(`Validation Error: NRIC birthdate prefix (${actualPrefix}) does not match Date of Birth (${expectedPrefix}).`);
        }
      }
    } else {
      if (cleanNric.length < 6 || cleanNric.length > 12) {
        throw new Error('Validation Error: Foreign Passport must be 6 to 12 alphanumeric characters.');
      }
    }

    const cleanPhone = patientData.phone_number ? patientData.phone_number.replace(/[-\s\(\)\+]/g, '') : '';
    if (!cleanPhone || cleanPhone.length < 8 || cleanPhone.length > 15 || !/^\d+$/.test(cleanPhone)) {
      throw new Error('Validation Error: Please enter a valid contact phone number (at least 8 digits).');
    }

    // 2. Validate NRIC / Passport uniqueness (stripping hyphens and spaces)
    const [nricCheck] = await conn.query(
      `SELECT patient_id, full_name, nric_passport, status FROM patients 
       WHERE REPLACE(REPLACE(nric_passport, '-', ''), ' ', '') = ? LIMIT 1`,
      [cleanNric]
    );
    if (nricCheck.length > 0) {
      throw new Error(`Patient Already Registered: A record with ID/Passport "${patientData.nric_passport}" already exists for ${nricCheck[0].full_name} (${nricCheck[0].patient_id}, Status: ${nricCheck[0].status}).`);
    }

    // 3. Verify bed availability if assigned
    const wardId = patientData.assigned_ward_id || null;
    const bedId = patientData.assigned_bed_id || null;

    if (wardId && bedId) {
      const [bedRows] = await conn.query(
        `SELECT status, bed_code FROM ward_beds WHERE ward_id = ? AND bed_id = ? FOR UPDATE`,
        [wardId, bedId]
      );
      if (bedRows.length === 0) {
        throw new Error(`Bed ${bedId} not found in ward ${wardId}.`);
      }
      if (bedRows[0].status !== 'AVAILABLE') {
        throw new Error(`Cubicle ${bedRows[0].bed_code} (${bedId}) is currently ${bedRows[0].status} and cannot be assigned.`);
      }

      // Mark bed as OCCUPIED
      await conn.query(
        `UPDATE ward_beds SET status = 'OCCUPIED' WHERE ward_id = ? AND bed_id = ?`,
        [wardId, bedId]
      );
    }

    // 4. Default photo if empty
    let photoUrl = patientData.photo_url || '';
    if (!photoUrl.trim()) {
      photoUrl = patientData.gender === 'FEMALE' 
        ? '/uploads/patients/preset_adult_female.svg' 
        : '/uploads/patients/preset_adult_male.svg';
    }

    // 5. Insert patient record
    const insertSql = `
      INSERT INTO patients (
        patient_id,
        full_name,
        nric_passport,
        dob,
        gender,
        phone_number,
        assigned_ward_id,
        assigned_bed_id,
        fall_risk_score,
        medical_history,
        photo_url,
        admission_date,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), 'ADMITTED')
    `;

    await conn.query(insertSql, [
      patientId,
      patientData.full_name.trim(),
      patientData.nric_passport.trim(),
      patientData.dob,
      patientData.gender || 'MALE',
      patientData.phone_number.trim(),
      wardId,
      bedId,
      patientData.fall_risk_score || 'LOW',
      patientData.medical_history ? patientData.medical_history.trim() : '',
      photoUrl
    ]);

    await conn.commit();
    return {
      success: true,
      patient_id: patientId,
      message: `Patient ${patientData.full_name} (${patientId}) admitted successfully.`
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Updates an existing patient's clinical profile or notes.
 */
async function updatePatient(patientId, updateData) {
  const pool = getPool();
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const [existing] = await conn.query(
      `SELECT * FROM patients WHERE patient_id = ? LIMIT 1 FOR UPDATE`,
      [patientId]
    );
    if (existing.length === 0) {
      throw new Error(`Patient "${patientId}" not found.`);
    }

    const current = existing[0];
    const newWardId = updateData.assigned_ward_id !== undefined ? updateData.assigned_ward_id : current.assigned_ward_id;
    const newBedId = updateData.assigned_bed_id !== undefined ? updateData.assigned_bed_id : current.assigned_bed_id;

    // Bed reassignment handling
    if (current.status === 'ADMITTED' && (current.assigned_ward_id !== newWardId || current.assigned_bed_id !== newBedId)) {
      // Release old bed if it was set
      if (current.assigned_ward_id && current.assigned_bed_id) {
        await conn.query(
          `UPDATE ward_beds SET status = 'AVAILABLE' WHERE ward_id = ? AND bed_id = ?`,
          [current.assigned_ward_id, current.assigned_bed_id]
        );
      }
      // Occupy new bed if provided
      if (newWardId && newBedId) {
        const [targetBed] = await conn.query(
          `SELECT status, bed_code FROM ward_beds WHERE ward_id = ? AND bed_id = ? FOR UPDATE`,
          [newWardId, newBedId]
        );
        if (targetBed.length === 0) {
          throw new Error(`Target bed ${newBedId} not found in ward ${newWardId}.`);
        }
        if (targetBed[0].status !== 'AVAILABLE') {
          throw new Error(`Target bed ${targetBed[0].bed_code} is already ${targetBed[0].status}.`);
        }
        await conn.query(
          `UPDATE ward_beds SET status = 'OCCUPIED' WHERE ward_id = ? AND bed_id = ?`,
          [newWardId, newBedId]
        );
      }
    }

    // Update fields
    const updateSql = `
      UPDATE patients SET
        full_name = ?,
        nric_passport = ?,
        dob = ?,
        gender = ?,
        phone_number = ?,
        assigned_ward_id = ?,
        assigned_bed_id = ?,
        fall_risk_score = ?,
        medical_history = ?,
        photo_url = COALESCE(?, photo_url)
      WHERE patient_id = ?
    `;

    await conn.query(updateSql, [
      updateData.full_name || current.full_name,
      updateData.nric_passport || current.nric_passport,
      updateData.dob || current.dob,
      updateData.gender || current.gender,
      updateData.phone_number || current.phone_number,
      newWardId,
      newBedId,
      updateData.fall_risk_score || current.fall_risk_score,
      updateData.medical_history !== undefined ? updateData.medical_history : current.medical_history,
      updateData.photo_url || null,
      patientId
    ]);

    await conn.commit();
    return { success: true, message: `Patient ${patientId} updated successfully.` };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Discharges an admitted patient, releases their hospital cubicle bed back to AVAILABLE.
 */
async function dischargePatient(patientId) {
  const pool = getPool();
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      `SELECT patient_id, full_name, assigned_ward_id, assigned_bed_id, status 
       FROM patients WHERE patient_id = ? FOR UPDATE`,
      [patientId]
    );

    if (rows.length === 0) {
      throw new Error(`Patient "${patientId}" not found.`);
    }

    const patient = rows[0];
    if (patient.status === 'DISCHARGED') {
      throw new Error(`Patient ${patient.full_name} (${patientId}) is already discharged.`);
    }

    // 1. Release the bed back to AVAILABLE if assigned
    if (patient.assigned_ward_id && patient.assigned_bed_id) {
      await conn.query(
        `UPDATE ward_beds SET status = 'AVAILABLE' WHERE ward_id = ? AND bed_id = ?`,
        [patient.assigned_ward_id, patient.assigned_bed_id]
      );
    }

    // 2. Release any active wristband wearable tag back to AVAILABLE
    try {
      const [bindRows] = await conn.query('SELECT device_id FROM patient_bindings WHERE patient_id = ?', [patientId]);
      if (bindRows && bindRows.length > 0) {
        for (const b of bindRows) {
          await conn.query(`UPDATE devices SET availability_status = 'AVAILABLE' WHERE device_id = ?`, [b.device_id]);
        }
        await conn.query('DELETE FROM patient_bindings WHERE patient_id = ?', [patientId]);
      }
    } catch (_) {}

    // 2. Mark patient as DISCHARGED
    await conn.query(
      `UPDATE patients 
       SET status = 'DISCHARGED', 
           discharge_date = NOW(),
           assigned_ward_id = NULL,
           assigned_bed_id = NULL
       WHERE patient_id = ?`,
      [patientId]
    );

    await conn.commit();
    return {
      success: true,
      message: `Patient ${patient.full_name} (${patientId}) discharged. Bed released to AVAILABLE.`
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Permanently deletes a patient record from MySQL.
 * If the patient was occupying a bed, releases the bed back to AVAILABLE.
 */
async function deletePatient(patientId) {
  const pool = getPool();
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      `SELECT patient_id, full_name, assigned_ward_id, assigned_bed_id 
       FROM patients WHERE patient_id = ? FOR UPDATE`,
      [patientId]
    );

    if (rows.length === 0) {
      throw new Error(`Patient "${patientId}" not found.`);
    }

    const patient = rows[0];

    // 1. Release assigned bed if any
    if (patient.assigned_ward_id && patient.assigned_bed_id) {
      await conn.query(
        `UPDATE ward_beds SET status = 'AVAILABLE' WHERE ward_id = ? AND bed_id = ?`,
        [patient.assigned_ward_id, patient.assigned_bed_id]
      );
    }

    // 2. Delete patient row
    await conn.query(`DELETE FROM patients WHERE patient_id = ?`, [patientId]);

    await conn.commit();
    return {
      success: true,
      message: `Patient ${patient.full_name} (${patientId}) permanently deleted.`
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Assigns or re-assigns an inpatient to a specific ward and bed cubicle.
 */
async function assignBed(patientId, wardId, bedId) {
  const pool = getPool();
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    // 1. Fetch current patient
    const [patientRows] = await conn.query(
      `SELECT patient_id, full_name, assigned_ward_id, assigned_bed_id, status 
       FROM patients WHERE patient_id = ? FOR UPDATE`,
      [patientId]
    );

    if (patientRows.length === 0) {
      throw new Error(`Patient "${patientId}" not found.`);
    }

    const patient = patientRows[0];

    // 2. Check target bed availability
    const [bedRows] = await conn.query(
      `SELECT status, bed_code FROM ward_beds WHERE ward_id = ? AND bed_id = ? FOR UPDATE`,
      [wardId, bedId]
    );

    if (bedRows.length === 0) {
      throw new Error(`Bed ${bedId} not found in ward ${wardId}.`);
    }
    if (bedRows[0].status !== 'AVAILABLE') {
      throw new Error(`Bed ${bedRows[0].bed_code} (${bedId}) is currently ${bedRows[0].status} and cannot be assigned.`);
    }

    // 3. Release old bed if currently assigned
    if (patient.assigned_ward_id && patient.assigned_bed_id) {
      await conn.query(
        `UPDATE ward_beds SET status = 'AVAILABLE' WHERE ward_id = ? AND bed_id = ?`,
        [patient.assigned_ward_id, patient.assigned_bed_id]
      );
    }

    // 4. Occupy target bed
    await conn.query(
      `UPDATE ward_beds SET status = 'OCCUPIED' WHERE ward_id = ? AND bed_id = ?`,
      [wardId, bedId]
    );

    // 5. Update patient record
    await conn.query(
      `UPDATE patients 
       SET assigned_ward_id = ?, 
           assigned_bed_id = ?, 
           status = 'ADMITTED' 
       WHERE patient_id = ?`,
      [wardId, bedId, patientId]
    );

    await conn.commit();
    return {
      success: true,
      message: `Bed ${bedRows[0].bed_code} (${wardId}) successfully assigned to ${patient.full_name} (${patientId}).`
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Saves a base64 encoded photo to disk in public/uploads/patients/
 */
async function savePhotoUpload(base64Data, patientId) {
  const matches = base64Data.match(/^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/);
  if (!matches) {
    throw new Error('Invalid image data format. Expected base64 image data URI.');
  }

  const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
  const buffer = Buffer.from(matches[2], 'base64');

  const filename = `${patientId}_${Date.now()}.${ext}`;
  const uploadDir = path.join(config.PUBLIC_DIR, 'uploads', 'patients');

  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  const filePath = path.join(uploadDir, filename);
  fs.writeFileSync(filePath, buffer);

  return `/uploads/patients/${filename}`;
}

module.exports = {
  getAllPatients,
  getPatientById,
  getNextPatientId,
  getAvailableBeds,
  admitPatient,
  updatePatient,
  dischargePatient,
  deletePatient,
  assignBed,
  savePhotoUpload,
  calculateAge
};

