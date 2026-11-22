# SHIRO: Spatial Health Interface & Real-Time Observer

> **MR-Patient Connect (SHIRO)** — Final Year Project (RSWG7)  
> A research prototype for inpatient monitoring: wearable vital-sign and fall telemetry, indoor positioning (IPS) from BLE signal strength, and a Mixed Reality (MR) digital twin of the ward. All data stays on a local edge server; nothing is sent to a cloud service.  
> **Maintainer:** Tan Shou Xian  
> **Repository:** https://github.com/DreamingXian/FYP-SHIRO.git  

---

## 1. Project Overview

**SHIRO** is a healthcare IoT and spatial Mixed Reality monitoring prototype. Patient wristbands measure heart rate, blood oxygen saturation (SpO2, indicative only), battery level and motion, and detect falls on the wristband itself. Stationary wall anchors hear the wristbands' BLE broadcasts; from the signal strength (RSSI) at each anchor the edge server estimates the patient's position in the ward with a 1D Kalman filter per anchor and weighted least-squares multilateration.

### Dual-Role Anchor Architecture
There is no separate gateway hardware. The stationary wall anchors serve a dual role:
1. **Positioning anchors**: measuring the BLE RSSI of each wristband broadcast.
2. **Vitals gateways**: decoding the telemetry the wristband places in its broadcast (heart rate, SpO2, battery, motion state, fall events, sensor faults).

The anchors publish both over Wi-Fi to the MQTT broker built into the edge server. The server computes the position and keeps the web dashboard and the Meta Quest 3 headset in step.

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                SHIRO SYSTEM ARCHITECTURE                               │
└────────────────────────────────────────────────────────────────────────────────────────┘

 [ Tier 1: Patient Wristband ]
   Seeed Studio XIAO ESP32-C6 + MAX30102 PPG + MPU-6050 (6-DOF IMU) + Battery Divider
     │
     └──(BLE advertising, every 62.5–100 ms)
         │  [Telemetry packet v2: vitals, motion, fall, battery, sensor faults]
         ▼
 [ Tier 1.5: Dual-Role Stationary Wall Anchors (Anchor & Gateway) ]
   3x ESP32-WROOM-32E (one firmware for all, identity assigned by the edge server)
     │  - Measures RSSI for multilateration
     │  - Decodes the wristband's telemetry packet
     │
     └──(Wi-Fi, MQTT TCP:1883, anchor login)──► [ Tier 2: Central Edge Server ]
                                  Host PC / Laptop (Node.js)
                                  - Embedded Aedes MQTT Broker (:1883)
                                  - HTTP REST API Server (:3000)
                                  - WebSocket Real-Time Event Server (:3000)
                                  - 1D Kalman Filter on RSSI per anchor
                                  - Weighted Least-Squares Multilateration
                                  - MariaDB / MySQL Relational Database (XAMPP :3306)
                                  - InfluxDB Time-Series Store (:8086, optional)
                                  - Web Operations Dashboard
                                          │
                                          └──(WebSocket JSON:3000)──► [ Tier 3: MR Client ]
                                                                      Meta Quest 3 (Unity 6, Meta XR)
                                                                      - Color Passthrough Digital Twin
                                                                      - In-Situ Walking Patient Hologram
                                                                      - Bed Docking (Headboard/Bedside)
                                                                      - 2-Point Door Frame Calibration
                                                                      - Hand Slate HUD
```

---

## 2. Hardware & Software Stack

### Hardware Fleet
| Role | Microcontroller / Board | Sensors / Modules | Description |
| :--- | :--- | :--- | :--- |
| **Patient Wristband Tag** | Seeed Studio XIAO ESP32-C6 | HW-605 (MAX30102 PPG) + MPU-6050 (6-DOF IMU) + 100k/100k Battery Divider | Wearable node measuring heart rate, SpO2 (indicative), battery % and motion, with on-board fall detection. Broadcasts BLE advertising packets every 62.5–100 ms. |
| **Stationary Wall Anchors (Dual-Role)** | ESP32-WROOM-32E; also ESP32-S3 and Seeed XIAO ESP32-C3 (same firmware) | On-board Wi-Fi + BLE Scanner | Wall-mounted nodes that measure BLE RSSI and decode the wristband telemetry, publishing both to MQTT over Wi-Fi. Not enough WROOM-32E boards were available, so other ESP32 boards fill the extra anchor positions; each anchor's calibration absorbs their different antennas. |
| **LiDAR Room Sensor (Phase 10)** | ESP32-S3 (N16R8) | SLAMTEC RPLIDAR C1 (360° laser range scanner, 10 turns/s) | Sends each LiDAR turn (720 directions, distances only, no image) to the edge server over Wi-Fi/MQTT, so the server can find where people are in the room (`firmware/shiro_lidar_node`). |
| **Central Edge Server** | Local PC / Laptop | 2.4 GHz Wi-Fi / Ethernet | Hosts the embedded MQTT broker, REST API, WebSocket server, positioning engine, MariaDB/MySQL and InfluxDB. |
| **Mixed Reality Headset** | Meta Quest 3 | Color Passthrough + Depth Sensor | Spatial client rendering the 3D ward digital twin, in-situ patient vitals panels and the hand slate. |

*(Note: Standalone ESP32-S3 gateway hardware has been retired; its bridging duties are performed directly by the ESP32 wall anchors).*

### Software & Frameworks
* **MR Client Engine:** Unity 6 (`6000.3.28f1`) Universal Render Pipeline (URP), Meta XR Core SDK, OpenXR
* **Edge Server Runtime:** Node.js (v20.12+), built-in `http` module (no web framework)
* **MQTT Broker:** Aedes (integrated MQTT broker listening on port `1883`)
* **Real-Time Streaming:** `ws` package (bi-directional event streaming on port `3000`)
* **Relational Database:** MariaDB 10.4 as shipped with XAMPP (MySQL-compatible), connection pooling with `mysql2`
* **Time-Series Database:** InfluxDB 2.x for measured vitals and position history (optional: without a token the server runs without it)
* **Frontend Web Dashboard:** Vanilla JavaScript, CSS3 variables, HTML5 Canvas
* **Signal Conditioning & IPS:** 1D Kalman filter on RSSI (`services/kalman_filter.js`), log-distance path-loss model, weighted least-squares multilateration with a weighted-centroid fallback (`services/ips/geometry.js`), motion state machine (`services/ips_service.js`)
* **Embedded Firmware:** Arduino C++ / ESP32 Core with `PubSubClient`, `BLEDevice` and `SparkFun MAX3010x`; the MPU-6050 is read directly over I2C

---

## 3. Completed Modules & Implemented Features

### Tier 1: Embedded IoT & Wearable Biometrics
* **Universal Anchor Firmware (`shiro_anchor_node.ino`):** Identical firmware flashed to all anchor boards without hardcoded IDs. Each anchor is identified by its MAC address; its device ID (for example `ANCHOR-001`), ward and position are assigned on the dashboard when it is enrolled.
* **Dual-Role Anchor Pipeline:** Anchors capture the wristbands' BLE advertising packets, record RSSI for positioning, decode the telemetry packet, and publish JSON over Wi-Fi/MQTT (`shiro/ward-A1/anchor/telemetry`).
* **Connectionless Broadcast Telemetry:** No point-to-point BLE connection is needed for normal monitoring. Every anchor in range hears the same broadcast.
* **On-Chip Triple-Phase Fall Detection:** Wristband runs an embedded kinematic fall state machine (free-fall below 0.5 g for at least 150 ms $\rightarrow$ impact above 2.5 g within 500 ms $\rightarrow$ 0.5 s settling, then stillness for 2 s: mean motion below 0.20 g, or below 0.08 g after an impact under 4 g) on the MPU-6050 (±16 g range). The stricter limit after a soft impact stops the false alarms of a standing wearer whose arm drops against the leg (firmware V5.1, `docs/test_records/phase-3-bench-test.md`, Round 4). A confirmed fall is broadcast with a fall counter and its measured impact, free-fall minimum and post-impact motion. From V5.2 the Serial Monitor shows a `[FALL CHECK]` line for every drop-like movement, saying why it did or did not raise an alarm.
* **Heart Rate Reported Only When It Can Be Measured:** The wristband estimates the heart rate from how regularly the pulse signal repeats over 8 seconds, and reports it only when that is clear and three estimates agree. With movement or a weak signal it reports no reading instead of a wrong value. The sensor (MAX30102) is made for a fingertip. The wristband is worn with the sensor on the outer side of the wrist, at a fixed spot with the strap snug: on that side the result depends on the exact position (evidence in [docs/test_records/heart-rate-measurement.md](docs/test_records/heart-rate-measurement.md)).
* **Vitals Alarms on Heart Rate Only:** Heart-rate alarms need a persisting or repeated abnormal reading (limits in `edge_server/config/clinical_thresholds.js`). SpO2 is displayed as an indicative value and raises no alarm, because the wristband's SpO2 measurement is not calibrated (evidence in [docs/test_records/phase-3-bench-test.md](docs/test_records/phase-3-bench-test.md)).
* **Versioned Telemetry Packet:** The wristband broadcasts a 15-byte packet (version 2) defined once in [docs/protocol.md](docs/protocol.md). A failed accelerometer or pulse sensor is reported by a fault flag; missing values are never replaced by defaults. The raw pulse signal is not transmitted, only the computed results.
* **Battery Sensing & Adaptive Power:** 100k/100k voltage divider on pin `D0` with battery percentage calculation; a passive mode with periodic readings and a 1 Hz active mode requested by the server.

### Tier 2: Edge Server, IPS Engine & Web Dashboard
* **Indoor Positioning (IPS) Engine:**
  * 1D Kalman filter on the RSSI of each anchor–wristband pair, after a median filter, to suppress multipath jitter.
  * Log-distance path-loss model per anchor, with the 3D slant range projected onto the floor using the anchor height and a nominal wristband height.
  * Weighted least-squares multilateration, with a distance-weighted centroid as fallback, and the result kept inside the room.
  * Velocity gate: a distance cannot change faster than a walking patient (1.3 m/s plus 0.35 m RF tolerance), which rejects non-physical jumps.
  * Motion state machine (`STATIONARY`, `HAND_MOVEMENT`, `WALKING`, `SETTLING`) that combines the wristband's motion with the RF track; after walking stops, the position settles on the median of a 1.8 s window.
  * Landmark calibration of each anchor's path-loss parameters ($A$ and $n$) on the dashboard, with a live preview and reset to defaults.
  * **Placement planner (ward editor → 📐 Plan Anchors & LiDAR, Phase 10, `services/ips/placement.js`):** suggests where to mount each anchor and the LiDAR and which way each faces, as an installation sheet to print. Anchors are chosen to lower the expected error over the floor (Cramér–Rao bound for signal-strength positioning, blocked lines count nothing, door and bed areas count twice). The LiDAR goes where it sees the most floor, off the walking routes. Current and suggested layouts are compared. Steps: `SYSTEM_STARTUP_PROCEDURE.md`, section 4.5.
  * **Position test (Live Map → 📏 Position test):** measures the positioning error at marked spots. The tester stands on a spot, the server records the wristband's position 4 times a second for 20 s (shown position and its source, Bluetooth-only position, raw solver position, zone, motion state, every anchor's RSSI), and reports the mean, median, 95 % and largest error and the share in the correct zone (bed, door, rest of the room). Sessions are kept in `edge_server/data/position_tests/` and download as CSV. Steps: `SYSTEM_STARTUP_PROCEDURE.md`, section 9.
  * **LiDAR room sensors (Phase 10):** the node is accepted on its own MQTT topics (`docs/protocol.md`, section 5), enrolled as a `ROOM_SENSOR` and shown on the Devices page with its turns per second and the LiDAR's health. Each ward stores where its LiDAR stands, the height of its base and the direction of its ▲ (ward editor, Panel 3b). In Panel 3b: 👁 Live scan on the floor plan, 🧹 Learn empty room (stored per ward and node; anything closer later is new in the room, and a LiDAR knocked out of place is reported) and 🎯 Align to walls (finds x, y and heading from the scan of the drawn walls; `services/room_sensor/`, `SYSTEM_STARTUP_PROCEDURE.md` section 4.6). Position-test runs also record the LiDAR's turns, for checking LiDAR positioning against the marked spots offline.
  * **Patient positions from the LiDAR (Phase 10, step 5b):** the server finds the people in each LiDAR turn (returns closer than the empty room, grouped, at least body-sized), follows them from turn to turn, and links each to the wristband whose Bluetooth position is near (by position only, not the motion state). A linked patient's map position comes from the LiDAR (source `LIDAR`, about ±0.1 m); a patient who lies down in bed, below the scan slice, keeps their last position. People without a wristband show as grey dots on the Live Map. A headset that sees the patient still comes first, Bluetooth last. Replaying the 31 recorded runs of 21 Nov 2026 gives a mean error of 0.13 m against 1.00 m for Bluetooth (`tools/replay_lidar_runs.js`, `docs/test_records/ips-accuracy-10.md`; `services/room_sensor/people*.js`, `lidar_linker.js`; `SYSTEM_STARTUP_PROCEDURE.md` section 4.7).
* **Web Management Portal** (Phase 11: menu by role, plain words, 8 rows a table page):
  * **Menu:** everyone sees Ward (the overview, first after sign-in), Patients (with their wristbands) and Shift report; admins also see ⚙ Setup (Wards & layout, Devices, System status, Accounts & headsets, Test tools).
  * **Ward overview:** the patients of one ward as tiles (where they are in words, heart rate, why a tile is red or amber) and a card for the chosen patient with large vitals, the heart-rate state ("Measuring… ready in about N s", "No skin contact", "Next reading within 3 min" with the last value) and a 2-minute live-vitals button with a countdown. On the map each patient is a disc with initials and a status ring (red needs help, amber check, blue OK, grey off) and a 🛏 / 🚪 badge; technical layers are in the admin-only Technician details.
  * **Ward Configuration Editor:** Room dimensions, ensuite cut-outs, rotatable beds ($0^\circ, 90^\circ, 180^\circ, 270^\circ$), anchor placement and the LiDAR room sensor, stored in MySQL.
  * **2D Live Ward Map:** Scaled patient marker, movement trail, bed docking status, and wristband unbinding. A patient whom a headset has linked to a person it sees is drawn where the headset sees them (violet dot, 👁, "seen by headset …"), with the Bluetooth estimate as a faint dot and its distance on the card; after 1.5 s without news from the headset the marker goes back to Bluetooth.
  * **Device Provisioning Radar:** Lists nearby devices that are not yet enrolled, with one-click enrollment.
  * **Binding History:** Unbinding a wristband or discharging a patient keeps the binding, with when it ended and who ended it. The ⌚ Wristband history (Patients page) lists every binding (patient, wristband, bound at and by, ended at and by, how it ended, duration), and the patient profile shows the patient's wristbands. Deleting a wristband from the registry keeps its history under its MAC address. The database allows only one active binding per patient and per wristband.
  * **Shift Summary Report (`/shift_report.html`, 📋 Shift report on the Patients page):** the nursing handover report of thesis section 4.7.1 for one ward and one shift (07:00–15:00, 15:00–23:00, 23:00–07:00, set in `edge_server/config/shifts.js`): ward census (patients during the shift, admissions and discharges, beds, wristbands bound and unbound), heart rate and indicative SpO2 per patient (min, mean and max from InfluxDB), an **ATTN** flag with its reasons (a fall, a critical vitals alarm, a ward exit, an unanswered alert, a heart rate outside the alarm limits), the incidents of the shift with who responded and how fast, device status, and handover sign-off lines. Print it or save it as a PDF from the browser. Values that were not measured are shown as such, and when InfluxDB is not running the report says so instead of showing empty vitals. Each report is recorded in the audit log (`GET /api/reports/shift-summary`).
  * **Patient Inpatient Directory:** The admitted patients first, 8 a page; admission from **＋ Admit patient**; medical history, optional height and weight ("not recorded" when empty; the headset uses the height to tell people apart), bed allocation, wristband binding and discharge; a discharged patient is admitted again with a bed (**↩ Admit again**), on the same record.
  * **Test tools (Setup):** Live vitals and motion from the wristband, raw versus Kalman-filtered RSSI per anchor, the wall sensors' messages, and test alarms.
  * **System status (Setup):** Server uptime, memory, response time and database load, and the status of every wall sensor, LiDAR and headset.
* **Clinical Emergency Audit Logging:** Every fall and vitals alarm is written to a MySQL incident log with its own ID (`INC-YYYYMMDD-NNNN`), and its acknowledgement is recorded; measured vitals and positions also go to InfluxDB when it is running. The incident log exports as CSV (`GET /api/alerts/history.csv`, the **⬇ CSV** button): UTF-8 for Excel, local times, empty cells for values that were not measured, and no cell that a spreadsheet would run as a formula. Each export is recorded in the audit log.
* **Every Input Is Checked:** Each value that reaches the edge server over HTTP, WebSocket or MQTT is checked for type, form and range before it is used (`edge_server/utils/validate.js`). A request with a missing or malformed identifier is refused with a 400 response; it is never answered with a default patient, ward or device. Request bodies and messages have size limits, a photo upload is accepted only as PNG, JPEG or WebP by its content, and requests from pages of other websites are refused. The dashboard shows every value from the server as text (`public/js/html_safety.js`), so a name such as `<img src=x onerror=alert(1)>` is displayed, never run.
* **Only the Project's Devices Are Accepted:** The MQTT broker requires the anchor login and an anchor client ID, limits each anchor to its own topics and locks out an address after 10 failed logins. MySQL and InfluxDB listen on the server PC only, the server uses a limited MySQL account, and the firewall opens only the dashboard and MQTT ports on private networks. What is protected, and the known limits (no TLS, unauthenticated BLE, shared anchor login, minimal sign-in), are in [docs/security.md](docs/security.md).
* **Stable Under Continuous Telemetry:** Device presence is kept in memory and written in one batch every 5 s; status changes are written at once. In a 5-minute load test (3 anchors × 2 wristbands at 7 Hz) database queries fell from about 150 to 2.6 per second and memory stayed at about 95 MB instead of growing to 200 MB; a 30-minute run with the real hardware stayed level at 79–83 MB ([docs/test_records/load-test.md](docs/test_records/load-test.md)). Ctrl+C shuts the server down cleanly without losing buffered data; log lines carry a time stamp and a level (`LOG_LEVEL`); a database outage is logged without flooding and the server recovers by itself.
* **Clinician Sign-in and Audit Trail:** The dashboard and API need a signed-in clinician (roles `ADMIN` and `CLINICIAN`; scrypt password hashes, 12-hour HttpOnly session, lockout after 5 wrong passwords). Every change, sign-in and failed sign-in is written to an audit log with who did it; bindings and acknowledgements record the real clinician. A headset is paired once with a 6-digit code from the dashboard and then uses its own revocable token. The ⚙ Setup → Accounts & headsets manages accounts, headset pairings and the audit log ([docs/security.md](docs/security.md)).
* **One Anchor per 1 Hz Command:** The server sends the 1 Hz vitals command through the anchor that hears the wristband most strongly, so two anchors never compete for the same BLE connection. The wristband then streams for 120 s (firmware V5.3).
* **Door Alerts (ward with a LiDAR):** a patient whom the LiDAR follows raises **At the door** after 10 s in the doorway, and **Left the ward** when it loses them at the door and does not see them again (about 11.5 s). Both are geofence incidents with their kind, on the dashboard and the headset, in the incident log, CSV and shift report ([docs/protocol.md](docs/protocol.md), section 5). Not in a ward without a LiDAR; a wristband taken off is not followed.

### Tier 3: Meta Quest 3 Mixed Reality Spatial Client (`quest3_client/`)

> **Two versions (Phase 12, from 22 Nov 2026):** `quest3_client/` is version 1, the working headset app, kept as it is. `quest3_client_v2/` is version 2: a copy of version 1 with the same logic (connection, pairing, room alignment, positions, person linking, alerts) that receives the new interface. Each is its own Unity project; open either in Unity Hub with the same editor version.
>
> Version 2 so far (`Assets/Scripts/ShiroMR/UI/`): one look for every part (`ShiroTheme`, `ShiroUIKit`: dark glass panels, TextMeshPro text, buttons in four kinds, at least 22 mm); buttons pressed like real ones (`ShiroPokeInteractor`: over the button's area, once on reaching the surface, again only after the finger comes back out) and by the ray, with the same hover; the left-hand menu opens only with Meta's palm-up pinch (or Y / B); the **alert card** (`ShiroAlertCard`) in front of the clinician with "I'm responding", "Show me" (an arrow toward the patient) and "Mute"; the **patient tag** (`PatientHologram`) with name, bed, heart rate in words as on the dashboard and a status stripe, keeping its size to the eye, details on a tap. Preview images without a headset: SHIRO → v2: Save UI preview images (`Builds/ui_preview/`).

* **Color Passthrough Digital Twin:** Real-time 3D ward generation (`WardVisualizer.cs`) matching real-world architectural dimensions, walls, doors, obstacles, and hospital beds.
* **Dual-Mode Patient In-Situ Hologram (`PatientHologram.cs`):**
  * **In-Transit Walking Mode:** 0.65 m floor occupancy ring and an eye-level vitals panel that turns to face the clinician.
  * **Bed-Docked Mode:** Detects when the patient is in their bed area and docks the panel to the bed headwall or bedside, aligned with the bed's rotation.
  * **Vitals Panel:** Heart rate with a heart icon pulsing at the measured rate, SpO2 (indicative), motion state badge, and dock mode toggle.
  * **Manual Repositioning Handle:** `[✥ Move]` handle to pinch and drag the panel.
  * **Re-Attach and Auto:** `[🎯 Re-Attach]`, then aim and pinch. Aimed at a detected person (marked by an amber column, "🔗 LINK TO THIS PERSON"), the panel follows that person until they are lost from view, whatever the Bluetooth position says. Aimed where nobody is detected, the panel is pinned to that spot. `[🔄 Auto]` ends either choice.
  * **Status Line:** why the panel is where it is, for example "linked: person 1.62 m, 0.3 m from the wristband" or "nobody within 0.5 m of the wristband: Bluetooth position".
* **Person Detection and Linking (`ShiroDepthProbe.cs`, `ShiroPersonDetection.cs`, `ShiroPersonLinking.cs`, `ShiroPatientLinking.cs`):** a second source of position besides Bluetooth, without a camera image.
  * Five times per second, 40 × 30 rays measure distances with Meta's Depth API. The points are grouped on a 10 cm floor grid into objects with a position and a height. The floor is measured, and walls and the wearer's own hands are left out.
  * A person-sized object (0.9–2.1 m) becomes a person candidate once it has moved at least 0.4 m within 10 s. Each step needs evidence: its old spot is seen empty, or it now stands where empty space was seen before. A still cabinet or a flickering screen is therefore not a person.
  * Each patient panel away from its bed links to the person candidate within 0.5 m of the wristband's Bluetooth position, also scored on the patient's recorded height and the wristband's motion state. Two people who fit equally give "unclear", and no guess is made. A link holds while the Bluetooth position stays within 1.5 m.
  * While linked, the panel stands beside the person with the patient's name above their head, and both maps show the patient at the headset's position.
  * Points are used for one update only; nothing is recorded. Test results and limitations: [docs/test_records/person-linking-8d.md](docs/test_records/person-linking-8d.md).
* **Spatial Room Alignment Tool (`WardAlignmentTool.cs`, `WardSpatialManager.cs`):**
  * 2-point door frame calibration with floor height from the Meta XR environment raycast.
  * 2-point bed calibration (`AlignWardByBedTwoPoints`) and 2-point wall anchor calibration (`AlignWardByWallAnchors`).
  * Persistent spatial anchor, saved on the headset and its ID sent to the server (`/api/ward/save-anchor`).
  * After the headset wakes from sleep, the saved anchor is loaded again by its ID and found in the room again; Re-Sync does the same. Saving checks that the new anchor is localized and tries a second, fresh anchor when the first fails.
  * A spatial anchor exists only on the headset that saved it, so the server keeps one anchor per headset and ward. With **🧭 Auto ward** on, the headset keeps the anchors of its calibrated wards loaded. When it is inside another calibrated ward for 2 s, that ward becomes active and is aligned from its anchor, with no new calibration (tested in one room so far).
* **Emergency Alerts on the Headset (`ShiroAlertManager.cs`):** a fall, critical-vitals or geofence incident makes the patient's panel and floor ring flash red, plays a two-tone alarm and opens the alert on the hand slate. **✓ Acknowledge & Respond** records the headset and the clinician using it (`QUEST3-… (Nurse Lim, CLN-002)`, assigned by an admin on ⚙ Setup → Accounts & headsets) on the server; an alert acknowledged elsewhere turns green with who responded and when, until closed with **OK**. Pending alerts are fetched again after every reconnection.
* **Own Identity per Headset:** Each headset reports its own ID (`QUEST3-` plus 6 characters, derived from the device) and must be enrolled on the dashboard; the ward is chosen on the hand slate, never assumed.
* **Hand Slate HUD (`ShiroHandSlate.cs`, `ShiroHandVisualizer.cs`):**
  * Follows the left palm; hand contour outline and fingertip touch.
  * **Ward Setup:** door frame calibration, save or purge the spatial anchor, re-sync alignment, digital twin overlay on/off.
  * **Location:** find the current ward/room and continuous refresh, with the ward's real beds and anchors only.
  * **Patient:** re-attach the hologram and switch between headboard and bedside mount; the alert status line.
  * **System:** reconnect, server address presets (Wi-Fi, Hotspot, Localhost for Quest Link), headset ID and connection state, pairing. Person linking: **🔗 Linking** (on by default), **🔬 Depth view** (shows the depth points and every object found with its height and state), **🚶 Move rule** (off only to test with height alone) and **🧪 Fake band** (a test panel whose Bluetooth position wanders in front of the wearer).
  * **Live Map (`ShiroWardMiniMap.cs`):** top view of the ward the headset is in (walls, door, beds, anchors) with each wristband's BLE position, this headset's position and heading, and patients with a pending alert blinking red. Wristbands not heard for 10 s turn grey with "last seen". The ward bar shows any other ward without changing the active ward. Tapping a patient opens their card (patient, bed, wristband, live vitals) and requests 1 Hz vitals for 60 s through the strongest anchor. A patient linked to a person seen by a headset is shown at that person's position (violet, 👁), with the Bluetooth estimate as a faint dot.

---

## 4. Hardware Wiring & Pinout

### Wristband Node (Seeed Studio XIAO ESP32-C6)
The HW-605 (MAX30102) and MPU-6050 share the hardware I2C bus, with battery sensing on analog pin `D0`:

| Sensor Pin / Signal | XIAO ESP32-C6 Pin | Function |
| :--- | :--- | :--- |
| **VCC / VIN** | **3.3V** | Regulated Sensor Power |
| **GND** | **GND** | Ground |
| **SDA** | **D4** (GPIO 22) | I2C Data Line |
| **SCL** | **D5** (GPIO 23) | I2C Clock Line |
| **BAT+ (via 100k/100k divider)** | **D0** (GPIO 0) | Analog Battery Voltage Monitor |


### Prototype:
<img width="4608" height="3456" alt="IMG_20261108_073603" src="https://github.com/user-attachments/assets/53cd1721-7a8f-435f-8464-96460933887f" />

---

## 5. Quick Startup Procedure

Detailed step-by-step instructions, including troubleshooting, are in [SYSTEM_STARTUP_PROCEDURE.md](SYSTEM_STARTUP_PROCEDURE.md).

0. **First-time configuration** (once per PC; details in Section 3 of the startup guide):
   * Copy `edge_server/.env.example` to `edge_server/.env` and fill in your own values:

     | Setting | Meaning |
     | :--- | :--- |
     | `HTTP_PORT`, `MQTT_PORT` | Dashboard/WebSocket port (3000) and MQTT port (1883) |
     | `MQTT_ANCHOR_USER`, `MQTT_ANCHOR_PASSWORD` | The login every anchor uses; the same values go into the anchors' `secrets.h` |
     | `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | The limited MySQL account `shiro_app` and the database `shiro_db` |
     | `INFLUX_URL`, `INFLUX_TOKEN`, `INFLUX_ORG`, `INFLUX_BUCKET` | InfluxDB; leave the token empty to run without it |
     | `LOG_LEVEL` | `error`, `warn`, `info` (default) or `debug` |
     | `ENABLE_SIMULATION` | `true` allows the Live Lab's simulated alarms (always marked as simulated in the incident log); `false` outside testing and demonstrations |

   * Copy `firmware/shiro_anchor_node/secrets.example.h` to `secrets.h` and fill in the Wi-Fi name and password, the server PC's IP address, and the MQTT anchor login from `.env`.
   * Both files are git-ignored; credentials are never stored in this repository. Then do the one-time security setup (MySQL account, databases on this PC only, firewall) in Section 3.2 of the startup guide.
1. **Start the databases:** Open XAMPP Control Panel and start MySQL on port `3306`. Start InfluxDB with `edge_server\tools\start_influxdb.bat`.
2. **Launch Edge Server:**
   ```powershell
   cd d:\RSW\FYP\Code\edge_server
   npm start
   ```
   Open the dashboard at `http://localhost:3000` and sign in. On the very first start, create the first admin account there (on the server PC only), then the other accounts on ⚙ Setup → Accounts & headsets (startup guide, Section 3.6).
3. **Power On Hardware Nodes:**
   * **Wristband:** Power the XIAO ESP32-C6 and wear it with the sensor on the outer side of the wrist, strap snug.
   * **Anchors:** Power the ESP32-WROOM-32E nodes. They connect to Wi-Fi and the MQTT broker by themselves and start publishing.
4. **Launch Meta Quest 3 Client:**
   * In Unity Hub, open the project folder `quest3_client/` of this repository with Unity `6000.3.28f1` (platform: Android).
   * Open `Assets/Scenes/SampleScene.unity`, connect the Quest 3 via Quest Link / Air Link and press Play. Person linking needs the depth sensor, which over Link needs **Meta Quest Link app → Settings → Developer → Spatial Data over Meta Quest Link** switched on.
   * Pair the headset once: ⚙ Setup → Accounts & headsets → Create pairing code, then hand slate → System → Pair headset (code).
   * Look at the left palm → **Ward Setup** tab → choose the ward → **Start Door Frame Calibration** and aim at the door frame corners.

### Automated Tests

Run from `edge_server/`:

| Command | What it runs | Needs |
| :--- | :--- | :--- |
| `npm run lint` | ESLint on the server, tests, tools and dashboard code | Nothing |
| `npm test` | Unit tests (filters, positioning maths, incident IDs, binding cache, alarm thresholds, fall de-duplication, telemetry validation, firmware/server contract, input validation, request limits, photo upload, WebSocket and MQTT message checks, MQTT login and topic rules, choice of the anchor for the 1 Hz command, logger, and a check that every value the dashboard places into HTML is escaped) | Nothing. They cannot reach a database: `test/unit/no_database.js` points them at a closed port |
| `npm run test:integration` | Database start-up, restart safety, bindings, incident log, alarm path, the full MQTT-to-dashboard pipeline, refused requests, commands and messages, MQTT access (no login, wrong login, forbidden topics, lockout), batched device presence, OFFLINE detection and clean shutdown, with a real server on spare ports | MySQL running. Uses a separate `shiro_test` database; InfluxDB checks are skipped when it is not running |
| `node tools/load_test.js --duration 300` | Load test: replays anchors (default 3 anchors × 2 wristbands at 7 Hz) against a running server and reports messages per second, database queries per second, memory, event-loop delay and API answer times. Results of 15 Nov 2026: [docs/test_records/load-test.md](docs/test_records/load-test.md) | A server started against `shiro_test`, never the database with real patients |
| `node tools/replay_lidar_runs.js <session-id> [--csv file]` | Runs the LiDAR turns recorded with a position-test session through the server's LiDAR positioning and scores it against the marked spots, next to what the maps showed then | The session's files in `data/position_tests/`; no server, no database |

The headset's person detection and linking are plain C# and are tested outside Unity, from the repository root:

| Command | What it runs | Needs |
| :--- | :--- | :--- |
| `dotnet run --project "quest3_client/Tests~/DetectionTests"` | 69 tests: the person detector, 23 scenes of a ray-cast room simulation (a wearer walking past a rack, a cabinet, a monitor and a chair, with depth noise), the wristband-to-person linking and choosing a person by hand | .NET SDK 10 |
| the same with `-c Release -- --seeds 100` | Every scene with 100 random seeds (path, noise, timing); about 8 minutes. Add a word after the number to run only the scenes whose name contains it | .NET SDK 10 |

GitHub Actions ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs the lint, the unit tests, the integration tests (against a temporary MariaDB 10.4), the headset detection tests and a compile of the anchor and wristband firmware on every push and pull request.

Firmware logic (fall state machine, telemetry packet, heart-rate and SpO2 estimation against recorded pulse signals) is tested on the PC, without a board:

| Command | What it runs | Needs |
| :--- | :--- | :--- |
| `firmware\tests\run_host_tests.bat` | Compiles the same header files the firmware uses and replays synthetic 50 Hz acceleration traces (falls, short dips, claps, arm swings, sitting down) | Visual Studio C++ tools, or any `g++` (see the top of `host_tests.cpp`) |

The wristband also runs a short self-test of the fall state machine at every power-on and prints `[SELF-TEST] Fall detector: PASS` on the Serial Monitor. Hardware bench tests are recorded in [docs/test_records/](docs/test_records/), and each requirement is traced to its code and tests in [docs/traceability.md](docs/traceability.md).

---

## 6. Project Structure

```
Code/
├── .github/workflows/ci.yml        # GitHub Actions: lint, unit + integration tests, firmware compile
├── .gitignore                      # Git exclusion rules (Node, Unity, firmware)
├── README.md                       # Master project overview & feature guide
├── docs/                           # protocol.md (telemetry definition), security.md (protections and limits),
│                                   # traceability.md (requirements → code → tests), test_records/
├── SYSTEM_STARTUP_PROCEDURE.md     # Step-by-step operations & troubleshooting guide
├── firmware/                       # Embedded Arduino C++ firmware
│   ├── shiro_wristband_vitals/     # XIAO ESP32-C6 PPG + IMU wearable firmware
│   │   ├── fall_detector.h         # Fall state machine (Algorithm 3) and its self-test
│   │   ├── shiro_packet.h          # Telemetry packet v2 (identical copy in shiro_anchor_node)
│   │   └── vitals_filter.h         # Accepted vitals range and beat smoothing
│   ├── tests/                      # PC tests for the firmware logic (run_host_tests.bat)
│   ├── shiro_anchor_node/          # ESP32 dual-role anchor & vitals gateway (WROOM-32E, S3 or XIAO C3)
│   │   └── secrets.example.h       # Template for git-ignored secrets.h (Wi-Fi / MQTT settings)
│   └── shiro_lidar_node/           # ESP32-S3 + RPLIDAR C1 room sensor (Phase 10)
│       ├── rplidar_protocol.h      # RPLIDAR requests, answers and scan samples (host-tested)
│       └── scan_frame.h            # One LiDAR turn as a 1452-byte MQTT message (host-tested)
├── edge_server/                    # Central Node.js edge server & web portal
│   ├── server.js                   # Server entrypoint (HTTP, WebSocket, MQTT, clean shutdown)
│   ├── package.json                # Server dependencies & scripts
│   ├── eslint.config.js            # Lint rules (npm run lint)
│   ├── .env.example                # Template for git-ignored .env (ports, MQTT anchor login, MySQL, InfluxDB token)
│   ├── test/                       # Automated tests (unit/ and integration/)
│   ├── tools/                      # start_influxdb.bat (InfluxDB on this PC only), load_test.js, reset_password.js, replay_lidar_runs.js
│   ├── config/                     # Application, network, calibration and alarm threshold configs
│   ├── database/                   # Connection pool, schema/ (tables), seed/ (sample data), migrations
│   ├── controllers/                # Request handlers (Wards, Patients, Devices, Bindings)
│   ├── services/                   # MQTT (with mqtt_access.js: login and topic rules), WebSocket, IPS, alerts, device presence
│   ├── routes/                     # REST API routes on Node's http module
│   ├── utils/                      # Request helpers (size limit, JSON, errors), input validation, logger (LOG_LEVEL)
│   └── public/                     # Single Page Application frontend (HTML/CSS/JS)
│       ├── index.html              # Main dashboard application shell
│       ├── css/                    # Modular stylesheet components & theme
│       ├── js/                     # Client controllers & canvas rendering
│       └── views/                  # HTML module templates
├── quest3_client_v2/               # Version 2 of the headset app: same logic, new interface (Phase 12, in progress)
└── quest3_client/                  # Unity 6 Meta Quest 3 Mixed Reality Client, version 1 (open this folder in Unity Hub)
    ├── Assets/
    │   ├── Scenes/                 # SampleScene.unity
    │   ├── Scripts/ShiroMR/        # C# Spatial MR architecture
    │   │   ├── ShiroMRManager.cs       # Master MR orchestrator & lifecycle
    │   │   ├── ShiroNetworkManager.cs  # WebSocket & REST network client, headset identity
    │   │   ├── ShiroDiagnostics.cs     # Rate-limited error logging, headset ID derivation
    │   │   ├── WardVisualizer.cs       # 3D digital twin room generator
    │   │   ├── WardSpatialManager.cs   # Coordinate math, bed docking, alignment
    │   │   ├── WardAlignmentTool.cs    # 2-point door & bed calibration laser tool
    │   │   ├── PatientHologram.cs      # Dual-mode in-situ vitals hologram & HUD
    │   │   ├── ShiroHandSlate.cs       # 5-tab hand slate HUD
    │   │   ├── ShiroHandVisualizer.cs  # Hand outline contour tracking
    │   │   ├── ShiroVRPointer.cs       # Depth raycast laser pointer
    │   │   ├── ShiroAlertManager.cs    # Emergency alerts on the headset (flash, tone, acknowledge)
    │   │   ├── ShiroWardMiniMap.cs     # Live Map tab (2D ward map)
    │   │   ├── ShiroWardAutoDetect.cs  # Auto ward: recognise a calibrated ward from its saved anchor
    │   │   ├── ShiroDepthProbe.cs      # Depth rays, floor measurement, depth view
    │   │   ├── ShiroPersonDetection.cs # Person detector (plain C#, tested outside Unity)
    │   │   ├── ShiroPersonLinking.cs   # Wristband-to-person linking and aiming at a person (plain C#)
    │   │   ├── ShiroPatientLinking.cs  # Links each panel, reports seen positions, fake wristband
    │   │   └── ShiroDataModels.cs      # Telemetry & JSON data contracts
    │   ├── Plugins/                # NativeWebSocket networking library
    │   ├── Resources/              # Runtime UI fonts & default assets
    │   ├── Settings/               # URP rendering pipelines & volume profiles
    │   └── XR/                     # OpenXR & Meta XR runtime configurations
    ├── Tests~/DetectionTests/      # Tests of person detection and linking (dotnet run; ignored by Unity)
    ├── Packages/                   # Package manifest & lockfiles
    └── ProjectSettings/            # InputSystem, TagManager, QualitySettings
```

---

## 7. Upcoming Milestones & Roadmap

* [x] **Clinician sign-in (minimal):** accounts with two roles, protected HTTP and WebSocket endpoints, audit log, headset pairing, the real clinician recorded on bindings and acknowledgements. Not included: sign-in of a named clinician on the headset, password expiry, two-factor sign-in.
* [ ] **Remaining clinical features:**
  * ✅ Headset emergency overlay with alarm tone and acknowledge; live 2D ward map on the hand slate.
  * ✅ Person linking on the headset: a wristband linked to the person the depth sensor sees, choosing by hand, maps showing where the headset sees the patient.
  * ✅ Headset-triggered live mode (1 Hz from the Live Map card), 120 s (wristband V5.3). Open: an explicit return to passive mode.
  * ✅ Each patient's incident history on the dashboard's Patients page (🚨 Incidents on a patient row, 🚨 Incident log for every patient), with who responded and how fast; **⬇ CSV** downloads the filtered list for Excel.
  * ✅ Headset: restore the ward alignment after the headset wakes from sleep (F-5, confirmed on the headset).
  * ✅ Optional patient height and weight; one spatial anchor per headset and ward; automatic ward detection (walk between two rooms not tested yet).
  * ✅ Geofence on the server, in a ward with a LiDAR: **At the door** and **Left the ward** alerts ([docs/test_records/ward-exit-10.md](docs/test_records/ward-exit-10.md)).
  * Patient profile and 24-hour history in the headset.
  * ✅ Binding history instead of deleting binding rows.
  * ✅ Shift summary report for handover (printable, Save as PDF).
  * ✅ Standalone Android APK for the Quest 3: runs without the PC, works beyond the headset's boundary area, **Quit app** on the hand slate ([docs/test_records/headset-apk-9d.md](docs/test_records/headset-apk-9d.md)). Open: no click sound on buttons (UI/UX).
  * Clearer panels and hand slate (UI/UX).
* [ ] **Evaluation:**
  * Position accuracy measured at fixed points in the ward, and improved (the regression run of 16 Nov 2026 found it low in a small room), together with the wristband's motion state (walking shown as hand movement).
  * End-to-end telemetry and tracking latency.
  * Frame rate and battery runtime on the Meta Quest 3 and the wristband.
  * Thesis chapters aligned with what was built.
