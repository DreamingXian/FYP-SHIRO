// =============================================================================
// SHIRO Hospital Edge Server - Patient Controller
// REST API Handlers for Inpatient Directory, Admissions & Bed Sync
// =============================================================================
const patientService = require('../services/patient_service');

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function sendError(res, statusCode, message) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ success: false, error: message }));
}

/**
 * GET /api/patients
 */
async function listPatients(req, res, parsedUrl) {
  try {
    const status = parsedUrl.searchParams.get('status') || 'ALL';
    const patients = await patientService.getAllPatients(status);
    sendJson(res, 200, { success: true, count: patients.length, patients });
  } catch (err) {
    console.error('[PATIENT API ERROR] listPatients:', err);
    sendError(res, 500, err.message || 'Failed to list patients');
  }
}

/**
 * GET /api/patients/get?id=P-001
 */
async function getPatient(req, res, parsedUrl) {
  try {
    const id = parsedUrl.searchParams.get('id');
    if (!id) {
      return sendError(res, 400, 'Missing required query parameter "id"');
    }
    const patient = await patientService.getPatientById(id);
    if (!patient) {
      return sendError(res, 404, `Patient "${id}" not found`);
    }
    sendJson(res, 200, { success: true, patient });
  } catch (err) {
    console.error('[PATIENT API ERROR] getPatient:', err);
    sendError(res, 500, err.message || 'Failed to fetch patient');
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
    console.error('[PATIENT API ERROR] getNextId:', err);
    sendError(res, 500, err.message || 'Failed to generate next patient ID');
  }
}

/**
 * GET /api/patients/available-beds?ward_id=WARD-001
 */
async function getAvailableBeds(req, res, parsedUrl) {
  try {
    const wardId = parsedUrl.searchParams.get('ward_id') || null;
    const data = await patientService.getAvailableBeds(wardId);
    sendJson(res, 200, { success: true, ...data });
  } catch (err) {
    console.error('[PATIENT API ERROR] getAvailableBeds:', err);
    sendError(res, 500, err.message || 'Failed to fetch available beds');
  }
}

/**
 * POST /api/patients/admit
 */
async function admitPatient(req, res, body) {
  try {
    let payload;
    try {
      payload = typeof body === 'string' ? JSON.parse(body) : body;
    } catch {
      return sendError(res, 400, 'Invalid JSON request payload');
    }

    if (!payload.full_name || !payload.nric_passport || !payload.dob || !payload.phone_number) {
      return sendError(res, 400, 'Missing required patient fields (Full Name, NRIC, DOB, Phone).');
    }

    const result = await patientService.admitPatient(payload);
    sendJson(res, 201, result);
  } catch (err) {
    console.error('[PATIENT API ERROR] admitPatient:', err);
    sendError(res, 400, err.message || 'Patient admission failed');
  }
}

/**
 * POST /api/patients/update
 */
async function updatePatient(req, res, body, parsedUrl) {
  try {
    let payload;
    try {
      payload = typeof body === 'string' ? JSON.parse(body) : body;
    } catch {
      return sendError(res, 400, 'Invalid JSON request payload');
    }

    const patientId = payload.patient_id || parsedUrl.searchParams.get('id');
    if (!patientId) {
      return sendError(res, 400, 'Missing required patient_id');
    }

    const result = await patientService.updatePatient(patientId, payload);
    sendJson(res, 200, result);
  } catch (err) {
    console.error('[PATIENT API ERROR] updatePatient:', err);
    sendError(res, 400, err.message || 'Failed to update patient record');
  }
}

/**
 * POST /api/patients/discharge
 */
async function dischargePatient(req, res, body, parsedUrl) {
  try {
    let payload = {};
    if (body && body.trim() !== '') {
      try { payload = JSON.parse(body); } catch (_) {}
    }

    const patientId = payload.patient_id || parsedUrl.searchParams.get('id');
    if (!patientId) {
      return sendError(res, 400, 'Missing required patient_id for discharge');
    }

    const result = await patientService.dischargePatient(patientId);
    sendJson(res, 200, result);
  } catch (err) {
    console.error('[PATIENT API ERROR] dischargePatient:', err);
    sendError(res, 400, err.message || 'Failed to discharge patient');
  }
}

/**
 * POST /api/patients/assign-bed
 */
async function assignBed(req, res, body) {
  try {
    let payload;
    try {
      payload = typeof body === 'string' ? JSON.parse(body) : body;
    } catch {
      return sendError(res, 400, 'Invalid JSON request payload');
    }

    const { patient_id, ward_id, bed_id } = payload;
    if (!patient_id || !ward_id || !bed_id) {
      return sendError(res, 400, 'Missing required fields: patient_id, ward_id, bed_id');
    }

    const result = await patientService.assignBed(patient_id, ward_id, bed_id);
    sendJson(res, 200, result);
  } catch (err) {
    console.error('[PATIENT API ERROR] assignBed:', err);
    sendError(res, 400, err.message || 'Failed to assign bed');
  }
}

/**
 * POST /api/patients/delete or DELETE /api/patients/delete
 */
async function deletePatient(req, res, body, parsedUrl) {
  try {
    let payload = {};
    if (body && body.trim() !== '') {
      try { payload = JSON.parse(body); } catch (_) {}
    }

    const patientId = payload.patient_id || parsedUrl.searchParams.get('id');
    if (!patientId) {
      return sendError(res, 400, 'Missing required patient_id for deletion');
    }

    const result = await patientService.deletePatient(patientId);
    sendJson(res, 200, result);
  } catch (err) {
    console.error('[PATIENT API ERROR] deletePatient:', err);
    sendError(res, 400, err.message || 'Failed to delete patient record');
  }
}

/**
 * POST /api/patients/upload-photo
 */
async function uploadPhoto(req, res, body) {
  try {
    let payload;
    try {
      payload = typeof body === 'string' ? JSON.parse(body) : body;
    } catch {
      return sendError(res, 400, 'Invalid JSON request payload');
    }

    if (!payload.image_data) {
      return sendError(res, 400, 'Missing image_data base64 string');
    }

    const patientId = payload.patient_id || 'TEMP';
    const photoUrl = await patientService.savePhotoUpload(payload.image_data, patientId);
    sendJson(res, 200, { success: true, photo_url: photoUrl });
  } catch (err) {
    console.error('[PATIENT API ERROR] uploadPhoto:', err);
    sendError(res, 400, err.message || 'Photo upload failed');
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
