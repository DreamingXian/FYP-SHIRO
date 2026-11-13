// =============================================================================
// SHIRO Edge Server - Telemetry Normalisation
// Turns the JSON an anchor publishes into one validated object. Anything that
// is missing or implausible becomes null: nothing is invented here.
// Packet layout and JSON fields are specified in docs/protocol.md.
// =============================================================================
const thresholds = require('../../config/clinical_thresholds');

const MOTION_STATES = new Set(['STATIONARY', 'HAND_MOVEMENT', 'WALKING', 'FALL_EMERGENCY']);

function isTrue(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function finiteOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function intInRange(value, min, max) {
  const n = finiteOrNull(value);
  if (n === null) return null;
  const rounded = Math.round(n);
  return rounded >= min && rounded <= max ? rounded : null;
}

/**
 * @param {object} parsed  JSON published by an anchor
 * @returns {object} normalised telemetry; fields are null when unknown
 */
function normalizeTelemetry(parsed, config = thresholds) {
  const p = parsed || {};
  const valid = config.vitals.valid;

  // v = 2: current firmware. v = 0: the anchor heard a wristband whose packet
  // it could not decode (RSSI only). No v field: firmware older than protocol 2.
  const versionField = finiteOrNull(p.v);
  const protocolVersion = versionField === null ? 1 : versionField;

  const hasTelemetry = protocolVersion !== 0 && (
    p.bpm !== undefined || p.spo2 !== undefined || p.battery !== undefined ||
    p.bat !== undefined || p.g !== undefined || p.motion !== undefined
  );

  const imuFault = isTrue(p.imu_fault);
  const ppgFault = isTrue(p.ppg_fault);

  const motionRaw = typeof p.motion === 'string' ? p.motion.toUpperCase() : null;
  const fall = hasTelemetry && (isTrue(p.fall) || motionRaw === 'FALL_EMERGENCY');

  let motion = MOTION_STATES.has(motionRaw) ? motionRaw : null;
  if (fall) motion = 'FALL_EMERGENCY';
  else if (imuFault) motion = null; // the motion class cannot be trusted without the accelerometer

  let g = finiteOrNull(p.g);
  if (g !== null && (g < 0 || g > config.kinematics.maxPlausibleG)) g = null;
  if (imuFault) g = null;

  // Fall measurements exist only for firmware that reports them, and only
  // while a fall is flagged. An impact of 0 means "none recorded".
  let impactG = null;
  let freefallG = null;
  let stillG = null;
  if (fall) {
    const impact = finiteOrNull(p.impact_g);
    if (impact !== null && impact > 0 && impact <= config.kinematics.maxPlausibleG) {
      impactG = impact;
      const freefall = finiteOrNull(p.freefall_g);
      if (freefall !== null && freefall >= 0 && freefall <= config.kinematics.maxPlausibleG) freefallG = freefall;
      const still = finiteOrNull(p.still_g);
      if (still !== null && still >= 0 && still <= config.kinematics.maxPlausibleG) stillG = still;
    }
  }

  return {
    protocolVersion,
    hasTelemetry,
    bpm: hasTelemetry && !ppgFault ? intInRange(p.bpm, valid.bpmMin, valid.bpmMax) : null,
    spo2: hasTelemetry && !ppgFault ? intInRange(p.spo2, valid.spo2Min, valid.spo2Max) : null,
    g,
    motion,
    touch: isTrue(p.touch),
    active: isTrue(p.active) || fall,
    battery: intInRange(p.battery !== undefined ? p.battery : p.bat, 0, 100),
    charging: isTrue(p.charging),
    fall,
    fallSeq: fall ? intInRange(p.fall_seq, 0, 255) : null,
    impactG,
    freefallG,
    stillG,
    imuFault,
    ppgFault
  };
}

module.exports = { normalizeTelemetry, MOTION_STATES };
