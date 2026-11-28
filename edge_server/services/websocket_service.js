// =============================================================================
// WebSocket Real-Time Bridge Service
// =============================================================================
const logger = require('../utils/logger');
const { WebSocketServer } = require('ws');
const { getCalibration, updateCalibration, setAnchorCalibration } = require('./kalman_filter');
const { HttpError, isCrossSiteRequest } = require('../utils/http');
const { actorOf, clientIp } = require('./auth/request_auth');
const { actorLabel } = require('./auth/auth_service');
const { decideCommand } = require('./auth/permissions');
const audit = require('./audit_service');
const {
  requireId, optionalId, requireMac, optionalMac, requireDeviceRef, requireLabel,
  optionalOneOf, requireNumber, optionalNumber, optionalInt, optionalText, normalizeMac
} = require('../utils/validate');

// Commands are short JSON objects. A larger message is refused by the socket.
const MAX_MESSAGE_BYTES = 16 * 1024;

const RSSI_AT_1M = { min: -120, max: 0 };   // calibration value A, dBm
const PATH_LOSS = { min: 0.5, max: 10 };    // calibration value n
const ACTIVE_MODE_SECONDS = { min: 5, max: 600 };   // a requested length is checked, but ...
const ACTIVE_MODE_FIRMWARE_SECONDS = 120;           // ... the wristband streams for its own fixed time (firmware V5.3)
const WARD_COORDINATE = { min: -100, max: 100 }; // m from the ward's corner
const PERSON_HEIGHT = { min: 0.5, max: 2.5 };    // m, measured by the headset

let wss = null;

/**
 * Checks one command received over the WebSocket and returns it with checked,
 * normalised fields. Throws HttpError for anything that is not a valid command.
 */
function validateCommand(cmd) {
  if (cmd === null || typeof cmd !== 'object' || Array.isArray(cmd)) {
    throw new HttpError(400, 'A command must be a JSON object.');
  }
  const data = cmd.data !== null && typeof cmd.data === 'object' && !Array.isArray(cmd.data) ? cmd.data : {};

  switch (cmd.action) {
    case 'UPDATE_CALIBRATION': {
      const anchorId = cmd.anchor_id === undefined || cmd.anchor_id === null || cmd.anchor_id === ''
        ? null
        : requireLabel(cmd.anchor_id, 'anchor_id');
      const A = optionalNumber(cmd.A, 'A', RSSI_AT_1M);
      const n = optionalNumber(cmd.n, 'n', PATH_LOSS);
      if (A === null && n === null) throw new HttpError(400, 'UPDATE_CALIBRATION needs A or n.');
      return { action: cmd.action, anchorId, A, n };
    }

    case 'SET_ACTIVE_MODE': {
      const tagId = requireDeviceRef(cmd.tag_id || data.tagId, 'tag_id');
      const targetMac = optionalMac(cmd.target_mac || data.targetMac, 'target_mac');
      optionalInt(cmd.duration !== undefined ? cmd.duration : data.duration, 'duration', ACTIVE_MODE_SECONDS, null);
      // The anchor only tells the wristband to start; it streams for its own fixed time,
      // so that is the length sent and reported back
      return { action: cmd.action, tagId, targetMac, duration: ACTIVE_MODE_FIRMWARE_SECONDS };
    }

    // A headset sees the patient of a wristband (linked to a person its depth sensor
    // sees) at x, y in ward coordinates; seen: false when it no longer does
    case 'PATIENT_SEEN': {
      const seen = cmd.seen !== false;
      return {
        action: cmd.action,
        tagId: requireDeviceRef(cmd.tag_id, 'tag_id'),
        wardId: requireId(cmd.ward_id, 'ward_id'),
        seen,
        x: seen ? requireNumber(cmd.x, 'x', WARD_COORDINATE) : null,
        y: seen ? requireNumber(cmd.y, 'y', WARD_COORDINATE) : null,
        heightM: seen ? optionalNumber(cmd.height_m, 'height_m', PERSON_HEIGHT) : null,
        manual: cmd.manual === true
      };
    }

    case 'DEVICE_HANDSHAKE':
    case 'DEVICE_HEARTBEAT':
      return {
        action: cmd.action,
        deviceId: requireId(cmd.device_id, 'device_id'),
        mac: requireMac(cmd.mac_address, 'mac_address'),
        deviceType: optionalOneOf(cmd.device_type, ['HEADSET'], 'device_type', 'HEADSET'),
        battery: optionalInt(cmd.battery_level, 'battery_level', { min: 0, max: 100 }),
        model: optionalText(cmd.model, 'model', 64),
        assignedWardId: optionalId(cmd.assigned_ward_id, 'assigned_ward_id')
      };

    default:
      throw new HttpError(400, 'Unknown command.');
  }
}

function handleCalibration(cmd) {
  if (cmd.anchorId) {
    const updated = setAnchorCalibration(cmd.anchorId, cmd.A ?? undefined, cmd.n ?? undefined);
    logger.info(`[ANCHOR CALIBRATION UPDATED] ${cmd.anchorId} -> A: ${updated.A} dBm | n: ${updated.n}`);
    broadcastToClients({ type: 'ANCHOR_CALIBRATION_SYNC', anchor_id: cmd.anchorId, calibration: updated });
  } else {
    const updated = updateCalibration(cmd.A ?? undefined, cmd.n ?? undefined);
    logger.info(`[CALIBRATION UPDATED] A: ${updated.A} dBm | n: ${updated.n}`);
    broadcastToClients({ type: 'CALIBRATION_SYNC', calibration: updated });
  }
}

async function findWristbandMac(tagId) {
  const deviceService = require('./device_service');
  const dev = deviceService.findEnrolledDeviceByMac(tagId);
  if (dev && dev.mac_address) return normalizeMac(dev.mac_address);

  const ipsService = require('./ips_service');
  const liveTag = ipsService.getTagPosition(tagId);
  if (liveTag && liveTag.tag_mac) return normalizeMac(liveTag.tag_mac);

  const { getPool } = require('../database/db');
  const [rows] = await getPool().query('SELECT mac_address FROM devices WHERE device_id = ? LIMIT 1', [tagId]);
  return rows.length > 0 && rows[0].mac_address ? normalizeMac(rows[0].mac_address) : null;
}

/**
 * 1 Hz activation. The command goes out through ONE anchor: the one that hears
 * the wristband most strongly now. Two anchors connecting to the same wristband
 * at once would make both connections fail.
 */
async function handleActiveMode(cmd) {
  const { tagId, duration } = cmd;

  // The anchors address a wristband by its MAC address. Find it when the
  // command names the wristband by its device ID only.
  const targetMac = cmd.targetMac || await findWristbandMac(tagId);
  if (!targetMac) {
    throw new HttpError(404, `The MAC address of wristband ${tagId} is not known, so no anchor can reach it.`);
  }

  const tagHearing = require('./telemetry/tag_hearing');
  const best = tagHearing.strongestAnchor(targetMac);
  if (!best) {
    throw new HttpError(409, `No anchor has heard wristband ${tagId} in the last ${tagHearing.HEARD_WITHIN_MS / 1000} s. Check that it is switched on and near an anchor, then try again.`);
  }

  const { publishMqtt } = require('./mqtt_service');
  const sent = publishMqtt('shiro/control/mode', {
    cmd: 'SET_ACTIVE',
    target_tag: tagId,
    target_mac: targetMac,
    target_anchor: best.anchorMac,
    duration
  });
  if (!sent) throw new HttpError(503, 'The MQTT broker is not running, so the command could not be sent.');

  const deviceService = require('./device_service');
  const enrolledAnchor = deviceService.findEnrolledDeviceByMac(best.anchorMac);
  const viaAnchor = enrolledAnchor ? enrolledAnchor.device_id : best.anchorMac;
  logger.info(`[ACTIVE MODE TRIGGER] 1 Hz monitoring for ${tagId} (${targetMac}, ${duration}s) sent through anchor ${viaAnchor} (${best.rssi} dBm, heard by ${best.heardBy} anchor(s))`);

  broadcastToClients({
    type: 'ACTIVE_MODE_ENGAGED',
    tag_id: tagId,
    target_mac: targetMac,
    via_anchor: viaAnchor,
    anchor_mac: best.anchorMac,
    duration,
    timestamp: new Date().toLocaleTimeString()
  });
}

async function handleDevicePresence(cmd, ws, req) {
  const deviceService = require('./device_service');
  const clientIp = (req && req.socket && req.socket.remoteAddress) ? req.socket.remoteAddress.replace(/^.*:/, '') : null;

  try {
    const { getPool } = require('../database/db');
    const [rows] = await getPool().query('SELECT device_id FROM devices WHERE mac_address = ? OR device_id = ? LIMIT 1', [cmd.mac, cmd.deviceId]);

    if (rows.length === 0) {
      // Not enrolled yet: shown in the discovery list with the ID it suggests.
      // A headset is connected over Wi-Fi, so it has no BLE signal strength.
      deviceService.recordDiscoveredDevice({
        mac: cmd.mac,
        hardware_model: cmd.model || 'Meta Quest 3 (MR)',
        device_type: 'HEADSET',
        suggested_id: cmd.deviceId,
        battery_level: cmd.battery,
        ip_address: clientIp,
        rssi: null
      });
      logger.info(`[RADAR] Unprovisioned Headset ${cmd.deviceId} [${cmd.mac}] broadcasting in Live Discovery Radar`);
    } else {
      // Enrolled: keep its session online
      const enrolledId = rows[0].device_id;
      ws.associatedDeviceId = enrolledId;
      await deviceService.recordActiveDeviceTraffic(enrolledId, cmd.deviceType, {
        status: 'ONLINE',
        battery_level: cmd.battery === null ? undefined : cmd.battery,
        ip: clientIp
      });
    }
  } catch (dErr) {
    logger.warn('[DEVICE HANDSHAKE ERROR]', dErr.message);
  }
}

function sendCommandError(ws, action, message) {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify({
    type: 'ERROR',
    action: typeof action === 'string' ? action.slice(0, 40) : null,
    error: message
  }));
}

/**
 * A socket is accepted only from this server's own pages or a non-browser client,
 * and only with a signed-in session (dashboard) or a paired headset's token.
 */
// KEY LOGIC: checked BEFORE a WebSocket is accepted: the request must come from this
// server's own pages (no cross-site page can open it) and carry a valid session cookie
// (dashboard) or headset token. Commands that arrive later are checked again per role
// (decideCommand): a headset may report what it sees, but not change calibration.
function verifyClient(info, done) {
  if (isCrossSiteRequest(info.req)) {
    done(false, 403, 'Forbidden');
    return;
  }
  actorOf(info.req)
    .then((actor) => {
      if (actor) done(true);
      else done(false, 401, 'Sign in or pair this headset first');
    })
    .catch((err) => {
      logger.warn('[WEBSOCKET] Could not check who is connecting:', err.message);
      done(false, 503, 'Service unavailable');
    });
}

function initWebSocketServer(httpServer) {
  wss = new WebSocketServer({
    server: httpServer,
    maxPayload: MAX_MESSAGE_BYTES,
    verifyClient
  });

  wss.on('connection', (ws, req) => {
    ws.actor = req.actor || null;
    logger.info(`[WEBSOCKET] Connected: ${ws.actor ? actorLabel(ws.actor) : 'unknown'}.`);
    ws.send(JSON.stringify({
      type: 'STATUS',
      message: 'Connected to SHIRO Edge Server',
      calibration: getCalibration()
    }));

    ws.on('message', async (data) => {
      let action = null;
      try {
        let parsed;
        try {
          parsed = JSON.parse(data.toString());
        } catch {
          throw new HttpError(400, 'A command must be valid JSON.');
        }
        action = parsed && parsed.action;
        const cmd = validateCommand(parsed);

        if (decideCommand(cmd.action, ws.actor) !== 'ok') {
          throw new HttpError(403, ws.actor && ws.actor.type === 'HEADSET'
            ? 'A headset cannot send this command.'
            : 'Your account does not have permission for this command.');
        }
        const ip = clientIp(req);

        if (cmd.action === 'UPDATE_CALIBRATION') {
          handleCalibration(cmd);
          await audit.record({ actor: ws.actor, action: 'CALIBRATION_UPDATE', targetType: 'DEVICE', targetId: cmd.anchorId, details: { A: cmd.A, n: cmd.n }, ip });
        } else if (cmd.action === 'SET_ACTIVE_MODE') {
          await handleActiveMode(cmd);
          await audit.record({ actor: ws.actor, action: 'ACTIVE_MODE', targetType: 'DEVICE', targetId: cmd.tagId, details: { duration: cmd.duration }, ip });
        } else if (cmd.action === 'PATIENT_SEEN') {
          // Five times a second per patient: not audited one by one (start and end are logged)
          const ipsService = require('./ips_service');
          if (cmd.seen) ipsService.applyHeadsetPosition(cmd.tagId, cmd, ws.actor.id);
          else ipsService.endHeadsetPosition(cmd.tagId, ws.actor.id);
        } else {
          // A headset reports only itself
          if (cmd.deviceId !== ws.actor.id) {
            throw new HttpError(403, `This headset is paired as ${ws.actor.id}, not ${cmd.deviceId}.`);
          }
          await handleDevicePresence(cmd, ws, req);
        }
      } catch (err) {
        if (err instanceof HttpError) {
          logger.warn(`[WEBSOCKET] Command refused (${typeof action === 'string' ? action.slice(0, 40) : 'no action'}): ${err.message}`);
          sendCommandError(ws, action, err.message);
        } else {
          logger.error('[WEBSOCKET] Command failed:', err);
          sendCommandError(ws, action, 'The command could not be carried out.');
        }
      }
    });

    ws.on('close', async () => {
      if (ws.actor && ws.actor.type === 'HEADSET') {
        // The patients it saw go back to their Bluetooth position
        try { require('./ips_service').headsetDisconnected(ws.actor.id); } catch (err) { logger.warn('[WEBSOCKET] Could not end the headset\'s positions:', err.message); }
      }
      if (ws.associatedDeviceId) {
        try {
          const deviceService = require('./device_service');
          await deviceService.handleDeviceDisconnect(ws.associatedDeviceId);
          logger.info(`[WEBSOCKET] Headset disconnected: ${ws.associatedDeviceId} set to OFFLINE`);
        } catch (err) {
          logger.warn('[WEBSOCKET] Could not mark the headset offline:', err.message);
        }
      }
    });

    ws.on('error', (err) => {
      logger.warn('[WEBSOCKET ERROR]', err.message);
    });
  });

  return wss;
}

// KEY LOGIC: push, not polling. Every position, telemetry and alert is sent to all open
// sockets the moment it happens; each client keeps only what it shows (for example the
// headset keeps positions of its own ward).
function broadcastToClients(data) {
  if (!wss) return;
  const payload = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(payload);
    }
  });
}

/**
 * Ends the open sockets of one clinician or one headset, after a sign-out,
 * deactivation, password reset or revoked pairing.
 */
function closeConnectionsOf(type, id) {
  if (!wss) return 0;
  let closed = 0;
  wss.clients.forEach((client) => {
    if (client.actor && client.actor.type === type && client.actor.id === id) {
      client.close(4001, 'Access ended');
      closed++;
    }
  });
  return closed;
}

/**
 * A headset was assigned to another clinician (or to nobody): its open sockets
 * act for the new clinician from now on, and the headset is told who it is.
 */
function updateHeadsetUser(deviceId, user) {
  if (!wss) return 0;
  let updated = 0;
  const payload = JSON.stringify({ type: 'HEADSET_ASSIGNMENT', device_id: deviceId, assigned_clinician: user || null });
  wss.clients.forEach((client) => {
    if (client.actor && client.actor.type === 'HEADSET' && client.actor.id === deviceId) {
      client.actor = { ...client.actor, user: user || null };
      if (client.readyState === 1) client.send(payload);
      updated++;
    }
  });
  return updated;
}

const closeHeadsetConnections = (deviceId) => closeConnectionsOf('HEADSET', deviceId);
const closeClinicianConnections = (clinicianId) => closeConnectionsOf('CLINICIAN', clinicianId);

function getConnectedClientsCount() {
  if (!wss) return 0;
  let count = 0;
  wss.clients.forEach(c => { if (c.readyState === 1) count++; });
  return count;
}

/** Shutdown: tells every dashboard and headset that the server is going away. */
function closeWebSocketServer() {
  if (!wss) return Promise.resolve();
  const server = wss;
  wss = null;
  for (const client of server.clients) {
    try {
      client.close(1001, 'Server shutting down');
    } catch (err) {
      logger.debug('[WEBSOCKET] Close failed, connection ended instead:', err.message);
      client.terminate();
    }
  }
  return new Promise((resolve) => server.close(() => resolve()));
}

module.exports = {
  initWebSocketServer,
  closeWebSocketServer,
  broadcastToClients,
  getConnectedClientsCount,
  closeHeadsetConnections,
  closeClinicianConnections,
  updateHeadsetUser,
  validateCommand,
  MAX_MESSAGE_BYTES
};
