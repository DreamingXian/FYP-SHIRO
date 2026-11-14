// =============================================================================
// WebSocket Real-Time Bridge Service
// =============================================================================
const { WebSocketServer } = require('ws');
const { getCalibration, updateCalibration, setAnchorCalibration } = require('./kalman_filter');
const { HttpError, isCrossSiteRequest } = require('../utils/http');
const {
  requireId, optionalId, requireMac, optionalMac, requireDeviceRef, requireLabel,
  optionalOneOf, optionalNumber, optionalInt, optionalText
} = require('../utils/validate');

// Commands are short JSON objects. A larger message is refused by the socket.
const MAX_MESSAGE_BYTES = 16 * 1024;

const RSSI_AT_1M = { min: -120, max: 0 };   // calibration value A, dBm
const PATH_LOSS = { min: 0.5, max: 10 };    // calibration value n
const ACTIVE_MODE_SECONDS = { min: 5, max: 600 };
const ACTIVE_MODE_DEFAULT_SECONDS = 60;     // the length of one activation in the firmware

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

    case 'SET_ACTIVE_MODE':
      return {
        action: cmd.action,
        tagId: requireDeviceRef(cmd.tag_id || data.tagId, 'tag_id'),
        targetMac: optionalMac(cmd.target_mac || data.targetMac, 'target_mac'),
        duration: optionalInt(cmd.duration !== undefined ? cmd.duration : data.duration, 'duration', ACTIVE_MODE_SECONDS, ACTIVE_MODE_DEFAULT_SECONDS)
      };

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
    console.log(`[ANCHOR CALIBRATION UPDATED] ${cmd.anchorId} -> A: ${updated.A} dBm | n: ${updated.n}`);
    broadcastToClients({ type: 'ANCHOR_CALIBRATION_SYNC', anchor_id: cmd.anchorId, calibration: updated });
  } else {
    const updated = updateCalibration(cmd.A ?? undefined, cmd.n ?? undefined);
    console.log(`[CALIBRATION UPDATED] A: ${updated.A} dBm | n: ${updated.n}`);
    broadcastToClients({ type: 'CALIBRATION_SYNC', calibration: updated });
  }
}

async function handleActiveMode(cmd) {
  const { tagId, duration } = cmd;
  let targetMac = cmd.targetMac;

  // The anchors address a wristband by its MAC address. Find it when the
  // command names the wristband by its device ID only.
  if (!targetMac) {
    try {
      const deviceService = require('./device_service');
      const dev = deviceService.findEnrolledDeviceByMac(tagId);
      if (dev && dev.mac_address) targetMac = dev.mac_address;
      else {
        const ipsService = require('./ips_service');
        const liveTag = ipsService.getTagPosition(tagId);
        if (liveTag && liveTag.tag_mac) targetMac = liveTag.tag_mac;
        else {
          const { getPool } = require('../database/db');
          const [rows] = await getPool().query('SELECT mac_address FROM devices WHERE device_id = ? LIMIT 1', [tagId]);
          if (rows.length > 0 && rows[0].mac_address) targetMac = rows[0].mac_address;
        }
      }
    } catch (err) {
      console.warn(`[ACTIVE MODE] Could not look up the MAC address of ${tagId}:`, err.message);
    }
  }

  console.log(`[ACTIVE MODE TRIGGER] Clinician engaged 1 Hz Active Monitoring for ${tagId} (MAC: ${targetMac || 'unknown'}, ${duration}s)`);

  broadcastToClients({
    type: 'ACTIVE_MODE_ENGAGED',
    tag_id: tagId,
    target_mac: targetMac,
    duration,
    timestamp: new Date().toLocaleTimeString()
  });

  if (targetMac) {
    try {
      const { publishMqtt } = require('./mqtt_service');
      publishMqtt('shiro/control/mode', { cmd: 'SET_ACTIVE', target_tag: tagId, target_mac: targetMac, duration });
    } catch (e) {
      console.warn('[MQTT ACTIVE TRIGGER ERROR]', e.message);
    }
  }
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
      console.log(`[RADAR] Unprovisioned Headset ${cmd.deviceId} [${cmd.mac}] broadcasting in Live Discovery Radar`);
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
    console.warn('[DEVICE HANDSHAKE ERROR]', dErr.message);
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

function initWebSocketServer(httpServer) {
  wss = new WebSocketServer({
    server: httpServer,
    maxPayload: MAX_MESSAGE_BYTES,
    // A page of another website must not be able to open a socket to this server
    verifyClient: (info) => !isCrossSiteRequest(info.req)
  });

  wss.on('connection', (ws, req) => {
    console.log('[WEBSOCKET] Web Dashboard / HMD connected.');
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

        if (cmd.action === 'UPDATE_CALIBRATION') handleCalibration(cmd);
        else if (cmd.action === 'SET_ACTIVE_MODE') await handleActiveMode(cmd);
        else await handleDevicePresence(cmd, ws, req);
      } catch (err) {
        if (err instanceof HttpError) {
          console.warn(`[WEBSOCKET] Command refused (${typeof action === 'string' ? action.slice(0, 40) : 'no action'}): ${err.message}`);
          sendCommandError(ws, action, err.message);
        } else {
          console.error('[WEBSOCKET] Command failed:', err);
          sendCommandError(ws, action, 'The command could not be carried out.');
        }
      }
    });

    ws.on('close', async () => {
      if (ws.associatedDeviceId) {
        try {
          const deviceService = require('./device_service');
          await deviceService.handleDeviceDisconnect(ws.associatedDeviceId);
          console.log(`[WEBSOCKET] Headset disconnected: ${ws.associatedDeviceId} set to OFFLINE`);
        } catch (err) {
          console.warn('[WEBSOCKET] Could not mark the headset offline:', err.message);
        }
      }
    });

    ws.on('error', (err) => {
      console.warn('[WEBSOCKET ERROR]', err.message);
    });
  });

  return wss;
}

function broadcastToClients(data) {
  if (!wss) return;
  const payload = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(payload);
    }
  });
}

function getConnectedClientsCount() {
  if (!wss) return 0;
  let count = 0;
  wss.clients.forEach(c => { if (c.readyState === 1) count++; });
  return count;
}

module.exports = {
  initWebSocketServer,
  broadcastToClients,
  getConnectedClientsCount,
  validateCommand,
  MAX_MESSAGE_BYTES
};
