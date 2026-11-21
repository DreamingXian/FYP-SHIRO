// =============================================================================
// SHIRO Edge Server - LiDAR room sensor routes (Phase 10)
//   GET  /api/room-sensors/status         the live picture of every LiDAR node heard
//                                         since the server started: connected,
//                                         scanning, turns per second, LiDAR health
//   GET  /api/room-sensors/scan           ?ward_id=&device_id=  the newest turn, the
//                                         directions new in the room, the empty room,
//                                         the moved check and learning (ward editor)
//   GET  /api/room-sensors/people         ?ward_id=  the people the ward's LiDARs follow
//                                         now, each with the wristband linked to it or null
//   POST /api/room-sensors/learn          { ward_id, device_id, countdown_s?, duration_s? }
//                                         learn the empty room (ADMIN)
//   POST /api/room-sensors/learn/cancel   { device_id }  (ADMIN)
//   POST /api/room-sensors/align          { layout, sensor: { device_id, x, y, heading_deg, base_height? } }
//                                         where the LiDAR is, from its scan of the
//                                         walls; computes only, stores nothing
// Signed-in clinicians (STAFF) unless listed in services/auth/permissions.js.
// =============================================================================
const roomSensorService = require('../services/room_sensor/room_sensor_service');
const roomSensorManager = require('../services/room_sensor/room_sensor_manager');
const peopleService = require('../services/room_sensor/people_service');
const { alignScan } = require('../services/room_sensor/alignment');
const { checkWardPayload } = require('../controllers/ward_controller');
const { actorLabel } = require('../services/auth/auth_service');
const { requireId, requireNumber, optionalNumber } = require('../utils/validate');
const { sendJson, sendFailure, parseJsonBody, HttpError } = require('../utils/http');

function objectField(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, `${name} must be an object.`);
  return value;
}

async function handleRoomSensorRoutes(pathname, req, res, parsedUrl, body) {
  const route = `${req.method} ${pathname}`;
  const manager = roomSensorManager.instance();
  try {
    switch (route) {
      case 'GET /api/room-sensors/status':
        sendJson(res, 200, { success: true, sensors: roomSensorService.getStatuses() });
        return true;

      case 'GET /api/room-sensors/scan': {
        const q = parsedUrl.searchParams;
        const wardId = requireId(q.get('ward_id'), 'ward_id');
        const deviceId = requireId(q.get('device_id'), 'device_id');
        sendJson(res, 200, { success: true, ...manager.getScanView(wardId, deviceId) });
        return true;
      }

      case 'GET /api/room-sensors/people': {
        const wardId = requireId(parsedUrl.searchParams.get('ward_id'), 'ward_id');
        sendJson(res, 200, { success: true, ...peopleService.instance().peopleOfWard(wardId) });
        return true;
      }

      case 'POST /api/room-sensors/learn': {
        const data = parseJsonBody(body);
        const learning = manager.startLearning({
          wardId: requireId(data.ward_id, 'ward_id'),
          deviceId: requireId(data.device_id, 'device_id'),
          countdownS: data.countdown_s,
          durationS: data.duration_s,
          learnedBy: req.actor ? actorLabel(req.actor) : null
        });
        sendJson(res, 200, { success: true, learning });
        return true;
      }

      case 'POST /api/room-sensors/learn/cancel': {
        const data = parseJsonBody(body);
        sendJson(res, 200, { success: true, cancelled: manager.cancelLearning(requireId(data.device_id, 'device_id')) });
        return true;
      }

      case 'POST /api/room-sensors/align': {
        const data = parseJsonBody(body);
        const layout = objectField(data.layout, 'layout');
        checkWardPayload(layout);
        const sensor = objectField(data.sensor, 'sensor');
        const deviceId = requireId(sensor.device_id, 'sensor.device_id');
        const pose = {
          x: requireNumber(sensor.x, 'sensor.x', { min: 0, max: 1000 }),
          y: requireNumber(sensor.y, 'sensor.y', { min: 0, max: 1000 }),
          heading_deg: requireNumber(sensor.heading_deg, 'sensor.heading_deg', { min: -360, max: 360 }),
          base_height: optionalNumber(sensor.base_height, 'sensor.base_height', { min: 0, max: 5 }, 0.92)
        };
        const scan = manager.scanForAlignment(layout.ward_id, deviceId);
        if (!scan) {
          throw new HttpError(409, `Nothing to align with: LiDAR node ${deviceId} is not sending turns, and no empty room is learned for it in ${layout.ward_id}.`);
        }
        const result = alignScan({ distancesMm: scan.distancesMm, layout, pose });
        if (!result.ok) throw new HttpError(409, result.reason);
        sendJson(res, 200, { success: true, alignment: { ...result, scan_source: scan.source, scan_turns: scan.turns } });
        return true;
      }

      default:
        return false;
    }
  } catch (err) {
    sendFailure(res, err, 'roomSensors');
    return true;
  }
}

module.exports = { handleRoomSensorRoutes };
