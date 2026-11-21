// =============================================================================
// SHIRO Edge Server - Geofence alerts: at the door, left the ward (Phase 10)
// The LiDAR's people service (room_sensor/people_service.js) reports two
// events for a wristband's patient:
//   AT_DOOR    standing in the door zone for 10 s: may be about to leave
//   LEFT_WARD  lost in the door zone and not seen again for 10 s: left
// Each becomes one GEOFENCE_BREACH incident (alert_service.recordIncident)
// with its kind, on the dashboards and the headsets, unless:
//   - a headset sees the patient in that ward (the headset comes first):
//     anywhere for LEFT_WARD, away from the door zone for AT_DOOR
//   - the wristband is not bound to a patient
// Limit: a patient who takes the wristband off and walks out is not followed.
// =============================================================================
const logger = require('../../utils/logger');
const { inDoorZone } = require('../room_sensor/lidar_linker');

const KINDS = Object.freeze(['LEFT_WARD', 'AT_DOOR']);

/**
 * @param {object} deps
 * @param {Function} deps.getPosition        (tagId) => ips_service.getTagPosition result or null
 * @param {Function} deps.findActiveBinding  async (tagId, mac) => { patient_id, device_id, mac_address } or null
 * @param {Function} deps.recordIncident     async (incidentData) => incident
 * @param {object}   [deps.log]
 */
function createGeofenceAlerts({ getPosition, findActiveBinding, recordIncident, log = logger }) {
  return {
    /**
     * @param {{kind, tagId, wardId, x, y, seconds, door}} event
     * @returns {Promise<object|null>} the incident, or null when none was raised
     */
    async raise({ kind, tagId, wardId, x, y, seconds = null, door = null }) {
      if (!KINDS.includes(kind) || !tagId) return null;
      const pos = getPosition(tagId) || null;

      if (pos && pos.source === 'HEADSET' && pos.ward_id === wardId) {
        const headsetAtDoor = inDoorZone(door, Number(pos.x), Number(pos.y));
        if (kind === 'LEFT_WARD' || !headsetAtDoor) {
          log.info(`[GEOFENCE] ${kind} of ${tagId} not raised: a headset sees the patient in ${wardId}.`);
          return null;
        }
      }

      const mac = pos && pos.tag_mac ? pos.tag_mac : null;
      const binding = await findActiveBinding(tagId, mac);
      if (!binding) {
        log.info(`[GEOFENCE] ${kind} of ${tagId} not raised: the wristband is not bound to a patient.`);
        return null;
      }

      return recordIncident({
        incident_category: 'GEOFENCE_BREACH',
        geofence_kind: kind,
        geofence_seconds: seconds,
        device_id: binding.device_id || tagId,
        wristband_mac: binding.mac_address || mac,
        ward_id: wardId,
        pos_x: x,
        pos_y: y
      });
    }
  };
}

/** The active binding of a wristband, by device ID or MAC, from MySQL. */
async function findActiveBindingInDb(tagId, mac) {
  const { getPool } = require('../../database/db');
  const [rows] = await getPool().query(`
    SELECT pb.patient_id, d.device_id, d.mac_address
    FROM patient_bindings pb
    JOIN devices d ON pb.device_id = d.device_id
    WHERE pb.status = 'ACTIVE'
      AND (d.device_id = ? OR d.mac_address = ? OR d.mac_address = ?)
    LIMIT 1
  `, [tagId, tagId, mac || tagId]);
  return rows.length > 0 ? rows[0] : null;
}

// The server's own instance
let serverInstance = null;
function instance() {
  if (!serverInstance) {
    const ipsService = require('../ips_service');
    const alertService = require('../alert_service');
    serverInstance = createGeofenceAlerts({
      getPosition: (tagId) => ipsService.getTagPosition(tagId),
      findActiveBinding: findActiveBindingInDb,
      recordIncident: (data) => alertService.recordIncident(data)
    });
  }
  return serverInstance;
}

module.exports = { KINDS, createGeofenceAlerts, findActiveBindingInDb, instance };
