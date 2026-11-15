// =============================================================================
// SHIRO Hospital Edge Server - Emergency & Incident Alert Routes
// =============================================================================
const alertService = require('../services/alert_service');
const patientService = require('../services/patient_service');
const config = require('../config/app_config');
const thresholds = require('../config/clinical_thresholds');
const { getPool } = require('../database/db');
const { HttpError, sendJson, sendFailure, parseJsonBody } = require('../utils/http');
const { requireId, requireOneOf, optionalNumber, optionalInt, optionalText } = require('../utils/validate');
const { actorLabel } = require('../services/auth/auth_service');

const INCIDENT_CATEGORIES = ['FALL_ACCIDENT', 'CRITICAL_VITALS', 'GEOFENCE_BREACH'];
const INCIDENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$/;

// Test inputs of the Live Lab test bench. They are not measurements: every
// incident created from them is stored with is_simulated = 1.
const SIMULATION_INPUTS = {
  FALL_ACCIDENT: { impactG: 3.42, stillness: 0.08, heartRate: 88, spo2: 97 },
  CRITICAL_VITALS: { impactG: null, stillness: null, heartRate: 148, spo2: 84 },
  GEOFENCE_BREACH: { impactG: null, stillness: null, heartRate: null, spo2: null }
};

/** The wristband bound to a patient, or null. */
async function findBoundWristband(patientId) {
  const [rows] = await getPool().query(`
    SELECT d.device_id, d.mac_address
    FROM patient_bindings pb
    JOIN devices d ON pb.device_id = d.device_id
    WHERE pb.patient_id = ? AND pb.status = 'ACTIVE'
    LIMIT 1
  `, [patientId]);
  return rows.length > 0 ? rows[0] : null;
}

async function handleAlertRoutes(pathname, req, res, parsedUrl, body) {
  // 1. GET /api/alerts/active - Retrieve current unacknowledged emergencies
  if (pathname === '/api/alerts/active' && req.method === 'GET') {
    try {
      const alerts = await alertService.getActiveAlerts();
      sendJson(res, 200, { success: true, count: alerts.length, alerts });
    } catch (err) {
      sendFailure(res, err, 'getActiveAlerts');
    }
    return true;
  }

  // 2. GET /api/alerts/history - Retrieve historical incident audit logs
  if (pathname === '/api/alerts/history' && req.method === 'GET') {
    try {
      const limit = optionalInt(parsedUrl.searchParams.get('limit'), 'limit', { min: 1, max: 500 }, 50);
      const history = await alertService.getIncidentHistory(limit);
      sendJson(res, 200, { success: true, count: history.length, history });
    } catch (err) {
      sendFailure(res, err, 'getIncidentHistory');
    }
    return true;
  }

  // 3. POST /api/alerts/acknowledge - Clinician acknowledges emergency incident
  if (pathname === '/api/alerts/acknowledge' && req.method === 'POST') {
    try {
      const data = parseJsonBody(body);
      if (typeof data.incident_id !== 'string' || !INCIDENT_ID_PATTERN.test(data.incident_id)) {
        throw new HttpError(400, 'incident_id is required and must be a valid incident ID.');
      }
      const notes = optionalText(data.notes, 'notes', 2000);
      // The signed-in clinician or the paired headset; a name sent by the client is not trusted
      const result = await alertService.acknowledgeIncident(
        data.incident_id,
        req.actor ? actorLabel(req.actor).slice(0, 64) : alertService.UNVERIFIED_CLINICIAN,
        notes || ''
      );
      sendJson(res, 200, result);
    } catch (err) {
      sendFailure(res, err, 'acknowledgeIncident');
    }
    return true;
  }

  // 4. POST /api/alerts/trigger-simulation - Live Lab test bench.
  // The patient must exist: name, ward, bed and wristband are read from the
  // database. Only the measurement values are test inputs.
  if (pathname === '/api/alerts/trigger-simulation' && req.method === 'POST') {
    try {
      if (!config.ENABLE_SIMULATION) {
        throw new HttpError(403, 'Simulation is disabled on this server (ENABLE_SIMULATION=false).');
      }
      const data = parseJsonBody(body);
      const category = requireOneOf(data.category, INCIDENT_CATEGORIES, 'category');
      const patientId = requireId(data.patient_id, 'patient_id');
      const valid = thresholds.vitals.valid;
      const inputs = SIMULATION_INPUTS[category];
      const impactG = optionalNumber(data.impact_g, 'impact_g', { min: 0, max: thresholds.kinematics.maxPlausibleG }, inputs.impactG);
      const heartRate = optionalInt(data.heart_rate, 'heart_rate', { min: valid.bpmMin, max: valid.bpmMax }, inputs.heartRate);
      const spo2 = optionalNumber(data.spo2, 'spo2', { min: valid.spo2Min, max: valid.spo2Max }, inputs.spo2);
      const posX = optionalNumber(data.pos_x, 'pos_x', { min: -1000, max: 1000 });
      const posY = optionalNumber(data.pos_y, 'pos_y', { min: -1000, max: 1000 });
      const message = optionalText(data.message, 'message', 500);

      const patient = await patientService.getPatientById(patientId);
      if (!patient) throw new HttpError(404, `Patient "${patientId}" not found. A simulation needs an existing patient.`);
      const wristband = await findBoundWristband(patientId);

      const created = await alertService.recordIncident({
        incident_category: category,
        patient_id: patient.patient_id,
        patient_name: patient.full_name,
        ward_id: patient.assigned_ward_id || null,
        bed_id: patient.assigned_bed_id || null,
        wristband_mac: wristband ? wristband.mac_address : null,
        device_id: wristband ? wristband.device_id : null,
        pos_x: posX === null ? undefined : posX,
        pos_y: posY === null ? undefined : posY,
        kinematic_impact_force: impactG,
        post_impact_stillness: inputs.stillness,
        heart_rate: heartRate,
        spo2,
        alert_message: message || '',
        is_simulated: true
      });
      sendJson(res, 201, { success: true, message: 'Simulation alert triggered successfully', incident: created });
    } catch (err) {
      sendFailure(res, err, 'triggerSimulation');
    }
    return true;
  }

  return false;
}

module.exports = { handleAlertRoutes };
