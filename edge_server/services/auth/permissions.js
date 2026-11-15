// =============================================================================
// SHIRO Edge Server - Who may call which API address
// One table for the whole API. An address that is not listed needs a signed-in
// clinician (STAFF), so a new route is protected even if it is forgotten here.
//
//   PUBLIC            no sign-in (only what is needed to sign in or pair)
//   STAFF             a signed-in clinician or admin
//   STAFF_OR_HEADSET  as STAFF, or a paired headset
//   ADMIN             a signed-in admin
// =============================================================================

const ACCESS = Object.freeze({
  PUBLIC: 'PUBLIC',
  STAFF: 'STAFF',
  STAFF_OR_HEADSET: 'STAFF_OR_HEADSET',
  ADMIN: 'ADMIN'
});

// [method or '*', path, access]. A path ending in /* matches everything below it.
const RULES = [
  ['GET', '/api/auth/status', ACCESS.PUBLIC],
  ['POST', '/api/auth/login', ACCESS.PUBLIC],
  ['POST', '/api/auth/setup', ACCESS.PUBLIC],     // only from the server PC, and only before the first account exists
  ['POST', '/api/headset/pair', ACCESS.PUBLIC],   // needs a pairing code made by an admin

  ['*', '/api/admin/*', ACCESS.ADMIN],
  ['POST', '/api/devices/enroll', ACCESS.ADMIN],
  ['POST', '/api/devices/update', ACCESS.ADMIN],
  ['POST', '/api/devices/delete', ACCESS.ADMIN],
  ['DELETE', '/api/devices/delete', ACCESS.ADMIN],
  ['POST', '/api/ward/config', ACCESS.ADMIN],
  ['DELETE', '/api/ward/config', ACCESS.ADMIN],
  ['POST', '/api/ward/reset-default', ACCESS.ADMIN],
  ['POST', '/api/ward/calibration/start', ACCESS.ADMIN],
  ['POST', '/api/ward/calibration/apply', ACCESS.ADMIN],
  ['POST', '/api/ward/calibration/reset', ACCESS.ADMIN],

  // What the headset reads and does
  ['GET', '/api/ward/list', ACCESS.STAFF_OR_HEADSET],
  ['GET', '/api/ward/ips-init', ACCESS.STAFF_OR_HEADSET],
  ['GET', '/api/ward/config', ACCESS.STAFF_OR_HEADSET],
  ['GET', '/api/ward/get', ACCESS.STAFF_OR_HEADSET],
  ['POST', '/api/ward/save-anchor', ACCESS.STAFF_OR_HEADSET],
  ['GET', '/api/patients/list', ACCESS.STAFF_OR_HEADSET],
  ['GET', '/api/patients/get', ACCESS.STAFF_OR_HEADSET],
  ['GET', '/api/patients/vitals-history', ACCESS.STAFF_OR_HEADSET],
  ['GET', '/api/bindings/list', ACCESS.STAFF_OR_HEADSET],
  ['GET', '/api/alerts/active', ACCESS.STAFF_OR_HEADSET],
  ['GET', '/api/alerts/history', ACCESS.STAFF_OR_HEADSET],
  ['POST', '/api/alerts/acknowledge', ACCESS.STAFF_OR_HEADSET]
];

function matches(rulePath, pathname) {
  if (rulePath.endsWith('/*')) {
    const base = rulePath.slice(0, -2);
    return pathname === base || pathname.startsWith(base + '/');
  }
  return pathname === rulePath;
}

/** The access an API request needs. Unlisted addresses need STAFF. */
function requiredAccess(method, pathname) {
  for (const [ruleMethod, rulePath, access] of RULES) {
    if ((ruleMethod === '*' || ruleMethod === method) && matches(rulePath, pathname)) return access;
  }
  return ACCESS.STAFF;
}

/**
 * Whether an actor may make a request with that access level.
 * actor: null (nobody signed in), { type: 'CLINICIAN', role }, or { type: 'HEADSET' }.
 * Returns 'ok', 'unauthenticated' (401) or 'forbidden' (403).
 */
function decide(access, actor) {
  if (access === ACCESS.PUBLIC) return 'ok';
  if (!actor) return 'unauthenticated';
  const isClinician = actor.type === 'CLINICIAN';
  const isAdmin = isClinician && actor.role === 'ADMIN';
  switch (access) {
    case ACCESS.ADMIN: return isAdmin ? 'ok' : 'forbidden';
    case ACCESS.STAFF: return isClinician ? 'ok' : 'forbidden';
    case ACCESS.STAFF_OR_HEADSET: return isClinician || actor.type === 'HEADSET' ? 'ok' : 'forbidden';
    default: return 'forbidden';
  }
}

// WebSocket commands
const COMMAND_ACCESS = Object.freeze({
  UPDATE_CALIBRATION: ACCESS.ADMIN,
  SET_ACTIVE_MODE: ACCESS.STAFF_OR_HEADSET,
  DEVICE_HANDSHAKE: 'HEADSET',
  DEVICE_HEARTBEAT: 'HEADSET'
});

/** Same answers as decide(), for a WebSocket command. */
function decideCommand(action, actor) {
  const access = COMMAND_ACCESS[action];
  if (!access) return 'forbidden';
  if (access === 'HEADSET') return actor && actor.type === 'HEADSET' ? 'ok' : 'forbidden';
  return decide(access, actor);
}

module.exports = { ACCESS, RULES, requiredAccess, decide, decideCommand };
