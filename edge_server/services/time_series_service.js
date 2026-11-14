// =============================================================================
// SHIRO Hospital Edge Server - InfluxDB Time-Series Telemetry Service
// Module: Continuous Biometric Logging & Spatial Trajectories (Table 4.10)
// =============================================================================
const http = require('http');
const config = require('../config/app_config');

const influxUrl = new URL(config.INFLUX_URL || 'http://127.0.0.1:8086');
const token = config.INFLUX_TOKEN;
const org = config.INFLUX_ORG;
const bucket = config.INFLUX_BUCKET;

// Time-series logging needs an API token (INFLUX_TOKEN in edge_server/.env).
// Without one, writes are skipped and history queries return no points.
const enabled = Boolean(token);
if (!enabled) {
  console.warn('[INFLUXDB] INFLUX_TOKEN is not set. Time-series logging and vitals history are disabled.');
}

function isEnabled() {
  return enabled;
}

// Write Buffer for high-frequency batched streaming
let writeBuffer = [];
let flushTimer = null;
const BATCH_INTERVAL_MS = 1000; // Flush write buffer once every 1 second

/**
 * Execute HTTP Line Protocol Write to InfluxDB v2
 */
function sendLineProtocol(lines) {
  return new Promise((resolve) => {
    if (!lines || lines.length === 0) return resolve(true);

    const payload = lines.join('\n');
    const req = http.request({
      host: influxUrl.hostname,
      port: influxUrl.port || 8086,
      path: `/api/v2/write?org=${encodeURIComponent(org)}&bucket=${encodeURIComponent(bucket)}&precision=ms`,
      method: 'POST',
      headers: {
        'Authorization': `Token ${token}`,
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(true);
        } else {
          console.warn(`[INFLUXDB WRITE WARNING] HTTP ${res.statusCode}:`, data);
          resolve(false);
        }
      });
    });

    req.on('error', err => {
      console.warn('[INFLUXDB WRITE ERROR] Could not connect to InfluxDB daemon:', err.message);
      resolve(false);
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Flush buffered Line Protocol points to InfluxDB
 */
async function flushBuffer() {
  if (writeBuffer.length === 0) return;
  const batch = [...writeBuffer];
  writeBuffer = [];
  await sendLineProtocol(batch);
}

// Every point carries its own millisecond timestamp. Without one, InfluxDB
// stamps a whole batch with the same time and keeps only the last point of
// each series. The counter also keeps two points in the same millisecond apart.
let lastTimestampMs = 0;

function nextTimestampMs() {
  lastTimestampMs = Math.max(Date.now(), lastTimestampMs + 1);
  return lastTimestampMs;
}

function queuePoint(line) {
  if (!enabled) return;
  writeBuffer.push(`${line} ${nextTimestampMs()}`);
  if (!flushTimer) {
    flushTimer = setTimeout(async () => {
      flushTimer = null;
      await flushBuffer();
    }, BATCH_INTERVAL_MS);
  }
}

/**
 * 1. Log Patient Physiological Vitals (patient_vitals measurement)
 * Table 4.10: heart_rate (Integer, BPM), spo2_percentage (Float, %), ppg_signal_quality (Float, 0.0-1.0)
 */
function buildVitalsLine({ patientId, wristbandMac, bpm, spo2, quality = 0.95, mode = 'ACTIVE_STREAM' }) {
  // A field is written only when it was measured: an unknown heart rate or
  // SpO2 is left out of the point instead of being stored as 0.
  const fields = [];
  const hr = Number(bpm);
  const ox = Number(spo2);
  if (Number.isFinite(hr) && hr > 0) fields.push(`heart_rate=${Math.round(hr)}i`);
  if (Number.isFinite(ox) && ox > 0) fields.push(`spo2_percentage=${ox.toFixed(1)}`);
  if (fields.length === 0) return null;

  const q = Number(quality);
  if (Number.isFinite(q)) fields.push(`ppg_signal_quality=${q.toFixed(2)}`);

  const pId = patientId || 'UNASSIGNED';
  const mac = wristbandMac || 'UNKNOWN_MAC';
  const m = mode || 'ACTIVE_STREAM';
  return `patient_vitals,patient_id=${pId},wristband_mac=${mac},sampling_mode=${m} ${fields.join(',')}`;
}

function logVitals(point) {
  const line = buildVitalsLine(point || {});
  if (line) queuePoint(line);
}

/**
 * 2. Log Spatial Coordinates (spatial_trajectories measurement)
 * Table 4.10: pos_x (Float, meters), pos_y (Float, meters), estimation_confidence (Float, 0.0-1.0)
 */
function logTrajectory({ patientId, wristbandMac, posX, posY, confidence = 0.92, zone = 'IN_WARD' }) {
  if (posX === undefined || posY === undefined || isNaN(posX) || isNaN(posY)) return;
  const pId = patientId || 'UNASSIGNED';
  const mac = wristbandMac || 'UNKNOWN_MAC';
  const z = zone || 'IN_WARD';

  const line = `spatial_trajectories,patient_id=${pId},wristband_mac=${mac},zone_status=${z} pos_x=${parseFloat(posX).toFixed(2)},pos_y=${parseFloat(posY).toFixed(2)},estimation_confidence=${parseFloat(confidence).toFixed(2)}`;
  queuePoint(line);
}

/**
 * 3. Log Kinematic Fall Vector (kinematic_fall_vectors measurement)
 * Table 4.10: accel_freefall_min_g, accel_impact_max_g, post_impact_motion_g (Float, g)
 * Only measured values are written. With nothing measured, no point is stored.
 */
function buildFallVectorLine({ wristbandMac, minG = null, impactG = null, stillG = null, alertLevel = 'CRITICAL' }) {
  const fields = [];
  const add = (name, value) => {
    if (value === null || value === undefined || value === '') return;
    const n = Number(value);
    if (Number.isFinite(n)) fields.push(`${name}=${n.toFixed(2)}`);
  };
  add('accel_freefall_min_g', minG);
  add('accel_impact_max_g', impactG);
  add('post_impact_motion_g', stillG);
  if (fields.length === 0) return null;

  const mac = wristbandMac || 'UNKNOWN_MAC';
  return `kinematic_fall_vectors,wristband_mac=${mac},alert_level=${alertLevel} ${fields.join(',')}`;
}

function logFallVector(point) {
  const line = buildFallVectorLine(point || {});
  if (line) queuePoint(line);
}

// A wristband stores several readings per second while it measures, so a day
// holds tens of thousands of points. The trend shows one point per window (the
// median of the readings in it), which keeps every range complete with a few
// hundred points. Cutting the list instead would show only one end of the range.
const HISTORY_WINDOWS = { '-1h': '10s', '-6h': '1m', '-24h': '5m', '-7d': '30m', '-30d': '2h' };
const DEFAULT_HISTORY_RANGE = '-24h';
const RAW_RANGE_FORMAT = /^-\d{1,3}[mhd]$/;
const RAW_POINT_LIMIT = 1000;

/**
 * The range and window a history request is answered with. A range that is
 * not in the list is answered with the default range.
 */
function resolveHistoryRange(range) {
  const known = Object.prototype.hasOwnProperty.call(HISTORY_WINDOWS, range);
  const used = known ? range : DEFAULT_HISTORY_RANGE;
  return { range: used, window: HISTORY_WINDOWS[used] };
}

/**
 * Builds the Flux query for one patient's vitals history.
 * Matches on patient_id only: a wristband that is later given to another
 * patient must never bring the previous patient's readings with it.
 *
 * Default: one median point per window over the whole range, stamped with
 * the start of its window.
 * With { raw: true }: the individual readings, the newest RAW_POINT_LIMIT of them.
 */
function buildVitalsHistoryQuery(patientId, range = DEFAULT_HISTORY_RANGE, { raw = false } = {}) {
  const source = (start) => `
      from(bucket: "${bucket}")
        |> range(start: ${start})
        |> filter(fn: (r) => r._measurement == "patient_vitals" and r.patient_id == "${patientId}")
        |> filter(fn: (r) => r._field == "heart_rate" or r._field == "spo2_percentage")`;

  if (raw) {
    // The readings of one patient are spread over several series (one per
    // wristband and sampling mode). They are merged before the newest are taken.
    const start = RAW_RANGE_FORMAT.test(String(range)) ? range : DEFAULT_HISTORY_RANGE;
    return `${source(start)}
        |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
        |> group()
        |> sort(columns: ["_time"], desc: false)
        |> tail(n: ${RAW_POINT_LIMIT})
    `;
  }

  const resolved = resolveHistoryRange(range);
  return `${source(resolved.range)}
        |> group(columns: ["_field"])
        |> toFloat()
        |> aggregateWindow(every: ${resolved.window}, fn: median, createEmpty: false, timeSrc: "_start")
        |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
        |> group()
        |> sort(columns: ["_time"], desc: false)
    `;
}

/**
 * Parses the CSV answer of the vitals history query into points.
 * A field that was not stored for a point comes back as null.
 */
function parseVitalsCsv(csvData) {
  const points = [];
  const lines = String(csvData || '').trim().split(/\r?\n/);
  let header = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;

    const parts = line.split(',');
    if (parts.includes('_time') && (parts.includes('heart_rate') || parts.includes('spo2_percentage'))) {
      header = parts;
      continue;
    }

    if (header.length > 0 && parts.length === header.length) {
      const timeIdx = header.indexOf('_time');
      const hrIdx = header.indexOf('heart_rate');
      const spo2Idx = header.indexOf('spo2_percentage');

      points.push({
        time: parts[timeIdx],
        heart_rate: hrIdx !== -1 && parts[hrIdx] ? Math.round(parseFloat(parts[hrIdx])) : null,
        spo2: spo2Idx !== -1 && parts[spo2Idx] ? Math.round(parseFloat(parts[spo2Idx]) * 10) / 10 : null
      });
    }
  }
  return points;
}

/**
 * 4. Query Historical Vitals via Flux (Table 4.10: 30-Day Vitals Retention)
 */
function queryVitalsHistory(patientId, range = DEFAULT_HISTORY_RANGE, options = {}) {
  return new Promise((resolve) => {
    if (!enabled) return resolve([]);
    const flux = buildVitalsHistoryQuery(patientId, range, options);

    const req = http.request({
      host: influxUrl.hostname,
      port: influxUrl.port || 8086,
      path: `/api/v2/query?org=${encodeURIComponent(org)}`,
      method: 'POST',
      headers: {
        'Authorization': `Token ${token}`,
        'Content-Type': 'application/vnd.flux',
        'Accept': 'application/csv'
      }
    }, res => {
      let csvData = '';
      res.on('data', c => csvData += c);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          console.warn('[INFLUXDB QUERY WARNING] Status', res.statusCode, csvData);
          return resolve([]);
        }

        const points = parseVitalsCsv(csvData);

        resolve(points);
      });
    });

    req.on('error', err => {
      console.warn('[INFLUXDB QUERY ERROR]', err.message);
      resolve([]);
    });

    req.write(flux);
    req.end();
  });
}

module.exports = {
  logVitals,
  logTrajectory,
  logFallVector,
  queryVitalsHistory,
  flushBuffer,
  isEnabled,
  buildVitalsHistoryQuery,
  resolveHistoryRange,
  buildVitalsLine,
  buildFallVectorLine,
  parseVitalsCsv,
  nextTimestampMs
};

