// =============================================================================
// SHIRO Edge Server - MQTT access control
// Who may connect to the broker, and which topics they may use.
//
// Only the anchors use MQTT. They share one username and password, set in
// edge_server/.env (MQTT_ANCHOR_USER, MQTT_ANCHOR_PASSWORD) and in the anchor
// firmware's secrets.h. Without both values the server does not start: an open
// broker is never the fallback.
// =============================================================================
const logger = require('../utils/logger');
const crypto = require('crypto');

// Client ID an anchor uses: SHIRO_Anchor_ followed by its Wi-Fi MAC address without colons
const ANCHOR_CLIENT_ID = /^SHIRO_Anchor_([0-9A-Fa-f]{12})$/;

// Topics an anchor may publish to, and the topics it may subscribe to
const PUBLISH_TOPICS = [
  /^shiro\/[A-Za-z0-9_-]{1,32}\/anchor\/telemetry$/,
  /^shiro\/discovery$/
];
const CONTROL_PREFIX = 'shiro/control/';
const TOPIC_LEVEL = /^([A-Za-z0-9_-]{1,32}|\+)$/;

const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,64}$/;
const PASSWORD_MIN_LENGTH = 16;
const PASSWORD_MAX_LENGTH = 128;

// Repeated failed logins from one address: refuse that address for a while
const FAILURE_WINDOW_MS = 60000;
const MAX_FAILURES_PER_WINDOW = 10;
const LOCKOUT_MS = 60000;

// MQTT 3.1.1 CONNACK return codes
const IDENTIFIER_REJECTED = 2;
const BAD_USERNAME_OR_PASSWORD = 4;
const NOT_AUTHORIZED = 5;

/**
 * Reads the anchor login from the environment.
 * @returns {{username: string, password: string}}
 * @throws Error with a message that says what to put in .env
 */
function readAnchorCredentials(env = process.env) {
  const username = typeof env.MQTT_ANCHOR_USER === 'string' ? env.MQTT_ANCHOR_USER.trim() : '';
  const password = typeof env.MQTT_ANCHOR_PASSWORD === 'string' ? env.MQTT_ANCHOR_PASSWORD : '';

  if (!username || !password) {
    throw new Error('MQTT_ANCHOR_USER and MQTT_ANCHOR_PASSWORD must be set in edge_server/.env. The MQTT broker does not run without a login (see .env.example).');
  }
  if (!USERNAME_PATTERN.test(username)) {
    throw new Error('MQTT_ANCHOR_USER must be 3 to 64 characters: letters, digits, "_", "-" or ".".');
  }
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    throw new Error(`MQTT_ANCHOR_PASSWORD must be ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters long.`);
  }
  if (!/^[\x21-\x7E]+$/.test(password)) {
    throw new Error('MQTT_ANCHOR_PASSWORD may contain printable ASCII characters only, without spaces.');
  }
  return { username, password };
}

/** Compares two secrets in constant time, whatever their lengths. */
function secretEquals(expected, given) {
  const a = crypto.createHash('sha256').update(Buffer.from(String(expected), 'utf8')).digest();
  const b = crypto.createHash('sha256').update(Buffer.isBuffer(given) ? given : Buffer.from(given == null ? '' : String(given), 'utf8')).digest();
  return crypto.timingSafeEqual(a, b);
}

/** The anchor MAC address in an anchor client ID ("AA:BB:CC:DD:EE:FF"), or null. */
function anchorMacFromClientId(clientId) {
  const match = typeof clientId === 'string' ? clientId.match(ANCHOR_CLIENT_ID) : null;
  return match ? match[1].toUpperCase().match(/.{2}/g).join(':') : null;
}

function mayPublish(topic) {
  return typeof topic === 'string' && PUBLISH_TOPICS.some(re => re.test(topic));
}

function maySubscribe(topic) {
  if (typeof topic !== 'string' || !topic.startsWith(CONTROL_PREFIX)) return false;
  const levels = topic.slice(CONTROL_PREFIX.length).split('/');
  if (levels.length > 4) return false;
  return levels.every((level, i) => TOPIC_LEVEL.test(level) || (level === '#' && i === levels.length - 1));
}

function addressOf(client) {
  const raw = client && client.conn && client.conn.remoteAddress;
  return typeof raw === 'string' ? raw.replace(/^::ffff:/, '') : 'unknown';
}

function refusal(returnCode, message) {
  const err = new Error(message);
  err.returnCode = returnCode;
  return err;
}

/**
 * Builds the Aedes hooks for the given login.
 * @param {{username: string, password: string}} credentials
 * @param {{warn?: Function, now?: Function}} [options]  warn receives one text line; now for tests
 */
function createAccessControl(credentials, options = {}) {
  const warn = options.warn || ((line) => logger.warn(line));
  const now = options.now || Date.now;

  const failures = new Map();     // address -> { count, since, lockedUntil }
  const lastWarning = new Map();  // address|reason -> time

  function warnOnce(key, line) {
    const t = now();
    if (t - (lastWarning.get(key) || 0) < 10000) return;
    if (lastWarning.size > 500) lastWarning.clear();
    lastWarning.set(key, t);
    warn(line);
  }

  function recordFailure(address) {
    const t = now();
    let entry = failures.get(address);
    if (!entry || t - entry.since > FAILURE_WINDOW_MS) entry = { count: 0, since: t, lockedUntil: 0 };
    entry.count += 1;
    if (entry.count >= MAX_FAILURES_PER_WINDOW) {
      entry.lockedUntil = t + LOCKOUT_MS;
      entry.count = 0;
      entry.since = t;
      warnOnce(`${address}|lockout`, `[MQTT SECURITY] ${MAX_FAILURES_PER_WINDOW} failed logins from ${address}: refused for ${LOCKOUT_MS / 1000} s.`);
    }
    if (failures.size > 1000) failures.clear();
    failures.set(address, entry);
  }

  function authenticate(client, username, password, callback) {
    const address = addressOf(client);
    const clientId = client && typeof client.id === 'string' ? client.id.slice(0, 60) : '';
    const entry = failures.get(address);
    if (entry && entry.lockedUntil > now()) {
      return callback(refusal(NOT_AUTHORIZED, 'Too many failed logins'), false);
    }

    if (!anchorMacFromClientId(clientId)) {
      recordFailure(address);
      warnOnce(`${address}|id`, `[MQTT SECURITY] Refused ${address}: client ID "${clientId}" is not an anchor ID (SHIRO_Anchor_<12 hex digits>).`);
      return callback(refusal(IDENTIFIER_REJECTED, 'Client ID not allowed'), false);
    }

    // Both comparisons always run, so the answer time does not tell which part was wrong
    const userOk = secretEquals(credentials.username, username);
    const passwordOk = secretEquals(credentials.password, password);
    if (!(userOk && passwordOk)) {
      recordFailure(address);
      const what = username === undefined || username === null ? 'no username or password' : 'wrong username or password';
      warnOnce(`${address}|login`, `[MQTT SECURITY] Refused ${clientId} from ${address}: ${what}.`);
      return callback(refusal(BAD_USERNAME_OR_PASSWORD, 'Bad username or password'), false);
    }

    failures.delete(address);
    return callback(null, true);
  }

  function authorizePublish(client, packet, callback) {
    if (mayPublish(packet && packet.topic)) return callback(null);
    const clientId = client && typeof client.id === 'string' ? client.id.slice(0, 60) : 'unknown';
    warnOnce(`${clientId}|pub`, `[MQTT SECURITY] ${clientId} may not publish to "${String(packet && packet.topic).slice(0, 80)}": disconnected.`);
    return callback(new Error('Publishing to this topic is not allowed'));
  }

  function authorizeSubscribe(client, subscription, callback) {
    if (subscription && maySubscribe(subscription.topic)) return callback(null, subscription);
    const clientId = client && typeof client.id === 'string' ? client.id.slice(0, 60) : 'unknown';
    warnOnce(`${clientId}|sub`, `[MQTT SECURITY] ${clientId} may not subscribe to "${String(subscription && subscription.topic).slice(0, 80)}": refused.`);
    return callback(null, null); // SUBACK 0x80 for this topic, the connection stays open
  }

  return { authenticate, authorizePublish, authorizeSubscribe };
}

module.exports = {
  readAnchorCredentials,
  createAccessControl,
  anchorMacFromClientId,
  mayPublish,
  maySubscribe,
  secretEquals,
  MAX_FAILURES_PER_WINDOW,
  LOCKOUT_MS
};
