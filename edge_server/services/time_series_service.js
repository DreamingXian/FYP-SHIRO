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
      path: `/api/v2/write?org=${encodeURIComponent(org)}&bucket=${encodeURIComponent(bucket)}&precision=s`,
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

function queuePoint(line) {
  writeBuffer.push(line);
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
function logVitals({ patientId, wristbandMac, bpm, spo2, quality = 0.95, mode = 'ACTIVE_STREAM' }) {
  if (!bpm && !spo2) return;
  const pId = patientId || 'UNASSIGNED';
  const mac = wristbandMac || 'UNKNOWN_MAC';
  const q = parseFloat(quality).toFixed(2);
  const m = mode || 'ACTIVE_STREAM';

  const line = `patient_vitals,patient_id=${pId},wristband_mac=${mac},sampling_mode=${m} heart_rate=${parseInt(bpm, 10)}i,spo2_percentage=${parseFloat(spo2).toFixed(1)},ppg_signal_quality=${q}`;
  queuePoint(line);
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
 * Table 4.10: accel_freefall_min_g (Float, g), accel_impact_max_g (Float, g)
 */
function logFallVector({ wristbandMac, minG = 0.35, impactG = 3.42, alertLevel = 'CRITICAL' }) {
  const mac = wristbandMac || 'UNKNOWN_MAC';
  const line = `kinematic_fall_vectors,wristband_mac=${mac},alert_level=${alertLevel} accel_freefall_min_g=${parseFloat(minG).toFixed(2)},accel_impact_max_g=${parseFloat(impactG).toFixed(2)}`;
  queuePoint(line);
}

/**
 * 4. Query Historical Vitals via Flux (Table 4.10: 30-Day Vitals Retention)
 */
function queryVitalsHistory(patientId, range = '-24h', wristbandMac = null, deviceId = null) {
  return new Promise((resolve) => {
    let idFilter = `r.patient_id == "${patientId}"`;
    if (wristbandMac) idFilter += ` or r.wristband_mac == "${wristbandMac}"`;
    if (deviceId && deviceId !== patientId) idFilter += ` or r.patient_id == "${deviceId}"`;

    const flux = `
      from(bucket: "${bucket}")
        |> range(start: ${range})
        |> filter(fn: (r) => r._measurement == "patient_vitals" and (${idFilter}))
        |> filter(fn: (r) => r._field == "heart_rate" or r._field == "spo2_percentage")
        |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
        |> sort(columns: ["_time"], desc: false)
        |> limit(n: 500)
    `;

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

        // Parse CSV into structured points array
        const points = [];
        const lines = csvData.trim().split('\n');
        let header = [];

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line || line.startsWith('#')) continue;

          const parts = line.split(',');
          if (parts.includes('_time') && parts.includes('heart_rate')) {
            header = parts;
            continue;
          }

          if (header.length > 0 && parts.length === header.length) {
            const timeIdx = header.indexOf('_time');
            const hrIdx = header.indexOf('heart_rate');
            const spo2Idx = header.indexOf('spo2_percentage');

            if (timeIdx !== -1) {
              points.push({
                time: parts[timeIdx],
                heart_rate: hrIdx !== -1 && parts[hrIdx] ? Math.round(parseFloat(parts[hrIdx])) : null,
                spo2: spo2Idx !== -1 && parts[spo2Idx] ? Math.round(parseFloat(parts[spo2Idx]) * 10) / 10 : null
              });
            }
          }
        }

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
  flushBuffer
};

