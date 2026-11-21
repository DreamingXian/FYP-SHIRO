// =============================================================================
// SHIRO LiDAR Node - one LiDAR turn as a compact MQTT message
//
// A turn of the RPLIDAR C1 has about 500 samples at uneven angles. The node
// reduces it to 720 fixed directions (every 0.5 degree) and keeps, for each,
// the NEAREST distance measured in that direction during the turn (0 = no
// return). Nearest, because a person in front of a wall must win over the wall.
//
// Message layout (little-endian), version 1, 1452 bytes; docs/protocol.md:
//   0   'S' 'L'            magic
//   2   version            1
//   3   flags              0 (reserved)
//   4   sequence (u16)     counts turns, wraps at 65535
//   6   turn time (u16)    milliseconds this turn took (about 100 at 10 Hz)
//   8   samples (u16)      samples in the turn, with or without a distance
//   10  valid (u16)        samples with a distance
//   12  720 x u16          distance in mm per direction; direction i covers
//                          [i * 0.5, i * 0.5 + 0.5) degrees, clockwise from
//                          the triangle on top of the LiDAR
// Plain C++ without Arduino calls, so the PC host tests compile this code.
// =============================================================================
#pragma once

#include <math.h>
#include <stddef.h>
#include <stdint.h>

namespace scanframe {

const uint16_t BINS = 720;              // 0.5 degree each
const uint8_t MAGIC_0 = 'S';
const uint8_t MAGIC_1 = 'L';
const uint8_t VERSION = 1;
const size_t HEADER_SIZE = 12;
const size_t FRAME_SIZE = HEADER_SIZE + (size_t)BINS * 2;  // 1452 bytes

// The direction (0..719) of an angle in degrees; any angle is wrapped into 0..360.
inline uint16_t binOf(float angleDeg) {
  if (!(angleDeg == angleDeg)) return 0;  // NaN
  float a = fmodf(angleDeg, 360.0f);
  if (a < 0.0f) a += 360.0f;
  int b = (int)(a * 2.0f);
  if (b >= (int)BINS) b -= (int)BINS;
  if (b < 0) b = 0;
  return (uint16_t)b;
}

struct Turn {
  uint16_t bins[BINS];
  uint16_t samples;
  uint16_t valid;

  void clear() {
    for (uint16_t i = 0; i < BINS; i++) bins[i] = 0;
    samples = 0;
    valid = 0;
  }

  // Adds one sample. A distance of 0 (no return) or out of range only counts.
  void add(float angleDeg, float distanceMm) {
    if (samples < 0xFFFF) samples++;
    if (!(distanceMm >= 1.0f) || distanceMm > 65000.0f) return;
    const uint16_t d = (uint16_t)(distanceMm + 0.5f);
    const uint16_t b = binOf(angleDeg);
    if (bins[b] == 0 || d < bins[b]) bins[b] = d;
    if (valid < 0xFFFF) valid++;
  }
};

inline void putU16(uint8_t* p, uint16_t v) {
  p[0] = (uint8_t)(v & 0xFF);
  p[1] = (uint8_t)(v >> 8);
}

// Writes the message into out. Returns its size, or 0 when out is too small.
inline size_t pack(const Turn& turn, uint16_t sequence, uint16_t turnMs, uint8_t flags, uint8_t* out, size_t outSize) {
  if (outSize < FRAME_SIZE) return 0;
  out[0] = MAGIC_0;
  out[1] = MAGIC_1;
  out[2] = VERSION;
  out[3] = flags;
  putU16(out + 4, sequence);
  putU16(out + 6, turnMs);
  putU16(out + 8, turn.samples);
  putU16(out + 10, turn.valid);
  for (uint16_t i = 0; i < BINS; i++) putU16(out + HEADER_SIZE + (size_t)i * 2, turn.bins[i]);
  return FRAME_SIZE;
}

}  // namespace scanframe
