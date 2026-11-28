// =============================================================================
// SHIRO Hospital Edge Server - Clinical Safety & Emergency Alert Service
// Module: On-Chip Kinematic Fall Alerts, Abnormal Vitals & Incident Audits
// Documentation Reference: Chapter 4 (Section 4.2.2, Section 4.7, Table 4.13)
//
// Rule for this module: a value that was not measured is stored as NULL.
// The audit log must never contain a number the system made up.
// =============================================================================
const logger = require('../utils/logger');
const { getPool } = require('../database/db');
const { broadcastToClients } = require('./websocket_service');
const ipsService = require('./ips_service');
const timeSeriesService = require('./time_series_service');
const { nextIncidentId } = require('./alerts/incident_id');
const { createFallTracker } = require('./alerts/fall_tracker');
const { createVitalsEvaluator } = require('./alerts/vitals_evaluator');
const thresholds = require('../config/clinical_thresholds');
const { HttpError } = require('../utils/http');
const { buildHistoryFilter, normalizeSummary } = require('./alerts/incident_history');

// One open fall session per wristband: see alerts/fall_tracker.js
const fallTracker = createFallTracker();
// Vitals verification state per wristband: see alerts/vitals_evaluator.js
const vitalsEvaluator = createVitalsEvaluator();

// The fall tracker lives in memory. For one session lifetime after a start it
// cannot know whether a wristband that is flagging a fall was already handled
// before the restart, so the audit log is asked (see evaluateTelemetry).
const serviceStartedAt = Date.now();

async function findOpenFallIncident(wristbandMac) {
  if (!wristbandMac) return null;
  try {
    const [rows] = await getPool().query(`
      SELECT incident_id FROM emergency_incident_logs
      WHERE wristband_mac = ? AND incident_category = 'FALL_ACCIDENT' AND is_simulated = 0
        AND trigger_timestamp >= (NOW() - INTERVAL ? SECOND)
      ORDER BY trigger_timestamp DESC LIMIT 1
    `, [wristbandMac, Math.ceil(thresholds.fall.sessionTtlMs / 1000)]);
    return rows.length > 0 ? rows[0].incident_id : null;
  } catch (err) {
    // When in doubt the alarm is raised: a duplicate is better than a missed fall
    logger.warn('[ALERT SERVICE] Could not check for an earlier incident of this fall:', err.message);
    return null;
  }
}

// Recorded as the acknowledging person until clinician login exists.
const UNVERIFIED_CLINICIAN = 'Unverified dashboard user';

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function describeLocation(wardId, bedId, posX, posY) {
  const parts = [];
  if (wardId) parts.push(bedId ? `${wardId}, ${bedId}` : wardId);
  if (posX !== null && posY !== null) parts.push(`position (${posX} m, ${posY} m)`);
  return parts.length > 0 ? parts.join(', ') : 'location unknown';
}

// The two kinds of geofence alert (Phase 10): left through the door, or standing at it
const GEOFENCE_KINDS = Object.freeze(['LEFT_WARD', 'AT_DOOR']);

function buildAlertMessage(category, { impactG, stillness, freefallMinG, bpm, spo2, wardId, bedId, posX, posY, geofenceKind = null, seconds = null }) {
  const where = describeLocation(wardId, bedId, posX, posY);
  if (category === 'FALL_ACCIDENT') {
    const freefall = freefallMinG !== null ? `free-fall minimum ${freefallMinG} g` : 'free-fall minimum not reported';
    const impact = impactG !== null ? `impact ${impactG} g` : 'impact not reported';
    const still = stillness !== null ? `post-impact motion ${stillness} g` : 'post-impact motion not reported';
    return `CRITICAL FALL DETECTED: ${freefall}, ${impact}, ${still}; ${where}.`;
  }
  if (category === 'CRITICAL_VITALS') {
    const hr = bpm !== null ? `${bpm} BPM` : 'not available';
    const ox = spo2 !== null ? `${spo2}%` : 'not available';
    return `PHYSIOLOGICAL ANOMALY: Heart rate ${hr}, SpO2 ${ox}; ${where}. Immediate clinical check required.`;
  }
  if (category === 'GEOFENCE_BREACH') {
    if (geofenceKind === 'LEFT_WARD') {
      const gone = seconds !== null ? `, not seen in the room for ${seconds} s` : '';
      return `LEFT THE WARD: last seen at the door${gone}; ${where}.`;
    }
    if (geofenceKind === 'AT_DOOR') {
      const stay = seconds !== null ? ` for ${seconds} s` : '';
      return `AT THE DOOR: standing at the door${stay}, may be about to leave; ${where}.`;
    }
    return `GEOFENCE: patient at the door or outside the ward; ${where}.`;
  }
  return `Clinical safety event; ${where}.`;
}

/**
 * Record a new Emergency Incident in MySQL and broadcast over WebSockets.
 * Unknown values are stored and broadcast as null.
 */
async function recordIncident(incidentData) {
  const pool = getPool();
  const idWasSupplied = Boolean(incidentData.incident_id);
  let incidentId = incidentData.incident_id || await nextIncidentId();

  let patientId = incidentData.patient_id || null;
  let patientName = incidentData.patient_name || null;
  let wardId = incidentData.ward_id || null;
  let bedId = incidentData.bed_id || null;
  const wristbandMac = incidentData.wristband_mac || null;
  const deviceId = incidentData.device_id || null;
  const isSimulated = incidentData.is_simulated === true;

  // 1. Resolve Patient details from active wristband binding if not explicitly passed
  if (!patientId && (wristbandMac || deviceId)) {
    try {
      const [rows] = await pool.query(`
        SELECT pb.patient_id, p.full_name, p.assigned_ward_id, p.assigned_bed_id
        FROM patient_bindings pb
        JOIN patients p ON pb.patient_id = p.patient_id
        JOIN devices d ON pb.device_id = d.device_id
        WHERE pb.status = 'ACTIVE'
          AND (d.mac_address = ? OR d.device_id = ?)
        LIMIT 1
      `, [wristbandMac, deviceId]);

      if (rows.length > 0) {
        patientId = rows[0].patient_id;
        patientName = rows[0].full_name;
        wardId = wardId || rows[0].assigned_ward_id;
        bedId = bedId || rows[0].assigned_bed_id;
      }
    } catch (err) {
      logger.warn('[ALERT SERVICE] Could not resolve patient from binding:', err.message);
    }
  }

  // A label, not a guess: it says exactly what is and is not known
  if (!patientName) {
    patientName = patientId ? `Patient (${patientId})` : `Unassigned Wristband (${deviceId || wristbandMac || 'unknown'})`;
  }

  // The ward of an unbound wristband is the ward the device is assigned to, when there is one
  if (!wardId && (deviceId || wristbandMac)) {
    try {
      const [devRows] = await pool.query('SELECT assigned_ward_id FROM devices WHERE device_id = ? OR mac_address = ? LIMIT 1', [deviceId, wristbandMac]);
      if (devRows.length > 0 && devRows[0].assigned_ward_id) {
        wardId = devRows[0].assigned_ward_id;
      }
    } catch (err) {
      logger.warn('[ALERT SERVICE] Could not resolve ward from device:', err.message);
    }
  }

  // 2. Resolve the latest (X, Y) position from the IPS service if not provided
  let posX = numberOrNull(incidentData.pos_x);
  let posY = numberOrNull(incidentData.pos_y);
  const liveTag = (deviceId || patientId) ? ipsService.getTagPosition(deviceId || patientId) : null;
  if ((posX === null || posY === null) && (deviceId || patientId)) {
    if (liveTag && Number.isFinite(liveTag.x) && Number.isFinite(liveTag.y)) {
      posX = round2(liveTag.x);
      posY = round2(liveTag.y);
    } else {
      posX = null;
      posY = null;
    }
  }
  // The ward the wristband is in, when neither the patient's bed nor the device
  // names one (until 22 Nov 2026 such incidents were stored with a position but
  // no ward)
  if (!wardId && liveTag && liveTag.ward_id) wardId = liveTag.ward_id;

  const category = incidentData.incident_category || 'FALL_ACCIDENT';
  // Only a geofence alert has a kind; anything else stays NULL
  const geofenceKind = category === 'GEOFENCE_BREACH' && GEOFENCE_KINDS.includes(incidentData.geofence_kind)
    ? incidentData.geofence_kind
    : null;
  const geofenceSeconds = numberOrNull(incidentData.geofence_seconds);
  const impactG = numberOrNull(incidentData.kinematic_impact_force);
  const stillness = numberOrNull(incidentData.post_impact_stillness);
  const freefallMinG = numberOrNull(incidentData.freefall_min_g);
  const bpm = numberOrNull(incidentData.heart_rate);
  const spo2 = numberOrNull(incidentData.spo2);

  let alertMessage = incidentData.alert_message ||
    buildAlertMessage(category, { impactG, stillness, freefallMinG, bpm, spo2, wardId, bedId, posX, posY, geofenceKind, seconds: geofenceSeconds });
  if (isSimulated && !alertMessage.startsWith('[SIMULATION]')) {
    alertMessage = `[SIMULATION] ${alertMessage}`;
  }

  // 3. Persist to MySQL emergency_incident_logs.
  // A duplicate ID (for example after another process wrote the same number) gets a fresh one.
  let persisted = false;
  const MAX_ID_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_ID_ATTEMPTS && !persisted; attempt++) {
    try {
      await pool.query(`
        INSERT INTO emergency_incident_logs
        (incident_id, patient_id, patient_name, wristband_mac, ward_id, bed_id, incident_category, geofence_kind,
         pos_x, pos_y, kinematic_impact_force, post_impact_stillness, freefall_min_g, heart_rate, spo2,
         alert_message, is_simulated, resolution_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')
      `, [
        incidentId, patientId, patientName, wristbandMac, wardId, bedId, category, geofenceKind,
        posX, posY, impactG, stillness, freefallMinG, bpm, spo2, alertMessage, isSimulated ? 1 : 0
      ]);
      persisted = true;
      logger.info(`[ALERT PERSISTED] Incident ${incidentId} logged in MySQL for ${patientName} (${category}${isSimulated ? ', simulated' : ''}).`);
    } catch (dbErr) {
      if (dbErr.code === 'ER_DUP_ENTRY' && !idWasSupplied && attempt < MAX_ID_ATTEMPTS) {
        incidentId = await nextIncidentId();
        continue;
      }
      logger.error('[ALERT DATABASE ERROR] Failed to save incident log:', dbErr.message);
      break;
    }
  }

  const incidentPayload = {
    incident_id: incidentId,
    patient_id: patientId,
    patient_name: patientName,
    ward_id: wardId,
    bed_id: bedId,
    wristband_mac: wristbandMac,
    device_id: deviceId,
    incident_category: category,
    geofence_kind: geofenceKind,
    trigger_timestamp: new Date().toISOString(),
    pos_x: posX,
    pos_y: posY,
    kinematic_impact_force: impactG,
    post_impact_stillness: stillness,
    freefall_min_g: freefallMinG,
    heart_rate: bpm,
    spo2: spo2,
    alert_message: alertMessage,
    is_simulated: isSimulated,
    resolution_status: 'PENDING',
    persisted // false when the audit record could not be written; the alert is still raised
  };

  // 4. Push Real-Time Broadcast to Web Dashboard & Quest 3 MR
  broadcastToClients({
    type: 'EMERGENCY_ALERT',
    incident: incidentPayload,
    timestamp: new Date().toLocaleTimeString()
  });

  return incidentPayload;
}

/**
 * Evaluates one normalised telemetry reading (see services/telemetry/normalize.js)
 * and raises an incident when a fall is flagged or the vitals rules are met.
 * Returns the incident that was raised, or null.
 */
// KEY LOGIC: decides whether one telemetry message raises an incident.
//   Fall: the wristband already confirmed it on-chip. Several anchors hear the same fall
//         packet, and the wristband repeats it for 45 s, so the fall tracker turns all of
//         them into ONE incident (same wristband + same fall counter).
//   Vitals: only readings with skin contact; the two-tier rules of vitals_evaluator.js
//         (extreme for 5 s, or abnormal confirmed over time) avoid alarms from one bad beat.
// recordIncident then stores it in MySQL (INC-YYYYMMDD-NNNN) and broadcasts it.
async function evaluateTelemetry(telemetry, detectedTag, tagMac) {
  if (!telemetry) return null;
  const key = String(detectedTag || tagMac || 'UNKNOWN').toUpperCase();

  // Check 1: fall confirmed by the wristband (Algorithm 3: free-fall, impact, stillness).
  // Never delayed by the vitals quiet period.
  if (telemetry.fall) {
    // Registered synchronously, before any database work: the packets of the
    // other anchors that arrive in the same instant find the session open.
    const { isNew, session, firstSighting } = fallTracker.observe(key, telemetry.fallSeq);
    if (!isNew) return null;

    // Shortly after a server start, a fall that is still being flagged may already
    // have its incident from before the restart: continue that one.
    if (firstSighting && Date.now() - serviceStartedAt < thresholds.fall.sessionTtlMs) {
      const earlierIncidentId = await findOpenFallIncident(tagMac);
      if (earlierIncidentId) {
        session.incidentId = earlierIncidentId;
        logger.info(`[FALL] ${detectedTag} is still flagging the fall of incident ${earlierIncidentId} (raised before this server start). No new incident.`);
        return null;
      }
    }

    const impact = telemetry.impactG !== null ? `${telemetry.impactG} g` : 'not reported';
    logger.warn(`[EMERGENCY DETECTED] On-chip fall alarm from ${detectedTag} (${tagMac}), fall #${telemetry.fallSeq ?? 'n/a'}, impact ${impact}`);

    // Fall vector to InfluxDB (Table 4.10): only values the wristband measured
    timeSeriesService.logFallVector({
      wristbandMac: tagMac,
      minG: telemetry.freefallG,
      impactG: telemetry.impactG,
      stillG: telemetry.stillG,
      alertLevel: 'CRITICAL'
    });

    const incident = await recordIncident({
      device_id: detectedTag,
      wristband_mac: tagMac,
      incident_category: 'FALL_ACCIDENT',
      kinematic_impact_force: telemetry.impactG,
      post_impact_stillness: telemetry.stillG,
      freefall_min_g: telemetry.freefallG,
      heart_rate: telemetry.bpm,
      spo2: telemetry.spo2
    });
    session.incidentId = incident.incident_id;
    fallTracker.sweep();
    return incident;
  }

  // Check 2: abnormal vitals. Only readings taken with skin contact are judged.
  if (!telemetry.touch) return null;
  const decision = vitalsEvaluator.evaluate(key, { bpm: telemetry.bpm, spo2: telemetry.spo2 });
  if (!decision) return null;

  const label = decision.severity === 'EXTREME' ? 'CRITICAL PHYSIOLOGICAL EMERGENCY' : 'SUSTAINED PHYSIOLOGICAL ANOMALY';
  logger.warn(`[VITALS ALERT] ${label}: ${decision.reason} on ${detectedTag}`);

  return recordIncident({
    device_id: detectedTag,
    wristband_mac: tagMac,
    incident_category: 'CRITICAL_VITALS',
    heart_rate: decision.bpm,
    spo2: decision.spo2,
    alert_message: decision.severity === 'EXTREME'
      ? `${label}: ${decision.reason} on ${detectedTag}. Immediate bedside intervention required.`
      : `${label}: ${decision.reason} on ${detectedTag}.`
  });
}

/**
 * A clinician (or a paired headset) acknowledges a pending incident.
 * Only a PENDING incident can be acknowledged: the first acknowledgement is
 * the record (who responded, how fast) and is never overwritten by a second
 * one from another screen. 404 when the incident does not exist, 409 when it
 * was already handled.
 */
async function acknowledgeIncident(incidentId, clinicianId, notes) {
  const pool = getPool();
  const clinician = clinicianId || UNVERIFIED_CLINICIAN;
  const incidentNotes = notes || null;

  const [result] = await pool.query(`
    UPDATE emergency_incident_logs
    SET resolution_status = 'ACKNOWLEDGED',
        acknowledgment_time = CURRENT_TIMESTAMP,
        response_latency_seconds = TIMESTAMPDIFF(SECOND, trigger_timestamp, CURRENT_TIMESTAMP),
        attending_clinician = ?,
        notes = ?
    WHERE incident_id = ? AND resolution_status = 'PENDING'
  `, [clinician, incidentNotes, incidentId]);

  if (result.affectedRows === 0) {
    const [rows] = await pool.query(
      'SELECT resolution_status, attending_clinician FROM emergency_incident_logs WHERE incident_id = ?',
      [incidentId]
    );
    if (rows.length === 0) throw new HttpError(404, `Incident "${incidentId}" not found.`);
    const by = rows[0].attending_clinician || 'a clinician who was not recorded';
    throw new HttpError(409, `Incident ${incidentId} was already ${String(rows[0].resolution_status).toLowerCase()} by ${by}.`);
  }

  logger.info(`[ALERT ACKNOWLEDGED] Incident ${incidentId} acknowledged by ${clinician}.`);

  // The wristband keeps repeating its fall flag for a while: the open session stays
  // in place so those packets do not raise the same fall again.
  fallTracker.markAcknowledged(incidentId);

  broadcastToClients({
    type: 'EMERGENCY_ACKNOWLEDGED',
    incident_id: incidentId,
    attending_clinician: clinician,
    notes: incidentNotes,
    timestamp: new Date().toISOString()
  });

  return { success: true, incident_id: incidentId, status: 'ACKNOWLEDGED', attending_clinician: clinician };
}

/**
 * Incidents still waiting for a response, newest first.
 * A database error is passed on: an empty list would tell the dashboard
 * "no emergencies" while the database cannot be asked.
 */
async function getActiveAlerts() {
  const [rows] = await getPool().query(`
    SELECT * FROM emergency_incident_logs
    WHERE resolution_status = 'PENDING'
    ORDER BY trigger_timestamp DESC
    LIMIT 50
  `);
  return rows;
}

/**
 * Incident history for audits, shift reports and one patient's record.
 * @param {object} options
 * @param {number} [options.limit=50]
 * @param {string|null} [options.patientId]
 * @param {string} [options.range='all']  '24h' | '7d' | '30d' | 'all'
 * @param {string|null} [options.category]
 * @param {boolean} [options.includeSimulated=true]
 * @returns {Promise<{history: object[], summary: object}>} the summary counts
 *   every incident matching the filter, not only the rows returned
 */
async function getIncidentHistory({ limit = 50, patientId = null, range = 'all', category = null, includeSimulated = true } = {}) {
  const pool = getPool();
  const { where, params } = buildHistoryFilter({ patientId, range, category, includeSimulated });

  const [rows] = await pool.query(`
    SELECT incident_id, patient_id, patient_name, wristband_mac, ward_id, bed_id,
           incident_category, geofence_kind, trigger_timestamp, pos_x, pos_y,
           kinematic_impact_force, post_impact_stillness, freefall_min_g,
           heart_rate, spo2, alert_message, is_simulated,
           acknowledgment_time, response_latency_seconds, attending_clinician,
           resolution_status, notes
    FROM emergency_incident_logs
    ${where}
    ORDER BY trigger_timestamp DESC, incident_id DESC
    LIMIT ?
  `, [...params, parseInt(limit, 10)]);

  const [summaryRows] = await pool.query(`
    SELECT COUNT(*) AS total,
           SUM(incident_category = 'FALL_ACCIDENT') AS falls,
           SUM(incident_category = 'CRITICAL_VITALS') AS critical_vitals,
           SUM(incident_category = 'GEOFENCE_BREACH') AS geofence,
           SUM(resolution_status = 'PENDING') AS pending,
           SUM(resolution_status <> 'PENDING') AS acknowledged,
           SUM(is_simulated = 1) AS simulated,
           AVG(CASE WHEN resolution_status <> 'PENDING' THEN response_latency_seconds END) AS avg_response_seconds,
           MAX(CASE WHEN resolution_status <> 'PENDING' THEN response_latency_seconds END) AS max_response_seconds
    FROM emergency_incident_logs
    ${where}
  `, params);

  return { history: rows, summary: normalizeSummary(summaryRows[0]) };
}

module.exports = {
  UNVERIFIED_CLINICIAN,
  GEOFENCE_KINDS,
  buildAlertMessage,
  recordIncident,
  evaluateTelemetry,
  acknowledgeIncident,
  getActiveAlerts,
  getIncidentHistory
};
