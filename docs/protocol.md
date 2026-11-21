# SHIRO Telemetry Protocol

This document is the single definition of the data that travels from the wristband to the edge server. Firmware and server code must match it.

| Hop | Transport | Format | Defined in code by |
| :--- | :--- | :--- | :--- |
| Wristband to anchor | BLE advertisement, manufacturer data | Binary packet, version 2 | `firmware/*/shiro_packet.h` |
| Anchor to edge server | MQTT over Wi-Fi, topic `shiro/ward-A1/anchor/telemetry`, anchor login required | JSON | `buildTelemetryJson()` in `shiro_anchor_node.ino` |
| Edge server to anchors | MQTT, topic `shiro/control/mode` | JSON | `handleActiveMode()` in `websocket_service.js` |
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

### Broker access

The broker accepts a connection only with the anchor login (`MQTT_ANCHOR_USER` and `MQTT_ANCHOR_PASSWORD` in `edge_server/.env`, the same values as `SHIRO_MQTT_USER` and `SHIRO_MQTT_PASSWORD` in the anchor's `secrets.h`) and a node client ID: `SHIRO_Anchor_` followed by the anchor's Wi-Fi MAC address without colons (`SHIRO_Anchor_A4CF1201F82C`), or `SHIRO_Lidar_` and the MAC address for a LiDAR node (section 5). Rules, in `edge_server/services/mqtt_access.js`:

| | Allowed | Otherwise |
| :--- | :--- | :--- |
| Connect | Anchor login and an anchor or LiDAR client ID | Refused: return code 4 (bad username or password) or 2 (identifier rejected) |
| Publish (anchor) | `shiro/<ward>/anchor/telemetry`, `shiro/discovery` | The connection is closed |
| Publish (LiDAR node) | `shiro/<ward>/lidar/scan`, `shiro/<ward>/lidar/status` | The connection is closed |
| Subscribe | Topics under `shiro/control/` | That subscription is refused (`0x80`); the connection stays open |
| Repeated failures | | 10 failed logins from one address within a minute lock that address out for 60 seconds (return code 5) |

Refused logins are logged once per address every 10 seconds, without the password.

## 3. Edge server to anchors: 1 Hz command

When a clinician selects a patient on the live map, the server asks that wristband to stream its vitals at 1 Hz. The wristband then streams for 120 seconds, a time fixed in its firmware (V5.3; 60 seconds before). Every anchor receives the command; only the anchor named in `target_anchor` carries it out.

```json
{ "cmd": "SET_ACTIVE", "target_tag": "TAG-002", "target_mac": "54:32:04:AB:CD:EF", "target_anchor": "A4:CF:12:01:F8:2C", "duration": 120 }
```

| Field | Meaning |
| :--- | :--- |
| `target_tag` | Device ID of the wristband, or its MAC address when it is not enrolled |
| `target_mac` | BLE address of the wristband |
| `target_anchor` | Wi-Fi MAC of the anchor that heard the wristband most strongly: the median of its last 5 readings within 3.5 seconds (`services/telemetry/tag_hearing.js`) |
| `duration` | Seconds the wristband streams: always 120, its own fixed time. The anchor writes only `ACTIVE` to the wristband, so a length asked for on the dashboard or headset (checked: 5 to 600) is not used. |

Only one anchor connects, because two anchors opening a BLE connection to the same wristband at the same time make both attempts fail. When no anchor has heard the wristband within 3.5 seconds, the server sends nothing and answers the dashboard with an error. The chosen anchor still checks that it has heard the wristband within 3.5 seconds at -82 dBm or stronger before it connects. An anchor ignores a command without `target_anchor`.

## 4. What the server does with anchor messages

Every MQTT message is first checked by `checkAnchorMessage()` (`edge_server/services/telemetry/anchor_message.js`). A message that fails is ignored and logged, at most once per client and reason every 10 seconds:

- The payload must be a JSON object of at most 2048 bytes.
- `anchor_mac` must be a MAC address, and the MAC address in the sender's client ID: an anchor cannot report under another anchor's address.
- `rssi` must be a number from -120 to 0 (0 marks the standby heartbeat).
- `tag_mac` must be a MAC address. When it is not, the wristband part of the message is dropped and only the anchor's presence is recorded.

An enrolled anchor or wristband is known by its device ID, any other by its MAC address. No device ID is assumed.

`normalizeTelemetry()` then turns the telemetry fields into one validated object:

- Heart rate outside 30 to 220, SpO2 outside 70 to 100, and `0` become `null`.
- With `imu_fault`, acceleration and motion become `null`. With `ppg_fault`, heart rate and SpO2 become `null`.
- Fall measurements are kept only while `fall` is true and the impact is greater than 0.
- Acceleration above 28 g is discarded as implausible for a ±16 g sensor (each axis is limited to 16 g, so the total cannot exceed 27.7 g).
- Messages without `v` (firmware older than version 2) are still accepted, without a fall counter or fall measurements.

Alarm rules use the normalised values and the limits in `edge_server/config/clinical_thresholds.js`:

- **Fall:** the first message with `fall` true for a wristband and fall counter opens one incident. Repeats within 90 seconds belong to the same incident.
- **At the door, left the ward (geofence):** only in a ward with a LiDAR; see section 5, "At the door and leaving the ward".
- **Fall after a server restart:** for 90 seconds after start-up, a wristband that is still flagging a fall is matched to the incident already stored for it, so a restart does not raise the same fall twice.
- **Heart rate:** judged only with skin contact. An extreme rate must persist for 5 seconds. An abnormal rate must be confirmed (5 seconds without a break) in two measurement cycles, or last 30 seconds without a break. A silence of more than 10 seconds, or a reading that is not abnormal, ends a series.
- **SpO2:** stored and displayed, but it raises no alarm (`spo2AlarmsEnabled: false` in `config/clinical_thresholds.js`). The wristband's SpO2 formula is not calibrated: in the bench tests of 14 Nov 2026, 68% of the readings on a healthy tester were below 90%. The switch may be turned on after validation against a reference pulse oximeter.
- **Wristband heart rate:** estimated once per second from the last 8 seconds of the pulse signal (`pulse_estimator.h`). A value is reported only when the signal is clearly periodic and three estimates in a row agree; it is the median of the last five. It is withdrawn (`0`) after 4 seconds without a new confirmation. With movement, a loose strap or a weak pulse the wristband therefore reports no heart rate instead of a wrong one. The first value of a measurement takes about 13 seconds. A passive measurement (every 3 minutes) runs until it has delivered a heart rate for 10 seconds, at most 90 seconds, and ends after 5 seconds when the sensor sees no skin.
- **Wristband SpO2:** reported together with a heart rate, from the red and infrared pulse amplitudes of the same 8 seconds. The conversion line is not calibrated for this hardware.

## 5. LiDAR room sensor node (Phase 10)

A LiDAR node (`firmware/shiro_lidar_node/`, an ESP32-S3 with a SLAMTEC RPLIDAR C1) sends what the LiDAR measures, so the server can find the people in the room. It sends distances only, never an image.

### Scan message: `shiro/<ward>/lidar/scan`, binary, version 1

One message per LiDAR turn, about 10 per second, 1452 bytes. The node reduces the turn's samples (about 500, at uneven angles) to 720 fixed directions, every 0.5 degree, and keeps the **nearest** distance measured in each direction. Nearest, because a person in front of a wall must win over the wall. All numbers are little-endian:

| Offset | Size | Field |
| ---: | ---: | :--- |
| 0 | 2 | `'S' 'L'` |
| 2 | 1 | Version, 1 |
| 3 | 1 | Flags, 0 (reserved) |
| 4 | 2 | Sequence number of the turn, wraps at 65535 |
| 6 | 2 | Time the turn took, ms (about 100 at 10 Hz) |
| 8 | 2 | Samples in the turn, with or without a distance |
| 10 | 2 | Samples with a distance |
| 12 | 720 × 2 | Distance in mm per direction, 0 = nothing measured. Direction `i` covers `[i × 0.5°, i × 0.5° + 0.5°)`, clockwise seen from above, 0° at the triangle on top of the LiDAR. |

The layout is defined once for the firmware (`scan_frame.h`) and once for the server (`services/room_sensor/scan_frame.js`). Both are tested against the same bytes. The server refuses a message of another size, without `SL`, or of another version. A gap in the sequence numbers counts as lost turns.

### Status message: `shiro/<ward>/lidar/status`, JSON, every 2 seconds

```json
{ "lidar_mac": "10:B2:C3:D4:E5:F6", "state": "SCANNING", "node_fw": "1.0.1", "model": 65, "lidar_fw": "1.02", "lidar_hw": 18,
  "serial": "…32 hex digits…", "health": "OK", "health_code": 0, "turns_per_s": 10.0, "points_per_turn": 500, "valid_per_turn": 480,
  "turn_ms": 100, "bytes_per_s": 25000, "samples_per_s": 5000, "sent": 120, "send_failed": 0, "overwritten": 0, "bad_bytes": 0,
  "restarts": 0, "wifi_rssi": -55, "uptime_s": 30 }
```

- `state`: `STARTING` (also while the motor spins up, until the first complete turn), `SCANNING`, `NO_ANSWER` (the LiDAR does not answer: wiring or power) or `FAULT`.
- `bytes_per_s`, `samples_per_s`: what arrives from the LiDAR at all, for diagnosis (0 while the motor is not at speed). The server ignores them for now.
- `health`: the LiDAR's own report, `OK`, `WARNING` or `ERROR`. The C1 switches its laser off for a fault, for example a supply below 4.8 V.
- `lidar_mac` must be the MAC address of the sender's client ID. Unknown fields are ignored, and implausible values are stored as null.

The server shows the node on the Devices page (device type `ROOM_SENSOR`, IDs `lidar-001`, …) and on `GET /api/room-sensors/status`.

### In the ward: live scan, empty room, alignment (Phase 10, step 5a)

A node placed in a ward (Panel 3b of the ward editor, saved as `ward_room_sensors`) is used in that ward's coordinates. A return at distance `d` in direction `i` lies at compass bearing `heading + (i + 0.5) × 0.5°` from the LiDAR's `(x, y)`, so at `x + d·sin(bearing)`, `y + d·cos(bearing)` (0° north = +y, 90° east = +x).

| Address | Who | What |
| :--- | :--- | :--- |
| `GET /api/room-sensors/scan?ward_id=&device_id=` | clinician | The newest turn (`distances_mm`, 720 values), `foreground_bins` (directions closer than the empty room, null when none is learned), the empty room's summary, the moved check, learning progress. The ward editor polls it three times a second while 👁 Live scan is on. |
| `POST /api/room-sensors/learn` `{ ward_id, device_id, countdown_s?, duration_s? }` | admin | Learns the empty room: after the countdown (default 15 s, at most 60), records the turns for `duration_s` (default 20, 5–60). Needs the node in the ward's saved setup and sending turns. Fails, and saves nothing, with fewer than half the expected turns (10 a second). |
| `POST /api/room-sensors/learn/cancel` `{ device_id }` | admin | Stops learning; nothing is saved. |
| `POST /api/room-sensors/align` `{ layout, sensor: { device_id, x, y, heading_deg, base_height? } }` | clinician | Where the LiDAR is from its scan of the walls: the x, y and heading (within 0.30 m and 10° of the given ones) at which the returns lie on the drawn walls and the obstacles at least as tall as the scan slice. Uses the learned empty room, else the median of the last 30 turns. Computes only. Reports the fit (`before`/`after`: share of returns within 5 cm of a surface, median distance), a quality (`GOOD`, `FAIR`, `POOR`) and warnings when another heading or a mirrored scan fits clearly better. |

**Empty room** (table `room_sensor_backgrounds`, by ward and node; `services/room_sensor/background.js`): per direction the median distance, the 10th percentile ("near") and the share of turns with a return. A return is **new in the room** when it is more than 10 cm closer than the nearest "near" of its direction and the two next to it, or where none of the three had a surface. People only ever make returns closer. When more than 10 % of the steady directions (a return in at least 60 % of turns) read more than 15 cm farther than the empty room, averaged over about 2 s, the LiDAR has probably been knocked or turned: the server logs it and sends `ROOM_SENSOR_MOVED`, until it is under 5 % again.

WebSocket messages to the dashboards:

| `type` | Fields |
| :--- | :--- |
| `ROOM_SENSOR_LEARNING` | `learning`: state (`COUNTDOWN`, `RECORDING`, `SAVING`, `DONE`, `FAILED`), turns, result or error |
| `ROOM_SENSOR_BACKGROUND` | `ward_id`, `device_id`, `background`: learned_at, learned_by, turns, coverage_pct, unsteady_pct |
| `ROOM_SENSOR_MOVED` | `ward_id`, `device_id`, `suspected` (true/false), `farther_pct` |

**Recorded with the position test:** when the ward has a placed LiDAR, every turn from the start of a run's countdown to its end is saved in `edge_server/data/position_tests/<session>-run<n>.lidar.json.gz`, with where the LiDAR stands, its empty room and the wristband's positions four times a second (`services/ips/lidar_record.js` describes the file). Removing a run removes its file.

### Patient positions from the LiDAR (Phase 10, step 5b)

Every turn of a LiDAR that is placed, has its empty room learned, is not being relearned and is not suspected of having moved goes through three steps (`services/room_sensor/`, run for each ward by `people_service.js`):

1. **People in the turn** (`people.js`). The returns new in the room and inside it (5 cm from the walls) are grouped: neighbouring returns with a gap of at most 3 directions and 0.2 m form a piece, and pieces whose nearest returns are within 0.35 m are joined while the group stays at most 0.9 m wide (a body often shows as torso and arm). A group is a person with at least 9 returns (fewer beyond 3 m: 9 × 3 m / range, at least 4) and at least 0.12 m wide. Its position is the middle of its returns moved 0.10 m farther from the LiDAR, because the LiDAR sees the near side of the body. The slice is about 0.95 m above the floor: a standing or sitting person is seen, a person lying in bed or on the floor is not.
2. **Following** (`people_tracker.js`, one per LiDAR). Each turn's people are matched to those followed, nearest first, within 0.6 m. A person counts once seen in 3 of the last 5 turns and is let go after 1.5 s unseen.
3. **Linking to wristbands** (`lidar_linker.js`, one per ward), by position only; the wristband's motion state is not used. The Bluetooth position used is the unsmoothed estimate of each reading (before the motion lock), averaged over the last 5 s, at least 3 readings. A wristband is linked to a person within 2 m of it when that person is the only one, or at most 0.6 of the next distance, for 1 s; one person per wristband. The link holds while the LiDAR follows the person, and ends when the Bluetooth position stays more than 2.5 m away for 5 s. When the LiDAR loses the linked person, the last position is **held**: near a bed (0.5 m around it) as long as the Bluetooth position does not leave (lying in bed), elsewhere for 10 s. Only a person who appears after the patient was last seen can be the patient again; someone already in the room is not. A patient held in bed is picked up by a person whose track was first seen at that bed (within 0.6 m of it): getting out on either side or at the foot end, the patient is first seen there, while a visitor walking up to the bed was first seen where they came into view. A patient held elsewhere is picked up by a person within 0.8 m of the held position. A held position also ends when the Bluetooth position stays more than 2 m away for 5 s. (Until 21 Nov 2026 the 0.8 m rule applied in bed too; a tester who got out on the far side was first seen about 0.9 m away and stayed a person without a wristband.)

The position of a linked or held patient is the map position, with **source `LIDAR`**, as long as it is renewed (every turn; stale after 1 s). A headset that sees the patient still comes first (`HEADSET`), Bluetooth last (`BLE`). `IPS_POSITION_UPDATE` and `GET` positions then carry, besides `ble_x`/`ble_y`:

| Field | Meaning |
| :--- | :--- |
| `source` | `LIDAR` |
| `lidar_person` | The person followed, `<device_id>#<number>` |
| `lidar_held` | true: the LiDAR lost the patient and the last position is held |
| `lidar_in_bed` | true: held at a bed (probably lying down) |

| Address or message | Who | What |
| :--- | :--- | :--- |
| `GET /api/room-sensors/people?ward_id=` | clinician | The people the ward's LiDARs follow now: `at`, `people: [{ key, x, y, tag_id }]`, `tag_id` the linked wristband or null |
| WebSocket `ROOM_PEOPLE` | dashboards | The same, at most 5 a second per ward, and at once when the number of people changes. The Live Map draws people without a wristband as grey dots. |

The position test records the source of each reading and, for `LIDAR`, whether it was held (`LiDAR held` in the CSV). `tools/replay_lidar_runs.js <session>` runs the recorded runs of a session through the same code and scores the result against the marked spots.

### At the door and leaving the ward (Phase 10)

The door zone is the door's width plus 0.1 m on each side, reaching 1 m into the room (`services/ips/zones.js`; in WARD-005 x 1.29–2.29 m, y 2.47–3.39 m). For a patient whose wristband the LiDAR has linked:

| Kind (`geofence_kind`) | When | Rule |
| :--- | :--- | :--- |
| `AT_DOOR` | The LiDAR has seen the patient in the door zone for 10 s | `door_watch.js`. Stepping out of the zone for less than 3 s does not restart the 10 s; walking through the zone does not count. At most one per patient a minute. |
| `LEFT_WARD` | The LiDAR lost the patient in the door zone and did not see them again before the held position ended | `lidar_linker.js`. A patient lost in the door zone is held as "elsewhere", never as lying in bed, even next to a bed. The hold ends 10 s after the tracker let the person go (1.5 s after the last sighting), so the alert comes about 11.5 s after the patient was last seen; earlier when the Bluetooth position leaves (2 m for 5 s) or the wristband is no longer heard. Someone appearing within 0.8 m before then is the patient again, and there is no alert. |

Each is one `GEOFENCE_BREACH` incident with its `geofence_kind` (`services/alerts/geofence_alerts.js` → `alert_service.recordIncident`), sent as `EMERGENCY_ALERT` to the dashboards and headsets like a fall, with the ward and the spot where the patient was last seen. No alert when:
- a headset sees the patient in that ward (the headset comes first): anywhere for `LEFT_WARD`, away from the door zone for `AT_DOOR`;
- the wristband is not bound to a patient.

After `LEFT_WARD` the wristband is linked again only to a person first seen within 0.5 m of the door zone after the exit (the patient coming back in), not to anyone who was already in the room. Until then its position is Bluetooth. The patient coming back is logged; the alert stays until it is acknowledged.

Limits: no door alerts in a ward without a LiDAR (Bluetooth cannot tell the door zone from the rest of the room); a patient who takes off the wristband and walks out is not followed; when the wristband is linked to the wrong person, that person's door events are reported for the patient.

## 6. Changing the protocol

1. Change `shiro_packet.h` in the wristband folder and copy it over the anchor's copy. For an incompatible change, raise `PACKET_VERSION`.
2. Update this document and the reference packet.
3. Update `buildTelemetryJson()` and `normalize.js` when fields are added.
4. Run `firmware/tests/run_host_tests.bat` and `npm test`. Both check that the copies, the field names and the limits still agree.
5. Flash the wristband and all anchors together.
