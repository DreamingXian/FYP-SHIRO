// =============================================================================
// SHIRO Hospital Edge Server - Device Fleet HTTP Controller
// Handles REST APIs for Device Management, Discovery Radar & Remote Actions
// =============================================================================

const deviceService = require('../services/device_service');

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data));
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { success: false, error: message });
}

/**
 * GET /api/devices/list?type=ALL&status=ALL
 */
async function listDevices(req, res, parsedUrl) {
  try {
    const type = parsedUrl.searchParams.get('type') || 'ALL';
    const status = parsedUrl.searchParams.get('status') || 'ALL';
    const devices = await deviceService.listDevices(type, status);
    sendJson(res, 200, { success: true, count: devices.length, devices });
  } catch (err) {
    console.error('[DEVICE API ERROR] listDevices:', err);
    sendError(res, 500, err.message || 'Failed to list devices');
  }
}

/**
 * GET /api/devices/unprovisioned
 */
async function getUnprovisioned(req, res) {
  try {
    const unprovisioned = await deviceService.getUnprovisionedDevices();
    sendJson(res, 200, { success: true, count: unprovisioned.length, unprovisioned });
  } catch (err) {
    console.error('[DEVICE API ERROR] getUnprovisioned:', err);
    sendError(res, 500, err.message || 'Failed to get unprovisioned devices');
  }
}

/**
 * GET /api/devices/next-id?type=WRISTBAND
 */
async function getNextId(req, res, parsedUrl) {
  try {
    const type = parsedUrl.searchParams.get('type') || 'WRISTBAND';
    const nextId = await deviceService.getNextDeviceId(type);
    sendJson(res, 200, { success: true, nextId });
  } catch (err) {
    console.error('[DEVICE API ERROR] getNextId:', err);
    sendError(res, 500, err.message || 'Failed to generate next device ID');
  }
}

/**
 * POST /api/devices/enroll
 */
async function enrollDevice(req, res, body) {
  try {
    let payload;
    try {
      payload = typeof body === 'string' ? JSON.parse(body) : body;
    } catch {
      return sendError(res, 400, 'Invalid JSON request payload');
    }

    const result = await deviceService.enrollDevice(payload);
    sendJson(res, 201, result);
  } catch (err) {
    console.error('[DEVICE API ERROR] enrollDevice:', err);
    sendError(res, 400, err.message || 'Failed to enroll device');
  }
}

/**
 * POST /api/devices/update
 */
async function updateDevice(req, res, body, parsedUrl) {
  try {
    let payload;
    try {
      payload = typeof body === 'string' ? JSON.parse(body) : body;
    } catch {
      return sendError(res, 400, 'Invalid JSON request payload');
    }

    const deviceId = payload.device_id || parsedUrl.searchParams.get('id');
    if (!deviceId) {
      return sendError(res, 400, 'Missing required device_id');
    }

    const result = await deviceService.updateDevice(deviceId, payload);
    sendJson(res, 200, result);
  } catch (err) {
    console.error('[DEVICE API ERROR] updateDevice:', err);
    sendError(res, 400, err.message || 'Failed to update device');
  }
}

/**
 * POST or DELETE /api/devices/delete
 */
async function deleteDevice(req, res, body, parsedUrl) {
  try {
    let payload = {};
    if (body && body.trim() !== '') {
      try { payload = JSON.parse(body); } catch (_) {}
    }

    const deviceId = payload.device_id || parsedUrl.searchParams.get('id');
    if (!deviceId) {
      return sendError(res, 400, 'Missing required device_id for deletion');
    }

    const result = await deviceService.deleteDevice(deviceId);
    sendJson(res, 200, result);
  } catch (err) {
    console.error('[DEVICE API ERROR] deleteDevice:', err);
    sendError(res, 400, err.message || 'Failed to delete device');
  }
}

/**
 * POST /api/devices/ping
 */
async function pingDevice(req, res, body) {
  try {
    let payload = {};
    if (body && body.trim() !== '') {
      try { payload = JSON.parse(body); } catch (_) {}
    }

    const deviceId = payload.device_id;
    if (!deviceId) {
      return sendError(res, 400, 'Missing device_id');
    }

    // In a live system, this sends an MQTT CMD_PING_LED to shiro/command/{device_id}
    console.log(`[DEVICE ACTION] Dispatched PING_LED to ${deviceId}`);
    sendJson(res, 200, { success: true, message: `Ping command sent to ${deviceId}. Visual LED triggered!` });
  } catch (err) {
    console.error('[DEVICE API ERROR] pingDevice:', err);
    sendError(res, 500, err.message || 'Failed to ping device');
  }
}

module.exports = {
  listDevices,
  getUnprovisioned,
  getNextId,
  enrollDevice,
  updateDevice,
  deleteDevice,
  pingDevice
};
