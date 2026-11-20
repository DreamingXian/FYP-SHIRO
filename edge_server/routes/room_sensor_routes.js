// =============================================================================
// SHIRO Edge Server - LiDAR room sensor routes (Phase 10)
//   GET /api/room-sensors/status   the live picture of every LiDAR node heard
//                                  since the server started: connected,
//                                  scanning, turns per second, LiDAR health
// Signed-in clinicians only (not in the permission table, so STAFF).
// =============================================================================
const roomSensorService = require('../services/room_sensor/room_sensor_service');
const { sendJson, sendFailure } = require('../utils/http');

async function handleRoomSensorRoutes(pathname, req, res) {
  if (pathname === '/api/room-sensors/status' && req.method === 'GET') {
    try {
      sendJson(res, 200, { success: true, sensors: roomSensorService.getStatuses() });
    } catch (err) {
      sendFailure(res, err, 'getRoomSensorStatus');
    }
    return true;
  }
  return false;
}

module.exports = { handleRoomSensorRoutes };
