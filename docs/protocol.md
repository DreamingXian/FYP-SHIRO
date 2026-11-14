# SHIRO Telemetry Protocol

This document is the single definition of the data that travels from the wristband to the edge server. Firmware and server code must match it.

| Hop | Transport | Format | Defined in code by |
| :--- | :--- | :--- | :--- |
| Wristband to anchor | BLE advertisement, manufacturer data | Binary packet, version 2 | `firmware/*/shiro_packet.h` |
| Anchor to edge server | MQTT over Wi-Fi, topic `shiro/ward-A1/anchor/telemetry` | JSON | `buildTelemetryJson()` in `shiro_anchor_node.ino` |
| Inside the edge server | Function call | Normalised object | `edge_server/services/telemetry/normalize.js` |

One rule applies at every hop: **a value that was not measured is reported as unknown, never replaced by a default.**

## 1. Wristband packet (version 2)

The wristband broadcasts 15 bytes as BLE manufacturer data, about every 100 to 160 ms. With the 3-byte flags field and the 2-byte manufacturer data header, the advertisement uses 20 of the 31 bytes available. Multi-byte values are big-endian.

| Byte | Field | Type | Meaning |
| :--- | :--- | :--- | :--- |
| 0 | Magic | `0x53` ('S') | Identifies a SHIRO packet. Bytes 0 and 1 are also the BLE company identifier field. |
| 1 | Magic | `0x48` ('H') | |
| 2 | Version | uint8 | `2`. A receiver must ignore the rest of any packet with a version it does not know. |
| 3 | Heart rate | uint8 | BPM, 30 to 220. `0` = no valid reading. |
| 4 | SpO2 | uint8 | Percent, 70 to 100. `0` = no valid reading. |
| 5 | Motion | uint8 | `0` stationary, `1` hand movement, `2` walking, `3` fall emergency. |
| 6 | Battery | uint8 | Percent, 0 to 100. |
| 7 | Flags | bit field | See below. |
| 8 to 9 | Acceleration | uint16 | Total acceleration in g, multiplied by 100 (1.00 g = 100). `0` when the accelerometer has failed. |
| 10 | Fall counter | uint8 | Identifies the most recent confirmed fall. Starts at a random value at power-on, increases by 1 per fall, wraps from 255 to 0. |
| 11 to 12 | Peak impact | uint16 | Highest acceleration of the most recent fall, in g multiplied by 100. `0` until the first fall. |
| 13 | Free-fall minimum | uint8 | Lowest acceleration during the free-fall of the most recent fall, in g multiplied by 100 (0 to 2.55 g). |
| 14 | Post-impact motion | uint8 | Mean of \|acceleration − 1 g\| during the 2 seconds that follow a 0.5-second settling time after the impact, in g multiplied by 100 (0 to 2.55 g). |

Flags (byte 7):

| Bit | Mask | Meaning when set |
| :--- | :--- | :--- |
| 0 | `0x01` | Battery is charging |
| 1 | `0x02` | Skin contact detected by the pulse sensor |
| 2 | `0x04` | Fall emergency: a fall was confirmed and its 45-second alert is running |
| 3 | `0x08` | Active streaming mode (1 Hz vitals) |
| 4 | `0x10` | Accelerometer fault: acceleration, motion and fall detection are unavailable |
| 5 | `0x20` | Pulse sensor fault: heart rate and SpO2 are unavailable |
| 6, 7 | | Reserved, sent as 0 |

Values that exceed their field are limited to the field maximum; they never wrap around.

**Reference packet** (also checked by `firmware/tests/host_tests.cpp`):

```
53 48 02 48 62 02 57 0A 00 7B C8 01 B5 0C 06
```

Heart rate 72, SpO2 98, walking, battery 87%, skin contact and active streaming, 1.23 g, fall counter 200, last fall: impact 4.37 g, free-fall minimum 0.12 g, post-impact motion 0.06 g.

### Fall measurements

Bytes 10 to 14 describe the most recent confirmed fall and keep their values after the alert ends. They are meaningful to a receiver only while the fall flag (bit 2) is set. A receiver uses the fall counter to tell a repeated packet of the same fall from a new fall.

### Version history

| Version | Length | Notes |
| :--- | :--- | :--- |
| 1 | 9 bytes | No version byte (byte 2 was the heart rate). No fall counter, fall measurements or fault flags. Not accepted by version 2 anchors. |
| 2 | 15 bytes | Current. |

The wristband and every anchor must run the same version. Flash them in one session.

## 2. Anchor message (JSON over MQTT)

Each anchor publishes one message per wristband it heard, about every 150 ms.

```json
{
  "anchor_mac": "A4:CF:12:01:F8:2C",
  "tag_mac": "54:32:04:AB:CD:EF",
  "rssi": -58,
  "v": 2,
  "bpm": 72,
  "spo2": 98,
  "battery": 87,
  "charging": false,
  "motion": "WALKING",
  "g": 1.23,
  "touch": 1,
  "active": true,
  "fall": false,
  "fall_seq": 200,
  "impact_g": 4.37,
  "freefall_g": 0.12,
  "still_g": 0.06,
  "imu_fault": false,
  "ppg_fault": false,
  "ts": 123456
}
```

| Field | Source | Notes |
| :--- | :--- | :--- |
| `anchor_mac` | Anchor | Wi-Fi MAC of the anchor. The server maps it to the enrolled anchor. |
| `tag_mac` | BLE address | The server maps it to the enrolled wristband. |
| `rssi` | Anchor radio | dBm. Input to positioning. |
| `v` | Anchor | `2`: the telemetry fields follow. `0`: the wristband sent a SHIRO packet of a version this anchor cannot read; only `rssi` is valid. Absent: the wristband was heard but no telemetry packet arrived in this interval. |
| `bpm`, `spo2` | Bytes 3, 4 | `0` = no valid reading. |
| `battery`, `charging` | Byte 6, flag bit 0 | |
| `motion` | Byte 5 | `STATIONARY`, `HAND_MOVEMENT`, `WALKING` or `FALL_EMERGENCY`. |
| `g` | Bytes 8 to 9 | Total acceleration in g. |
| `touch`, `active` | Flag bits 1, 3 | |
| `fall`, `fall_seq` | Flag bit 2, byte 10 | |
| `impact_g`, `freefall_g`, `still_g` | Bytes 11 to 14 | Most recent fall; meaningful while `fall` is true. |
| `imu_fault`, `ppg_fault` | Flag bits 4, 5 | |
| `ts` | Anchor | Milliseconds since the anchor started. Diagnostic only. |

When no wristband has been heard for 2 seconds, the anchor publishes a heartbeat instead: `{"anchor_mac":"…","status":"STANDBY","rssi":0,"ts":…}`.

An anchor tracks up to 16 wristbands and frees the slot of a wristband that has been silent for 30 seconds.

## 3. What the server does with it

`normalizeTelemetry()` turns the JSON into one validated object:

- Heart rate outside 30 to 220, SpO2 outside 70 to 100, and `0` become `null`.
- With `imu_fault`, acceleration and motion become `null`. With `ppg_fault`, heart rate and SpO2 become `null`.
- Fall measurements are kept only while `fall` is true and the impact is greater than 0.
- Acceleration above 28 g is discarded as implausible for a ±16 g sensor (each axis is limited to 16 g, so the total cannot exceed 27.7 g).
- Messages without `v` (firmware older than version 2) are still accepted, without a fall counter or fall measurements.

Alarm rules use the normalised values and the limits in `edge_server/config/clinical_thresholds.js`:

- **Fall:** the first message with `fall` true for a wristband and fall counter opens one incident. Repeats within 90 seconds belong to the same incident.
- **Fall after a server restart:** for 90 seconds after start-up, a wristband that is still flagging a fall is matched to the incident already stored for it, so a restart does not raise the same fall twice.
- **Heart rate:** judged only with skin contact. An extreme rate must persist for 5 seconds. An abnormal rate must be confirmed (5 seconds without a break) in two measurement cycles, or last 30 seconds without a break. A silence of more than 10 seconds, or a reading that is not abnormal, ends a series.
- **SpO2:** stored and displayed, but it raises no alarm (`spo2AlarmsEnabled: false` in `config/clinical_thresholds.js`). The wristband's SpO2 formula is not calibrated: in the bench tests of 14 Nov 2026, 68% of the readings on a healthy tester were below 90%. The switch may be turned on after validation against a reference pulse oximeter.
- **Wristband heart rate:** reported only after three beat intervals have been measured (median), and withdrawn (`0`) when no valid beat has been detected for 6 seconds.

## 4. Changing the protocol

1. Change `shiro_packet.h` in the wristband folder and copy it over the anchor's copy. For an incompatible change, raise `PACKET_VERSION`.
2. Update this document and the reference packet.
3. Update `buildTelemetryJson()` and `normalize.js` when fields are added.
4. Run `firmware/tests/run_host_tests.bat` and `npm test`. Both check that the copies, the field names and the limits still agree.
5. Flash the wristband and all anchors together.
