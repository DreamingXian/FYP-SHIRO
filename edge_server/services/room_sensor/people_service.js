// =============================================================================
// SHIRO Edge Server - Patient positions from the LiDARs (Phase 10, step 5b)
// For every turn of a LiDAR that is placed in a ward and has its empty room
// learned (room_sensor_manager.peopleSetup):
//   - finds and follows the people in the ward and links them to wristbands
//     (ward_people.js), using the wristbands' unsmoothed Bluetooth positions
//   - gives the IPS the position of each linked or held patient
//     (ips_service.applyLidarPosition / endLidarPosition)
//   - sends the people the LiDARs see to the dashboards (WebSocket
//     ROOM_PEOPLE, at most 5 a second per ward), with the wristband each one
//     is linked to; the ones without show as grey dots on the Live Map
// A LiDAR whose empty room is being learned, or that has probably been moved,
// is not used until it is fine again.
// =============================================================================
const logger = require('../../utils/logger');
const { createWardPeople } = require('./ward_people');

const BROADCAST_INTERVAL_MS = 200;

const round2 = (v) => Math.round(v * 100) / 100;

/**
 * @param {object} deps
 * @param {Function} deps.setupOf            (deviceId) => room_sensor_manager.peopleSetup result or null
 * @param {Function} deps.onFrame            (listener) => stop; listener({mac, deviceId, frame, at})
 * @param {Function} deps.getWardLayout      async (wardId) => { length_x, width_y, beds } or null
 * @param {Function} deps.getWardBluetooth   (wardId) => [{tagId, x, y, at}]
 * @param {Function} deps.applyPosition      (tagId, {x, y, wardId, key, held, inBed}, now) => bool
 * @param {Function} deps.endPosition        (tagId, now) => void
 * @param {Function} [deps.broadcast]
 * @param {object}   [deps.options]          overrides for ward_people
 */
function createPeopleService({
  setupOf, onFrame, getWardLayout, getWardBluetooth, applyPosition, endPosition,
  broadcast = () => {}, options = {}
} = {}) {
  const wards = new Map();       // ward_id -> { people: ward_people, latest: {at, people}, lastBroadcast, lastCount }
  const deviceWard = new Map();  // device_id -> ward_id it was used in
  const learnedAt = new Map();   // device_id -> learned_at of the empty room in use
  const layouts = new Map();     // ward_id -> layout | null (not found) ; missing while loading
  const loading = new Set();
  let stopListening = null;

  function wardState(wardId) {
    let w = wards.get(wardId);
    if (!w) {
      w = { people: createWardPeople(options), latest: { at: null, people: [] }, lastBroadcast: 0, lastCount: 0 };
      wards.set(wardId, w);
    }
    return w;
  }

  function loadLayout(wardId) {
    if (loading.has(wardId)) return;
    loading.add(wardId);
    Promise.resolve()
      .then(() => getWardLayout(wardId))
      .then(layout => {
        layouts.set(wardId, layout
          ? { length_x: Number(layout.length_x), width_y: Number(layout.width_y), beds: layout.beds || [] }
          : null);
      })
      .catch(err => logger.warn(`[ROOM PEOPLE] Layout of ${wardId} not loaded: ${err.message}`))
      .finally(() => loading.delete(wardId));
  }

  /** A LiDAR stops being used in its ward: what it saw is forgotten; patients only it saw go back to Bluetooth. */
  function dropDevice(deviceId, now) {
    const wardId = deviceWard.get(deviceId);
    deviceWard.delete(deviceId);
    learnedAt.delete(deviceId);
    if (!wardId || !wards.has(wardId)) return;
    const w = wards.get(wardId);
    w.people.dropLidar(deviceId);
    if (![...deviceWard.values()].includes(wardId)) {
      for (const tagId of w.people.clear()) endPosition(tagId, now);
      wards.delete(wardId);
      broadcast({ type: 'ROOM_PEOPLE', ward_id: wardId, at: now, people: [] });
    }
  }

  function send(wardId, w, people, at, force) {
    if (!force && at - w.lastBroadcast < BROADCAST_INTERVAL_MS) return;
    w.lastBroadcast = at;
    w.lastCount = people.length;
    broadcast({
      type: 'ROOM_PEOPLE',
      ward_id: wardId,
      at,
      people: people.map(p => ({ key: p.key, x: round2(p.x), y: round2(p.y), tag_id: p.tag_id || null }))
    });
  }

  function handleFrame({ deviceId, frame, at }) {
    if (!deviceId || !frame || !frame.distancesMm) return;
    const setup = setupOf(deviceId);
    if (!setup) {
      if (deviceWard.has(deviceId)) dropDevice(deviceId, at);
      return;
    }
    const before = deviceWard.get(deviceId);
    if ((before && before !== setup.ward_id) || (learnedAt.has(deviceId) && learnedAt.get(deviceId) !== setup.learned_at)) {
      dropDevice(deviceId, at);   // moved to another ward, or a new empty room: start afresh
    }
    if (!layouts.has(setup.ward_id)) {
      loadLayout(setup.ward_id);
      return;
    }
    const layout = layouts.get(setup.ward_id);
    if (!layout) return;
    deviceWard.set(deviceId, setup.ward_id);
    learnedAt.set(deviceId, setup.learned_at);

    const w = wardState(setup.ward_id);
    const out = w.people.turn({
      deviceId, distancesMm: frame.distancesMm, model: setup.model, pose: setup.pose,
      room: layout, beds: layout.beds, t: at, wristbands: getWardBluetooth(setup.ward_id)
    });
    for (const p of out.positions) {
      applyPosition(p.tagId, { x: p.x, y: p.y, wardId: setup.ward_id, key: p.key, held: p.held, inBed: p.in_bed }, at);
    }
    for (const tagId of out.ended) endPosition(tagId, at);
    w.latest = { at, people: out.people };
    send(setup.ward_id, w, out.people, at, out.people.length !== w.lastCount);
  }

  return {
    start() {
      if (!stopListening) stopListening = onFrame(handleFrame);
    },

    stop() {
      if (stopListening) stopListening();
      stopListening = null;
    },

    /** The wards were edited: read their layouts again (beds, size) on the next turn. */
    reload() {
      layouts.clear();
    },

    /** The people the LiDARs of a ward follow now, with the wristband each is linked to. */
    peopleOfWard(wardId) {
      const w = wards.get(wardId);
      if (!w || !w.latest.at) return { ward_id: wardId, at: null, people: [] };
      return {
        ward_id: wardId,
        at: w.latest.at,
        people: w.latest.people.map(p => ({ key: p.key, x: round2(p.x), y: round2(p.y), tag_id: p.tag_id || null }))
      };
    }
  };
}

// The server's own instance
let serverInstance = null;
function instance() {
  if (!serverInstance) {
    const manager = require('./room_sensor_manager').instance();
    const roomSensorService = require('./room_sensor_service');
    const wardService = require('../ward_service');
    const ipsService = require('../ips_service');
    const { broadcastToClients } = require('../websocket_service');
    serverInstance = createPeopleService({
      setupOf: (deviceId) => manager.peopleSetup(deviceId),
      onFrame: (listener) => roomSensorService.onFrame(listener),
      getWardLayout: (wardId) => wardService.getWardConfig(wardId),
      getWardBluetooth: (wardId) => ipsService.getWardBluetoothPositions(wardId),
      applyPosition: (tagId, pos, now) => ipsService.applyLidarPosition(tagId, pos, now),
      endPosition: (tagId, now) => ipsService.endLidarPosition(tagId, now),
      broadcast: broadcastToClients
    });
  }
  return serverInstance;
}

module.exports = { createPeopleService, instance, BROADCAST_INTERVAL_MS };
