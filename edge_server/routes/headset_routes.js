// =============================================================================
// SHIRO Edge Server - Headset pairing
//   POST /api/headset/pair  { device_id, mac_address, code, model }
// The code is made by an admin on the dashboard (valid 5 minutes, once).
// A headset that is not enrolled yet is enrolled here: the admin's code is the
// approval. The answer carries the headset's token, which it keeps.
// =============================================================================
const authService = require('../services/auth/auth_service');
const audit = require('../services/audit_service');
const deviceService = require('../services/device_service');
const { getPool } = require('../database/db');
const { clientIp } = require('../services/auth/request_auth');
const { HttpError, sendJson, sendFailure, parseJsonBody } = require('../utils/http');
const { requireMac, optionalText } = require('../utils/validate');

const HEADSET_ID_PATTERN = /^QUEST3-[A-Z0-9]{3,16}$/;
const CODE_PATTERN = /^\d{6}$/;

async function ensureEnrolled(deviceId, mac, model) {
  const [rows] = await getPool().query(
    'SELECT device_id, mac_address, device_type FROM devices WHERE device_id = ? OR mac_address = ?',
    [deviceId, mac]
  );
  const sameId = rows.find(r => r.device_id === deviceId);
  if (sameId) {
    if (sameId.device_type !== 'HEADSET') throw new HttpError(409, `${deviceId} is enrolled as a ${sameId.device_type}, not a headset.`);
    return false;
  }
  const otherId = rows.find(r => r.mac_address && r.mac_address.toUpperCase() === mac);
  if (otherId) throw new HttpError(409, `This headset's MAC address is already enrolled as ${otherId.device_id}.`);
  await deviceService.enrollDevice({
    device_id: deviceId,
    mac_address: mac,
    device_type: 'HEADSET',
    hardware_model: model || 'Meta Quest 3 (MR)',
    status: 'OFFLINE'
  });
  return true;
}

async function handleHeadsetRoutes(pathname, req, res, parsedUrl, body) {
  if (pathname === '/api/headset/pair' && req.method === 'POST') {
    const ip = clientIp(req);
    let deviceId = null;
    try {
      const data = parseJsonBody(body);
      deviceId = typeof data.device_id === 'string' ? data.device_id.trim().toUpperCase() : '';
      if (!HEADSET_ID_PATTERN.test(deviceId)) throw new HttpError(400, 'device_id must be a headset ID such as QUEST3-1A2B3C.');
      const mac = requireMac(data.mac_address, 'mac_address');
      if (typeof data.code !== 'string' || !CODE_PATTERN.test(data.code.trim())) {
        throw new HttpError(400, 'The pairing code has 6 digits.');
      }
      const model = optionalText(data.model, 'model', 64);

      const { token, pairedBy } = await authService.pairHeadset(deviceId, data.code.trim(), ip || 'unknown');
      let enrolled;
      try {
        enrolled = await ensureEnrolled(deviceId, mac, model);
      } catch (err) {
        // The headset cannot be used: do not leave a working token behind
        await authService.revokePairing(deviceId, 'SYSTEM').catch(() => {});
        throw err;
      }
      const actor = { type: 'HEADSET', id: deviceId, pairedBy };
      await audit.record({ actor, action: 'HEADSET_PAIR', targetType: 'HEADSET', targetId: deviceId, details: { newly_enrolled: enrolled }, ip });
      sendJson(res, 200, { success: true, token, device_id: deviceId, paired_by: pairedBy, newly_enrolled: enrolled });
    } catch (err) {
      if (err instanceof HttpError && (err.status === 401 || err.status === 429)) {
        await audit.record({ action: 'HEADSET_PAIR_FAILED', targetType: 'HEADSET', targetId: deviceId, ip });
      }
      sendFailure(res, err, 'pairHeadset');
    }
    return true;
  }
  return false;
}

module.exports = { handleHeadsetRoutes };
