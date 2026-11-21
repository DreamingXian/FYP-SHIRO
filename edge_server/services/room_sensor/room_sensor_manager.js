// =============================================================================
// SHIRO Edge Server - LiDAR room sensors in their wards (Phase 10, step 5a)
// Joins the live turns of each LiDAR node (room_sensor_service.js) with where
// it stands in a ward and the empty room learned for it:
//   - "Learn empty room": after a countdown to leave the room, records the
//     turns of one node for 20 s and stores the empty-room model
//     (background.js, room_sensor_backgrounds).
//   - Moved check: when many directions read farther than the empty room for
//     a few seconds, the LiDAR has probably been knocked or turned. It is
//     reported (log, WebSocket, ward editor) until it matches again.
//   - The newest turn of a node with the directions that are new in the room,
//     for the live scan in the ward editor.
//   - A clean scan for lining the LiDAR up with the walls: the empty room when
//     learned, else the median of the last 30 turns.
// Positions of people (step 5b, people_service.js) build on this: peopleSetup().
// =============================================================================
const logger = require('../../utils/logger');
const { HttpError } = require('../../utils/http');
const { BINS } = require('./scan_frame');
const { learnBackground, foregroundBins, compareWithBackground } = require('./background');

const LEARN_COUNTDOWN_S = 15;
const LEARN_DURATION_S = 20;
const LEARN_MAX_COUNTDOWN_S = 60;
const LEARN_MIN_DURATION_S = 5;
const LEARN_MAX_DURATION_S = 60;
const EXPECTED_TURNS_PER_S = 10;
const SCANNING_FRESH_MS = 3000;     // a node with no turn for longer is not scanning
const RECENT_TURNS = 30;            // kept per node for a live median (3 s)
const MOVED_SMOOTHING = 0.05;       // per turn: about 2 s at 10 turns a second
const MOVED_ON_PCT = 10;            // directions farther than the empty room: probably moved
const MOVED_OFF_PCT = 5;
const MOVED_MIN_TURNS = 30;

const key = (wardId, deviceId) => `${wardId}|${deviceId}`;

function wholeNumber(value, name, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${name} must be a whole number from ${min} to ${max}.`);
  return n;
}

/**
 * @param {object} deps
 * @param {Function} deps.loadPlacements   async () => [{ward_id, sensor_id, device_id, x, y, base_height, heading_deg}]
 * @param {Function} deps.loadBackgrounds  async () => [{ward_id, device_id, learned_at, learned_by, model}]
 * @param {Function} deps.saveBackground   async ({ward_id, device_id, learned_by, model}) => void
 * @param {Function} deps.onFrame          (listener) => stop; listener({mac, deviceId, frame, at})
 * @param {Function} [deps.broadcast]
 * @param {Function} [deps.now]
 * @param {Function} [deps.setTimer]
 * @param {Function} [deps.clearTimer]
 */
function createRoomSensorManager({
  loadPlacements, loadBackgrounds, saveBackground, onFrame, broadcast = () => {},
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout
} = {}) {
  const placements = new Map();   // device_id -> placement
  const backgrounds = new Map();  // ward|device -> { ward_id, device_id, learned_at, learned_by, model }
  const live = new Map();         // device_id -> { mac, lastFrame, lastAt, recent[], moved }
  const learning = new Map();     // device_id -> session (running or the last finished one)
  let stopListening = null;

  function liveFor(deviceId) {
    let s = live.get(deviceId);
    if (!s) {
      s = { mac: null, lastFrame: null, lastAt: null, recent: [], moved: freshMoved() };
      live.set(deviceId, s);
    }
    return s;
  }

  function freshMoved() {
    return { ema: 0, turns: 0, suspected: false, since: null, last: null };
  }

  function summaryOf(bg) {
    if (!bg) return null;
    const m = bg.model;
    return {
      ward_id: bg.ward_id, device_id: bg.device_id, learned_at: bg.learned_at, learned_by: bg.learned_by || null,
      turns: m.turns, coverage_pct: m.coverage_pct, unsteady_pct: m.unsteady_pct
    };
  }

  // ---------------------------------------------------------------------------
  // Turns as they arrive
  // ---------------------------------------------------------------------------
  function checkMoved(deviceId, s, distancesMm, t) {
    const p = placements.get(deviceId);
    const bg = p ? backgrounds.get(key(p.ward_id, deviceId)) : null;
    if (!bg) return;
    const c = compareWithBackground(distancesMm, bg.model);
    if (c.comparable < 50) return;   // a covered window or no returns: nothing to judge by
    const m = s.moved;
    m.turns++;
    m.ema = m.turns === 1 ? c.farther_pct : m.ema + MOVED_SMOOTHING * (c.farther_pct - m.ema);
    m.last = c;
    if (!m.suspected && m.turns >= MOVED_MIN_TURNS && m.ema > MOVED_ON_PCT) {
      m.suspected = true;
      m.since = t;
      logger.warn(`[ROOM SENSOR] ${deviceId} in ${p.ward_id}: ${Math.round(m.ema)}% of directions read farther than the empty room. The LiDAR may have been moved or turned: check it, align it and learn the empty room again.`);
      broadcast({ type: 'ROOM_SENSOR_MOVED', ward_id: p.ward_id, device_id: deviceId, suspected: true, farther_pct: Math.round(m.ema * 10) / 10 });
    } else if (m.suspected && m.ema < MOVED_OFF_PCT) {
      m.suspected = false;
      m.since = null;
      logger.info(`[ROOM SENSOR] ${deviceId} in ${p.ward_id} matches its empty room again.`);
      broadcast({ type: 'ROOM_SENSOR_MOVED', ward_id: p.ward_id, device_id: deviceId, suspected: false, farther_pct: Math.round(m.ema * 10) / 10 });
    }
  }

  function handleFrame({ mac, deviceId, frame, at }) {
    if (!deviceId || !frame || !frame.distancesMm) return;
    const s = liveFor(deviceId);
    s.mac = mac;
    s.lastFrame = frame;
    s.lastAt = at;
    s.recent.push(frame.distancesMm);
    if (s.recent.length > RECENT_TURNS) s.recent.shift();

    const session = learning.get(deviceId);
    if (session && (session.state === 'COUNTDOWN' || session.state === 'RECORDING')) {
      if (at >= session.starts_at && at < session.ends_at) {
        session.state = 'RECORDING';
        session.turns.push(frame.distancesMm);
      }
      return;   // no moved check while the empty room is being learned
    }
    checkMoved(deviceId, s, frame.distancesMm, at);
  }

  // ---------------------------------------------------------------------------
  // Learning the empty room
  // ---------------------------------------------------------------------------
  function learningView(session) {
    if (!session) return null;
    const t = now();
    let state = session.state;
    if (state === 'COUNTDOWN' && t >= session.starts_at) state = 'RECORDING';
    return {
      ward_id: session.ward_id, device_id: session.device_id, state,
      countdown_s: session.countdown_s, duration_s: session.duration_s,
      seconds_to_start: Math.max(0, Math.ceil((session.starts_at - t) / 1000)),
      seconds_left: Math.max(0, Math.ceil((session.ends_at - Math.max(t, session.starts_at)) / 1000)),
      turns: session.turnCount !== undefined ? session.turnCount : session.turns.length,
      result: session.result, error: session.error, finished_at: session.finished_at || null
    };
  }

  function fail(session, message) {
    session.state = 'FAILED';
    session.error = message;
    session.turnCount = session.turns.length;
    session.turns = [];
    session.finished_at = now();
    logger.warn(`[ROOM SENSOR] Empty room for ${session.device_id} in ${session.ward_id} not learned: ${message}`);
    broadcast({ type: 'ROOM_SENSOR_LEARNING', learning: learningView(session) });
  }

  async function finishLearning(session) {
    if (learning.get(session.device_id) !== session || (session.state !== 'COUNTDOWN' && session.state !== 'RECORDING')) return;
    session.timer = null;
    const expected = session.duration_s * EXPECTED_TURNS_PER_S;
    const minTurns = Math.max(20, Math.floor(expected / 2));
    const learned = learnBackground(session.turns, { minTurns });
    if (!learned.ok) {
      fail(session, `Only ${session.turns.length} turns arrived in ${session.duration_s} s (about ${expected} expected): is the LiDAR scanning? Nothing was saved.`);
      return;
    }
    session.state = 'SAVING';
    try {
      await saveBackground({ ward_id: session.ward_id, device_id: session.device_id, learned_by: session.learned_by, model: learned.model });
    } catch (err) {
      fail(session, `The empty room could not be saved (${err.message}).`);
      return;
    }
    const bg = { ward_id: session.ward_id, device_id: session.device_id, learned_at: now(), learned_by: session.learned_by, model: learned.model };
    backgrounds.set(key(session.ward_id, session.device_id), bg);
    liveFor(session.device_id).moved = freshMoved();
    session.state = 'DONE';
    session.turnCount = session.turns.length;
    session.turns = [];
    session.finished_at = now();
    session.result = { ...summaryOf(bg), warnings: learned.warnings };
    logger.info(`[ROOM SENSOR] Empty room learned for ${session.device_id} in ${session.ward_id}: ${learned.model.turns} turns, surface in ${learned.model.coverage_pct}% of directions.`);
    broadcast({ type: 'ROOM_SENSOR_BACKGROUND', ward_id: session.ward_id, device_id: session.device_id, background: summaryOf(bg) });
    broadcast({ type: 'ROOM_SENSOR_LEARNING', learning: learningView(session) });
  }

  // ---------------------------------------------------------------------------
  // Clean scans
  // ---------------------------------------------------------------------------
  /** Per direction, the median of the recent turns that had a return in at least half of them. */
  function recentMedian(s) {
    const n = s.recent.length;
    const out = new Array(BINS).fill(0);
    const values = [];
    for (let i = 0; i < BINS; i++) {
      values.length = 0;
      for (const turn of s.recent) if (turn[i] > 0) values.push(turn[i]);
      if (values.length * 2 < n || values.length === 0) continue;
      values.sort((a, b) => a - b);
      out[i] = values[Math.floor((values.length - 1) / 2)];
    }
    return out;
  }

  return {
    /** Loads placements and empty rooms, and starts listening to the turns. */
    async start() {
      await this.reload();
      if (!stopListening) stopListening = onFrame(handleFrame);
    },

    stop() {
      if (stopListening) stopListening();
      stopListening = null;
      for (const session of learning.values()) if (session.timer) clearTimer(session.timer);
    },

    /** Reads the placements and empty rooms again (after a ward is saved or deleted). */
    async reload() {
      const list = await loadPlacements();
      const before = new Map(placements);
      placements.clear();
      for (const p of list) if (p.device_id) placements.set(p.device_id, p);
      // A node now in another ward starts its moved check afresh
      for (const [deviceId, p] of placements) {
        const old = before.get(deviceId);
        if (old && old.ward_id !== p.ward_id && live.has(deviceId)) live.get(deviceId).moved = freshMoved();
      }
      const stored = await loadBackgrounds();
      backgrounds.clear();
      for (const bg of stored) backgrounds.set(key(bg.ward_id, bg.device_id), bg);
    },

    /** The saved placement of a node, or null. */
    placementOf(deviceId) {
      return placements.get(deviceId) || null;
    },

    /** The LiDARs placed in a ward, each with its empty room (model included) or null. */
    sensorsOfWard(wardId) {
      return [...placements.values()]
        .filter(p => p.ward_id === wardId)
        .map(p => {
          const bg = backgrounds.get(key(wardId, p.device_id));
          return { ...p, background: bg ? { ...summaryOf(bg), model: bg.model } : null };
        });
    },

    /**
     * What finding people in this node's turns needs: its ward, pose and empty
     * room. null while it cannot be used: not placed, no empty room learned, the
     * empty room being learned, or probably moved.
     */
    peopleSetup(deviceId) {
      const p = placements.get(deviceId);
      if (!p) return null;
      const bg = backgrounds.get(key(p.ward_id, deviceId));
      if (!bg) return null;
      const session = learning.get(deviceId);
      if (session && (session.state === 'COUNTDOWN' || session.state === 'RECORDING' || session.state === 'SAVING')) return null;
      const s = live.get(deviceId);
      if (s && s.moved.suspected) return null;
      return {
        ward_id: p.ward_id,
        pose: { x: Number(p.x), y: Number(p.y), heading_deg: Number(p.heading_deg) },
        model: bg.model,
        learned_at: bg.learned_at
      };
    },

    /** The empty room of a node in a ward: summary and model, or null. */
    getBackground(wardId, deviceId) {
      const bg = backgrounds.get(key(wardId, deviceId));
      return bg ? { ...summaryOf(bg), model: bg.model } : null;
    },

    /**
     * Starts learning the empty room. The node must be placed in the ward (saved)
     * and scanning. Throws HttpError 400/409 with a message for the user.
     */
    startLearning({ wardId, deviceId, countdownS, durationS, learnedBy = null }) {
      const p = placements.get(deviceId);
      if (!p || p.ward_id !== wardId) {
        throw new HttpError(409, `LiDAR node ${deviceId} is not in the saved setup of ${wardId}. Assign it in Panel 3b and press Save Changes first.`);
      }
      const running = learning.get(deviceId);
      if (running && (running.state === 'COUNTDOWN' || running.state === 'RECORDING' || running.state === 'SAVING')) {
        throw new HttpError(409, `The empty room of ${deviceId} is already being learned.`);
      }
      const s = live.get(deviceId);
      const t = now();
      if (!s || s.lastAt === null || t - s.lastAt > SCANNING_FRESH_MS) {
        throw new HttpError(409, `LiDAR node ${deviceId} is not sending turns. Check that it is on and scanning (Devices page).`);
      }
      const countdown = wholeNumber(countdownS, 'countdown_s', 0, LEARN_MAX_COUNTDOWN_S, LEARN_COUNTDOWN_S);
      const duration = wholeNumber(durationS, 'duration_s', LEARN_MIN_DURATION_S, LEARN_MAX_DURATION_S, LEARN_DURATION_S);
      const session = {
        ward_id: wardId, device_id: deviceId, learned_by: learnedBy,
        countdown_s: countdown, duration_s: duration,
        created_at: t, starts_at: t + countdown * 1000, ends_at: t + (countdown + duration) * 1000,
        state: countdown > 0 ? 'COUNTDOWN' : 'RECORDING', turns: [], result: null, error: null, timer: null
      };
      learning.set(deviceId, session);
      // A little after the end, so the last turn has arrived
      session.timer = setTimer(() => {
        finishLearning(session).catch(err => fail(session, err.message));
      }, session.ends_at - t + 300);
      logger.info(`[ROOM SENSOR] Learning the empty room for ${deviceId} in ${wardId}: starts in ${countdown} s, ${duration} s long.`);
      return learningView(session);
    },

    /** Stops learning without saving. Returns true when something was stopped. */
    cancelLearning(deviceId) {
      const session = learning.get(deviceId);
      if (!session || (session.state !== 'COUNTDOWN' && session.state !== 'RECORDING')) return false;
      if (session.timer) clearTimer(session.timer);
      learning.delete(deviceId);
      logger.info(`[ROOM SENSOR] Learning the empty room for ${deviceId} cancelled.`);
      return true;
    },

    /** The running or last learning of a node, or null. */
    learningStatus(deviceId) {
      return learningView(learning.get(deviceId));
    },

    /**
     * What the ward editor shows for a node in a ward: the newest turn and the
     * directions new in the room, the empty room, the moved check, learning.
     */
    getScanView(wardId, deviceId) {
      const s = live.get(deviceId);
      const bg = backgrounds.get(key(wardId, deviceId));
      const p = placements.get(deviceId);
      const t = now();
      let scan = null;
      if (s && s.lastFrame) {
        const f = s.lastFrame;
        scan = {
          mac: s.mac, age_ms: t - s.lastAt, sequence: f.sequence, turn_ms: f.turnMs, samples: f.samples, valid: f.valid,
          distances_mm: Array.from(f.distancesMm),
          foreground_bins: bg ? foregroundBins(f.distancesMm, bg.model) : null
        };
      }
      const placedHere = !!(p && p.ward_id === wardId);
      const m = s ? s.moved : null;
      return {
        ward_id: wardId,
        device_id: deviceId,
        placed_in_ward: placedHere,
        scan,
        background: summaryOf(bg),
        moved: bg && placedHere && m
          ? { suspected: m.suspected, since: m.since, farther_pct: Math.round(m.ema * 10) / 10, turns_checked: m.turns }
          : null,
        learning: learningView(learning.get(deviceId))
      };
    },

    /**
     * The scan to line the LiDAR up with: the empty room when learned for this
     * ward, else the median of the last turns. null when there is neither.
     */
    scanForAlignment(wardId, deviceId) {
      const bg = backgrounds.get(key(wardId, deviceId));
      if (bg) return { source: 'EMPTY_ROOM', turns: bg.model.turns, distancesMm: bg.model.median_mm };
      const s = live.get(deviceId);
      if (s && s.recent.length >= 10 && now() - s.lastAt <= SCANNING_FRESH_MS) {
        return { source: 'LIVE', turns: s.recent.length, distancesMm: recentMedian(s) };
      }
      return null;
    }
  };
}

// The server's own instance
let serverInstance = null;
function instance() {
  if (!serverInstance) {
    const store = require('./room_sensor_store');
    const roomSensorService = require('./room_sensor_service');
    const { broadcastToClients } = require('../websocket_service');
    serverInstance = createRoomSensorManager({
      loadPlacements: store.loadPlacements,
      loadBackgrounds: store.loadBackgrounds,
      saveBackground: store.saveBackground,
      onFrame: (listener) => roomSensorService.onFrame(listener),
      broadcast: broadcastToClients
    });
  }
  return serverInstance;
}

module.exports = {
  createRoomSensorManager,
  instance,
  LEARN_COUNTDOWN_S,
  LEARN_DURATION_S,
  MOVED_ON_PCT,
  MOVED_OFF_PCT
};
