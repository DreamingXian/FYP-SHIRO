// =============================================================================
// SHIRO Edge Server - Incident log as CSV (thesis section 4.7.2)
// Turns incident rows into a CSV file that opens in Excel or LibreOffice:
//   - RFC 4180: fields with a comma, quote or line break are quoted, quotes doubled,
//     lines end with CRLF; a UTF-8 byte order mark so Excel reads names correctly;
//   - no spreadsheet formula can run: a text starting with = + - @, a tab or a
//     carriage return gets a leading apostrophe (numbers are written as numbers);
//   - missing values stay empty, never 0 or a default;
//   - times in the server's local time, "YYYY-MM-DD HH:MM:SS".
// Pure functions: no database access, unit-tested in test/unit/incident_csv.test.js
// =============================================================================

const BOM = '\uFEFF';
const EOL = '\r\n';

const CATEGORY_TEXT = Object.freeze({
  FALL_ACCIDENT: 'Fall',
  CRITICAL_VITALS: 'Critical vitals',
  GEOFENCE_BREACH: 'Left the ward'
});
// The two kinds of geofence alert (Phase 10); older geofence rows have none
const GEOFENCE_KIND_TEXT = Object.freeze({ LEFT_WARD: 'Left the ward', AT_DOOR: 'At the door' });

function typeText(r) {
  if (r.incident_category === 'GEOFENCE_BREACH' && GEOFENCE_KIND_TEXT[r.geofence_kind]) return GEOFENCE_KIND_TEXT[r.geofence_kind];
  return CATEGORY_TEXT[r.incident_category] || r.incident_category;
}

/** Local time "YYYY-MM-DD HH:MM:SS", or null. */
function formatLocalTime(value) {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function numberOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** A positive measurement, or null (0 means "no reading" for heart rate and SpO2). */
function readingOrNull(v) {
  const n = numberOrNull(v);
  return n !== null && n > 0 ? n : null;
}

const round = (digits) => (v) => {
  const n = numberOrNull(v);
  return n === null ? null : Number(n.toFixed(digits));
};

// Column title, and how the value is taken from an incident row
const COLUMNS = Object.freeze([
  ['Incident ID', r => r.incident_id],
  ['Time (local)', r => formatLocalTime(r.trigger_timestamp)],
  ['Type', typeText],
  ['Live Lab test', r => (Number(r.is_simulated) === 1 ? 'yes' : 'no')],
  ['Patient ID', r => r.patient_id],
  ['Patient name', r => r.patient_name],
  ['Ward', r => r.ward_id],
  ['Bed', r => r.bed_id],
  ['Wristband MAC', r => r.wristband_mac],
  ['Position x (m)', r => round(2)(r.pos_x)],
  ['Position y (m)', r => round(2)(r.pos_y)],
  ['Impact (g)', r => round(2)(r.kinematic_impact_force)],
  ['Free-fall minimum (g)', r => round(2)(r.freefall_min_g)],
  ['Post-impact stillness (g)', r => round(2)(r.post_impact_stillness)],
  ['Heart rate (bpm)', r => readingOrNull(r.heart_rate)],
  ['SpO2 indicative (%)', r => { const n = readingOrNull(r.spo2); return n === null ? null : Math.round(n); }],
  ['Alert message', r => r.alert_message],
  ['Status', r => r.resolution_status],
  ['Acknowledged at (local)', r => formatLocalTime(r.acknowledgment_time)],
  ['Response time (s)', r => round(1)(r.response_latency_seconds)],
  ['Responder', r => r.attending_clinician],
  ['Notes', r => r.notes]
]);

/** One CSV field. */
function csvCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;   // never a formula in a spreadsheet
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** The whole file: byte order mark, header row, one row per incident. */
function incidentsToCsv(rows) {
  const lines = [COLUMNS.map(([title]) => csvCell(title)).join(',')];
  for (const r of rows || []) {
    lines.push(COLUMNS.map(([, take]) => csvCell(take(r))).join(','));
  }
  return BOM + lines.join(EOL) + EOL;
}

/** "shiro-incidents_P-001_30d_FALL_ACCIDENT_20261119-1530.csv" (only safe characters). */
function csvFileName({ patientId = null, range = 'all', category = null, now = new Date() } = {}) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  const parts = ['shiro-incidents', patientId || 'all-patients', range || 'all'];
  if (category) parts.push(category);
  parts.push(stamp);
  return `${parts.join('_').replace(/[^A-Za-z0-9_.-]/g, '-')}.csv`;
}

module.exports = { COLUMNS, CATEGORY_TEXT, csvCell, incidentsToCsv, csvFileName, formatLocalTime };
