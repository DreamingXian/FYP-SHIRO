// =============================================================================
// SHIRO Edge Server - Clinician sign-in, sessions and headset pairing
//
// Sessions: a random 32-byte token in an HttpOnly cookie; only its SHA-256
// hash is stored. A session lasts one shift (12 h) or until sign-out.
// Headsets: an admin creates a 6-digit code (5 min, single use); the headset
// sends it once and receives its own token, valid until an admin revokes it.
// =============================================================================
const crypto = require('crypto');
const { HttpError } = require('../../utils/http');
const { hashPassword, verifyPassword, passwordProblem } = require('./passwords');
const { mysqlStore } = require('./stores');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_LOCK_MS = 5 * 60 * 1000;
const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;
const PAIR_MAX_FAILURES = 5;
const PAIR_LOCK_MS = 5 * 60 * 1000;
const ROLES = ['ADMIN', 'CLINICIAN'];
const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;

let store = mysqlStore();
let now = () => Date.now();

// Failed sign-ins per username and failed pairing codes per address (memory only)
const loginFailures = new Map();
const pairFailures = new Map();
// Pairing codes waiting to be used: code -> { createdBy, expiresAt }
const pairingCodes = new Map();

/** Replaces the storage (unit tests use the memory store) and the clock. */
function configure(options = {}) {
  if (options.store) store = options.store;
  if (options.now) now = options.now;
  loginFailures.clear();
  pairFailures.clear();
  pairingCodes.clear();
}

const newToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

function publicClinician(c) {
  return {
    clinician_id: c.clinician_id,
    username: c.username,
    full_name: c.full_name,
    role: c.role,
    is_active: Boolean(Number(c.is_active)),
    created_at: c.created_at || null,
    created_by: c.created_by || null,
    last_login_at: c.last_login_at || null
  };
}

function clinicianActor(c) {
  return { type: 'CLINICIAN', id: c.clinician_id, username: c.username, name: c.full_name, role: c.role };
}

/** How an actor is written in records: "Dr Lim (CLN-002)" or "QUEST3-1A2B3C (paired by CLN-001)". */
function actorLabel(actor) {
  if (!actor) return null;
  if (actor.type === 'CLINICIAN') return `${actor.name} (${actor.id})`;
  if (actor.type === 'HEADSET') return `${actor.id} (paired by ${actor.pairedBy})`;
  return null;
}

// ----- accounts -----

function checkUsername(username) {
  const clean = typeof username === 'string' ? username.trim().toLowerCase() : '';
  if (!USERNAME_PATTERN.test(clean)) {
    throw new HttpError(400, 'The username must have 3 to 32 characters: lowercase letters, digits, dot, dash or underscore.');
  }
  return clean;
}

function checkFullName(fullName) {
  const clean = typeof fullName === 'string' ? fullName.trim().replace(/\s+/g, ' ') : '';
  if (clean.length < 2 || clean.length > 120 || /[<>]/.test(clean)) {
    throw new HttpError(400, 'The full name must have 2 to 120 characters and no < or >.');
  }
  return clean;
}

function checkPassword(password) {
  const problem = passwordProblem(password);
  if (problem) throw new HttpError(400, problem);
  return password;
}

async function hasAnyClinician() {
  return (await store.countClinicians()) > 0;
}

async function createClinician({ username, fullName, role, password }, createdBy = null) {
  const cleanUsername = checkUsername(username);
  const cleanName = checkFullName(fullName);
  if (!ROLES.includes(role)) throw new HttpError(400, `role must be one of: ${ROLES.join(', ')}.`);
  checkPassword(password);

  if (await store.findClinicianByUsername(cleanUsername)) {
    throw new HttpError(409, `The username "${cleanUsername}" is already taken.`);
  }
  const number = (await store.maxClinicianNumber()) + 1;
  const row = {
    clinician_id: `CLN-${String(number).padStart(3, '0')}`,
    username: cleanUsername,
    full_name: cleanName,
    role,
    password_hash: await hashPassword(password),
    created_by: createdBy
  };
  try {
    await store.insertClinician(row);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw new HttpError(409, `The username "${cleanUsername}" is already taken.`);
    throw err;
  }
  return publicClinician({ ...row, is_active: 1 });
}

/** The first account: an admin, allowed only while no account exists. */
async function createFirstAdmin({ username, fullName, password }) {
  if (await hasAnyClinician()) throw new HttpError(409, 'An account already exists. Ask an admin to create yours.');
  return createClinician({ username, fullName, role: 'ADMIN', password }, null);
}

async function listClinicians() {
  return (await store.listClinicians()).map(publicClinician);
}

async function requireClinician(id) {
  if (typeof id !== 'string' || !/^CLN-\d{3,6}$/.test(id)) throw new HttpError(400, 'clinician_id must look like CLN-001.');
  const c = await store.findClinicianById(id);
  if (!c) throw new HttpError(404, `Account ${id} not found.`);
  return c;
}

async function setClinicianActive(id, active, byActor) {
  const c = await requireClinician(id);
  if (!active) {
    if (byActor && byActor.id === id) throw new HttpError(400, 'You cannot deactivate your own account.');
    if (c.role === 'ADMIN' && Number(c.is_active) && (await store.countActiveAdmins()) <= 1) {
      throw new HttpError(400, 'The last active admin cannot be deactivated.');
    }
  }
  await store.updateClinician(id, { is_active: active ? 1 : 0 });
  if (!active) await store.revokeSessionsOf(id);
  return publicClinician({ ...c, is_active: active ? 1 : 0 });
}

async function resetPassword(id, password) {
  await requireClinician(id);
  checkPassword(password);
  await store.updateClinician(id, { password_hash: await hashPassword(password) });
  await store.revokeSessionsOf(id);
}

// ----- sign-in and sessions -----

function lockRemainingMs(map, key) {
  const entry = map.get(key);
  if (!entry || !entry.lockedUntil) return 0;
  const left = entry.lockedUntil - now();
  if (left <= 0) { map.delete(key); return 0; }
  return left;
}

function recordFailure(map, key, maxFailures, lockMs) {
  const entry = map.get(key) || { failures: 0, lockedUntil: 0 };
  entry.failures += 1;
  if (entry.failures >= maxFailures) {
    entry.lockedUntil = now() + lockMs;
    entry.failures = 0;
  }
  map.set(key, entry);
  if (map.size > 10000) map.clear(); // bounded memory
}

/**
 * Checks a username and password. Resolves with { token, expiresAt, actor }.
 * Throws 401 for a wrong username or password (the same answer for both),
 * 429 while the account is locked after repeated failures.
 */
async function login(username, password, ip = null) {
  const key = typeof username === 'string' ? username.trim().toLowerCase().slice(0, 64) : '';
  const locked = lockRemainingMs(loginFailures, key);
  if (locked > 0) {
    throw new HttpError(429, `Too many failed sign-ins for this account. Try again in ${Math.ceil(locked / 60000)} minute(s).`);
  }
  const c = key ? await store.findClinicianByUsername(key) : null;
  const ok = c ? await verifyPassword(password, c.password_hash) : false;
  if (!c || !ok || !Number(c.is_active)) {
    recordFailure(loginFailures, key, LOGIN_MAX_FAILURES, LOGIN_LOCK_MS);
    const err = new HttpError(401, 'Wrong username or password, or the account is deactivated.');
    err.attemptedUsername = key;
    throw err;
  }
  loginFailures.delete(key);

  const token = newToken();
  const expiresAt = new Date(now() + SESSION_TTL_MS);
  await store.insertSession({ token_hash: hashToken(token), clinician_id: c.clinician_id, expires_at: expiresAt, ip_address: ip });
  await store.updateClinician(c.clinician_id, { last_login_at: new Date(now()) });
  return { token, expiresAt, actor: clinicianActor(c) };
}

/** The signed-in clinician for a session token, or null. */
async function authenticateSession(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const s = await store.findSession(hashToken(token));
  if (!s || s.revoked_at || new Date(s.expires_at).getTime() <= now()) return null;
  const c = await store.findClinicianById(s.clinician_id);
  if (!c || !Number(c.is_active)) return null;
  return clinicianActor(c);
}

async function logout(token) {
  if (typeof token === 'string' && token) await store.revokeSession(hashToken(token));
}

// ----- headset pairing -----

function createPairingCode(createdBy) {
  for (const [code, entry] of pairingCodes) if (entry.expiresAt <= now()) pairingCodes.delete(code);
  let code;
  do {
    code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  } while (pairingCodes.has(code));
  const expiresAt = now() + PAIRING_CODE_TTL_MS;
  pairingCodes.set(code, { createdBy, expiresAt });
  return { code, expiresAt: new Date(expiresAt), validSeconds: PAIRING_CODE_TTL_MS / 1000 };
}

/**
 * Exchanges a pairing code for a headset token. The code works once.
 * Throws 401 for a wrong or expired code, 429 after repeated wrong codes from one address.
 */
async function pairHeadset(deviceId, code, ip = 'unknown') {
  const locked = lockRemainingMs(pairFailures, ip);
  if (locked > 0) {
    throw new HttpError(429, `Too many wrong pairing codes. Try again in ${Math.ceil(locked / 60000)} minute(s).`);
  }
  const entry = typeof code === 'string' ? pairingCodes.get(code.trim()) : undefined;
  if (!entry || entry.expiresAt <= now()) {
    recordFailure(pairFailures, ip, PAIR_MAX_FAILURES, PAIR_LOCK_MS);
    throw new HttpError(401, 'The pairing code is wrong or has expired. Create a new code on the dashboard.');
  }
  pairingCodes.delete(code.trim());
  pairFailures.delete(ip);

  const token = newToken();
  await store.upsertPairing({ device_id: deviceId, token_hash: hashToken(token), paired_by: entry.createdBy });
  return { token, pairedBy: entry.createdBy };
}

/** The paired headset for a headset token, or null. */
async function authenticateHeadset(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const p = await store.findPairingByHash(hashToken(token));
  if (!p || p.revoked_at) return null;
  return { type: 'HEADSET', id: p.device_id, pairedBy: p.paired_by };
}

async function listPairings() {
  return store.listPairings();
}

async function revokePairing(deviceId, revokedBy) {
  const revoked = await store.revokePairing(deviceId, revokedBy);
  if (!revoked) throw new HttpError(404, `No active pairing for ${deviceId}.`);
}

module.exports = {
  configure,
  hashToken,
  actorLabel,
  hasAnyClinician,
  createClinician,
  createFirstAdmin,
  listClinicians,
  setClinicianActive,
  resetPassword,
  login,
  authenticateSession,
  logout,
  createPairingCode,
  pairHeadset,
  authenticateHeadset,
  listPairings,
  revokePairing,
  SESSION_TTL_MS,
  LOGIN_MAX_FAILURES,
  PAIRING_CODE_TTL_MS
};
