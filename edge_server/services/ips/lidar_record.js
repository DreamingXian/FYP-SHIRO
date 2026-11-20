// =============================================================================
// SHIRO Edge Server - LiDAR turns recorded with a position-test run (Phase 10)
// While a run counts down and records, every turn of the ward's LiDAR nodes is
// kept, together with where each LiDAR stands, its empty room, and the
// wristband's positions four times a second (also during the countdown, while
// the tester walks to the spot). Saved next to the session as
//   <session>-run<n>.lidar.json.gz
// so LiDAR positioning can be developed and checked against the marked spots
// offline, with the same turns every time.
//
// File (gzip JSON), format "shiro-lidar-run" version 1:
//   session_id, run, ward_id, tag_id, created_at, starts_at, ends_at (ms epoch)
//   truth: { x, y, zone, spot, posture, facing }
//   bins: 720, deg_per_bin: 0.5
//   sensors: [{ sensor_id, device_id, x, y, base_height, heading_deg,
//               background: null | { learned_at, turns, coverage_pct, unsteady_pct,
//                                    median_mm, near_mm (base64 u16 LE), hit_pct (base64 u8) } }]
//   frames:  [{ t_ms (from starts_at, negative in the countdown), device_id,
//               sequence, turn_ms, samples, valid, d (base64 u16 LE, 720 distances mm) }]
//   track:   [{ t_ms, status, source, x, y, ble_x, ble_y, raw_x, raw_y, motion_state }]
// =============================================================================
const zlib = require('zlib');
const { BINS, DEG_PER_BIN } = require('../room_sensor/scan_frame');

const FORMAT = 'shiro-lidar-run';
const VERSION = 1;

function encodeU16(values) {
  const buf = Buffer.alloc(values.length * 2);
  for (let i = 0; i < values.length; i++) buf.writeUInt16LE(Math.max(0, Math.min(65535, Math.round(values[i] || 0))), i * 2);
  return buf.toString('base64');
}

function decodeU16(text) {
  const buf = Buffer.from(String(text || ''), 'base64');
  const out = new Array(Math.floor(buf.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = buf.readUInt16LE(i * 2);
  return out;
}

function encodeU8(values) {
  return Buffer.from(values.map(v => Math.max(0, Math.min(255, Math.round(v || 0))))).toString('base64');
}

function decodeU8(text) {
  return Array.from(Buffer.from(String(text || ''), 'base64'));
}

/** A sensor as recorded: where it stands and its empty room (model arrays encoded). */
function sensorEntry(s) {
  const bg = s.background;
  return {
    sensor_id: s.sensor_id, device_id: s.device_id, x: s.x, y: s.y, base_height: s.base_height, heading_deg: s.heading_deg,
    background: bg && bg.model
      ? {
          learned_at: bg.learned_at, turns: bg.model.turns, coverage_pct: bg.model.coverage_pct, unsteady_pct: bg.model.unsteady_pct,
          median_mm: encodeU16(bg.model.median_mm), near_mm: encodeU16(bg.model.near_mm), hit_pct: encodeU8(bg.model.hit_pct)
        }
      : null
  };
}

/** A turn as recorded. */
function frameEntry(tMs, deviceId, frame) {
  return {
    t_ms: tMs, device_id: deviceId, sequence: frame.sequence, turn_ms: frame.turnMs,
    samples: frame.samples, valid: frame.valid, d: encodeU16(frame.distancesMm)
  };
}

/** The file's bytes. */
function pack(record) {
  return zlib.gzipSync(Buffer.from(JSON.stringify({ format: FORMAT, version: VERSION, bins: BINS, deg_per_bin: DEG_PER_BIN, ...record })));
}

/**
 * Reads a file's bytes back, with the distances and empty rooms as plain arrays.
 * Throws when the bytes are not such a file.
 */
function unpack(bytes) {
  const record = JSON.parse(zlib.gunzipSync(bytes).toString('utf8'));
  if (record.format !== FORMAT || record.version !== VERSION) throw new Error('not a LiDAR run record this server can read');
  return {
    ...record,
    sensors: (record.sensors || []).map(s => ({
      ...s,
      background: s.background
        ? {
            ...s.background,
            model: {
              version: 1, bins: BINS, turns: s.background.turns, coverage_pct: s.background.coverage_pct, unsteady_pct: s.background.unsteady_pct,
              median_mm: decodeU16(s.background.median_mm), near_mm: decodeU16(s.background.near_mm), hit_pct: decodeU8(s.background.hit_pct)
            }
          }
        : null
    })),
    frames: (record.frames || []).map(f => ({ ...f, distancesMm: decodeU16(f.d), d: undefined }))
  };
}

module.exports = { FORMAT, VERSION, sensorEntry, frameEntry, pack, unpack, encodeU16, decodeU16 };
