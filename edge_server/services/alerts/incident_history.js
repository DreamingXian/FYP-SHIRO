// =============================================================================
// SHIRO Edge Server - Incident history filters
// Builds the WHERE clause for the incident history of one patient or of every
// patient, so the list and its summary always use the same filter.
// Pure functions: no database access, unit-tested in test/unit/incident_history.test.js
// =============================================================================

/** Time ranges the dashboard offers, in hours. null = no time limit. */
const HISTORY_RANGES = Object.freeze({ '24h': 24, '7d': 24 * 7, '30d': 24 * 30, all: null });

const CATEGORIES = Object.freeze(['FALL_ACCIDENT', 'CRITICAL_VITALS', 'GEOFENCE_BREACH']);

/**
 * @param {object} filter
 * @param {string|null} [filter.patientId]  only this patient's incidents
 * @param {string} [filter.range]           a key of HISTORY_RANGES (default 'all')
 * @param {string|null} [filter.category]   one of CATEGORIES
 * @param {boolean} [filter.includeSimulated=true] false leaves out Live Lab tests
 * @returns {{ where: string, params: Array }} where is '' or starts with 'WHERE '
 */
function buildHistoryFilter({ patientId = null, range = 'all', category = null, includeSimulated = true } = {}) {
  if (!Object.prototype.hasOwnProperty.call(HISTORY_RANGES, range)) {
    throw new Error(`Unknown history range "${range}".`);
  }
  if (category !== null && !CATEGORIES.includes(category)) {
    throw new Error(`Unknown incident category "${category}".`);
  }

  const clauses = [];
  const params = [];
  if (patientId) {
    clauses.push('patient_id = ?');
    params.push(patientId);
  }
  const hours = HISTORY_RANGES[range];
  if (hours !== null) {
    // The database clock decides, the same clock that wrote trigger_timestamp
    clauses.push('trigger_timestamp >= NOW() - INTERVAL ? HOUR');
    params.push(hours);
  }
  if (category) {
    clauses.push('incident_category = ?');
    params.push(category);
  }
  if (!includeSimulated) {
    clauses.push('is_simulated = 0');
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

/**
 * Turns the summary row from MySQL (SUM/AVG come back as strings or null)
 * into numbers. An average with nothing to average stays null, not 0.
 */
function normalizeSummary(row) {
  const r = row || {};
  const count = (v) => (v === null || v === undefined ? 0 : Number(v));
  const avg = r.avg_response_seconds;
  return {
    total: count(r.total),
    falls: count(r.falls),
    critical_vitals: count(r.critical_vitals),
    geofence: count(r.geofence),
    pending: count(r.pending),
    acknowledged: count(r.acknowledged),
    simulated: count(r.simulated),
    avg_response_seconds: avg === null || avg === undefined ? null : Math.round(Number(avg) * 10) / 10,
    max_response_seconds: r.max_response_seconds === null || r.max_response_seconds === undefined ? null : Number(r.max_response_seconds)
  };
}

module.exports = { HISTORY_RANGES, CATEGORIES, buildHistoryFilter, normalizeSummary };
