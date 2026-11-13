/*
 * =========================================================================================
 *   SHIRO BLE Telemetry Packet - Protocol Version 2
 *
 *   The wristband broadcasts this packet as BLE manufacturer data; every anchor
 *   decodes it. The layout is specified in docs/protocol.md.
 *
 *   THIS FILE EXISTS TWICE and both copies must stay identical:
 *     firmware/shiro_wristband_vitals/shiro_packet.h
 *     firmware/shiro_anchor_node/shiro_packet.h
 *   (An Arduino sketch can only include files from its own folder.)
 *   The PC test program in firmware/tests fails when the copies differ.
 *
 *   Plain C++ with no Arduino dependency.
 *
 *   Byte  Field
 *    0    0x53 'S'  \ magic (doubles as the BLE company identifier)
 *    1    0x48 'H'  /
 *    2    protocol version (2)
 *    3    heart rate in BPM, 0 = no valid reading
 *    4    SpO2 in percent, 0 = no valid reading
 *    5    motion code: 0 stationary, 1 hand movement, 2 walking, 3 fall emergency
 *    6    battery in percent
 *    7    flags: bit0 charging, bit1 skin contact, bit2 fall emergency,
 *                bit3 active streaming, bit4 accelerometer fault, bit5 pulse sensor fault
 *    8-9  total acceleration x100, unsigned, big-endian (1.00 g = 100)
 *   10    fall counter: identifies the most recent fall, +1 per fall, wraps at 255
 *   11-12 peak impact of the most recent fall x100, unsigned, big-endian
 *   13    lowest free-fall value of the most recent fall x100 (0-255)
 *   14    mean post-impact motion of the most recent fall x100 (0-255)
 * =========================================================================================
 */
#ifndef SHIRO_PACKET_H
#define SHIRO_PACKET_H

#include <stddef.h>
#include <stdint.h>

namespace shiro {

const uint8_t PACKET_MAGIC_0 = 0x53;  // 'S'
const uint8_t PACKET_MAGIC_1 = 0x48;  // 'H'
const uint8_t PACKET_VERSION = 2;
const size_t PACKET_V2_LENGTH = 15;

enum MotionCode {
  MOTION_STATIONARY = 0,
  MOTION_HAND_MOVEMENT = 1,
  MOTION_WALKING = 2,
  MOTION_FALL_EMERGENCY = 3
};

const uint8_t FLAG_CHARGING = 0x01;
const uint8_t FLAG_CONTACT = 0x02;
const uint8_t FLAG_FALL = 0x04;
const uint8_t FLAG_ACTIVE = 0x08;
const uint8_t FLAG_IMU_FAULT = 0x10;
const uint8_t FLAG_PPG_FAULT = 0x20;

struct Telemetry {
  uint8_t bpm;        // 0 = no valid reading
  uint8_t spo2;       // 0 = no valid reading
  uint8_t motion;     // MotionCode
  uint8_t battery;    // percent
  bool charging;
  bool contact;
  bool fall;
  bool active;
  bool imuFault;
  bool ppgFault;
  float g;            // total acceleration in g
  uint8_t fallSeq;    // fall counter
  float impactG;      // peak impact of the most recent fall
  float freefallG;    // lowest free-fall value of the most recent fall
  float stillG;       // mean post-impact motion of the most recent fall
};

enum DecodeResult {
  DECODE_OK = 0,
  DECODE_NOT_SHIRO = 1,     // not a SHIRO packet at all
  DECODE_BAD_VERSION = 2,   // a SHIRO packet of a version this code does not know
  DECODE_TOO_SHORT = 3      // version matches but bytes are missing
};

// Converts a value in g to hundredths, limited to 0..maxValue. NaN becomes 0.
inline uint16_t scaleG(float value, uint16_t maxValue) {
  if (!(value > 0.0f)) return 0;
  const float scaled = value * 100.0f + 0.5f;
  if (scaled >= (float)maxValue) return maxValue;
  return (uint16_t)scaled;
}

inline uint8_t clampPercent(int value) {
  if (value < 0) return 0;
  if (value > 100) return 100;
  return (uint8_t)value;
}

inline void encodePacketV2(const Telemetry& t, uint8_t out[PACKET_V2_LENGTH]) {
  const uint16_t g = scaleG(t.g, 65535);
  const uint16_t impact = scaleG(t.impactG, 65535);

  out[0] = PACKET_MAGIC_0;
  out[1] = PACKET_MAGIC_1;
  out[2] = PACKET_VERSION;
  out[3] = t.bpm;
  out[4] = t.spo2;
  out[5] = (uint8_t)(t.fall ? MOTION_FALL_EMERGENCY : t.motion);
  out[6] = t.battery;
  out[7] = (uint8_t)((t.charging ? FLAG_CHARGING : 0) |
                     (t.contact ? FLAG_CONTACT : 0) |
                     (t.fall ? FLAG_FALL : 0) |
                     (t.active ? FLAG_ACTIVE : 0) |
                     (t.imuFault ? FLAG_IMU_FAULT : 0) |
                     (t.ppgFault ? FLAG_PPG_FAULT : 0));
  out[8] = (uint8_t)(g >> 8);
  out[9] = (uint8_t)(g & 0xFF);
  out[10] = t.fallSeq;
  out[11] = (uint8_t)(impact >> 8);
  out[12] = (uint8_t)(impact & 0xFF);
  out[13] = (uint8_t)scaleG(t.freefallG, 255);
  out[14] = (uint8_t)scaleG(t.stillG, 255);
}

inline DecodeResult decodePacket(const uint8_t* data, size_t length, Telemetry& out) {
  if (data == NULL || length < 2 || data[0] != PACKET_MAGIC_0 || data[1] != PACKET_MAGIC_1) {
    return DECODE_NOT_SHIRO;
  }
  // Protocol 1 had no version byte and was 9 bytes long
  if (length < 3 || data[2] != PACKET_VERSION) return DECODE_BAD_VERSION;
  if (length < PACKET_V2_LENGTH) return DECODE_TOO_SHORT;

  const uint8_t flags = data[7];
  out.bpm = data[3];
  out.spo2 = data[4];
  out.motion = data[5] <= MOTION_FALL_EMERGENCY ? data[5] : (uint8_t)MOTION_STATIONARY;
  out.battery = data[6];
  out.charging = (flags & FLAG_CHARGING) != 0;
  out.contact = (flags & FLAG_CONTACT) != 0;
  out.fall = (flags & FLAG_FALL) != 0;
  out.active = (flags & FLAG_ACTIVE) != 0;
  out.imuFault = (flags & FLAG_IMU_FAULT) != 0;
  out.ppgFault = (flags & FLAG_PPG_FAULT) != 0;
  out.g = (float)(((uint16_t)data[8] << 8) | data[9]) / 100.0f;
  out.fallSeq = data[10];
  out.impactG = (float)(((uint16_t)data[11] << 8) | data[12]) / 100.0f;
  out.freefallG = (float)data[13] / 100.0f;
  out.stillG = (float)data[14] / 100.0f;
  if (out.fall) out.motion = (uint8_t)MOTION_FALL_EMERGENCY;
  return DECODE_OK;
}

inline const char* motionName(uint8_t code) {
  switch (code) {
    case MOTION_HAND_MOVEMENT: return "HAND_MOVEMENT";
    case MOTION_WALKING: return "WALKING";
    case MOTION_FALL_EMERGENCY: return "FALL_EMERGENCY";
    default: return "STATIONARY";
  }
}

}  // namespace shiro

#endif  // SHIRO_PACKET_H
