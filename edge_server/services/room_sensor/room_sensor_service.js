// =============================================================================
// SHIRO Edge Server - LiDAR room sensors (Phase 10)
// Receives what the LiDAR nodes send over MQTT (firmware/shiro_lidar_node):
//   shiro/<ward>/lidar/scan    one LiDAR turn, binary (scan_frame.js)
//   shiro/<ward>/lidar/status  the node's own report every 2 s, JSON
// and keeps a live picture of each node: is it connected and scanning, how many
// turns per second arrive, lost turns, the LiDAR's health. The node is shown on
// the Devices page like the anchors (device type ROOM_SENSOR). Other modules
// receive every turn through onFrame (positioning, ward editor overlay).
// Nothing is stored: the newest turn is kept in memory only.
// =============================================================================
const logger = require('../../utils/logger');
const { decodeScanFrame } = require('./scan_frame');

const MAX_SCAN_BYTES = 4096;
const MAX_STATUS_BYTES = 1024;
const UPDATE_INTERVAL_MS = 1000;   // device presence and dashboard update at most once a second
const RATE_WINDOW_MS = 5000;       // turns per second measured over the last 5 s
const SCANNING_FRESH_MS = 2000;    // a turn within this time: scanning
const ONLINE_FRESH_MS = 6000;      // any message within this time: online
const HARDWARE_MODEL = 'ESP32-S3 + RPLIDAR C1';

const NODE_STATES = ['STARTING', 'SCANNING', 'NO_ANSWER', 'FAULT'];
const HEALTH_VALUES = ['OK', 'WARNING', 'ERROR'];

function boundedNumber(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;
}

function boundedText(value, pattern, maxLength) {
  return typeof value === 'string' && value.length <= maxLength && pattern.test(value) ? value : null;
}

/**
 * Reads a node's status report. Only known fields with plausible values are kept.
 * @returns {{ok: true, status: object} | {ok: false, reason: string}}
 */
function checkStatusMessage(parsed, mac) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'status is not a JSON object' };
  if (typeof parsed.lidar_mac !== 'string' || parsed.lidar_mac.toUpperCase() !== mac) {
    return { ok: false, reason: 'lidar_mac is not the MAC address of this node\'s client ID' };
  }
  const MAX_COUNT = 4294967295;
  return {
    ok: true,
    status: {
      state: NODE_STATES.includes(parsed.state) ? parsed.state : 'UNKNOWN',
      health: HEALTH_VALUES.includes(parsed.health) ? parsed.health : 'UNKNOWN',
      health_code: boundedNumber(parsed.health_code, 0, 65535),
      node_fw: boundedText(parsed.node_fw, /^[0-9A-Za-z._-]+$/, 16),
      model: boundedNumber(parsed.model, 0, 255),
      lidar_fw: boundedText(parsed.lidar_fw, /^[0-9.]+$/, 8),
      lidar_hw: boundedNumber(parsed.lidar_hw, 0, 255),
      serial: boundedText(parsed.serial, /^[0-9A-F]*$/, 32),
      turns_per_s: boundedNumber(parsed.turns_per_s, 0, 100),
      points_per_turn: boundedNumber(parsed.points_per_turn, 0, 65535),
      valid_per_turn: boundedNumber(parsed.valid_per_turn, 0, 65535),
      turn_ms: boundedNumber(parsed.turn_ms, 0, 65535),
      sent: boundedNumber(parsed.sent, 0, MAX_COUNT),
      send_failed: boundedNumber(parsed.send_failed, 0, MAX_COUNT),
      overwritten: boundedNumber(parsed.overwritten, 0, MAX_COUNT),
      bad_bytes: boundedNumber(parsed.bad_bytes, 0, MAX_COUNT),
      restarts: boundedNumber(parsed.restarts, 0, MAX_COUNT),
      wifi_rssi: boundedNumber(parsed.wifi_rssi, -127, 0),
      uptime_s: boundedNumber(parsed.uptime_s, 0, MAX_COUNT)
    }
  };
}

/**
 * Builds the service. Dependencies are passed in so tests need no database.
 * @param {object} deps
 * @param {Function} deps.recordTraffic   (deviceIdOrMac, type, metadata) => Promise|void
 * @param {Function} deps.findEnrolled    (mac) => { device_id } | null
 * @param {Function} deps.broadcast       (message) => void
 * @param {Function} [deps.now]
 */
function createRoomSensorService({ recordTraffic = () => {}, findEnrolled = () => null, broadcast = () => {}, now = Date.now } = {}) {
  const sensors = new Map();          // mac -> live state
  const frameListeners = new Set();

  function sensorFor(mac, t) {
    let s = sensors.get(mac);
    if (!s) {
      s = {
        mac, ip: null, clientId: null, firstSeen: t, lastSeen: t,
        frames: 0, badFrames: 0, lostTurns: 0, lastSequence: null,
        frameTimes: [], lastFrameAt: null, lastFrame: null,
        node: null, nodeStatusAt: null, lastUpdateAt: 0
      };
      sensors.set(mac, s);
    }
    return s;
  }

  function turnsPerSecond(s, t) {
    const recent = s.frameTimes.filter(ft => t - ft <= RATE_WINDOW_MS);
    if (recent.length < 2) return 0;
    const span = (recent[recent.length - 1] - recent[0]) / 1000;
    return span > 0 ? Math.round(((recent.length - 1) / span) * 10) / 10 : 0;
  }

  function summary(s, t) {
    const enrolled = findEnrolled(s.mac);
    return {
      mac: s.mac,
      device_id: enrolled ? enrolled.device_id : null,
      ip: s.ip,
      online: t - s.lastSeen <= ONLINE_FRESH_MS,
      scanning: s.lastFrameAt !== null && t - s.lastFrameAt <= SCANNING_FRESH_MS,
      turns_per_s: turnsPerSecond(s, t),
      frames: s.frames,
      bad_frames: s.badFrames,
      lost_turns: s.lostTurns,
      last_frame: s.lastFrame
        ? { samples: s.lastFrame.samples, valid: s.lastFrame.valid, turn_ms: s.lastFrame.turnMs, sequence: s.lastFrame.sequence, age_ms: t - s.lastFrameAt }
        : null,
      node: s.node,
      node_status_age_ms: s.nodeStatusAt === null ? null : t - s.nodeStatusAt
    };
  }

  // Presence on the Devices page and a dashboard update, at most once a second
  function touch(s, t, force = false) {
    s.lastSeen = t;
    if (!force && t - s.lastUpdateAt < UPDATE_INTERVAL_MS) return;
    s.lastUpdateAt = t;
    const enrolled = findEnrolled(s.mac);
    const scanning = s.lastFrameAt !== null && t - s.lastFrameAt <= SCANNING_FRESH_MS;
    try {
      const pending = recordTraffic(enrolled ? enrolled.device_id : s.mac, 'ROOM_SENSOR', {
        mac: s.mac,
        ip: s.ip,
        clientId: s.clientId,
        model: HARDWARE_MODEL,
        status_text: scanning ? 'SCANNING' : (s.node ? s.node.state : 'CONNECTED')
      });
      if (pending && typeof pending.catch === 'function') {
        pending.catch(err => logger.error(`[ROOM SENSOR] Presence of ${s.mac}: ${err.message}`));
      }
    } catch (err) {
      logger.error(`[ROOM SENSOR] Presence of ${s.mac}: ${err.message}`);
    }
    broadcast({ type: 'ROOM_SENSOR_STATUS', sensor: summary(s, t) });
  }

  function handleScan(s, payload, t) {
    if (payload.length > MAX_SCAN_BYTES) return { ok: false, reason: `scan message larger than ${MAX_SCAN_BYTES} bytes` };
    const decoded = decodeScanFrame(payload);
    if (!decoded.ok) {
      s.badFrames++;
      return decoded;
    }
    const frame = decoded.frame;
    if (s.lastSequence !== null) {
      const gap = (frame.sequence - s.lastSequence - 1 + 65536) % 65536;
      if (gap > 0 && gap < 1000) s.lostTurns += gap;   // a larger gap is a restarted node, not lost turns
    }
    s.lastSequence = frame.sequence;
    s.frames++;
    s.lastFrameAt = t;
    s.lastFrame = frame;
    s.frameTimes.push(t);
    while (s.frameTimes.length > 0 && t - s.frameTimes[0] > RATE_WINDOW_MS) s.frameTimes.shift();

    const enrolled = findEnrolled(s.mac);
    for (const listener of frameListeners) {
      try {
        listener({ mac: s.mac, deviceId: enrolled ? enrolled.device_id : null, frame, at: t });
      } catch (err) {
        logger.error(`[ROOM SENSOR] Turn of ${s.mac} not processed: ${err.message}`);
      }
    }
    touch(s, t);
    return { ok: true };
  }

  function handleStatus(s, payload, t) {
    if (payload.length > MAX_STATUS_BYTES) return { ok: false, reason: `status larger than ${MAX_STATUS_BYTES} bytes` };
    let parsed;
    try {
      parsed = JSON.parse(payload.toString('utf8'));
    } catch {
      return { ok: false, reason: 'status is not valid JSON' };
    }
    const checked = checkStatusMessage(parsed, s.mac);
    if (!checked.ok) return checked;
    const previous = s.node;
    s.node = checked.status;
    s.nodeStatusAt = t;
    if (!previous || previous.state !== s.node.state || previous.health !== s.node.health) {
      logger.info(`[ROOM SENSOR] LiDAR node ${s.mac}: ${s.node.state}, LiDAR health ${s.node.health}.`);
    }
    touch(s, t, !previous);
    return { ok: true };
  }

  return {
    /**
     * A message from a LiDAR node. mac is the MAC address of its login client ID.
     * @returns {{ok: boolean, reason?: string}}
     */
    handleMessage({ mac, topic, payload, ip = null, clientId = null }) {
      const t = now();
      const s = sensorFor(mac, t);
      if (ip) s.ip = ip;
      if (clientId) s.clientId = clientId;
      const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
      if (/\/lidar\/scan$/.test(topic)) return handleScan(s, buf, t);
      if (/\/lidar\/status$/.test(topic)) return handleStatus(s, buf, t);
      return { ok: false, reason: 'not a LiDAR topic' };
    },

    /** A LiDAR node logged in to the broker. */
    noteConnected({ mac, ip = null, clientId = null }) {
      const t = now();
      const s = sensorFor(mac, t);
      if (ip) s.ip = ip;
      if (clientId) s.clientId = clientId;
      touch(s, t, true);
    },

    /** The live picture of every LiDAR node heard since the server started. */
    getStatuses() {
      const t = now();
      return [...sensors.values()].map(s => summary(s, t));
    },

    /** The newest turn of a node, or null. */
    getLatestFrame(mac) {
      const s = sensors.get(mac);
      return s && s.lastFrame ? { frame: s.lastFrame, at: s.lastFrameAt } : null;
    },

    /** Calls listener({mac, deviceId, frame, at}) for every turn. Returns a function that stops it. */
    onFrame(listener) {
      frameListeners.add(listener);
      return () => frameListeners.delete(listener);
    },

    /** Only for tests. */
    clearAll() {
      sensors.clear();
      frameListeners.clear();
    }
  };
}

// The server's own instance, with the real device registry and WebSocket
let serverInstance = null;
function instance() {
  if (!serverInstance) {
    const deviceService = require('../device_service');
    const { broadcastToClients } = require('../websocket_service');
    serverInstance = createRoomSensorService({
      recordTraffic: (id, type, metadata) => deviceService.recordActiveDeviceTraffic(id, type, metadata),
      findEnrolled: (mac) => deviceService.findEnrolledDeviceByMac(mac),
      broadcast: broadcastToClients
    });
  }
  return serverInstance;
}

module.exports = {
  createRoomSensorService,
  checkStatusMessage,
  MAX_SCAN_BYTES,
  MAX_STATUS_BYTES,
  HARDWARE_MODEL,
  handleMessage: (args) => instance().handleMessage(args),
  noteConnected: (args) => instance().noteConnected(args),
  getStatuses: () => instance().getStatuses(),
  getLatestFrame: (mac) => instance().getLatestFrame(mac),
  onFrame: (listener) => instance().onFrame(listener)
};
