// =============================================================================
// Ward Configuration Controller
// =============================================================================
const logger = require('../utils/logger');
const wardService = require('../services/ward_service');
const headsetAnchors = require('../services/headset_anchor_service');
const { broadcastToClients } = require('../services/websocket_service');
const { HttpError, sendJson, sendFailure, parseJsonBody } = require('../utils/http');
const {
  requireId, optionalId, optionalMac, requireDeviceRef, optionalOneOf, requireNumber, optionalNumber,
  optionalText, optionalAnchorRef, requireLabel, optionalArray
} = require('../utils/validate');

const DOOR_WALLS = ['SOUTH', 'NORTH', 'EAST', 'WEST'];
const LAYOUT_TYPES = ['RECTANGLE', 'L_SHAPED', 'POLYGON', 'ISOLATION'];
const OBSTACLE_TYPES = ['TOILET', 'PILLAR', 'STORAGE', 'PARTITION', 'CUPBOARD', 'TABLE'];
const BED_STATUSES = ['AVAILABLE', 'UNAVAILABLE', 'OCCUPIED'];

// Limits for a ward plan, in metres. Wide enough for any real room; their
// purpose is to refuse text, infinities and absurd values.
const COORDINATE = { min: -1000, max: 1000 };
const SIZE = { min: 0, max: 1000 };
const RSSI_AT_1M = { min: -120, max: 0 };   // calibration value A, dBm
const PATH_LOSS = { min: 0.5, max: 10 };    // calibration value n

/**
 * Checks a ward plan sent by the ward editor. Only the fields the server stores
 * are checked; anything else in the object is ignored by the service.
 */
function checkWardPayload(payload) {
  requireId(payload.ward_id, 'ward_id');
  optionalText(payload.room_title, 'room_title', 128);
  optionalNumber(payload.length_x, 'length_x', { min: 0.5, max: 1000 });
  optionalNumber(payload.width_y, 'width_y', { min: 0.5, max: 1000 });
  optionalNumber(payload.height_z, 'height_z', { min: 0.5, max: 100 });
  optionalOneOf(payload.layout_type, LAYOUT_TYPES, 'layout_type');
  optionalAnchorRef(payload.spatial_anchor_uuid, 'spatial_anchor_uuid');

  if (payload.door !== undefined && payload.door !== null) {
    if (typeof payload.door !== 'object' || Array.isArray(payload.door)) throw new HttpError(400, 'door must be an object.');
    optionalOneOf(payload.door.wall, DOOR_WALLS, 'door.wall');
    optionalNumber(payload.door.x, 'door.x', COORDINATE);
    optionalNumber(payload.door.y, 'door.y', COORDINATE);
    optionalNumber(payload.door.width, 'door.width', SIZE);
  }

  optionalArray(payload.obstacles, 'obstacles', 200).forEach((o, i) => {
    const at = `obstacles[${i}]`;
    optionalId(o.id, `${at}.id`);
    optionalOneOf(o.type, OBSTACLE_TYPES, `${at}.type`);
    optionalText(o.label, `${at}.label`, 64);
    optionalNumber(o.x, `${at}.x`, COORDINATE);
    optionalNumber(o.y, `${at}.y`, COORDINATE);
    optionalNumber(o.width, `${at}.width`, SIZE);
    optionalNumber(o.length, `${at}.length`, SIZE);
    optionalNumber(o.height, `${at}.height`, SIZE);
  });

  optionalArray(payload.beds, 'beds', 200).forEach((b, i) => {
    const at = `beds[${i}]`;
    optionalId(b.bed_id, `${at}.bed_id`);
    optionalText(b.bed_code, `${at}.bed_code`, 32);
    optionalOneOf(b.status, BED_STATUSES, `${at}.status`);
    optionalNumber(b.x, `${at}.x`, COORDINATE);
    optionalNumber(b.y, `${at}.y`, COORDINATE);
    optionalNumber(b.width, `${at}.width`, SIZE);
    optionalNumber(b.length, `${at}.length`, SIZE);
    optionalNumber(b.rotation_deg, `${at}.rotation_deg`, { min: -360, max: 360 });
  });

  optionalArray(payload.anchors, 'anchors', 32).forEach((a, i) => {
    const at = `anchors[${i}]`;
    if (a.anchor_id !== undefined && a.anchor_id !== null && a.anchor_id !== '') requireLabel(a.anchor_id, `${at}.anchor_id`);
    optionalId(typeof a.device_id === 'string' ? a.device_id.trim() : a.device_id, `${at}.device_id`);
    optionalMac(a.mac_address, `${at}.mac_address`);
    optionalText(a.wall_location, `${at}.wall_location`, 64);
    optionalNumber(a.x, `${at}.x`, COORDINATE);
    optionalNumber(a.y, `${at}.y`, COORDINATE);
    optionalNumber(a.z, `${at}.z`, COORDINATE);
    optionalNumber(a.calibrated_a, `${at}.calibrated_a`, RSSI_AT_1M);
    optionalNumber(a.calibrated_n, `${at}.calibrated_n`, PATH_LOSS);
  });
}

async function listWards(req, res) {
  try {
    const wards = await headsetAnchors.forViewer(req.actor, await wardService.getAllWards());
    sendJson(res, 200, { success: true, wards });
  } catch (err) {
    sendFailure(res, err, 'listWards');
  }
}

async function getWard(req, res, parsedUrl) {
  try {
    const wardId = requireId(parsedUrl.searchParams.get('ward_id'), 'ward_id');
    const config = await wardService.getWardConfig(wardId);
    if (!config) throw new HttpError(404, 'Ward not found');
    sendJson(res, 200, { success: true, ward: await headsetAnchors.forViewer(req.actor, config) });
  } catch (err) {
    sendFailure(res, err, 'getWard');
  }
}

async function saveWard(req, res, body) {
  try {
    const payload = parseJsonBody(body);
    checkWardPayload(payload);
    const result = await wardService.saveWardConfig(payload);

    // Notify connected WebSockets (Web Dashboard & Meta Quest 3)
    broadcastToClients({
      type: 'WARD_CONFIG_UPDATED',
      ward_id: result.ward_id,
      timestamp: new Date().toLocaleTimeString()
    });

    sendJson(res, 200, {
      success: true,
      message: 'Ward configuration saved to database successfully.',
      ward_id: result.ward_id
    });
  } catch (err) {
    sendFailure(res, err, 'saveWard');
  }
}

async function deleteWardRecord(req, res, parsedUrl) {
  try {
    const wardId = requireId(parsedUrl.searchParams.get('ward_id'), 'ward_id');
    await wardService.deleteWard(wardId);

    broadcastToClients({
      type: 'WARD_CONFIG_UPDATED',
      deleted_ward_id: wardId,
      timestamp: new Date().toLocaleTimeString()
    });

    sendJson(res, 200, { success: true, message: `Ward ${wardId} deleted successfully.` });
  } catch (err) {
    sendFailure(res, err, 'deleteWardRecord');
  }
}

function getTemplates(req, res) {
  sendJson(res, 200, { success: true, templates: wardService.WARD_TEMPLATES });
}

async function resetDefault(req, res) {
  try {
    const config = await wardService.resetDefaultWard();
    broadcastToClients({
      type: 'WARD_CONFIG_UPDATED',
      ward_id: config ? config.ward_id : undefined,
      timestamp: new Date().toLocaleTimeString()
    });
    sendJson(res, 200, { success: true, ward: config });
  } catch (err) {
    sendFailure(res, err, 'resetDefault');
  }
}

async function getWardIps(req, res, parsedUrl) {
  try {
    const wardId = requireId(parsedUrl.searchParams.get('ward_id'), 'ward_id');
    const ipsData = await wardService.getWardIpsData(wardId);
    if (!ipsData) throw new HttpError(404, 'Ward not found');
    ipsData.ward = await headsetAnchors.forViewer(req.actor, ipsData.ward);
    sendJson(res, 200, { success: true, ...ipsData });
  } catch (err) {
    sendFailure(res, err, 'getWardIps');
  }
}

async function removeWardIpsTag(req, res, parsedUrl, body) {
  try {
    const payload = parseJsonBody(body);
    const tagId = requireDeviceRef(parsedUrl.searchParams.get('tag_id') || payload.tag_id, 'tag_id');
    const mac = optionalMac(parsedUrl.searchParams.get('mac') || payload.mac, 'mac');

    const ipsService = require('../services/ips_service');
    ipsService.purgeTag(tagId, mac);

    sendJson(res, 200, { success: true, message: `Tag "${tagId}" purged from ward map.` });
  } catch (err) {
    sendFailure(res, err, 'removeWardIpsTag');
  }
}

async function startCalibration(req, res, body) {
  try {
    const calibrationService = require('../services/calibration_service');
    const payload = parseJsonBody(body);
    const session = {
      ward_id: requireId(payload.ward_id, 'ward_id'),
      tag_id: requireDeviceRef(payload.tag_id, 'tag_id'),
      target_x: requireNumber(payload.target_x, 'target_x', COORDINATE),
      target_y: requireNumber(payload.target_y, 'target_y', COORDINATE)
    };
    const targetZ = optionalNumber(payload.target_z, 'target_z', COORDINATE);
    const duration = optionalNumber(payload.duration_sec, 'duration_sec', { min: 1, max: 120 });
    const pathLoss = optionalNumber(payload.path_loss_n, 'path_loss_n', PATH_LOSS);
    if (targetZ !== null) session.target_z = targetZ;
    if (duration !== null) session.duration_sec = duration;
    if (pathLoss !== null) session.path_loss_n = pathLoss;

    const result = await calibrationService.startSession(session);
    sendJson(res, 200, result);
  } catch (err) {
    sendFailure(res, err, 'startCalibration');
  }
}

async function getCalibrationStatus(req, res) {
  try {
    const calibrationService = require('../services/calibration_service');
    sendJson(res, 200, calibrationService.getSessionResults());
  } catch (err) {
    sendFailure(res, err, 'getCalibrationStatus');
  }
}

async function applyCalibration(req, res, body) {
  try {
    const calibrationService = require('../services/calibration_service');
    const payload = parseJsonBody(body);
    const wardId = requireId(payload.ward_id, 'ward_id');
    const list = optionalArray(payload.calibrations, 'calibrations', 32);
    if (list.length === 0) throw new HttpError(400, 'calibrations is required.');

    // Only checked values are passed on: this list is stored and sent to every screen
    const calibrations = list.map((c, i) => {
      const at = `calibrations[${i}]`;
      return {
        anchor_id: requireLabel(c.anchor_id, `${at}.anchor_id`),
        device_id: optionalId(c.device_id, `${at}.device_id`),
        A: requireNumber(c.A, `${at}.A`, RSSI_AT_1M),
        n: optionalNumber(c.n, `${at}.n`, PATH_LOSS, 3.2)
      };
    });

    const result = await calibrationService.applyCalibrations(wardId, calibrations);
    sendJson(res, 200, result);
  } catch (err) {
    sendFailure(res, err, 'applyCalibration');
  }
}

async function resetCalibration(req, res, body) {
  try {
    const calibrationService = require('../services/calibration_service');
    const payload = parseJsonBody(body);
    const wardId = requireId(payload.ward_id, 'ward_id');
    const result = await calibrationService.resetCalibrations(wardId);
    sendJson(res, 200, result);
  } catch (err) {
    sendFailure(res, err, 'resetCalibration');
  }
}

/**
 * POST /api/ward/save-anchor
 * A headset stores the reference of the spatial anchor it placed for a ward
 * (an empty reference removes it). It is kept for that headset only: another
 * headset cannot load it. A staff request sets the ward's reference field
 * shown in the ward editor (kept for older clients).
 */
async function saveSpatialAnchor(req, res, body) {
  try {
    const payload = parseJsonBody(body);
    const wardId = requireId(payload.ward_id, 'ward_id');
    const uuid = optionalAnchorRef(payload.spatial_anchor_uuid, 'spatial_anchor_uuid') || '';

    if (req.actor && req.actor.type === 'HEADSET') {
      await headsetAnchors.saveAnchor(req.actor.id, wardId, uuid);
      logger.info(`[WARD SPATIAL ANCHOR] ${req.actor.id}: ${uuid ? `saved anchor "${uuid}"` : 'removed its anchor'} for ${wardId}`);
      sendJson(res, 200, { success: true, ward_id: wardId, spatial_anchor_uuid: uuid, device_id: req.actor.id });
      return;
    }

    const { getPool } = require('../database/db');
    const [result] = await getPool().query('UPDATE ward_rooms SET spatial_anchor_uuid = ? WHERE ward_id = ?', [uuid, wardId]);
    if (result.affectedRows === 0) throw new HttpError(404, 'Ward not found');

    logger.info(`[WARD SPATIAL ANCHOR] Saved anchor reference "${uuid}" for ${wardId}`);
    sendJson(res, 200, { success: true, ward_id: wardId, spatial_anchor_uuid: uuid });
  } catch (err) {
    sendFailure(res, err, 'saveSpatialAnchor');
  }
}

module.exports = {
  listWards,
  getWard,
  getWardIps,
  removeWardIpsTag,
  saveWard,
  deleteWardRecord,
  getTemplates,
  resetDefault,
  startCalibration,
  getCalibrationStatus,
  applyCalibration,
  resetCalibration,
  saveSpatialAnchor,
  checkWardPayload
};
