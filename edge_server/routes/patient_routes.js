// =============================================================================
// Patient Directory & Admission Routes Dispatcher
// =============================================================================
const patientController = require('../controllers/patient_controller');

async function handlePatientRoutes(pathname, req, res, parsedUrl, body) {
  // 1. GET /api/patients/list or /api/patients
  if ((pathname === '/api/patients/list' || pathname === '/api/patients') && req.method === 'GET') {
    await patientController.listPatients(req, res, parsedUrl);
    return true;
  }

  // 2. GET /api/patients/get
  if (pathname === '/api/patients/get' && req.method === 'GET') {
    await patientController.getPatient(req, res, parsedUrl);
    return true;
  }

  // 3. GET /api/patients/next-id
  if (pathname === '/api/patients/next-id' && req.method === 'GET') {
    await patientController.getNextId(req, res);
    return true;
  }

  // 4. GET /api/patients/available-beds
  if (pathname === '/api/patients/available-beds' && req.method === 'GET') {
    await patientController.getAvailableBeds(req, res, parsedUrl);
    return true;
  }

  // 5. POST /api/patients/admit
  if (pathname === '/api/patients/admit' && req.method === 'POST') {
    await patientController.admitPatient(req, res, body);
    return true;
  }

  // 6. POST /api/patients/update
  if (pathname === '/api/patients/update' && req.method === 'POST') {
    await patientController.updatePatient(req, res, body, parsedUrl);
    return true;
  }

  // 7. POST /api/patients/discharge
  if (pathname === '/api/patients/discharge' && req.method === 'POST') {
    await patientController.dischargePatient(req, res, body, parsedUrl);
    return true;
  }

  // 8. POST /api/patients/assign-bed
  if (pathname === '/api/patients/assign-bed' && req.method === 'POST') {
    await patientController.assignBed(req, res, body);
    return true;
  }

  // 9. POST or DELETE /api/patients/delete
  if (pathname === '/api/patients/delete' && (req.method === 'POST' || req.method === 'DELETE')) {
    await patientController.deletePatient(req, res, body, parsedUrl);
    return true;
  }

  // 10. POST /api/patients/upload-photo
  if (pathname === '/api/patients/upload-photo' && req.method === 'POST') {
    await patientController.uploadPhoto(req, res, body);
    return true;
  }

  return false;
}

module.exports = {
  handlePatientRoutes
};

