// =============================================================================
// SHIRO Edge Server - Position test (Phase 10, evaluation)
// Measures how close the system places a wristband to where it really is.
// The tester stands on a marked spot (true x, y), chooses facing and posture,
// and starts a run. After a countdown the server reads the wristband's position
// 4 times a second for 20 s and records for every reading:
//   - the position shown on the maps and its source (BLE, LIDAR or HEADSET)
//   - the Bluetooth-only position (ble_x, ble_y) and the solver's raw result
//     before smoothing and the motion locks (raw_x, raw_y)
//   - the zone of each, the motion state, the confidence, every anchor heard
// A session holds the runs of one measurement round (for example "baseline,
// 3 anchors"). Sessions are saved as JSON in edge_server/data/position_tests/
// (git-ignored) after every run, and can be downloaded as CSV.
// When the ward has a LiDAR, its turns are recorded with each run, from the
// start of the countdown to the end, in a file next to the session
// (lidar_record.js), for developing and checking LiDAR positioning offline.
// No patient data: a wristband ID and positions only.
// =============================================================================
const fs = require('fs');
const path = require('path');
const { buildZones, zoneAt } = require('./zones');
const { csvCell } = require('../alerts/incident_csv');
const { HttpError } = require('../../utils/http');
const lidarRecord = require('./lidar_record');

const SAMPLE_INTERVAL_MS = 250;
const DEFAULT_DURATION_S = 20;
const MIN_DURATION_S = 5;
const MAX_DURATION_S = 120;
const DEFAULT_COUNTDOWN_S = 5;
const MAX_COUNTDOWN_S = 30;
const FRESH_MS = 3500;               // an older position counts as "no position" (the IPS stale time)
const FACINGS = ['N', 'E', 'S', 'W'];
const POSTURES = ['STANDING', 'SITTING', 'LYING'];
const SESSION_ID = /^PT-\d{8}-\d{6}$/;
const TAG_ID = /^[A-Za-z0-9:_-]{1,32}$/;
const LABEL = /^[\p{L}\p{N} ._()#,-]{1,40}$/u;

// POSITION_TEST_DIR lets the integration tests keep their sessions out of the real folder
const DEFAULT_DIR = process.env.POSITION_TEST_DIR || path.join(__dirname, '..', '..', 'data', 'position_tests');

// ----------------------------------------------------------------------------
// Storage: one JSON file per session, written through a temporary file
// ----------------------------------------------------------------------------
function fileStore(dir = DEFAULT_DIR) {
  const fileOf = (id) => path.join(dir, `${id}.json`);
  const lidarFileOf = (id, number) => {
    if (!SESSION_ID.test(String(id)) || !Number.isInteger(number) || number < 1) throw new Error('bad session ID or run number');
    return path.join(dir, `${id}-run${number}.lidar.json.gz`);
  };
  return {
    /** The LiDAR turns of a run (bytes from lidar_record.pack). */
    saveLidar(id, number, bytes) {
      fs.mkdirSync(dir, { recursive: true });
      const file = lidarFileOf(id, number);
      fs.writeFileSync(`${file}.tmp`, bytes);
      fs.renameSync(`${file}.tmp`, file);
    },
    loadLidar(id, number) {
      const file = lidarFileOf(id, number);
      return fs.existsSync(file) ? fs.readFileSync(file) : null;
    },
    deleteLidar(id, number) {
      const file = lidarFileOf(id, number);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    },
    save(session) {
      fs.mkdirSync(dir, { recursive: true });
      const file = fileOf(session.id);
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(session));
      fs.renameSync(`${file}.tmp`, file);
    },
    load(id) {
      if (!SESSION_ID.test(String(id))) return null;
      const file = fileOf(id);
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    },
    list() {
      if (!fs.existsSync(dir)) return [];
      const sessions = [];
      for (const name of fs.readdirSync(dir)) {
        if (!/^PT-\d{8}-\d{6}\.json$/.test(name)) continue;
        try {
          sessions.push(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
        } catch {
          // a damaged file is skipped, never fatal
        }
      }
      return sessions;
    }
  };
}

function memoryStore() {
  const sessions = new Map();
  const lidar = new Map();
  const copy = (s) => JSON.parse(JSON.stringify(s));
  return {
    saveLidar: (id, number, bytes) => { lidar.set(`${id}#${number}`, Buffer.from(bytes)); },
    loadLidar: (id, number) => lidar.get(`${id}#${number}`) || null,
    deleteLidar: (id, number) => { lidar.delete(`${id}#${number}`); },
    save: (s) => { sessions.set(s.id, copy(s)); },
    load: (id) => (sessions.has(id) ? copy(sessions.get(id)) : null),
    list: () => [...sessions.values()].map(copy)
  };
}

// ----------------------------------------------------------------------------
// Statistics
// ----------------------------------------------------------------------------
const round = (v, digits = 2) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10 ** digits) / 10 ** digits);
const pct = (k, n) => (n > 0 ? round((100 * k) / n, 1) : null);

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const at = (sorted.length - 1) * p;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

/** Mean, median, 95th percentile, largest error and the share within 0.5, 1.0 and 1.5 m. */
function errorStats(values) {
  const e = values.filter(Number.isFinite).sort((a, b) => a - b);
  const n = e.length;
  if (n === 0) return { n: 0, mean: null, median: null, p95: null, max: null, within_0_5: null, within_1_0: null, within_1_5: null };
  return {
    n,
    mean: round(e.reduce((s, v) => s + v, 0) / n),
    median: round(percentile(e, 0.5)),
    p95: round(percentile(e, 0.95)),
    max: round(e[n - 1]),
    within_0_5: pct(e.filter(v => v <= 0.5).length, n),
    within_1_0: pct(e.filter(v => v <= 1.0).length, n),
    within_1_5: pct(e.filter(v => v <= 1.5).length, n)
  };
}

/** The statistics of a set of samples (one run, or all runs of a session pooled). */
function summarise(samples) {
  const available = samples.filter(s => s.available);
  const withBle = available.filter(s => Number.isFinite(s.ble_error_m));
  const sources = {};
  for (const s of available) sources[s.source] = (sources[s.source] || 0) + 1;
  for (const key of Object.keys(sources)) sources[key] = pct(sources[key], available.length);
  return {
    samples: samples.length,
    available: available.length,
    available_pct: pct(available.length, samples.length),
    final: errorStats(available.map(s => s.error_m)),
    zone_ok_pct: pct(available.filter(s => s.zone_ok).length, available.length),
    ble: errorStats(withBle.map(s => s.ble_error_m)),
    ble_zone_ok_pct: pct(withBle.filter(s => s.ble_zone_ok).length, withBle.length),
    raw: errorStats(available.map(s => s.raw_error_m)),
    sources,
    mean_anchors: available.length ? round(available.reduce((sum, s) => sum + s.anchors.length, 0) / available.length, 1) : null
  };
}

function sessionSummary(session) {
  const all = session.runs.flatMap(r => r.samples);
  const standing = session.runs.filter(r => r.posture === 'STANDING').flatMap(r => r.samples);
  const other = session.runs.filter(r => r.posture !== 'STANDING').flatMap(r => r.samples);
  return { runs: session.runs.length, all: summarise(all), standing: summarise(standing), sitting_lying: summarise(other) };
}

// ----------------------------------------------------------------------------
// CSV
// ----------------------------------------------------------------------------
const BOM = '\uFEFF';
const toCsv = (header, rows) => BOM + [header.map(csvCell).join(','), ...rows.map(r => r.map(csvCell).join(','))].join('\r\n') + '\r\n';

function samplesCsv(session) {
  const header = ['Session', 'Session name', 'Ward', 'Run', 'Spot', 'Posture', 'Facing', 'True x (m)', 'True y (m)', 'True zone',
    'Time (s)', 'Status', 'Available', 'Source', 'x (m)', 'y (m)', 'Error (m)', 'Zone', 'Zone correct',
    'Bluetooth x (m)', 'Bluetooth y (m)', 'Bluetooth error (m)', 'Bluetooth zone correct',
    'Raw x (m)', 'Raw y (m)', 'Raw error (m)', 'Confidence', 'Motion state', 'Anchors heard', 'Anchors (id: filtered RSSI / raw RSSI dBm / distance m)'];
  const rows = [];
  for (const run of session.runs) {
    for (const s of run.samples) {
      rows.push([session.id, session.name, session.ward_id, run.number, run.spot, run.posture, run.facing || '', run.true_x, run.true_y, run.true_zone,
        round(s.t_ms / 1000, 2), s.status, s.available ? 'yes' : 'no', s.source, s.x, s.y, s.error_m, s.zone, s.zone_ok ? 'yes' : 'no',
        s.ble_x, s.ble_y, s.ble_error_m, s.ble_error_m === null ? '' : (s.ble_zone_ok ? 'yes' : 'no'),
        s.raw_x, s.raw_y, s.raw_error_m, s.confidence, s.motion_state, s.anchors.length,
        s.anchors.map(a => `${a.anchor_id}: ${a.rssi} / ${a.raw_rssi} / ${a.distance}`).join('; ')]);
    }
  }
  return toCsv(header, rows);
}

function summaryCsv(session) {
  const header = ['Session', 'Ward', 'Run', 'Spot', 'Posture', 'Facing', 'True x (m)', 'True y (m)', 'True zone',
    'Samples', 'Available (%)', 'Mean error (m)', 'Median error (m)', '95% error (m)', 'Largest error (m)',
    'Within 0.5 m (%)', 'Within 1.0 m (%)', 'Within 1.5 m (%)', 'Zone correct (%)',
    'Bluetooth mean error (m)', 'Bluetooth 95% error (m)', 'Bluetooth zone correct (%)', 'Raw mean error (m)',
    'Source BLE (%)', 'Source LIDAR (%)', 'Source HEADSET (%)', 'Mean anchors heard', 'LiDAR turns recorded'];
  const line = (label, run, st) => [session.id, session.ward_id, label, run ? run.spot : '', run ? run.posture : '', run ? (run.facing || '') : '',
    run ? run.true_x : '', run ? run.true_y : '', run ? run.true_zone : '',
    st.samples, st.available_pct, st.final.mean, st.final.median, st.final.p95, st.final.max,
    st.final.within_0_5, st.final.within_1_0, st.final.within_1_5, st.zone_ok_pct,
    st.ble.mean, st.ble.p95, st.ble_zone_ok_pct, st.raw.mean,
    st.sources.BLE ?? 0, st.sources.LIDAR ?? 0, st.sources.HEADSET ?? 0, st.mean_anchors,
    run ? (run.lidar ? run.lidar.turns : '') : ''];
  const rows = session.runs.map(run => line(run.number, run, run.stats));
  const summary = sessionSummary(session);
  rows.push(line('ALL', null, summary.all), line('STANDING', null, summary.standing), line('SITTING+LYING', null, summary.sitting_lying));
  return toCsv(header, rows);
}

// ----------------------------------------------------------------------------
// The recorder
// ----------------------------------------------------------------------------
function localStamp(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function intInRange(value, name, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${name} must be a whole number from ${min} to ${max}.`);
  return n;
}

/**
 * @param {object} deps
 * @param {Function} deps.getPosition        (tagId) => position as ips_service.getTagPosition, or null
 * @param {Function} deps.getAnchorReadings  (tagId) => [{anchor_id, rssi, raw_rssi, distance, age_ms}]
 * @param {Function} deps.getWardLayout      async (wardId) => ward_service.getWardConfig result, or null
 * @param {object}   [deps.lidar]            { onFrame(listener) => stop, sensorsOfWard(wardId) => [placement with background] }
 * @param {object}   [deps.store]            fileStore() or memoryStore()
 * @param {Function} [deps.now]
 * @param {Function} [deps.setInterval]
 * @param {Function} [deps.clearInterval]
 */
function createPositionTest({ getPosition, getAnchorReadings = () => [], getWardLayout, lidar = null, store = fileStore(), now = Date.now,
  setInterval: startTimer = setInterval, clearInterval: stopTimer = clearInterval } = {}) {
  let active = null;       // { session, run, zoneMap, timer, lidar }
  let lastFinished = null; // { session_id, run }

  function takeSample(run, zoneMap, t) {
    const sample = {
      t_ms: t - run.starts_at, status: 'NO_POSITION', available: false, source: null,
      x: null, y: null, error_m: null, zone: null, zone_ok: false,
      ble_x: null, ble_y: null, ble_error_m: null, ble_zone_ok: false,
      raw_x: null, raw_y: null, raw_error_m: null,
      confidence: null, motion_state: null, ward_id: null, age_ms: null, anchors: []
    };
    const pos = getPosition(run.tag_id);
    if (pos) {
      const age = Number.isFinite(pos.last_seen) ? t - pos.last_seen : null;
      const errorTo = (x, y) => (Number.isFinite(x) && Number.isFinite(y) ? round(Math.hypot(x - run.true_x, y - run.true_y)) : null);
      sample.status = pos.status || 'UNKNOWN';
      sample.ward_id = pos.ward_id || null;
      sample.age_ms = age;
      sample.source = pos.source || 'BLE';
      sample.available = (pos.status === 'ONLINE' || pos.status === 'CHARGING') && pos.ward_id === run.ward_id &&
        Number.isFinite(pos.x) && Number.isFinite(pos.y) && (sample.source !== 'BLE' || age === null || age <= FRESH_MS);
      sample.x = round(pos.x);
      sample.y = round(pos.y);
      sample.error_m = errorTo(pos.x, pos.y);
      sample.zone = zoneAt(zoneMap, pos.x, pos.y).id;
      sample.zone_ok = sample.zone === run.true_zone;
      if (pos.has_ble !== false && Number.isFinite(pos.ble_x) && Number.isFinite(pos.ble_y)) {
        sample.ble_x = round(pos.ble_x);
        sample.ble_y = round(pos.ble_y);
        sample.ble_error_m = errorTo(pos.ble_x, pos.ble_y);
        sample.ble_zone_ok = zoneAt(zoneMap, pos.ble_x, pos.ble_y).id === run.true_zone;
      }
      if (Number.isFinite(pos.raw_x) && Number.isFinite(pos.raw_y)) {
        sample.raw_x = round(pos.raw_x);
        sample.raw_y = round(pos.raw_y);
        sample.raw_error_m = errorTo(pos.raw_x, pos.raw_y);
      }
      sample.confidence = pos.confidence || null;
      sample.motion_state = pos.motion_state || null;
      sample.anchors = (getAnchorReadings(run.tag_id) || []).map(a => ({
        anchor_id: a.anchor_id, rssi: a.rssi, raw_rssi: a.raw_rssi, distance: a.distance, age_ms: a.age_ms
      }));
    }
    run.samples.push(sample);
  }

  /** The wristband's position for the LiDAR record, four times a second from the start of the countdown. */
  function trackTag(rec, run, t) {
    const pos = getPosition(run.tag_id);
    rec.track.push(pos
      ? {
          t_ms: t - run.starts_at, status: pos.status || null, source: pos.source || 'BLE',
          x: round(pos.x), y: round(pos.y),
          ble_x: pos.has_ble === false ? null : round(pos.ble_x), ble_y: pos.has_ble === false ? null : round(pos.ble_y),
          raw_x: round(pos.raw_x), raw_y: round(pos.raw_y), motion_state: pos.motion_state || null
        }
      : { t_ms: t - run.starts_at, status: 'NO_POSITION' });
  }

  /** Saves the LiDAR turns of a finished run next to the session; the run notes how many. */
  function saveLidar(session, run, rec) {
    rec.stop();
    run.lidar = { sensors: rec.sensors.map(s => s.device_id), turns: rec.frames.length, empty_room: rec.sensors.some(s => !!s.background) };
    if (rec.frames.length === 0) return;
    try {
      store.saveLidar(session.id, run.number, lidarRecord.pack({
        session_id: session.id, run: run.number, ward_id: run.ward_id, tag_id: run.tag_id,
        created_at: run.created_at, starts_at: run.starts_at, ends_at: run.ends_at,
        truth: { x: run.true_x, y: run.true_y, zone: run.true_zone, spot: run.spot, posture: run.posture, facing: run.facing },
        sensors: rec.sensors.map(lidarRecord.sensorEntry),
        frames: rec.frames,
        track: rec.track
      }));
    } catch (err) {
      run.lidar.error = `not saved: ${err.message}`;
    }
  }

  function finish() {
    const { session, run, timer } = active;
    stopTimer(timer);
    run.state = 'DONE';
    run.finished_at = now();
    run.stats = summarise(run.samples);
    if (active.lidar) saveLidar(session, run, active.lidar);
    session.runs.push(run);
    session.updated_at = run.finished_at;
    session.summary = sessionSummary(session);
    store.save(session);
    lastFinished = { session_id: session.id, run };
    active = null;
  }

  function tick() {
    if (!active) return;
    const t = now();
    const { run, zoneMap } = active;
    if (active.lidar && t <= run.ends_at) trackTag(active.lidar, run, t);
    if (t < run.starts_at) return;
    if (run.state === 'COUNTDOWN') run.state = 'RECORDING';
    if (t <= run.ends_at) takeSample(run, zoneMap, t);
    if (t >= run.ends_at) finish();
  }

  function liveStatus() {
    if (!active) return null;
    const { session, run } = active;
    const t = now();
    const available = run.samples.filter(s => s.available);
    const last = run.samples[run.samples.length - 1] || null;
    return {
      session_id: session.id,
      session_name: session.name,
      run: {
        number: run.number, spot: run.spot, tag_id: run.tag_id, true_x: run.true_x, true_y: run.true_y, true_zone: run.true_zone,
        facing: run.facing, posture: run.posture, duration_s: run.duration_s, state: run.state
      },
      seconds_to_start: Math.max(0, Math.ceil((run.starts_at - t) / 1000)),
      seconds_left: Math.max(0, Math.ceil((run.ends_at - Math.max(t, run.starts_at)) / 1000)),
      samples: run.samples.length,
      mean_error_so_far: available.length ? round(available.reduce((s, x) => s + x.error_m, 0) / available.length) : null,
      last: last ? { x: last.x, y: last.y, error_m: last.error_m, source: last.source, zone: last.zone, available: last.available } : null
    };
  }

  function sessionListing(s) {
    return {
      id: s.id, name: s.name, ward_id: s.ward_id, created_at: s.created_at, updated_at: s.updated_at, created_by: s.created_by,
      runs: s.runs.length,
      mean_error: s.summary ? s.summary.all.final.mean : null,
      spots: [...new Map(s.runs.map(r => [r.spot, { spot: r.spot, x: r.true_x, y: r.true_y }])).values()]
    };
  }

  return {
    /**
     * Starts a run. Throws HttpError 400/404/409 with a message for the tester.
     */
    async startRun(input = {}, startedBy = null) {
      if (active) throw new HttpError(409, `A run is already in progress (run ${active.run.number} at ${active.run.spot}). Wait for it or cancel it.`);
      const wardId = String(input.ward_id || '');
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(wardId)) throw new HttpError(400, 'ward_id is required.');
      const tagId = String(input.tag_id || '');
      if (!TAG_ID.test(tagId)) throw new HttpError(400, 'tag_id is required (the wristband, for example TAG-002).');
      const layout = await getWardLayout(wardId);
      if (!layout) throw new HttpError(404, `Ward ${wardId} is not known.`);

      const x = Number(input.x);
      const y = Number(input.y);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > layout.length_x || y > layout.width_y) {
        throw new HttpError(400, `The spot must be inside the ward: x from 0 to ${layout.length_x} m, y from 0 to ${layout.width_y} m.`);
      }
      const facing = input.facing === undefined || input.facing === null || input.facing === '' ? null : String(input.facing).toUpperCase();
      if (facing !== null && !FACINGS.includes(facing)) throw new HttpError(400, 'facing must be N, E, S or W.');
      const posture = input.posture ? String(input.posture).toUpperCase() : 'STANDING';
      if (!POSTURES.includes(posture)) throw new HttpError(400, 'posture must be STANDING, SITTING or LYING.');
      const spot = input.spot === undefined || input.spot === null || input.spot === '' ? `(${round(x)}, ${round(y)})` : String(input.spot).trim();
      if (!LABEL.test(spot)) throw new HttpError(400, 'spot must be a short name: letters, digits, spaces and . _ ( ) # , - only.');
      const durationS = intInRange(input.duration_s, 'duration_s', MIN_DURATION_S, MAX_DURATION_S, DEFAULT_DURATION_S);
      const countdownS = intInRange(input.countdown_s, 'countdown_s', 0, MAX_COUNTDOWN_S, DEFAULT_COUNTDOWN_S);

      if (!getPosition(tagId)) {
        throw new HttpError(409, `Wristband ${tagId} has no position yet. Switch it on and check that the ward's anchors hear it (Live Map).`);
      }

      const t = now();
      let session;
      if (input.session_id) {
        session = store.load(String(input.session_id));
        if (!session) throw new HttpError(404, `Session ${input.session_id} is not known.`);
        if (session.ward_id !== wardId) throw new HttpError(409, `Session ${session.id} belongs to ward ${session.ward_id}; start a new session for ${wardId}.`);
      } else {
        const name = String(input.session_name || '').trim() || `Position test ${wardId}`;
        if (!LABEL.test(name)) throw new HttpError(400, 'session_name must be a short name: letters, digits, spaces and . _ ( ) # , - only.');
        session = {
          id: `PT-${localStamp(t)}`, name, ward_id: wardId, room_title: layout.room_title || null,
          created_at: t, updated_at: t, created_by: startedBy,
          ward_snapshot: {
            length_x: layout.length_x, width_y: layout.width_y, height_z: layout.height_z, door: layout.door,
            beds: layout.beds, obstacles: layout.obstacles,
            anchors: (layout.anchors || []).map(a => ({ anchor_id: a.anchor_id, device_id: a.device_id, x: a.x, y: a.y, z: a.z, calibrated_a: a.calibrated_a, calibrated_n: a.calibrated_n }))
          },
          runs: [],
          summary: null
        };
        if (store.load(session.id)) throw new HttpError(409, 'A session was started this same second; try again.');
        store.save(session);
      }

      const zoneMap = buildZones(layout);
      const run = {
        // One more than the highest so far: unique even after a run was discarded (its LiDAR file is named by it)
        number: session.runs.reduce((max, r) => Math.max(max, r.number), 0) + 1,
        ward_id: wardId, spot, tag_id: tagId, true_x: round(x), true_y: round(y), true_zone: zoneAt(zoneMap, x, y).id,
        facing, posture, duration_s: durationS, countdown_s: countdownS,
        created_at: t, starts_at: t + countdownS * 1000, ends_at: t + countdownS * 1000 + durationS * 1000,
        started_by: startedBy, state: countdownS > 0 ? 'COUNTDOWN' : 'RECORDING', samples: [], stats: null
      };
      active = { session, run, zoneMap, timer: null, lidar: null };
      const sensors = lidar ? lidar.sensorsOfWard(wardId).filter(s => s.device_id) : [];
      if (sensors.length > 0) {
        const ids = new Set(sensors.map(s => s.device_id));
        const rec = { sensors, frames: [], track: [], stop: () => {} };
        rec.stop = lidar.onFrame(({ deviceId, frame, at }) => {
          if (ids.has(deviceId) && at >= run.created_at && at <= run.ends_at) rec.frames.push(lidarRecord.frameEntry(at - run.starts_at, deviceId, frame));
        });
        active.lidar = rec;
      }
      active.timer = startTimer(tick, SAMPLE_INTERVAL_MS);
      return liveStatus();
    },

    /** Stops the run in progress without keeping it. */
    cancelRun() {
      if (!active) return false;
      stopTimer(active.timer);
      if (active.lidar) active.lidar.stop();
      active = null;
      return true;
    },

    /** The run in progress (null when none) and the last finished run. */
    getStatus() {
      return { active: liveStatus(), last_finished: lastFinished };
    },

    listSessions(wardId = null) {
      return store.list()
        .filter(s => !wardId || s.ward_id === wardId)
        .sort((a, b) => b.created_at - a.created_at)
        .map(sessionListing);
    },

    getSession(id) {
      const s = store.load(String(id));
      if (!s) throw new HttpError(404, `Session ${id} is not known.`);
      return {
        ...sessionListing(s),
        room_title: s.room_title,
        ward_snapshot: s.ward_snapshot,
        summary: s.summary,
        runs: s.runs.map(r => ({ ...r, samples: undefined, sample_count: r.samples.length }))
      };
    },

    /** Removes one run from a session (a run spoiled by a mistake). */
    discardRun(id, number) {
      const s = store.load(String(id));
      if (!s) throw new HttpError(404, `Session ${id} is not known.`);
      const index = s.runs.findIndex(r => r.number === Number(number));
      if (index < 0) throw new HttpError(404, `Session ${id} has no run ${number}.`);
      s.runs.splice(index, 1);
      try {
        store.deleteLidar(s.id, Number(number));
      } catch {
        // no LiDAR file, or it could not be removed: the run itself is gone
      }
      s.updated_at = now();
      s.summary = s.runs.length ? sessionSummary(s) : null;
      store.save(s);
      return { runs: s.runs.length };
    },

    samplesCsv(id) {
      const s = store.load(String(id));
      if (!s) throw new HttpError(404, `Session ${id} is not known.`);
      return samplesCsv(s);
    },

    summaryCsv(id) {
      const s = store.load(String(id));
      if (!s) throw new HttpError(404, `Session ${id} is not known.`);
      return summaryCsv(s);
    },

    /** The LiDAR turns recorded with a run (lidar_record.unpack), or null. */
    loadLidarRecord(id, number) {
      const bytes = store.loadLidar(String(id), Number(number));
      return bytes ? lidarRecord.unpack(bytes) : null;
    }
  };
}

// The server's own recorder
let serverInstance = null;
function instance() {
  if (!serverInstance) {
    const ipsService = require('../ips_service');
    const wardService = require('../ward_service');
    const roomSensorService = require('../room_sensor/room_sensor_service');
    const roomSensorManager = require('../room_sensor/room_sensor_manager');
    serverInstance = createPositionTest({
      getPosition: (tagId) => ipsService.getTagPosition(tagId),
      getAnchorReadings: (tagId) => ipsService.getTagAnchorReadings(tagId),
      getWardLayout: (wardId) => wardService.getWardConfig(wardId),
      lidar: {
        onFrame: (listener) => roomSensorService.onFrame(listener),
        sensorsOfWard: (wardId) => roomSensorManager.instance().sensorsOfWard(wardId)
      }
    });
  }
  return serverInstance;
}

module.exports = {
  createPositionTest,
  fileStore,
  memoryStore,
  summarise,
  errorStats,
  samplesCsv,
  summaryCsv,
  SAMPLE_INTERVAL_MS,
  instance
};
