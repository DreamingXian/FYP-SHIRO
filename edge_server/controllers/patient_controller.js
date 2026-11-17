// =============================================================================
// SHIRO Hospital Edge Server - Patient Controller
// REST API Handlers for Inpatient Directory, Admissions & Bed Sync
// =============================================================================
const patientService = require('../services/patient_service');
const { HttpError, sendJson, sendFailure, parseJsonBody } = require('../utils/http');
const { requireId, optionalId, optionalOneOf, optionalText, optionalInt, optionalNumber } = require('../utils/validate');

const PATIENT_STATUS_FILTERS = ['ALL', 'ADMITTED', 'DISCHARGED'];
const GENDERS = ['MALE', 'FEMALE', 'OTHER'];
const FALL_RISK_SCORES = ['LOW', 'MEDIUM', 'HIGH'];
const DATE_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

// Optional body measurements. Absent, null or empty means "not recorded";
// on an update, null or empty clears the recorded value.
const HEIGHT_CM_RANGE = { min: 40, max: 230 };
const WEIGHT_KG_RANGE = { min: 2, max: 300 };

// A patient photo is always a file this server stores in public/uploads/patients.
const PHOTO_URL_PATTERN = /^[/]uploads[/]patients[/][A-Za-z0-9][A-Za-z0-9_.-]{0,99}[.](png|jpg|jpeg|webp|svg)$/;

/**
 * Checks the type, length and allowed values of the patient fields that are
 * present. Which fields are required, and the NRIC and phone rules, are decided
 * by the patient service.
 */
function checkPatientFields(payload) {
  optionalId(payload.patient_id, 'patient_id');
  optionalId(payload.assigned_ward_id, 'assigned_ward_id');
  optionalId(payload.assigned_bed_id, 'assigned_bed_id');
  optionalText(payload.full_name, 'full_name', 128);
  optionalText(payload.nric_passport, 'nric_passport', 32);
  optionalText(payload.phone_number, 'phone_number', 32);
  optionalText(payload.medical_history, 'medical_history', 5000);
  optionalOneOf(payload.gender, GENDERS, 'gender');
  optionalOneOf(payload.fall_risk_score, FALL_RISK_SCORES, 'fall_risk_score');

  // Replaced by the checked number (or null), so the service stores exactly that
  if (payload.height_cm !== undefined) {
    payload.height_cm = optionalInt(payload.height_cm, 'height_cm', HEIGHT_CM_RANGE);
  }
  if (payload.weight_kg !== undefined) {
    const kg = optionalNumber(payload.weight_kg, 'weight_kg', WEIGHT_KG_RANGE);
    payload.weight_kg = kg === null ? null : Math.round(kg * 10) / 10;
  }

  const dob = optionalText(payload.dob, 'dob', 10);
  if (dob !== null && (!DATE_PATTERN.test(dob) || Number.isNaN(Date.parse(dob)))) {
    throw new HttpError(400, 'dob must be a date in the form YYYY-MM-DD.');
  }

  const photoUrl = optionalText(payload.photo_url, 'photo_url', 255);
  if (photoUrl !== null && (!PHOTO_URL_PATTERN.test(photoUrl) || photoUrl.includes('..'))) {
    throw new HttpError(400, 'photo_url must be a photo stored by this server. Upload the photo first.');
  }
}

/**
 * GET /api/patients
 */
async function listPatients(req, res, parsedUrl) {
  try {
    const status = optionalOneOf(parsedUrl.searchParams.get('status'), PATIENT_STATUS_FILTERS, 'status', 'ALL');
    const patients = await patientService.getAllPatients(status);
    sendJson(res, 200, { success: true, count: patients.length, patients });
  } catch (err) {
    sendFailure(res, err, 'listPatients');
  }
}

/**
 * GET /api/patients/get?id=P-001
 */
async function getPatient(req, res, parsedUrl) {
  try {
    const id = requireId(parsedUrl.searchParams.get('id'), 'id');
    const patient = await patientService.getPatientById(id);
    if (!patient) throw new HttpError(404, `Patient "${id}" not found`);
    sendJson(res, 200, { success: true, patient });
  } catch (err) {
    sendFailure(res, err, 'getPatient');
  }
}

/**
 * GET /api/patients/next-id
 */
async function getNextId(req, res) {
  try {
    const nextId = await patientService.getNextPatientId();
    sendJson(res, 200, { success: true, nextId });
  } catch (err) {
    sendFailure(res, err, 'getNextId');
  }
}

/**
 * GET /api/patients/available-beds?ward_id=WARD-001
 */
async function getAvailableBeds(req, res, parsedUrl) {
  try {
    const wardId = optionalId(parsedUrl.searchParams.get('ward_id'), 'ward_id');
    const data = await patientService.getAvailableBeds(wardId);
    sendJson(res, 200, { success: true, ...data });
  } catch (err) {
    sendFailure(res, err, 'getAvailableBeds');
  }
}

/**
 * POST /api/patients/admit
 */
async function admitPatient(req, res, body) {
  try {
    const payload = parseJsonBody(body);
    if (!payload.full_name || !payload.nric_passport || !payload.dob || !payload.phone_number) {
      throw new HttpError(400, 'Missing required patient fields (Full Name, NRIC, DOB, Phone).');
    }
    checkPatientFields(payload);

    const result = await patientService.admitPatient(payload);
    sendJson(res, 201, result);
  } catch (err) {
    sendFailure(res, err, 'admitPatient');
  }
}

/**
 * POST /api/patients/update
 */
async function updatePatient(req, res, body, parsedUrl) {
  try {
    const payload = parseJsonBody(body);
    const patientId = requireId(payload.patient_id || parsedUrl.searchParams.get('id'), 'patient_id');
    checkPatientFields(payload);

    const result = await patientService.updatePatient(patientId, payload);
    sendJson(res, 200, result);
  } catch (err) {
    sendFailure(res, err, 'updatePatient');
  }
}

/**
 * POST /api/patients/discharge
 */
async function dischargePatient(req, res, body, parsedUrl) {
  try {
    const payload = parseJsonBody(body);
    const patientId = requireId(payload.patient_id || parsedUrl.searchParams.get('id'), 'patient_id');
    const result = await patientService.dischargePatient(patientId);
    sendJson(res, 200, result);
  } catch (err) {
    sendFailure(res, err, 'dischargePatient');
  }
}

/**
 * POST /api/patients/assign-bed
 */
async function assignBed(req, res, body) {
  try {
    const payload = parseJsonBody(body);
    const patientId = requireId(payload.patient_id, 'patient_id');
    const wardId = requireId(payload.ward_id, 'ward_id');
    const bedId = requireId(payload.bed_id, 'bed_id');

    const result = await patientService.assignBed(patientId, wardId, bedId);
    sendJson(res, 200, result);
  } catch (err) {
    sendFailure(res, err, 'assignBed');
  }
}

/**
 * POST /api/patients/delete or DELETE /api/patients/delete
 */
async function deletePatient(req, res, body, parsedUrl) {
  try {
    const payload = parseJsonBody(body);
    const patientId = requireId(payload.patient_id || parsedUrl.searchParams.get('id'), 'patient_id');
    const result = await patientService.deletePatient(patientId);
    sendJson(res, 200, result);
  } catch (err) {
    sendFailure(res, err, 'deletePatient');
  }
}

/**
 * POST /api/patients/upload-photo
 */
async function uploadPhoto(req, res, body) {
  try {
    const payload = parseJsonBody(body);
    const patientId = requireId(payload.patient_id, 'patient_id');
    if (typeof payload.image_data !== 'string' || payload.image_data === '') {
      throw new HttpError(400, 'image_data is required.');
    }

    const photoUrl = await patientService.savePhotoUpload(payload.image_data, patientId);
    sendJson(res, 200, { success: true, photo_url: photoUrl });
  } catch (err) {
    sendFailure(res, err, 'uploadPhoto');
  }
}

module.exports = {
  listPatients,
  getPatient,
  getNextId,
  getAvailableBeds,
  admitPatient,
  updatePatient,
  dischargePatient,
  assignBed,
  deletePatient,
  uploadPhoto
};
