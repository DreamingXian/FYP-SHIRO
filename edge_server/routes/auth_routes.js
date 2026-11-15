// =============================================================================
// SHIRO Edge Server - Sign-in routes
//   GET  /api/auth/status   is anyone signed in; is the first account still to be created
//   POST /api/auth/setup    first admin account (server PC only, before any account exists)
//   POST /api/auth/login    username + password -> session cookie
//   POST /api/auth/logout   ends the session
//   GET  /api/auth/me       the signed-in clinician
// =============================================================================
const authService = require('../services/auth/auth_service');
const audit = require('../services/audit_service');
const { actorOf, sessionTokenOf, sessionCookie, clearedSessionCookie, clientIp, isLoopback } = require('../services/auth/request_auth');
const { HttpError, sendJson, sendFailure, parseJsonBody } = require('../utils/http');

const SESSION_MAX_AGE_S = Math.floor(authService.SESSION_TTL_MS / 1000);

function publicActor(actor) {
  if (!actor) return null;
  if (actor.type === 'CLINICIAN') {
    return { type: actor.type, clinician_id: actor.id, username: actor.username, full_name: actor.name, role: actor.role };
  }
  return { type: actor.type, device_id: actor.id, paired_by: actor.pairedBy };
}

async function startSession(res, username, password, ip) {
  const { token, actor } = await authService.login(username, password, ip);
  res.setHeader('Set-Cookie', sessionCookie(token, SESSION_MAX_AGE_S));
  await audit.record({ actor, action: 'LOGIN', targetType: 'CLINICIAN', targetId: actor.id, ip });
  return actor;
}

async function handleAuthRoutes(pathname, req, res, parsedUrl, body) {
  const ip = clientIp(req);

  if (pathname === '/api/auth/status' && req.method === 'GET') {
    try {
      const setupNeeded = !(await authService.hasAnyClinician());
      sendJson(res, 200, {
        success: true,
        setup_needed: setupNeeded,
        setup_allowed_here: setupNeeded && isLoopback(req),
        user: publicActor(await actorOf(req))
      });
    } catch (err) {
      sendFailure(res, err, 'authStatus');
    }
    return true;
  }

  if (pathname === '/api/auth/setup' && req.method === 'POST') {
    try {
      if (!isLoopback(req)) {
        throw new HttpError(403, 'The first admin account can only be created on the server PC itself (http://localhost:3000).');
      }
      const data = parseJsonBody(body);
      const admin = await authService.createFirstAdmin({ username: data.username, fullName: data.full_name, password: data.password });
      const actor = await startSession(res, admin.username, data.password, ip);
      await audit.record({ actor, action: 'SETUP_FIRST_ADMIN', targetType: 'CLINICIAN', targetId: admin.clinician_id, ip });
      sendJson(res, 201, { success: true, user: publicActor(actor) });
    } catch (err) {
      sendFailure(res, err, 'authSetup');
    }
    return true;
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    try {
      const data = parseJsonBody(body);
      if (typeof data.username !== 'string' || typeof data.password !== 'string') {
        throw new HttpError(400, 'username and password are required.');
      }
      const actor = await startSession(res, data.username, data.password, ip);
      sendJson(res, 200, { success: true, user: publicActor(actor) });
    } catch (err) {
      if (err instanceof HttpError && (err.status === 401 || err.status === 429)) {
        await audit.record({
          action: err.status === 429 ? 'LOGIN_LOCKED' : 'LOGIN_FAILED',
          targetType: 'CLINICIAN',
          targetId: err.attemptedUsername || null,
          ip
        });
      }
      sendFailure(res, err, 'authLogin');
    }
    return true;
  }

  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    try {
      const actor = await actorOf(req);
      await authService.logout(sessionTokenOf(req));
      res.setHeader('Set-Cookie', clearedSessionCookie());
      if (actor) await audit.record({ actor, action: 'LOGOUT', targetType: 'CLINICIAN', targetId: actor.id, ip });
      sendJson(res, 200, { success: true });
    } catch (err) {
      sendFailure(res, err, 'authLogout');
    }
    return true;
  }

  if (pathname === '/api/auth/me' && req.method === 'GET') {
    sendJson(res, 200, { success: true, user: publicActor(await actorOf(req)) });
    return true;
  }

  return false;
}

module.exports = { handleAuthRoutes, publicActor };
