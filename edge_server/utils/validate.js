// =============================================================================
// SHIRO Edge Server - Input validation
// Every value that arrives from outside (HTTP, WebSocket, MQTT) is checked with
// these functions before it is used. A value that fails is refused with a 400;
// it is never replaced by a default.
// =============================================================================
const { HttpError } = require('./http');

// Identifiers: patient, ward, bed, device and incident IDs (for example P-001,
// WARD-A1, BED-WARD-004-02, INC-20261114-0253). The database stores 32 characters.
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

// Names an operator gives to an anchor on a ward plan (for example "Anchor A").
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.:-]{0,31}$/;

const MAC_PATTERN = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;

// The reference of a spatial anchor, as the headset stores it: a UUID, or a
// name the headset builds when the platform gives none. 64 characters in the database.
const ANCHOR_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function isMissing(value) {
  return value === undefined || value === null || value === '';
}

function isId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function isLabel(value) {
  return typeof value === 'string' && LABEL_PATTERN.test(value);
}

/** Returns the MAC address as AA:BB:CC:DD:EE:FF, or null when it is not one. */
function normalizeMac(value) {
  if (typeof value !== 'string') return null;
  const mac = value.trim().toUpperCase().replace(/-/g, ':');
  return MAC_PATTERN.test(mac) ? mac : null;
}

function isMac(value) {
  return normalizeMac(value) !== null;
}

function requireId(value, name) {
  if (isMissing(value)) throw new HttpError(400, `${name} is required.`);
  if (!isId(value)) throw new HttpError(400, `${name} is not a valid identifier (letters, digits, "-" and "_", at most 32 characters).`);
  return value;
}

function optionalId(value, name) {
  return isMissing(value) ? null : requireId(value, name);
}

function requireMac(value, name) {
  if (isMissing(value)) throw new HttpError(400, `${name} is required.`);
  const mac = normalizeMac(value);
  if (mac === null) throw new HttpError(400, `${name} is not a valid MAC address (expected AA:BB:CC:DD:EE:FF).`);
  return mac;
}

function optionalMac(value, name) {
  return isMissing(value) ? null : requireMac(value, name);
}

/**
 * A wristband reference: the ID of an enrolled device, or the MAC address of
 * one that is not enrolled yet. Returns the ID unchanged or the MAC normalised.
 */
function requireDeviceRef(value, name) {
  if (isMissing(value)) throw new HttpError(400, `${name} is required.`);
  if (isId(value)) return value;
  const mac = normalizeMac(value);
  if (mac === null) throw new HttpError(400, `${name} is not a valid device ID or MAC address.`);
  return mac;
}

function requireOneOf(value, allowed, name) {
  if (isMissing(value)) throw new HttpError(400, `${name} is required.`);
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new HttpError(400, `${name} must be one of: ${allowed.join(', ')}.`);
  }
  return value;
}

function optionalOneOf(value, allowed, name, fallback = null) {
  return isMissing(value) ? fallback : requireOneOf(value, allowed, name);
}

function toFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function requireNumber(value, name, { min = -Infinity, max = Infinity } = {}) {
  if (isMissing(value)) throw new HttpError(400, `${name} is required.`);
  const n = toFiniteNumber(value);
  if (n === null) throw new HttpError(400, `${name} must be a number.`);
  if (n < min || n > max) throw new HttpError(400, `${name} must be between ${min} and ${max}.`);
  return n;
}

function optionalNumber(value, name, range, fallback = null) {
  return isMissing(value) ? fallback : requireNumber(value, name, range);
}

function requireInt(value, name, range) {
  const n = requireNumber(value, name, range);
  if (!Number.isInteger(n)) throw new HttpError(400, `${name} must be a whole number.`);
  return n;
}

function optionalInt(value, name, range, fallback = null) {
  return isMissing(value) ? fallback : requireInt(value, name, range);
}

/** Free text (names, notes). Returns the trimmed text, or null when absent. */
function optionalText(value, name, maxLength) {
  if (isMissing(value)) return null;
  if (typeof value !== 'string') throw new HttpError(400, `${name} must be text.`);
  const text = value.trim();
  if (text.length > maxLength) throw new HttpError(400, `${name} is too long (at most ${maxLength} characters).`);
  return text === '' ? null : text;
}

function optionalAnchorRef(value, name) {
  if (isMissing(value)) return null;
  if (typeof value !== 'string' || !ANCHOR_REF_PATTERN.test(value)) throw new HttpError(400, `${name} is not a valid spatial anchor reference.`);
  return value;
}

function requireLabel(value, name) {
  if (isMissing(value)) throw new HttpError(400, `${name} is required.`);
  if (!isLabel(value)) throw new HttpError(400, `${name} is not a valid name (letters, digits, spaces, "-", "_", "." and ":", at most 32 characters).`);
  return value;
}

/** A list from a JSON body. Absent gives []. */
function optionalArray(value, name, maxLength) {
  if (isMissing(value)) return [];
  if (!Array.isArray(value)) throw new HttpError(400, `${name} must be a list.`);
  if (value.length > maxLength) throw new HttpError(400, `${name} has too many entries (at most ${maxLength}).`);
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new HttpError(400, `Every entry of ${name} must be an object.`);
  }
  return value;
}

module.exports = {
  ID_PATTERN,
  isId,
  isLabel,
  isMac,
  normalizeMac,
  toFiniteNumber,
  requireId,
  optionalId,
  requireMac,
  optionalMac,
  requireDeviceRef,
  requireOneOf,
  optionalOneOf,
  requireNumber,
  optionalNumber,
  requireInt,
  optionalInt,
  optionalText,
  optionalAnchorRef,
  requireLabel,
  optionalArray
};
