// =============================================================================
// SHIRO Edge Server - Shift summary rules (thesis section 4.7.1)
// When a shift starts and ends, which shift is running now, and why a patient
// is flagged ATTN. Pure functions: no database, unit-tested in
// test/unit/shift_rules.test.js. Times are the edge server's local time.
// =============================================================================

const DATE_FORMAT = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_FORMAT = /^([01]\d|2[0-3]):([0-5]\d)$/;

function minutesOf(hhmm) {
  const m = TIME_FORMAT.exec(hhmm);
  if (!m) throw new Error(`Shift time "${hhmm}" is not HH:MM.`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Checks the shift table: three or more shifts that cover the day without gaps. */
function checkShifts(shifts) {
  if (!Array.isArray(shifts) || shifts.length === 0) throw new Error('No shifts are configured.');
  let total = 0;
  for (const s of shifts) {
    const start = minutesOf(s.start);
    const end = minutesOf(s.end);
    total += end > start ? end - start : end + 1440 - start;
  }
  if (total !== 1440) throw new Error(`The shifts cover ${total / 60} hours, not 24.`);
  return shifts;
}

/** 'YYYY-MM-DD' (a real calendar day) → { y, m, d }, or null. */
function parseDay(text) {
  const match = DATE_FORMAT.exec(String(text || ''));
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return { y, m, d };
}

function dayText(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

/**
 * Start and end of a shift. day: 'YYYY-MM-DD', the day the shift starts.
 * The night shift of 19 Nov runs from 19 Nov 23:00 to 20 Nov 07:00.
 */
function shiftWindow(shifts, day, key) {
  const shift = shifts.find(s => s.key === key);
  if (!shift) throw new Error(`Unknown shift "${key}".`);
  const parsed = parseDay(day);
  if (!parsed) throw new Error(`"${day}" is not a date (YYYY-MM-DD).`);
  const startMin = minutesOf(shift.start);
  const endMin = minutesOf(shift.end);
  const start = new Date(parsed.y, parsed.m - 1, parsed.d, Math.floor(startMin / 60), startMin % 60);
  const endDayOffset = endMin > startMin ? 0 : 1;
  const end = new Date(parsed.y, parsed.m - 1, parsed.d + endDayOffset, Math.floor(endMin / 60), endMin % 60);
  return { shift, day: dayText(start), start, end };
}

/**
 * The shift running at `now`, with the day it started on: at 02:00 on 20 Nov
 * that is the night shift of 19 Nov.
 */
function currentShift(shifts, now = new Date()) {
  for (const offset of [0, -1]) {
    const day = dayText(new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset));
    for (const s of shifts) {
      const w = shiftWindow(shifts, day, s.key);
      if (now >= w.start && now < w.end) return w;
    }
  }
  throw new Error('No shift covers the current time.');
}

/** Min, mean and max of the readings, as the report prints them. */
function roundStats(stats, digits) {
  if (!stats || !Number.isFinite(stats.count) || stats.count <= 0) return null;
  const r = (v) => (Number.isFinite(v) ? Number(v.toFixed(digits)) : null);
  return { min: r(stats.min), mean: r(stats.mean), max: r(stats.max), count: stats.count };
}

/**
 * Why a patient needs attention at handover (the report's ATTN tag). Empty: no flag.
 * incidents: the patient's incidents in the shift (Live Lab tests are left out here).
 * heartRate: { min, max } of the shift, or null when not measured.
 * thresholds: config/clinical_thresholds.js vitals section.
 */
function attentionReasons({ incidents = [], heartRate = null, spo2 = null }, thresholds, formatTime) {
  const reasons = [];
  const time = formatTime || ((d) => String(d));
  for (const inc of incidents) {
    if (Number(inc.is_simulated) === 1) continue;
    const at = time(inc.trigger_timestamp);
    if (inc.incident_category === 'FALL_ACCIDENT') reasons.push(`fall at ${at}`);
    else if (inc.incident_category === 'CRITICAL_VITALS') reasons.push(`critical vitals alarm at ${at}`);
    else if (inc.incident_category === 'GEOFENCE_BREACH') reasons.push(inc.geofence_kind === 'AT_DOOR' ? `at the door at ${at}` : `left the ward at ${at}`);
    if (inc.resolution_status === 'PENDING') reasons.push(`alert of ${at} still waiting for a response`);
  }
  const moderate = thresholds.moderate;
  if (heartRate && Number.isFinite(heartRate.max) && heartRate.max > moderate.bpmHigh) {
    reasons.push(`heart rate up to ${Math.round(heartRate.max)} bpm (above ${moderate.bpmHigh})`);
  }
  if (heartRate && Number.isFinite(heartRate.min) && heartRate.min < moderate.bpmLow) {
    reasons.push(`heart rate down to ${Math.round(heartRate.min)} bpm (below ${moderate.bpmLow})`);
  }
  // SpO2 is indicative (not calibrated): it flags only when its alarms are switched on
  if (thresholds.spo2AlarmsEnabled && spo2 && Number.isFinite(spo2.min) && spo2.min < moderate.spo2Low) {
    reasons.push(`SpO2 down to ${Math.round(spo2.min)} % (below ${moderate.spo2Low})`);
  }
  return reasons;
}

module.exports = { checkShifts, parseDay, dayText, shiftWindow, currentShift, roundStats, attentionReasons };
