// =============================================================================
// WebSocket Real-Time Bridge Service
// =============================================================================
const { WebSocketServer } = require('ws');
const { getCalibration, updateCalibration } = require('./kalman_filter');

let wss = null;

function initWebSocketServer(httpServer) {
  wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws) => {
    console.log('[WEBSOCKET] Web Dashboard / HMD connected.');
    ws.send(JSON.stringify({
      type: 'STATUS',
      message: 'Connected to SHIRO Edge Server',
      calibration: getCalibration()
    }));

    ws.on('message', (data) => {
      try {
        const cmd = JSON.parse(data.toString());
        if (cmd.action === 'UPDATE_CALIBRATION') {
          const updated = updateCalibration(cmd.A, cmd.n);
          console.log(`[CALIBRATION UPDATED] A: ${updated.A} dBm | n: ${updated.n}`);
          broadcastToClients({
            type: 'CALIBRATION_SYNC',
            calibration: updated
          });
        }
      } catch (err) {
        console.warn('[WEBSOCKET] Malformed command:', err.message);
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

