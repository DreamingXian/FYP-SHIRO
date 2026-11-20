// =============================================================================
// SHIRO Edge Server - LiDAR scan message (Phase 10)
// One turn of a LiDAR node's RPLIDAR C1, reduced to 720 directions. The layout
// is defined in firmware/shiro_lidar_node/scan_frame.h and docs/protocol.md:
//   0 'S' 'L', 2 version (1), 3 flags, 4 sequence (u16), 6 turn time ms (u16),
//   8 samples (u16), 10 samples with a distance (u16), 12: 720 x u16 distance
//   in mm (0 = no return). Direction i covers [i * 0.5, i * 0.5 + 0.5) degrees,
//   clockwise seen from above, 0 at the triangle on top of the LiDAR.
// =============================================================================

const BINS = 720;
const DEG_PER_BIN = 0.5;
const HEADER_SIZE = 12;
const FRAME_SIZE = HEADER_SIZE + BINS * 2;   // 1452 bytes
const VERSION = 1;

/**
 * Checks and reads a scan message.
 * @param {Buffer} payload
 * @returns {{ok: true, frame: {flags, sequence, turnMs, samples, valid, distancesMm: Uint16Array}} | {ok: false, reason: string}}
 */
function decodeScanFrame(payload) {
  if (!Buffer.isBuffer(payload)) return { ok: false, reason: 'scan message is not binary' };
  if (payload.length !== FRAME_SIZE) return { ok: false, reason: `scan message of ${payload.length} bytes, expected ${FRAME_SIZE}` };
  if (payload[0] !== 0x53 || payload[1] !== 0x4C) return { ok: false, reason: 'not a scan message (does not start with "SL")' };
  if (payload[2] !== VERSION) return { ok: false, reason: `scan message version ${payload[2]}; this server reads version ${VERSION}` };

  const distancesMm = new Uint16Array(BINS);
  for (let i = 0; i < BINS; i++) distancesMm[i] = payload.readUInt16LE(HEADER_SIZE + i * 2);

  return {
    ok: true,
    frame: {
      flags: payload[3],
      sequence: payload.readUInt16LE(4),
      turnMs: payload.readUInt16LE(6),
      samples: payload.readUInt16LE(8),
      valid: payload.readUInt16LE(10),
      distancesMm
    }
  };
}

/**
 * Builds a scan message, as the node does (for tests and the load test).
 * @param {{sequence?: number, turnMs?: number, samples?: number, valid?: number, flags?: number}} header
 * @param {ArrayLike<number>} distancesMm  720 distances in mm
 */
function encodeScanFrame(header, distancesMm) {
  const buf = Buffer.alloc(FRAME_SIZE);
  buf[0] = 0x53;
  buf[1] = 0x4C;
  buf[2] = VERSION;
  buf[3] = header.flags || 0;
  buf.writeUInt16LE((header.sequence || 0) & 0xFFFF, 4);
  buf.writeUInt16LE(Math.min(65535, header.turnMs ?? 100), 6);
  let valid = 0;
  for (let i = 0; i < BINS; i++) {
    const d = Math.max(0, Math.min(65535, Math.round(distancesMm[i] || 0)));
    if (d > 0) valid++;
    buf.writeUInt16LE(d, HEADER_SIZE + i * 2);
  }
  buf.writeUInt16LE(Math.min(65535, header.samples ?? 500), 8);
  buf.writeUInt16LE(Math.min(65535, header.valid ?? valid), 10);
  return buf;
}

module.exports = { BINS, DEG_PER_BIN, HEADER_SIZE, FRAME_SIZE, VERSION, decodeScanFrame, encodeScanFrame };
