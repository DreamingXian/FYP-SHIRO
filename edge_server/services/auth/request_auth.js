// =============================================================================
// SHIRO Edge Server - Who is making this request
// The dashboard sends its session in the HttpOnly cookie "shiro_session".
// A paired headset sends "Authorization: Bearer <headset token>".
// =============================================================================
const authService = require('./auth_service');

const SESSION_COOKIE = 'shiro_session';

function parseCookies(header) {
  const cookies = {};
  if (typeof header !== 'string') return cookies;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

function sessionTokenOf(req) {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE] || null;
}

function bearerTokenOf(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+([A-Za-z0-9_-]{20,100})$/);
  return match ? match[1] : null;
}

/** The clinician or headset behind the request, or null. Cached on the request. */
async function actorOf(req) {
  if (req.actor !== undefined) return req.actor;
  let actor = null;
  const session = sessionTokenOf(req);
  if (session) actor = await authService.authenticateSession(session);
  if (!actor) {
    const bearer = bearerTokenOf(req);
    if (bearer) actor = await authService.authenticateHeadset(bearer);
  }
  req.actor = actor;
  return actor;
}

/** Cookie that holds the session. HttpOnly: page scripts cannot read it. */
function sessionCookie(token, maxAgeSeconds) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
}

function clearedSessionCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

function clientIp(req) {
  const address = req && req.socket && req.socket.remoteAddress;
  return address ? address.replace(/^::ffff:/, '') : null;
}

/** True for a request made on the server PC itself. */
function isLoopback(req) {
  const ip = clientIp(req);
  return ip === '127.0.0.1' || ip === '::1';
}

module.exports = {
  SESSION_COOKIE,
  parseCookies,
  sessionTokenOf,
  bearerTokenOf,
  actorOf,
  sessionCookie,
  clearedSessionCookie,
  clientIp,
  isLoopback
};
