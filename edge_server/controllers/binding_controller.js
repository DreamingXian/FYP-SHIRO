// =============================================================================
// SHIRO Hospital Edge Server - Patient-to-Wristband Binding HTTP Controller
// =============================================================================

const bindingService = require('../services/binding_service');
const { sendJson, sendFailure, parseJsonBody } = require('../utils/http');
const { requireId } = require('../utils/validate');
const { actorLabel } = require('../services/auth/auth_service');

/**
 * GET /api/bindings/list or /api/bindings
 */
async function listBindings(req, res) {
  try {
    const bindings = await bindingService.getActiveBindings();
    sendJson(res, 200, { success: true, count: bindings.length, bindings });
  } catch (err) {
    sendFailure(res, err, 'listBindings');
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
    sendFailure(res, err, 'getUnpairedCandidates');
  }
}

/**
 * POST /api/bindings/bind
 */
async function createBinding(req, res, body) {
  try {
    const payload = parseJsonBody(body);
    const patientId = requireId(payload.patient_id, 'patient_id');
    const deviceId = requireId(payload.device_id, 'device_id');
    // Recorded as the signed-in clinician; a name sent by the browser is not trusted
    const boundBy = req.actor ? actorLabel(req.actor).slice(0, 64) : null;

    const result = await bindingService.bindPatientWristband(patientId, deviceId, boundBy);
    sendJson(res, 200, result);
  } catch (err) {
    sendFailure(res, err, 'createBinding');
  }
}

/**
 * POST or DELETE /api/bindings/unbind
 * The binding is named by its binding ID, its patient ID or its device ID.
 */
async function removeBinding(req, res, body, parsedUrl) {
  try {
    const payload = parseJsonBody(body);
    const identifier = requireId(
      parsedUrl.searchParams.get('id') || parsedUrl.searchParams.get('binding_id') ||
      (payload.binding_id !== undefined ? String(payload.binding_id) : null) || payload.patient_id || payload.device_id,
      'id'
    );
    const result = await bindingService.unbindPatientWristband(identifier);
    sendJson(res, 200, result);
  } catch (err) {
    sendFailure(res, err, 'removeBinding');
  }
}

module.exports = {
  listBindings,
  getUnpairedCandidates,
  createBinding,
  removeBinding
};
