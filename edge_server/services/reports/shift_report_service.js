// =============================================================================
// SHIRO Edge Server - Nursing shift summary report (thesis section 4.7.1)
// GET /api/reports/shift-summary. Gathers, for one ward and one shift:
//   1. header: ward, shift, its start and end, when and by whom generated;
//   2. ward census: patients in the ward during the shift, admissions and
//      discharges, beds, wristbands bound and unbound, device status now;
//   3. vitals per patient from InfluxDB: heart rate and indicative SpO2
//      (min, mean, max, readings), with an ATTN flag and its reasons;
//   4. incidents of the shift from the MySQL incident log, with responses;
//   5. (handover sign-off lines: printed by the page).
// Nothing is invented: a value that was not measured stays null, and InfluxDB
// being unavailable is reported as such, never as "no readings".
// Limits, stated in the report: a patient's ward is the current ward (or the ward
// they were discharged from); bed moves during the shift are not kept; device
// status is the status at the time the report is made.
// =============================================================================

const { getPool } = require('../../database/db');
const shifts = require('../../config/shifts');
const thresholds = require('../../config/clinical_thresholds');
const timeSeries = require('../time_series_service');
const { shiftWindow, currentShift, roundStats, attentionReasons, checkShifts } = require('./shift_rules');

checkShifts(shifts);

function hhmm(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '?';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function iso(value) {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** The shifts, and the one running now (for the report page's picker). */
function shiftOptions(now = new Date()) {
  const cur = currentShift(shifts, now);
  return {
    shifts: shifts.map(s => ({ key: s.key, label: s.label, start: s.start, end: s.end })),
    current: { day: cur.day, shift: cur.shift.key, start: iso(cur.start), end: iso(cur.end) }
  };
}

/**
 * Builds the report. Throws a plain Error (400) for an unknown ward or a shift
 * that has not started.
 */
async function buildShiftReport({ wardId, day = null, shiftKey = null, generatedBy = null, now = new Date() }) {
  const pool = getPool();
  const cur = currentShift(shifts, now);
  const win = shiftWindow(shifts, day || cur.day, shiftKey || cur.shift.key);
  if (win.start > now) throw new Error(`The ${win.shift.label.toLowerCase()} shift of ${win.day} has not started yet.`);
  const inProgress = win.end > now;
  const until = inProgress ? now : win.end;

  const [[ward]] = await pool.query('SELECT ward_id, room_title FROM ward_rooms WHERE ward_id = ?', [wardId]);
  if (!ward) throw new Error(`Ward "${wardId}" not found.`);
  const [[{ beds_total: bedsTotal }]] = await pool.query('SELECT COUNT(*) AS beds_total FROM ward_beds WHERE ward_id = ?', [wardId]);

  // 1. Patients in the ward during the shift: admitted before it ended, not discharged before it started
  const [patientRows] = await pool.query(`
    SELECT p.patient_id, p.full_name, p.fall_risk_score, p.status, p.admission_date, p.discharge_date,
           COALESCE(p.assigned_bed_id, p.discharged_from_bed_id) AS bed_id, b.bed_code
    FROM patients p
    LEFT JOIN ward_beds b ON b.ward_id = ? AND b.bed_id = COALESCE(p.assigned_bed_id, p.discharged_from_bed_id)
    WHERE COALESCE(p.assigned_ward_id, p.discharged_from_ward_id) = ?
      AND p.admission_date < ?
      AND (p.discharge_date IS NULL OR p.discharge_date >= ?)
    ORDER BY b.bed_code IS NULL, b.bed_code, p.full_name
  `, [wardId, wardId, until, win.start]);
  const ids = patientRows.map(p => p.patient_id);

  // 2. Wristbands worn during the shift (binding history)
  let bindingRows = [];
  if (ids.length > 0) {
    [bindingRows] = await pool.query(`
      SELECT pb.patient_id, pb.device_id, COALESCE(d.mac_address, pb.wristband_mac) AS mac_address,
             pb.status, pb.bound_at, pb.bound_by, pb.unbound_at, pb.unbound_by,
             d.battery_level, d.status AS device_status, d.last_seen
      FROM patient_bindings pb
      LEFT JOIN devices d ON d.device_id = pb.device_id
      WHERE pb.patient_id IN (?) AND pb.bound_at < ? AND (pb.unbound_at IS NULL OR pb.unbound_at >= ?)
      ORDER BY pb.bound_at
    `, [ids, until, win.start]);
  }

  // 3. Incidents of the shift: in this ward, or of a patient of the ward when no ward was recorded
  const [incidentRows] = await pool.query(`
    SELECT incident_id, patient_id, patient_name, ward_id, bed_id, incident_category, trigger_timestamp,
           heart_rate, spo2, alert_message, is_simulated, acknowledgment_time, response_latency_seconds,
           attending_clinician, resolution_status, notes
    FROM emergency_incident_logs
    WHERE trigger_timestamp >= ? AND trigger_timestamp < ?
      AND (ward_id = ?${ids.length > 0 ? ' OR (ward_id IS NULL AND patient_id IN (?))' : ''})
    ORDER BY trigger_timestamp, incident_id
  `, ids.length > 0 ? [win.start, until, wardId, ids] : [win.start, until, wardId]);

  // 4. Anchors of the ward, now
  const [anchorRows] = await pool.query(`
    SELECT a.anchor_id, a.device_id, d.status, d.last_seen
    FROM ward_anchors a LEFT JOIN devices d ON d.device_id = a.device_id
    WHERE a.ward_id = ? ORDER BY a.anchor_id
  `, [wardId]);

  // 5. Vitals from InfluxDB
  const vitals = await timeSeries.queryVitalsStats(ids, win.start, until);

  const real = incidentRows.filter(i => Number(i.is_simulated) !== 1);
  const patients = patientRows.map(p => {
    const own = incidentRows.filter(i => i.patient_id === p.patient_id);
    const stats = vitals.available ? (vitals.stats[p.patient_id] || {}) : null;
    const heartRate = stats ? roundStats(stats.heart_rate, 0) : null;
    const spo2 = stats ? roundStats(stats.spo2, 1) : null;
    const attention = attentionReasons({ incidents: own, heartRate, spo2 }, thresholds.vitals, hhmm);
    return {
      patient_id: p.patient_id,
      full_name: p.full_name,
      bed_code: p.bed_code || null,
      fall_risk: p.fall_risk_score,
      admitted_at: iso(p.admission_date),
      discharged_at: iso(p.discharge_date),
      admitted_in_shift: p.admission_date >= win.start && p.admission_date < until,
      discharged_in_shift: p.discharge_date !== null && p.discharge_date >= win.start && p.discharge_date < until,
      in_ward_at_end: p.discharge_date === null || p.discharge_date >= until,
      wristbands: bindingRows.filter(b => b.patient_id === p.patient_id).map(b => ({
        device_id: b.device_id,
        mac_address: b.mac_address,
        bound_at: iso(b.bound_at),
        unbound_at: iso(b.unbound_at),
        status: b.status
      })),
      heart_rate: heartRate,
      spo2,
      incidents: own.filter(i => Number(i.is_simulated) !== 1).length,
      attention
    };
  });

  const acknowledged = real.filter(i => i.resolution_status !== 'PENDING' && i.response_latency_seconds !== null);
  const latencies = acknowledged.map(i => Number(i.response_latency_seconds)).filter(Number.isFinite);
  const atEnd = patients.filter(p => p.in_ward_at_end);
  const activeBands = bindingRows.filter(b => b.status === 'ACTIVE');

  return {
    ward: { ward_id: ward.ward_id, title: ward.room_title, beds_total: Number(bedsTotal) },
    shift: {
      key: win.shift.key, label: win.shift.label, day: win.day,
      start: iso(win.start), end: iso(win.end), in_progress: inProgress, data_until: iso(until)
    },
    generated: { at: iso(now), by: generatedBy },
    census: {
      patients_during_shift: patients.length,
      in_ward_at_end: atEnd.length,
      beds_occupied_at_end: atEnd.filter(p => p.bed_code).length,
      admissions: patients.filter(p => p.admitted_in_shift).length,
      discharges: patients.filter(p => p.discharged_in_shift).length,
      wristbands_bound_now: activeBands.length,
      bindings_started: bindingRows.filter(b => b.bound_at >= win.start).length,
      bindings_ended: bindingRows.filter(b => b.unbound_at !== null && b.unbound_at < until).length
    },
    devices_now: {
      checked_at: iso(now),
      anchors: anchorRows.map(a => ({ anchor_id: a.anchor_id, device_id: a.device_id, status: a.device_id ? (a.status || 'NOT ENROLLED') : 'NO DEVICE', last_seen: iso(a.last_seen) })),
      wristbands: activeBands.map(b => ({ device_id: b.device_id, patient_id: b.patient_id, status: b.device_status, battery_level: b.battery_level, last_seen: iso(b.last_seen) }))
    },
    vitals_source: vitals.available
      ? { available: true }
      : { available: false, reason: vitals.reason },
    patients,
    incidents: {
      summary: {
        total: real.length,
        falls: real.filter(i => i.incident_category === 'FALL_ACCIDENT').length,
        critical_vitals: real.filter(i => i.incident_category === 'CRITICAL_VITALS').length,
        geofence: real.filter(i => i.incident_category === 'GEOFENCE_BREACH').length,
        pending: real.filter(i => i.resolution_status === 'PENDING').length,
        live_lab_tests: incidentRows.length - real.length,
        avg_response_seconds: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length * 10) / 10 : null,
        max_response_seconds: latencies.length ? Math.max(...latencies) : null
      },
      list: incidentRows.map(i => ({
        incident_id: i.incident_id,
        time: iso(i.trigger_timestamp),
        patient_id: i.patient_id,
        patient_name: i.patient_name,
        bed_id: i.bed_id,
        category: i.incident_category,
        message: i.alert_message,
        simulated: Number(i.is_simulated) === 1,
        status: i.resolution_status,
        acknowledged_at: iso(i.acknowledgment_time),
        response_seconds: i.response_latency_seconds === null ? null : Number(i.response_latency_seconds),
        responder: i.attending_clinician,
        notes: i.notes
      }))
    },
    thresholds: {
      heart_rate_high: thresholds.vitals.moderate.bpmHigh,
      heart_rate_low: thresholds.vitals.moderate.bpmLow,
      spo2_alarms: thresholds.vitals.spo2AlarmsEnabled
    }
  };
}

module.exports = { buildShiftReport, shiftOptions };
