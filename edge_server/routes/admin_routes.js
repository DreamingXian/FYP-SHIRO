// =============================================================================
// SHIRO Edge Server - Admin routes (accounts, headset pairing, audit log)
// Every address here needs a signed-in admin (services/auth/permissions.js).
// =============================================================================
const authService = require('../services/auth/auth_service');
const audit = require('../services/audit_service');
const { actorOf, clientIp } = require('../services/auth/request_auth');
const { HttpError, sendJson, sendFailure, parseJsonBody } = require('../utils/http');
const { requireId, optionalInt } = require('../utils/validate');

const AUDIT_ACTION_PATTERN = /^[A-Z_]{2,48}$/;

async function handleAdminRoutes(pathname, req, res, parsedUrl, body) {
  const ip = clientIp(req);

  // Accounts
  if (pathname === '/api/admin/clinicians' && req.method === 'GET') {
    try {
      sendJson(res, 200, { success: true, clinicians: await authService.listClinicians() });
    } catch (err) {
      sendFailure(res, err, 'listClinicians');
    }
    return true;
  }

  if (pathname === '/api/admin/clinicians/create' && req.method === 'POST') {
    try {
      const actor = await actorOf(req);
      const data = parseJsonBody(body);
      const created = await authService.createClinician(
        { username: data.username, fullName: data.full_name, role: data.role, password: data.password },
        actor.id
      );
      await audit.record({ actor, action: 'CLINICIAN_CREATE', targetType: 'CLINICIAN', targetId: created.clinician_id, details: { username: created.username, role: created.role }, ip });
      sendJson(res, 201, { success: true, clinician: created });
    } catch (err) {
      sendFailure(res, err, 'createClinician');
    }
    return true;
  }

  if (pathname === '/api/admin/clinicians/set-active' && req.method === 'POST') {
    try {
      const actor = await actorOf(req);
      const data = parseJsonBody(body);
      if (typeof data.active !== 'boolean') throw new HttpError(400, 'active must be true or false.');
      const updated = await authService.setClinicianActive(data.clinician_id, data.active, actor);
      const ws = require('../services/websocket_service');
      if (!data.active) ws.closeClinicianConnections(updated.clinician_id);
      // Headsets assigned to this clinician act for nobody while the account is deactivated
      const user = data.active ? { id: updated.clinician_id, name: updated.full_name } : null;
      for (const deviceId of await authService.headsetsAssignedTo(updated.clinician_id)) ws.updateHeadsetUser(deviceId, user);
      await audit.record({ actor, action: data.active ? 'CLINICIAN_ACTIVATE' : 'CLINICIAN_DEACTIVATE', targetType: 'CLINICIAN', targetId: updated.clinician_id, ip });
      sendJson(res, 200, { success: true, clinician: updated });
    } catch (err) {
      sendFailure(res, err, 'setClinicianActive');
    }
    return true;
  }

  if (pathname === '/api/admin/clinicians/reset-password' && req.method === 'POST') {
    try {
      const actor = await actorOf(req);
      const data = parseJsonBody(body);
      await authService.resetPassword(data.clinician_id, data.password);
      require('../services/websocket_service').closeClinicianConnections(data.clinician_id);
      await audit.record({ actor, action: 'PASSWORD_RESET', targetType: 'CLINICIAN', targetId: data.clinician_id, ip });
      sendJson(res, 200, { success: true, message: 'Password changed. The account has been signed out everywhere.' });
    } catch (err) {
      sendFailure(res, err, 'resetPassword');
    }
    return true;
  }

  // Headset pairing
  if (pathname === '/api/admin/headsets' && req.method === 'GET') {
    try {
      sendJson(res, 200, { success: true, pairings: await authService.listPairings() });
    } catch (err) {
      sendFailure(res, err, 'listPairings');
    }
    return true;
  }

  if (pathname === '/api/admin/headsets/pairing-code' && req.method === 'POST') {
    try {
      const actor = await actorOf(req);
      const created = authService.createPairingCode(actor.id);
      await audit.record({ actor, action: 'HEADSET_PAIRING_CODE', targetType: 'HEADSET', ip });
      sendJson(res, 201, { success: true, code: created.code, expires_at: created.expiresAt, valid_seconds: created.validSeconds });
    } catch (err) {
      sendFailure(res, err, 'createPairingCode');
    }
    return true;
  }

  // Assign a paired headset to the clinician who uses it (clinician_id null = nobody)
  if (pathname === '/api/admin/headsets/assign' && req.method === 'POST') {
    try {
      const actor = await actorOf(req);
      const data = parseJsonBody(body);
      const deviceId = requireId(data.device_id, 'device_id');
      const clinicianId = data.clinician_id === null ? null : requireId(data.clinician_id, 'clinician_id');
      const user = await authService.assignHeadset(deviceId, clinicianId, actor);
      require('../services/websocket_service').updateHeadsetUser(deviceId, user);
      await audit.record({
        actor, action: user ? 'HEADSET_ASSIGN' : 'HEADSET_UNASSIGN', targetType: 'HEADSET', targetId: deviceId,
        details: user ? `assigned to ${user.id}` : 'assigned to nobody', ip
      });
      sendJson(res, 200, { success: true, device_id: deviceId, assigned_user: user });
    } catch (err) {
      sendFailure(res, err, 'assignHeadset');
    }
    return true;
  }

  if (pathname === '/api/admin/headsets/revoke' && req.method === 'POST') {
    try {
      const actor = await actorOf(req);
      const data = parseJsonBody(body);
      const deviceId = requireId(data.device_id, 'device_id');
      await authService.revokePairing(deviceId, actor.id);
      const { closeHeadsetConnections } = require('../services/websocket_service');
      closeHeadsetConnections(deviceId);
      await audit.record({ actor, action: 'HEADSET_REVOKE', targetType: 'HEADSET', targetId: deviceId, ip });
      sendJson(res, 200, { success: true });
    } catch (err) {
      sendFailure(res, err, 'revokePairing');
    }
    return true;
  }

  // Audit log
  if (pathname === '/api/admin/audit' && req.method === 'GET') {
    try {
      const q = parsedUrl.searchParams;
      const limit = optionalInt(q.get('limit'), 'limit', { min: 1, max: 1000 }, 200);
      const actorId = q.get('actor_id') ? requireId(q.get('actor_id'), 'actor_id') : null;
      const targetId = q.get('target_id') ? requireId(q.get('target_id'), 'target_id') : null;
      const action = q.get('action') || null;
      if (action !== null && !AUDIT_ACTION_PATTERN.test(action)) throw new HttpError(400, 'action is not a valid action name.');
      sendJson(res, 200, { success: true, entries: await audit.list({ limit, actorId, action, targetId }) });
    } catch (err) {
      sendFailure(res, err, 'listAudit');
    }
    return true;
  }

  return false;
}

module.exports = { handleAdminRoutes };
