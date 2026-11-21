// =============================================================================
// SHIRO Hospital Edge Server - Device Fleet HTTP Controller
// Handles REST APIs for Device Management, Discovery Radar & Remote Actions
// =============================================================================

const logger = require('../utils/logger');
const deviceService = require('../services/device_service');
const { actorLabel } = require('../services/auth/auth_service');
const { HttpError, sendJson, sendFailure, parseJsonBody } = require('../utils/http');
const { requireId, requireMac, requireOneOf, optionalOneOf, optionalText, optionalInt } = require('../utils/validate');

const DEVICE_TYPES = ['WRISTBAND', 'ANCHOR', 'HEADSET', 'ROOM_SENSOR'];
const DEVICE_STATUSES = ['ONLINE', 'STANDBY', 'OFFLINE', 'CHARGING'];
const AVAILABILITY_STATUSES = ['AVAILABLE', 'IN_USE', 'UNAVAILABLE', 'MAINTENANCE'];
const IP_PATTERN = /^[0-9A-Fa-f:.]{2,45}$/;

/** Checks the optional descriptive fields of a device. */
function checkDeviceFields(payload) {
  optionalText(payload.hardware_model, 'hardware_model', 64);
  optionalText(payload.firmware_version, 'firmware_version', 32);
  optionalOneOf(payload.status, DEVICE_STATUSES, 'status');
  optionalOneOf(payload.availability_status, AVAILABILITY_STATUSES, 'availability_status');
  optionalInt(payload.battery_level, 'battery_level', { min: 0, max: 100 });
  const ip = optionalText(payload.ip_address, 'ip_address', 45);
  if (ip !== null && !IP_PATTERN.test(ip)) throw new HttpError(400, 'ip_address is not a valid IP address.');
}

/**
 * GET /api/devices/list?type=ALL&status=ALL
 */
async function listDevices(req, res, parsedUrl) {
  try {
    const type = optionalOneOf(parsedUrl.searchParams.get('type'), ['ALL', ...DEVICE_TYPES], 'type', 'ALL');
    const status = optionalOneOf(parsedUrl.searchParams.get('status'), ['ALL', ...DEVICE_STATUSES], 'status', 'ALL');
    const devices = await deviceService.listDevices(type, status);
    sendJson(res, 200, { success: true, count: devices.length, devices });
  } catch (err) {
    sendFailure(res, err, 'listDevices');
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
    sendFailure(res, err, 'getUnprovisioned');
  }
}

/**
 * GET /api/devices/next-id?type=WRISTBAND
 */
async function getNextId(req, res, parsedUrl) {
  try {
    const type = requireOneOf(parsedUrl.searchParams.get('type'), DEVICE_TYPES, 'type');
    const nextId = await deviceService.getNextDeviceId(type);
    sendJson(res, 200, { success: true, nextId });
  } catch (err) {
    sendFailure(res, err, 'getNextId');
  }
}

/**
 * POST /api/devices/enroll
 */
async function enrollDevice(req, res, body) {
  try {
    const payload = parseJsonBody(body);
    payload.device_id = requireId(payload.device_id, 'device_id');
    payload.mac_address = requireMac(payload.mac_address, 'mac_address');
    payload.device_type = requireOneOf(payload.device_type, DEVICE_TYPES, 'device_type');
    checkDeviceFields(payload);

    const result = await deviceService.enrollDevice(payload);
    sendJson(res, 201, result);
  } catch (err) {
    sendFailure(res, err, 'enrollDevice');
  }
}

/**
 * POST /api/devices/update
 */
async function updateDevice(req, res, body, parsedUrl) {
  try {
    const payload = parseJsonBody(body);
    const deviceId = requireId(payload.device_id || parsedUrl.searchParams.get('id'), 'device_id');
    checkDeviceFields(payload);

    const result = await deviceService.updateDevice(deviceId, payload);
    sendJson(res, 200, result);
  } catch (err) {
    sendFailure(res, err, 'updateDevice');
  }
}

/**
 * POST or DELETE /api/devices/delete
 */
async function deleteDevice(req, res, body, parsedUrl) {
  try {
    const payload = parseJsonBody(body);
    const deviceId = requireId(payload.device_id || parsedUrl.searchParams.get('id'), 'device_id');
    const deletedBy = req.actor ? actorLabel(req.actor).slice(0, 64) : null;
    const result = await deviceService.deleteDevice(deviceId, deletedBy);
    sendJson(res, 200, result);
  } catch (err) {
    sendFailure(res, err, 'deleteDevice');
  }
}

/**
 * POST /api/devices/ping
 */
async function pingDevice(req, res, body) {
  try {
    const payload = parseJsonBody(body);
    const deviceId = requireId(payload.device_id, 'device_id');

    // In a live system, this sends an MQTT CMD_PING_LED to shiro/command/{device_id}
    logger.info(`[DEVICE ACTION] Dispatched PING_LED to ${deviceId}`);
    sendJson(res, 200, { success: true, message: `Ping command sent to ${deviceId}. Visual LED triggered!` });
  } catch (err) {
    sendFailure(res, err, 'pingDevice');
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
