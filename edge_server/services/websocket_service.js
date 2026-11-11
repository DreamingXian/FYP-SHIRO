// =============================================================================
// WebSocket Real-Time Bridge Service
// =============================================================================
const { WebSocketServer } = require('ws');
const { getCalibration, updateCalibration } = require('./kalman_filter');

let wss = null;

function initWebSocketServer(httpServer) {
  wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws, req) => {
    console.log('[WEBSOCKET] Web Dashboard / HMD connected.');
    ws.send(JSON.stringify({
      type: 'STATUS',
      message: 'Connected to SHIRO Edge Server',
      calibration: getCalibration()
    }));

    ws.on('message', async (data) => {
      try {
        const cmd = JSON.parse(data.toString());
        if (cmd.action === 'UPDATE_CALIBRATION') {
          if (cmd.anchor_id) {
            const { setAnchorCalibration } = require('./kalman_filter');
            const updated = setAnchorCalibration(cmd.anchor_id, cmd.A, cmd.n);
            console.log(`[ANCHOR CALIBRATION UPDATED] ${cmd.anchor_id} -> A: ${updated.A} dBm | n: ${updated.n}`);
            broadcastToClients({
              type: 'ANCHOR_CALIBRATION_SYNC',
              anchor_id: cmd.anchor_id,
              calibration: updated
            });
          } else {
            const updated = updateCalibration(cmd.A, cmd.n);
            console.log(`[CALIBRATION UPDATED] A: ${updated.A} dBm | n: ${updated.n}`);
            broadcastToClients({
              type: 'CALIBRATION_SYNC',
              calibration: updated
            });
          }
        } else if (cmd.action === 'SET_ACTIVE_MODE') {
          const tagId = cmd.tag_id || (cmd.data && cmd.data.tagId) || 'TAG-001';
          const duration = cmd.duration || (cmd.data && cmd.data.duration) || 60;
          let targetMac = cmd.target_mac || (cmd.data && cmd.data.targetMac) || null;

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
            } catch (_) {}
          }

          console.log(`[ACTIVE MODE TRIGGER] Clinician engaged 1 Hz Active Monitoring for ${tagId} (MAC: ${targetMac || 'broadcast'}, ${duration}s)`);

          broadcastToClients({
            type: 'ACTIVE_MODE_ENGAGED',
            tag_id: tagId,
            target_mac: targetMac,
            duration: duration,
            timestamp: new Date().toLocaleTimeString()
          });

          if (targetMac) {
            try {
              const { publishMqtt } = require('./mqtt_service');
              publishMqtt('shiro/control/mode', {
                cmd: 'SET_ACTIVE',
                target_tag: tagId,
                target_mac: targetMac,
                duration: duration
              });
            } catch (e) {
              console.warn('[MQTT ACTIVE TRIGGER ERROR]', e.message);
            }
          }
        } else if (cmd.action === 'DEVICE_HANDSHAKE' || cmd.action === 'DEVICE_HEARTBEAT') {
          const deviceService = require('./device_service');
          const devId = cmd.device_id || 'QUEST3-001';
          const devMac = (cmd.mac_address || '02:00:00:51:55:01').toUpperCase().trim();
          const devType = cmd.device_type || 'HEADSET';
          const battery = cmd.battery_level !== undefined ? cmd.battery_level : 95;
          const assignedWard = cmd.assigned_ward_id || 'WARD-005';
          const clientIp = (req && req.socket && req.socket.remoteAddress) ? req.socket.remoteAddress.replace(/^.*:/, '') : '127.0.0.1';

          try {
            const { getPool } = require('../database/db');
            const pool = getPool();
            const [rows] = await pool.query('SELECT device_id FROM devices WHERE mac_address = ? OR device_id = ? LIMIT 1', [devMac, devId]);

            if (rows.length === 0) {
              // Not yet enrolled in MySQL: place in Live Discovery Radar with suggested ID & metadata
              deviceService.recordDiscoveredDevice({
                mac: devMac,
                hardware_model: cmd.model || 'Meta Quest 3 (MR)',
                device_type: 'HEADSET',
                suggested_id: devId,
                battery_level: battery,
                ip_address: clientIp,
                rssi: -42
              });
              console.log(`[RADAR] Unprovisioned Headset ${devId} [${devMac}] broadcasting in Live Discovery Radar`);
            } else {
              // Already enrolled in MySQL: keep live session active & online
              const enrolledId = rows[0].device_id;
              ws.associatedDeviceId = enrolledId;
              await deviceService.recordActiveDeviceTraffic(enrolledId, devType, {
                status: 'ONLINE',
                battery_level: battery,
                ip: clientIp
              });
            }
          } catch (dErr) {
            console.warn('[DEVICE HANDSHAKE ERROR]', dErr.message);
          }
        }
      } catch (err) {
        console.warn('[WEBSOCKET] Malformed command:', err.message);
      }
    });

    ws.on('close', async () => {
      if (ws.associatedDeviceId) {
        try {
          const deviceService = require('./device_service');
          await deviceService.handleDeviceDisconnect(ws.associatedDeviceId);
          console.log(`[WEBSOCKET] Headset disconnected: ${ws.associatedDeviceId} set to OFFLINE`);
        } catch (_) {}
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
  getConnectedClientsCount
};

