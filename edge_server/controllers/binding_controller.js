// =============================================================================
// SHIRO Hospital Edge Server - Patient-to-Wristband Binding HTTP Controller
// =============================================================================

const bindingService = require('../services/binding_service');

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data));
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { success: false, error: message });
}

/**
 * GET /api/bindings/list or /api/bindings
 */
async function listBindings(req, res) {
  try {
    const bindings = await bindingService.getActiveBindings();
    sendJson(res, 200, { success: true, count: bindings.length, bindings });
  } catch (err) {
    console.error('[BINDING API ERROR] listBindings:', err);
    sendError(res, 500, err.message || 'Failed to list active bindings');
  }
}

/**
 * GET /api/bindings/unpaired-candidates
 */
async function getUnpairedCandidates(req, res) {
  try {
    const data = await bindingService.getUnpairedCandidates();
    sendJson(res, 200, {
      success: true,
      patientCount: data.patients.length,
      wristbandCount: data.wristbands.length,
      patients: data.patients,
      wristbands: data.wristbands
    });
  } catch (err) {
    console.error('[BINDING API ERROR] getUnpairedCandidates:', err);
    sendError(res, 500, err.message || 'Failed to load unpaired candidates');
  }
}

/**
 * POST /api/bindings/bind
 */
async function createBinding(req, res, body) {
  try {
    const payload = typeof body === 'string' ? JSON.parse(body || '{}') : body;
    const { patient_id, device_id, bound_by } = payload;
    const result = await bindingService.bindPatientWristband(patient_id, device_id, bound_by);
    sendJson(res, 200, result);
  } catch (err) {
    console.error('[BINDING API ERROR] createBinding:', err);
    sendError(res, 400, err.message || 'Failed to pair patient with wristband');
  }
}

/**
 * POST or DELETE /api/bindings/unbind
 */
async function removeBinding(req, res, body, parsedUrl) {
  try {
    let identifier = parsedUrl?.searchParams?.get('id') || parsedUrl?.searchParams?.get('binding_id');
    if (!identifier && body) {
      const payload = typeof body === 'string' ? JSON.parse(body || '{}') : body;
      identifier = payload.binding_id || payload.patient_id || payload.device_id;
    }
    const result = await bindingService.unbindPatientWristband(identifier);
    sendJson(res, 200, result);
  } catch (err) {
    console.error('[BINDING API ERROR] removeBinding:', err);
    sendError(res, 400, err.message || 'Failed to unbind wearable tag');
  }
}

module.exports = {
  listBindings,
  getUnpairedCandidates,
  createBinding,
  removeBinding
};
