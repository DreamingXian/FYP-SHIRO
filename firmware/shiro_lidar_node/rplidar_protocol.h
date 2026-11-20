// =============================================================================
// SHIRO LiDAR Node - RPLIDAR serial protocol (standard scan mode)
//
// The requests and answers this node uses to talk to a SLAMTEC RPLIDAR C1
// (also understood by the A and S series). Plain C++ without Arduino calls,
// so the PC host tests (firmware/tests) compile exactly this code.
//
// Request:   A5 <command> (no payload for the commands used here)
// Answer:    descriptor A5 5A <30-bit length, 2-bit mode> <data type>, then data
// Scan data: 5-byte samples, about 5000 per second at 460800 baud:
//   byte 0  bit 0 = start of a new turn (S), bit 1 = not S, bits 2-7 = quality
//   byte 1  bit 0 = check bit (always 1), bits 1-7 = angle_q6 bits 0-6
//   byte 2  angle_q6 bits 7-14            (angle in degrees = angle_q6 / 64)
//   byte 3  distance_q2 low byte
//   byte 4  distance_q2 high byte         (distance in mm = distance_q2 / 4)
// The angle grows clockwise seen from above, 0 degrees at the triangle on top.
// =============================================================================
#pragma once

#include <stddef.h>
#include <stdint.h>

namespace rplidar {

const uint8_t SYNC_A = 0xA5;          // first byte of every request and descriptor
const uint8_t SYNC_B = 0x5A;          // second byte of every descriptor

// Requests (2 bytes each)
const uint8_t CMD_STOP = 0x25;        // stop scanning: laser and motor off; no answer
const uint8_t CMD_RESET = 0x40;       // restart the LiDAR core; no answer
const uint8_t CMD_SCAN = 0x20;        // standard scan; 5-byte samples until STOP
const uint8_t CMD_GET_INFO = 0x50;    // model, firmware, hardware, serial number
const uint8_t CMD_GET_HEALTH = 0x52;  // status and error code

// Data types in the descriptor
const uint8_t TYPE_SCAN = 0x81;
const uint8_t TYPE_INFO = 0x04;
const uint8_t TYPE_HEALTH = 0x06;

const size_t DESCRIPTOR_SIZE = 7;
const size_t SAMPLE_SIZE = 5;
const size_t INFO_SIZE = 20;
const size_t HEALTH_SIZE = 3;

// Health status values
const uint8_t HEALTH_GOOD = 0;
const uint8_t HEALTH_WARNING = 1;
const uint8_t HEALTH_ERROR = 2;

struct Descriptor {
  uint32_t length;  // bytes per answer (per sample for a scan)
  uint8_t mode;     // 0 = single answer, 1 = answers until stopped
  uint8_t type;
};

// Reads a 7-byte descriptor. Returns false when it does not start with A5 5A.
inline bool parseDescriptor(const uint8_t* b, Descriptor& out) {
  if (b[0] != SYNC_A || b[1] != SYNC_B) return false;
  const uint32_t v = (uint32_t)b[2] | ((uint32_t)b[3] << 8) | ((uint32_t)b[4] << 16) | ((uint32_t)b[5] << 24);
  out.length = v & 0x3FFFFFFFu;
  out.mode = (uint8_t)(v >> 30);
  out.type = b[6];
  return true;
}

struct Info {
  uint8_t model;
  uint8_t firmwareMinor;
  uint8_t firmwareMajor;
  uint8_t hardware;
  uint8_t serial[16];
};

inline void parseInfo(const uint8_t* b, Info& out) {
  out.model = b[0];
  out.firmwareMinor = b[1];
  out.firmwareMajor = b[2];
  out.hardware = b[3];
  for (size_t i = 0; i < 16; i++) out.serial[i] = b[4 + i];
}

struct Health {
  uint8_t status;      // HEALTH_GOOD, HEALTH_WARNING or HEALTH_ERROR
  uint16_t errorCode;
};

inline void parseHealth(const uint8_t* b, Health& out) {
  out.status = b[0];
  out.errorCode = (uint16_t)(b[1] | ((uint16_t)b[2] << 8));
}

inline const char* healthName(uint8_t status) {
  switch (status) {
    case HEALTH_GOOD: return "OK";
    case HEALTH_WARNING: return "WARNING";
    case HEALTH_ERROR: return "ERROR";
    default: return "UNKNOWN";
  }
}

struct Sample {
  bool start;          // first sample of a new turn
  uint8_t quality;     // 0-63
  float angleDeg;      // 0 to <360, clockwise seen from above
  float distanceMm;    // 0 = no return in this direction
};

// Decodes one 5-byte scan sample. Returns false when the check bits are wrong:
// the byte stream is out of step (see SampleStream).
inline bool decodeSample(const uint8_t* b, Sample& out) {
  const bool s = (b[0] & 0x01) != 0;
  const bool notS = (b[0] & 0x02) != 0;
  if (s == notS) return false;
  if ((b[1] & 0x01) == 0) return false;
  out.start = s;
  out.quality = (uint8_t)(b[0] >> 2);
  const uint16_t angleQ6 = (uint16_t)((b[1] >> 1) | ((uint16_t)b[2] << 7));
  out.angleDeg = (float)angleQ6 / 64.0f;
  const uint16_t distanceQ2 = (uint16_t)(b[3] | ((uint16_t)b[4] << 8));
  out.distanceMm = (float)distanceQ2 / 4.0f;
  return true;
}

// Builds the 5 bytes of a sample (used by the host tests).
inline void encodeSample(bool start, uint8_t quality, uint16_t angleQ6, uint16_t distanceQ2, uint8_t* out) {
  out[0] = (uint8_t)(((quality & 0x3F) << 2) | (start ? 0x01 : 0x02));
  out[1] = (uint8_t)(((angleQ6 & 0x7F) << 1) | 0x01);
  out[2] = (uint8_t)((angleQ6 >> 7) & 0xFF);
  out[3] = (uint8_t)(distanceQ2 & 0xFF);
  out[4] = (uint8_t)(distanceQ2 >> 8);
}

// Cuts the scan byte stream into samples. A byte that breaks the check bits is
// dropped and the next byte tried, so the stream gets back in step by itself
// (after a lost byte, or when the scan starts in the middle of a sample).
class SampleStream {
 public:
  // Feeds one byte. Returns true when a valid sample is complete (in out).
  bool push(uint8_t b, Sample& out) {
    window_[have_++] = b;
    if (have_ < SAMPLE_SIZE) return false;
    if (decodeSample(window_, out)) {
      have_ = 0;
      return true;
    }
    for (size_t i = 1; i < SAMPLE_SIZE; i++) window_[i - 1] = window_[i];
    have_ = SAMPLE_SIZE - 1;
    badBytes_++;
    return false;
  }
  void reset() { have_ = 0; }
  uint32_t badBytes() const { return badBytes_; }

 private:
  uint8_t window_[SAMPLE_SIZE] = {0, 0, 0, 0, 0};
  size_t have_ = 0;
  uint32_t badBytes_ = 0;
};

}  // namespace rplidar
