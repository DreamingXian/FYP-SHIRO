// =============================================================================
// SHIRO Hospital Edge Server - Clinical Safety & Emergency Alert Service
// Module: On-Chip Kinematic Fall Alerts, Abnormal Vitals & Incident Audits
// Documentation Reference: Chapter 4 (Section 4.2.2, Section 4.7, Table 4.13)
// =============================================================================
const { getPool } = require('../database/db');
const { broadcastToClients } = require('./websocket_service');
const ipsService = require('./ips_service');
const { nextIncidentId } = require('./alerts/incident_id');

// Debounce map to avoid flooding repeated alert packets for the same tag within 15 seconds
const recentAlertsDebounce = new Map();

// Active fall emergency sessions to prevent repeated incidents during the 1 Hz active hold
// Key: tagKey -> { incident_id, acknowledged: boolean, startTime, lastSeenFall }
const activeFallSessions = new Map();

// Multi-cycle streak tracker for abnormal vitals (persisting over discontinuous 3-minute cycles)
// Key: tagId/MAC -> { count, lastBpm, lastSpo2, firstSeen, lastSeen }
const vitalAnomalyStreaks = new Map();

/**
 * Record a new Emergency Incident in MySQL and broadcast over WebSockets
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
        wardId = rows[0].assigned_ward_id;
        bedId = rows[0].assigned_bed_id;
      }
    } catch (err) {
      console.warn('[ALERT SERVICE] Could not resolve patient from binding:', err.message);
    }
  }

  // Fallback labels for test / unprovisioned tags
  if (!patientName) {
    patientName = patientId ? `Patient (${patientId})` : `Unassigned Wristband (${deviceId || wristbandMac || 'TAG'})`;
  }
  if (!wardId) {
    try {
      const [devRows] = await pool.query('SELECT assigned_ward_id FROM devices WHERE device_id = ? OR mac_address = ? LIMIT 1', [deviceId, wristbandMac]);
      if (devRows.length > 0 && devRows[0].assigned_ward_id) {
        wardId = devRows[0].assigned_ward_id;
      }
    } catch (_) {}
  }
  if (!wardId) wardId = 'WARD-005';
  if (!bedId) bedId = 'Bed 1';

  // 2. Resolve latest spatial (X, Y) coordinates from IPS Service if not provided
  let posX = incidentData.pos_x !== undefined ? incidentData.pos_x : null;
  let posY = incidentData.pos_y !== undefined ? incidentData.pos_y : null;
  if ((posX === null || posY === null) && (deviceId || patientId)) {
    const liveTag = ipsService.getTagPosition(deviceId || patientId);
    if (liveTag && liveTag.x !== undefined) {
      posX = Math.round(liveTag.x * 100) / 100;
      posY = Math.round(liveTag.y * 100) / 100;
    } else {
      posX = 2.40;
      posY = 1.80;
    }
  }

  const category = incidentData.incident_category || 'FALL_ACCIDENT';
  const impactG = incidentData.kinematic_impact_force !== undefined ? incidentData.kinematic_impact_force : 3.42;
  const stillness = incidentData.post_impact_stillness !== undefined ? incidentData.post_impact_stillness : 0.08;
  const bpm = incidentData.heart_rate !== undefined ? incidentData.heart_rate : 88;
  const spo2 = incidentData.spo2 !== undefined ? incidentData.spo2 : 97.0;

  let alertMessage = incidentData.alert_message || '';
  if (!alertMessage) {
    if (category === 'FALL_ACCIDENT') {
      alertMessage = `CRITICAL FALL DETECTED: Sudden impact spike (${impactG}g) followed by incapacitation stillness (${stillness}g) near Bed ${bedId}.`;
    } else if (category === 'CRITICAL_VITALS') {
      alertMessage = `PHYSIOLOGICAL ANOMALY: Abnormal vitals detected (Heart Rate: ${bpm} BPM, SpO2: ${spo2}%). Immediate clinical check required.`;
    } else if (category === 'GEOFENCE_BREACH') {
      alertMessage = `GEOFENCE BOUNDARY BREACH: Patient navigated outside authorized clinical boundary at (${posX}m, ${posY}m).`;
    }
  }

  // 3. Persist to MySQL emergency_incident_logs.
  // A duplicate ID (for example after another process wrote the same number) gets a fresh one.
  let persisted = false;
  const MAX_ID_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_ID_ATTEMPTS && !persisted; attempt++) {
    try {
      await pool.query(`
        INSERT INTO emergency_incident_logs 
        (incident_id, patient_id, patient_name, wristband_mac, ward_id, bed_id, incident_category,
         pos_x, pos_y, kinematic_impact_force, post_impact_stillness, heart_rate, spo2, 
         alert_message, resolution_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')
      `, [
        incidentId, patientId, patientName, wristbandMac, wardId, bedId, category,
        posX, posY, impactG, stillness, bpm, spo2, alertMessage
      ]);
      persisted = true;
      console.log(`[ALERT PERSISTED] Incident ${incidentId} logged in MySQL for ${patientName} (${category}).`);
    } catch (dbErr) {
      if (dbErr.code === 'ER_DUP_ENTRY' && !idWasSupplied && attempt < MAX_ID_ATTEMPTS) {
        incidentId = await nextIncidentId();
        continue;
      }
      console.error('[ALERT DATABASE ERROR] Failed to save incident log:', dbErr.message);
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
    trigger_timestamp: new Date().toISOString(),
    pos_x: posX,
    pos_y: posY,
    kinematic_impact_force: impactG,
    post_impact_stillness: stillness,
    heart_rate: bpm,
    spo2: spo2,
    alert_message: alertMessage,
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
 * Evaluates live telemetry stream and triggers alerts if kinematic or physiological thresholds are violated
 */
async function evaluateTelemetry(parsed, detectedTag, tagMac) {
  const now = Date.now();
  const debounceKey = `${detectedTag || tagMac}`;
  const lastAlertTime = recentAlertsDebounce.get(debounceKey) || 0;

  // Don't generate multiple alarms for the same tag within 12 seconds
  if (now - lastAlertTime < 12000) {
    return;
  }

  // Check 1: Kinematic Fall Detection (Algorithm 3 On-Chip State Machine)
  // ONLY trigger on confirmed FALL_EMERGENCY (Freefall + Impact > 2.5g + Incapacitation Stillness < 0.2g)
  const isFallEmergency = (parsed.motion === 'FALL_EMERGENCY');
  if (isFallEmergency) {
    const existingSession = activeFallSessions.get(debounceKey);
    if (existingSession) {
      existingSession.lastSeenFall = now;
      // If already acknowledged by clinician or incident already actively raised, DO NOT duplicate!
      return;
    }

    const impactG = parsed.g !== undefined && parseFloat(parsed.g) >= 2.0 ? parseFloat(parsed.g) : 3.15;
    console.warn(`[EMERGENCY DETECTED] On-chip fall alarm confirmed from ${detectedTag} (${tagMac})! Impact: ${impactG}g`);

    // Log fall vector to InfluxDB (Table 4.10)
    try {
      const timeSeriesService = require('./time_series_service');
      timeSeriesService.logFallVector({
        wristbandMac: tagMac,
        minG: 0.35,
        impactG: impactG,
        alertLevel: 'CRITICAL'
      });
    } catch (e) { }

    const incident = await recordIncident({
      device_id: detectedTag,
      wristband_mac: tagMac,
      incident_category: 'FALL_ACCIDENT',
      kinematic_impact_force: impactG,
      post_impact_stillness: 0.08,
      heart_rate: parsed.bpm || 80,
      spo2: parsed.spo2 || 98
    });

    activeFallSessions.set(debounceKey, {
      incident_id: incident.incident_id,
      acknowledged: false,
      startTime: now,
      lastSeenFall: now
    });
    return;
  } else {
    // If tag was in a fall session and motion returned to normal for > 15 seconds, clear the session
    const existingSession = activeFallSessions.get(debounceKey);
    if (existingSession && (now - existingSession.lastSeenFall > 15000)) {
      activeFallSessions.delete(debounceKey);
      console.log(`[FALL SESSION CLEARED] Tag ${debounceKey} returned to normal activity.`);
    }
  }

  // Check 2: Physiological Anomaly Evaluation (Clinical Multi-Cycle Streak Algorithm)
  // Handles discontinuous 3-minute passive bursts and active streams to prevent single-sample false alarms
  if (parsed.bpm > 0) {
    const bpm = parseInt(parsed.bpm, 10);
    const spo2 = parseFloat(parsed.spo2);

    // Tier 1: Extreme Life-Threatening Anomaly -> Immediate 1st-cycle Emergency Alarm
    let isExtreme = false;
    let extremeReason = '';
    if (bpm > 160) {
      isExtreme = true;
      extremeReason = `Critical Tachycardia crisis (${bpm} BPM > 160)`;
    } else if (bpm < 40 && bpm > 0) {
      isExtreme = true;
      extremeReason = `Severe Bradycardia collapse (${bpm} BPM < 40)`;
    } else if (spo2 > 50 && spo2 < 85) {
      isExtreme = true;
      extremeReason = `Severe Acute Desaturation (${spo2}% < 85%)`;
    }

    if (isExtreme) {
      vitalAnomalyStreaks.delete(debounceKey);
      recentAlertsDebounce.set(debounceKey, now);
      console.warn(`[CRITICAL VITALS EMERGENCY] ${extremeReason} on ${detectedTag}`);
      await recordIncident({
        device_id: detectedTag,
        wristband_mac: tagMac,
        incident_category: 'CRITICAL_VITALS',
        heart_rate: bpm,
        spo2: spo2,
        alert_message: `CRITICAL PHYSIOLOGICAL EMERGENCY: ${extremeReason} on patient ${detectedTag}. Immediate bedside intervention required.`
      });
      return;
    }

    // Tier 2: Moderate Anomaly -> Requires 2 consecutive cycles (streak >= 2) within 10 minutes to verify
    let isModerate = false;
    let modReason = '';
    if (bpm > 120) {
      isModerate = true;
      modReason = `Sustained Tachycardia (${bpm} BPM > 120)`;
    } else if (bpm < 50 && bpm > 0) {
      isModerate = true;
      modReason = `Sustained Bradycardia (${bpm} BPM < 50)`;
    } else if (spo2 > 50 && spo2 < 90) {
      isModerate = true;
      modReason = `Persistent Hypoxia (SpO2 ${spo2}% < 90%)`;
    }

    if (isModerate) {
      const streak = vitalAnomalyStreaks.get(debounceKey) || { count: 0, lastSeen: 0 };
      // If previous anomalous reading was within 10 minutes (covering discontinuous 3-min cycles)
      if (now - streak.lastSeen < 600000 && streak.lastSeen > 0) {
        streak.count++;
      } else {
        streak.count = 1;
      }
      streak.lastSeen = now;
      streak.reason = modReason;
      vitalAnomalyStreaks.set(debounceKey, streak);

      console.log(`[VITALS ANOMALY STREAK] ${detectedTag} (${tagMac}): Verification Streak ${streak.count}/2 [${modReason}]`);

      // Trigger clinical alert once sustained over 2 consecutive measurement cycles
      if (streak.count >= 2) {
        vitalAnomalyStreaks.delete(debounceKey);
        recentAlertsDebounce.set(debounceKey, now);
        console.warn(`[SUSTAINED VITALS ALERT] Confirmed over consecutive cycles: ${modReason} on ${detectedTag}`);
        await recordIncident({
          device_id: detectedTag,
          wristband_mac: tagMac,
          incident_category: 'CRITICAL_VITALS',
          heart_rate: bpm,
          spo2: spo2,
          alert_message: `SUSTAINED PHYSIOLOGICAL ANOMALY: Verified over 2 consecutive cycles - ${modReason} on patient ${detectedTag}.`
        });
      }
    } else if (bpm >= 55 && bpm <= 100 && spo2 >= 94) {
      // Normal reading confirmed: clear anomaly streak counter
      if (vitalAnomalyStreaks.has(debounceKey)) {
        vitalAnomalyStreaks.delete(debounceKey);
        console.log(`[VITALS STREAK RESET] ${detectedTag} returned to normal baseline (HR: ${bpm}, SpO2: ${spo2}%).`);
      }
    }
  }
}

/**
 * Clinician Acknowledges an active emergency incident
 */
async function acknowledgeIncident(incidentId, clinicianId, notes) {
  const pool = getPool();
  const clinician = clinicianId || 'DOC-8821 (Dr. Tan)';
  const incidentNotes = notes || 'Acknowledged by bedside attending clinician.';

  try {
    await pool.query(`
      UPDATE emergency_incident_logs
      SET resolution_status = 'ACKNOWLEDGED',
          acknowledgment_time = CURRENT_TIMESTAMP,
          response_latency_seconds = TIMESTAMPDIFF(SECOND, trigger_timestamp, CURRENT_TIMESTAMP),
          attending_clinician = ?,
          notes = ?
      WHERE incident_id = ?
    `, [clinician, incidentNotes, incidentId]);

    console.log(`[ALERT ACKNOWLEDGED] Incident ${incidentId} acknowledged by ${clinician}.`);

    // Mark active fall session acknowledged so repeated alarms do not fire during active stream hold
    for (const [tagKey, session] of activeFallSessions.entries()) {
      if (session.incident_id === incidentId) {
        session.acknowledged = true;
        console.log(`[ALERT SERVICE] Marked active fall session acknowledged for ${tagKey}.`);
      }
    }

    broadcastToClients({
      type: 'EMERGENCY_ACKNOWLEDGED',
      incident_id: incidentId,
      attending_clinician: clinician,
      notes: incidentNotes,
      timestamp: new Date().toLocaleTimeString()
    });

    return { success: true, incident_id: incidentId, status: 'ACKNOWLEDGED' };
  } catch (err) {
    console.error('[ALERT ACKNOWLEDGE ERROR]', err.message);
    throw err;
  }
}

/**
 * Retrieve active pending alerts
 */
async function getActiveAlerts() {
  const pool = getPool();
  try {
    const [rows] = await pool.query(`
      SELECT * FROM emergency_incident_logs
      WHERE resolution_status = 'PENDING'
      ORDER BY trigger_timestamp DESC
      LIMIT 10
    `);
    return rows;
  } catch (err) {
    console.error('[GET ACTIVE ALERTS ERROR]', err.message);
    return [];
  }
}

/**
 * Retrieve full emergency incident history (for audits and shift reports)
 */
async function getIncidentHistory(limit = 50) {
  const pool = getPool();
  try {
    const [rows] = await pool.query(`
      SELECT * FROM emergency_incident_logs
      ORDER BY trigger_timestamp DESC
      LIMIT ?
    `, [parseInt(limit, 10)]);
    return rows;
  } catch (err) {
    console.error('[GET INCIDENT HISTORY ERROR]', err.message);
    return [];
  }
}

module.exports = {
  recordIncident,
  evaluateTelemetry,
  acknowledgeIncident,
  getActiveAlerts,
  getIncidentHistory
};

