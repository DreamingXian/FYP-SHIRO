// =============================================================================
// SHIRO Hospital Edge Server - Emergency & Incident Alert Routes
// =============================================================================
const alertService = require('../services/alert_service');
const config = require('../config/app_config');

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function handleAlertRoutes(pathname, req, res, parsedUrl, body) {
  // 1. GET /api/alerts/active - Retrieve current unacknowledged emergencies
  if (pathname === '/api/alerts/active' && req.method === 'GET') {
    try {
      const alerts = await alertService.getActiveAlerts();
      sendJson(res, 200, { success: true, count: alerts.length, alerts });
    } catch (err) {
      sendJson(res, 500, { success: false, error: err.message });
    }
    return true;
  }

  // 2. GET /api/alerts/history - Retrieve historical incident audit logs
  if (pathname === '/api/alerts/history' && req.method === 'GET') {
    try {
      const limit = parsedUrl.searchParams.get('limit') || 50;
      const history = await alertService.getIncidentHistory(limit);
      sendJson(res, 200, { success: true, count: history.length, history });
    } catch (err) {
      sendJson(res, 500, { success: false, error: err.message });
    }
    return true;
  }

  // 3. POST /api/alerts/acknowledge - Clinician acknowledges emergency incident
  if (pathname === '/api/alerts/acknowledge' && req.method === 'POST') {
    try {
      const data = JSON.parse(body || '{}');
      if (!data.incident_id) {
        sendJson(res, 400, { success: false, error: 'incident_id is required' });
        return true;
      }
      const result = await alertService.acknowledgeIncident(
        data.incident_id,
        data.attending_clinician || alertService.UNVERIFIED_CLINICIAN,
        data.notes || ''
      );
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, { success: false, error: err.message });
    }
    return true;
  }

  // 4. POST /api/alerts/trigger-simulation - Manual test trigger bench.
  // The values below are test inputs, and every incident created here is stored
  // with is_simulated = 1 so it can never be mistaken for a real alarm.
  if (pathname === '/api/alerts/trigger-simulation' && req.method === 'POST') {
    if (!config.ENABLE_SIMULATION) {
      sendJson(res, 403, { success: false, error: 'Simulation is disabled on this server (ENABLE_SIMULATION=false).' });
      return true;
    }
    try {
      const data = JSON.parse(body || '{}');
      const category = data.category || 'FALL_ACCIDENT';

      let incidentData = {
        incident_category: category,
        patient_id: data.patient_id || 'P-001',
        patient_name: data.patient_name || 'Tan Ah Kow',
        ward_id: data.ward_id || 'WARD-001',
        bed_id: data.bed_id || 'BED-001-01',
        wristband_mac: data.wristband_mac || 'A4:CF:12:01:F8:2C',
        device_id: data.device_id || 'WRISTBAND-001',
        pos_x: data.pos_x !== undefined ? parseFloat(data.pos_x) : 2.45,
        pos_y: data.pos_y !== undefined ? parseFloat(data.pos_y) : 1.82,
        kinematic_impact_force: data.impact_g !== undefined ? parseFloat(data.impact_g) : 3.42,
        post_impact_stillness: 0.08,
        heart_rate: data.heart_rate !== undefined ? parseInt(data.heart_rate, 10) : 88,
        spo2: data.spo2 !== undefined ? parseFloat(data.spo2) : 97.0,
        alert_message: data.message || '',
        is_simulated: true
      };

      if (category === 'CRITICAL_VITALS' && !data.heart_rate && !data.spo2) {
        incidentData.heart_rate = 148;
        incidentData.spo2 = 84.0;
        incidentData.alert_message = 'CRITICAL PHYSIOLOGICAL ALERT: Severe Tachycardia (148 BPM) and Acute Hypoxia (SpO2 84%) on Tan Ah Kow.';
      } else if (category === 'GEOFENCE_BREACH') {
        incidentData.pos_x = 5.20;
        incidentData.pos_y = 4.85;
        incidentData.alert_message = 'GEOFENCE BOUNDARY BREACH: Patient Tan Ah Kow detected crossing room perimeter into hallway.';
      }

      const created = await alertService.recordIncident(incidentData);
      sendJson(res, 201, { success: true, message: 'Simulation alert triggered successfully', incident: created });
    } catch (err) {
      sendJson(res, 500, { success: false, error: err.message });
    }
    return true;
  }

  return false;
}

module.exports = { handleAlertRoutes };

