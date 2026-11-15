// =============================================================================
// SHIRO Edge Server - Audit trail of important actions
// Every change made through the dashboard or a headset is recorded with who did
// it. Recording never fails the action itself: a failed write is logged.
// =============================================================================
const logger = require('../utils/logger');

const MAX_DETAIL_LENGTH = 1000;

// Requests that change data, recorded after they succeed (status below 400).
// fields: request values copied into the record (identifiers only, never
// passwords or free text). The first field found becomes the target.
const AUDITED_REQUESTS = {
  'POST /api/patients/admit': { action: 'PATIENT_ADMIT', targetType: 'PATIENT', fields: ['patient_id', 'ward_id', 'bed_id'] },
  'POST /api/patients/update': { action: 'PATIENT_UPDATE', targetType: 'PATIENT', fields: ['patient_id'] },
  'POST /api/patients/discharge': { action: 'PATIENT_DISCHARGE', targetType: 'PATIENT', fields: ['patient_id'] },
  'POST /api/patients/assign-bed': { action: 'PATIENT_ASSIGN_BED', targetType: 'PATIENT', fields: ['patient_id', 'ward_id', 'bed_id'] },
  'POST /api/patients/delete': { action: 'PATIENT_DELETE', targetType: 'PATIENT', fields: ['patient_id', 'id'] },
  'DELETE /api/patients/delete': { action: 'PATIENT_DELETE', targetType: 'PATIENT', fields: ['patient_id', 'id'] },
  'POST /api/patients/upload-photo': { action: 'PATIENT_PHOTO_UPLOAD', targetType: 'PATIENT', fields: ['patient_id'] },
  'POST /api/bindings/bind': { action: 'BINDING_CREATE', targetType: 'PATIENT', fields: ['patient_id', 'device_id'] },
  'POST /api/bindings/unbind': { action: 'BINDING_REMOVE', targetType: 'BINDING', fields: ['binding_id', 'patient_id', 'device_id', 'id'] },
  'DELETE /api/bindings/unbind': { action: 'BINDING_REMOVE', targetType: 'BINDING', fields: ['binding_id', 'patient_id', 'device_id', 'id'] },
  'POST /api/alerts/acknowledge': { action: 'ALERT_ACKNOWLEDGE', targetType: 'INCIDENT', fields: ['incident_id'] },
  'POST /api/alerts/trigger-simulation': { action: 'ALERT_SIMULATE', targetType: 'PATIENT', fields: ['patient_id', 'category'] },
  'POST /api/devices/enroll': { action: 'DEVICE_ENROLL', targetType: 'DEVICE', fields: ['device_id', 'device_type', 'mac_address'] },
  'POST /api/devices/update': { action: 'DEVICE_UPDATE', targetType: 'DEVICE', fields: ['device_id', 'assigned_ward_id'] },
  'POST /api/devices/delete': { action: 'DEVICE_DELETE', targetType: 'DEVICE', fields: ['device_id', 'id'] },
  'DELETE /api/devices/delete': { action: 'DEVICE_DELETE', targetType: 'DEVICE', fields: ['device_id', 'id'] },
  'POST /api/ward/config': { action: 'WARD_SAVE', targetType: 'WARD', fields: ['ward_id'] },
  'DELETE /api/ward/config': { action: 'WARD_DELETE', targetType: 'WARD', fields: ['ward_id', 'id'] },
  'POST /api/ward/reset-default': { action: 'WARD_RESET', targetType: 'WARD', fields: ['ward_id'] },
  'POST /api/ward/save-anchor': { action: 'WARD_ANCHOR_SAVE', targetType: 'WARD', fields: ['ward_id'] },
  'POST /api/ward/calibration/start': { action: 'CALIBRATION_START', targetType: 'WARD', fields: ['ward_id', 'anchor_id'] },
  'POST /api/ward/calibration/apply': { action: 'CALIBRATION_APPLY', targetType: 'WARD', fields: ['ward_id', 'anchor_id'] },
  'POST /api/ward/calibration/reset': { action: 'CALIBRATION_RESET', targetType: 'WARD', fields: ['ward_id', 'anchor_id'] },
  'POST /api/ward/ips-tag': { action: 'IPS_TAG_PURGE', targetType: 'DEVICE', fields: ['tag_id', 'id'] },
  'DELETE /api/ward/ips-tag': { action: 'IPS_TAG_PURGE', targetType: 'DEVICE', fields: ['tag_id', 'id'] }
};

async function mysqlSink(row) {
  const { getPool } = require('../database/db');
  await getPool().query(
    `INSERT INTO audit_log (actor_type, actor_id, actor_label, action, target_type, target_id, details, ip_address)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.actor_type, row.actor_id, row.actor_label, row.action, row.target_type, row.target_id, row.details, row.ip_address]
  );
}

let sink = mysqlSink;

/** Replaces where records go (unit tests collect them in memory). */
function configure(options = {}) {
  sink = options.sink || mysqlSink;
}

function shortValue(value) {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.slice(0, 64);
  return undefined; // objects and arrays are not copied
}

/**
 * Records one action. actor: the clinician or headset (null for an anonymous
 * attempt such as a failed sign-in). Never throws.
 */
async function record({ actor = null, action, targetType = null, targetId = null, details = null, ip = null }) {
  const { actorLabel } = require('./auth/auth_service');
  let detailText = null;
  if (details && typeof details === 'object') {
    const kept = {};
    for (const [k, v] of Object.entries(details)) {
      const value = shortValue(v);
      if (value !== undefined) kept[k] = value;
    }
    detailText = Object.keys(kept).length > 0 ? JSON.stringify(kept).slice(0, MAX_DETAIL_LENGTH) : null;
  } else if (typeof details === 'string') {
    detailText = details.slice(0, MAX_DETAIL_LENGTH);
  }
  const row = {
    actor_type: actor ? actor.type : 'ANONYMOUS',
    actor_id: actor ? String(actor.id).slice(0, 32) : null,
    actor_label: actor ? String(actorLabel(actor)).slice(0, 160) : null,
    action: String(action).slice(0, 48),
    target_type: targetType,
    target_id: targetId === null || targetId === undefined ? null : String(targetId).slice(0, 64),
    details: detailText,
    ip_address: ip ? String(ip).slice(0, 45) : null
  };
  try {
    await sink(row);
  } catch (err) {
    if (logger.every('audit-write-error', 30000)) {
      logger.error(`[AUDIT] Could not record ${row.action} by ${row.actor_label || 'anonymous'} (${err.code || err.message}).`);
    }
  }
}

/** Picks the identifiers named by the audit rule from the request and response. */
function collectFields(fields, sources) {
  const found = {};
  for (const field of fields) {
    for (const source of sources) {
      if (source && source[field] !== undefined && source[field] !== null && source[field] !== '') {
        const value = shortValue(source[field]);
        if (value !== undefined) { found[field] = value; break; }
      }
    }
  }
  return found;
}

/**
 * Called after an API request has been answered. Records it when it is an
 * audited change and it succeeded.
 */
function recordRequest({ method, pathname, status, actor, body, query, response, ip }) {
  const rule = AUDITED_REQUESTS[`${method} ${pathname}`];
  if (!rule || status >= 400) return Promise.resolve();
  let parsedBody = null;
  try {
    parsedBody = typeof body === 'string' && body.trim() ? JSON.parse(body) : null;
  } catch {
    parsedBody = null;
  }
  if (parsedBody === null || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) parsedBody = null;
  const responseObject = response && typeof response === 'object' ? response : null;
  const nested = responseObject && typeof responseObject.patient === 'object' ? responseObject.patient : null;
  const details = collectFields(rule.fields, [parsedBody, query, responseObject, nested]);
  const targetField = rule.fields.find(f => details[f] !== undefined);
  return record({
    actor,
    action: rule.action,
    targetType: rule.targetType,
    targetId: targetField ? details[targetField] : null,
    details,
    ip
  });
}

/** The newest records, optionally for one actor or one action. */
async function list({ limit = 100, actorId = null, action = null, targetId = null } = {}) {
  const { getPool } = require('../database/db');
  const where = [];
  const params = [];
  if (actorId) { where.push('actor_id = ?'); params.push(actorId); }
  if (action) { where.push('action = ?'); params.push(action); }
  if (targetId) { where.push('target_id = ?'); params.push(targetId); }
  params.push(limit);
  const [rows] = await getPool().query(
    `SELECT audit_id, created_at, actor_type, actor_id, actor_label, action, target_type, target_id, details, ip_address
     FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY audit_id DESC LIMIT ?`,
    params
  );
  return rows;
}

module.exports = { AUDITED_REQUESTS, configure, record, recordRequest, list };
