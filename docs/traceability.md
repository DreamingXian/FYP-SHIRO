# Requirement Traceability

Each requirement of the thesis (Chapter 3: Tables 3.3 to 3.6, use cases UC-01 to UC-05, non-functional requirements in Section 3.4.3) traced to the code that implements it and the evidence that it works.

State on 16 November 2026, branch `fix/phase-7-release` (Stage A of the remediation complete).

**Status**

| Mark | Meaning |
| :--- | :--- |
| **Met** | Implemented as specified and tested |
| **Met (different design)** | The intent is met by a design other than the one Chapter 3 names; Chapter 3 and 4 are to be updated to match (Stage D) |
| **Partial** | Part of the requirement is implemented; the rest is named |
| **Not implemented** | Not built yet; planned stage given |
| **Not measured** | Implemented, but the quantitative target has not been measured yet (Stage D evaluation) |

**Evidence**

- *Unit* and *integration* tests are in `edge_server/test/`; they run on every push (`.github/workflows/ci.yml`).
- *Host tests* are `firmware/tests/host_tests.cpp` (firmware logic on the PC, also in CI).
- *Bench*, *load* and *regression* records are in `docs/test_records/`.
- *Manual* means checked by hand on the hardware or headset; the regression run (`docs/test_records/regression-v1.0.md`) records it.

## 1. Functional requirements

### 1.1 Embedded IoT wearable (Table 3.3)

| ID | Requirement (short) | Status | Implementation | Evidence |
| :--- | :--- | :--- | :--- | :--- |
| FR-IOT-01 | Capture heart rate and SpO2 from the MAX30102 over I2C | **Partial** | `firmware/shiro_wristband_vitals/pulse_estimator.h`, `vitals_filter.h`, `shiro_wristband_vitals.ino`. Heart rate from the regularity of the pulse signal over 8 s, reported only when three estimates agree; SpO2 computed but not calibrated | Host tests (pulse estimation on recorded signals); `docs/test_records/heart-rate-measurement.md`; `docs/test_records/phase-3-bench-test.md`. Heart rate at the wrist depends on the sensor position; SpO2 is shown as indicative and raises no alarm |
| FR-IOT-02 | On-chip fall detection: free fall, impact, stillness | **Met** | `firmware/shiro_wristband_vitals/fall_detector.h` (free fall < 0.5 g for ≥ 150 ms, impact > 2.5 g within 500 ms, 0.5 s settling, 2 s stillness); only the result is broadcast | Host tests (falls, dips, claps, arm swings, sitting down); power-on self-test; `docs/test_records/phase-3-bench-test.md`; unit `fall_tracker.test.js`; integration `alarm_path.test.js` |
| FR-IOT-03 | Passive mode every 3 min, 1 Hz live mode on a trigger from the edge server | **Met (different design)** | Passive cycle `PASSIVE_CYCLE_INTERVAL` (3 min) and 1 Hz active mode for 60 s in the wristband firmware. The trigger is sent by the server through the anchor that hears the wristband most strongly (`services/websocket_service.js`, `services/telemetry/tag_hearing.js`, anchor firmware) instead of over Wi-Fi to the wristband | Unit `websocket_commands.test.js`, `tag_hearing.test.js`; integration `http_hardening.test.js` (strongest anchor named), `mqtt_access.test.js`; manual (live map "Active mode") |
| FR-IOT-04 | Wearable measures RSSI of three anchors and sends JSON over Wi-Fi/MQTT | **Met (different design)** | Reversed roles: the wristband only broadcasts BLE (no Wi-Fi, lower power); each anchor measures the wristband's RSSI and publishes JSON over MQTT (`firmware/shiro_anchor_node`, `docs/protocol.md`, `services/telemetry/anchor_message.js`) | Unit `anchor_message.test.js`, `firmware_contract.test.js`, `telemetry_normalize.test.js`; integration `telemetry_pipeline.test.js` |

### 1.2 BLE indoor positioning (Table 3.4)

| ID | Requirement (short) | Status | Implementation | Evidence |
| :--- | :--- | :--- | :--- | :--- |
| FR-IPS-01 | Three fixed wall-mounted ESP32 anchors in a 5 m × 5 m ward | **Met (different design)** | Three ESP32-WROOM-32E anchors, one firmware, identity assigned at enrollment. They scan for the wristband instead of broadcasting. Ward size is configured per ward on the dashboard | Manual (three anchors ONLINE on the System Health tab); integration `device_presence.test.js` |
| FR-IPS-02 | Tag measures RSSI of all anchors and sends the array | **Met (different design)** | As FR-IOT-04: each anchor reports the RSSI it measures; the server collects them per wristband (`services/ips_service.js`) | Integration `telemetry_pipeline.test.js` |
| FR-IPS-03 | Extended Kalman filter on raw RSSI | **Met (different design)** | 5-sample median, then a linear 1D Kalman filter per anchor–wristband pair (`services/kalman_filter.js`, `services/ips_service.js`). The state (RSSI) is observed directly, so the linear filter is the exact form; an extended filter is not needed | Unit `kalman_filter.test.js`; Live Lab shows raw against filtered RSSI |
| FR-IPS-04 | KNN radio fingerprinting to (X, Y) | **Met (different design)** | Log-distance path-loss model with per-anchor calibration (landmark calibration on the dashboard, `services/calibration_service.js`) and weighted least-squares multilateration with a weighted-centroid fallback, kept inside the room (`services/ips/geometry.js`). Needs no fingerprint survey | Unit `ips_geometry.test.js`. Accuracy: see NFR-ACC-01 (not measured) |

### 1.3 Edge processing and databases (Table 3.5)

| ID | Requirement (short) | Status | Implementation | Evidence |
| :--- | :--- | :--- | :--- | :--- |
| FR-EDG-01 | Mosquitto MQTT broker on the edge server | **Met (different design)** | Aedes broker embedded in the Node.js server (`services/mqtt_service.js`), with anchor login, client-ID rule, topic rules and lockout (`services/mqtt_access.js`) | Unit and integration `mqtt_access.test.js`; integration `telemetry_pipeline.test.js` |
| FR-EDG-02 | Python engine parses payloads and finds the patient bound to the wristband in MySQL | **Met (different design)** | Node.js instead of Python. Payload validation (`services/telemetry/normalize.js`, `utils/validate.js`); wristband → patient from an in-memory binding cache refreshed from MySQL (`services/binding_cache.js`, `services/binding_service.js`, `services/patient_service.js`) | Unit `telemetry_normalize.test.js`, `validate.test.js`, `binding_cache.test.js`; integration `binding_vitals.test.js` |
| FR-EDG-03 | Timestamped HR, SpO2, RSSI vectors and coordinates in InfluxDB | **Partial** | Measured vitals (`patient_vitals`) and positions (`spatial_trajectories`) are written (`services/time_series_service.js`); RSSI vectors are not stored | Unit `time_series_format.test.js`, `time_series_injection.test.js`, `time_series_disabled.test.js`; integration `telemetry_pipeline.test.js` (InfluxDB part runs when InfluxDB is up) |
| FR-EDG-04 | Push coordinates, vitals and alerts to the Quest 3 over MQTT/WebSocket | **Partial** | WebSocket broadcasts `IPS_POSITION_UPDATE`, `TELEMETRY` and `EMERGENCY_ALERT` to every client (`services/websocket_service.js`). The headset handles positions and vitals (`ShiroNetworkManager.cs`); it does not handle `EMERGENCY_ALERT` yet (Stage C) | Integration `telemetry_pipeline.test.js`, `alarm_path.test.js`; manual (headset) |

### 1.4 Mixed Reality application (Table 3.6)

| ID | Requirement (short) | Status | Implementation | Evidence |
| :--- | :--- | :--- | :--- | :--- |
| FR-MR-01 | Colour passthrough with a 2D/3D ward mini-map showing live patient markers | **Partial** | Passthrough with a full-scale 3D digital twin of the ward aligned to the room (`WardVisualizer.cs`) and the patient hologram with a floor ring at the live position (`PatientHologram.cs`). No separate mini-map with patient markers; the hand slate's IPS Location tab shows the ward, its beds and anchors | Manual (regression run) |
| FR-MR-02 | Hands-free mid-air gestures (pinch, air-tap) to open panels, drag charts, navigate the map | **Partial** | Hand tracking with ray pointer and pinch (`ShiroVRPointer.cs`), fingertip touch on the hand slate (`ShiroHandSlate.cs`, `ShiroHandVisualizer.cs`), pinch-drag of the vitals panel. No charts or map to drag | Manual |
| FR-MR-03 | 3D health badge at the bedside opening vital charts and trend panels on air-tap | **Partial** | Vitals panel docked at the bed headboard or bedside, or following the patient, with live heart rate, indicative SpO2, battery and motion state. Charts and history in the headset: not implemented (Stage C); the dashboard shows the history (`/api/patients/vitals-history`) | Manual |
| FR-MR-04 | Spatial anchor lifecycle (OVRSpatialAnchor) aligning the floor plan to the room | **Met** | Door-frame two-point calibration (`WardAlignmentTool.cs`), save, restore and purge of an `OVRSpatialAnchor`; its ID is kept on the headset and sent to the server (`WardSpatialManager.cs`, `/api/ward/save-anchor`). A failed save is reported, nothing invented is sent | Manual. Drift: see NFR-ACC-02 (not measured) |
| FR-MR-05 | Non-optical identity linking of BLE coordinates to the person in view, with manual re-sync | **Partial** | The hologram is placed at the BLE position and docks to the patient's bed; "Re-Attach" lets the clinician lock it onto the patient by hand. No detection of human geometry in the view | Manual |
| FR-MR-06 | Flashing alerts on the mini-map and in the spatial view on a fall or geofence breach | **Not implemented** in the headset (Stage C). On the dashboard, falls and vitals alarms raise an alarm with tone and acknowledge (`public/js/alerts/alert_manager.js`). Geofence: not implemented (Stage C) | Integration `alarm_path.test.js`, `incident_ids.test.js` (dashboard path) |

## 2. Use cases

| ID | Use case | Status | What works | What is missing |
| :--- | :--- | :--- | :--- | :--- |
| UC-01 | Inspect live biometrics and trends | **Partial** | Selecting a patient on the live map starts 1 Hz streaming through the strongest anchor; live vitals on the dashboard and on the headset's vitals panel; "NO SIGNAL" after 5 s without packets on the dashboard (alternative flow A2) | Trigger from the headset, trend charts in the headset, explicit return to passive mode (the 1 Hz mode ends after 60 s) — Stage C |
| UC-02 | Receive fall and geofence alerts | **Partial** | Fall on the wristband → anchor → server → dashboard alarm with tone; acknowledge recorded in the MySQL incident log with its ID | Alert in the headset; geofence (alternative flow A1) — Stage C |
| UC-03 | Navigate the 3D ward mini-map | **Not implemented** | The dashboard's live ward map gives the ward-wide view | Mini-map with gestures in the headset — not planned before the final submission; to be stated as a limitation |
| UC-04 | Calibrate the spatial ward geometry | **Met** | Door-frame calibration by two laser points, saved spatial anchor, restore by re-sync (alternative flow A1) | The calibration uses two points on the door frame instead of a marker above the door |
| UC-05 | Query patient profiles and history | **Partial** | Patient profile, medical history and 24-hour vitals history from InfluxDB on the dashboard | Profile and history in the headset — Stage C |

## 3. Non-functional requirements

| ID | Requirement | Target | Status | Evidence / plan |
| :--- | :--- | :--- | :--- | :--- |
| NFR-PERF-01 | Telemetry latency, sensor to headset | ≤ 500 ms | **Not measured** | Stage D: time stamps at the anchor, server and headset. The load test shows the server side is not the bottleneck (API p95 5.1 ms at 37 messages/s, `docs/test_records/load-test.md`) |
| NFR-PERF-02 | Headset frame rate | ≥ 72 FPS | **Not measured** | Stage D: OVR Metrics Tool on the Quest 3 during a ward round |
| NFR-PERF-03 | Fall alert propagation | ≤ 200 ms | **Not measured** | Stage D: time from the anchor's MQTT message to the dashboard/headset alert |
| NFR-ACC-01 | Positioning error | 1.0–1.5 m average | **Not measured** | Stage D: error at fixed points in the ward |
| NFR-ACC-02 | Spatial anchor drift across restarts | ≤ 2.0 cm | **Not measured** | Stage D: restore the anchor after restarts and measure the offset of a reference point |
| NFR-USAB-01 | Touchless operation | 100 % contactless | **Partial** | The headset is operated entirely by hand tracking (pinch, fingertip touch); the dashboard at the nurse station uses mouse and keyboard by design |
| NFR-USAB-02 | Gesture response | ≤ 100 ms | **Not measured** | Stage D |
| NFR-PRIV-01 | No cameras for patient tracking | 0 % camera use in IPS | **Met** | Positioning uses BLE signal strength only (`services/ips_service.js`); the headset's cameras are used only for its own passthrough view and room calibration, not for tracking patients |
| NFR-PRIV-02 | Local processing, no cloud dependency | 0 external services | **Met** | Broker, server, MySQL and InfluxDB run on the edge PC; MySQL and InfluxDB listen on that PC only; MQTT requires the anchor login (`docs/security.md`). Known limits: no TLS, no clinician login yet (Stage B) |
| NFR-EFF-01 | Wristband battery runtime | ≥ 12 h | **Not measured** | Stage D: full-charge run with the battery level logged |
| NFR-EFF-02 | Heavy computation off the headset | Quest 3 CPU/GPU ≤ 60 % | **Partial** | By design, filtering, positioning and storage run on the edge server; the headset only renders. Utilisation not measured (Stage D) |

## 4. Quality requirements added during the remediation (Stage A)

Not in Chapter 3; added because a clinical prototype needs them. Each is tested.

| Requirement | Implementation | Evidence |
| :--- | :--- | :--- |
| Unknown values are shown as unknown, never as defaults or invented values (dashboard and headset) | `services/telemetry/normalize.js`, dashboard pages, `PatientHologram.cs`, `ShiroHandSlate.cs` | Unit `telemetry_normalize.test.js`, `ward_payload.test.js`; manual |
| Every input over HTTP, WebSocket and MQTT is checked; refused input gets a clear 400 | `utils/validate.js`, `utils/http.js` | Unit `validate.test.js`, `http_guard.test.js`, `http_helpers.test.js`, `photo_upload.test.js`, `websocket_commands.test.js`; integration `http_hardening.test.js` |
| No value from the server can run as code in the dashboard | `public/js/html_safety.js` | Unit `dashboard_html_safety.test.js` (static audit of every page) |
| Only the project's anchors can use the MQTT broker | `services/mqtt_access.js` | Unit and integration `mqtt_access.test.js` |
| One incident per fall, with a unique ID, recorded even when the database is slow | `services/alerts/` | Unit `fall_tracker.test.js`, `incident_id.test.js`, `vitals_evaluator.test.js`; integration `alarm_path.test.js`, `incident_ids.test.js` |
| Stable under continuous telemetry; recovers from a database outage; clean shutdown | `services/device_service.js`, `server.js`, `services/binding_cache.js`, `utils/logger.js` | Integration `device_presence.test.js`, `db_unreachable.test.js`, `db_init.test.js`; unit `binding_cache.test.js`, `logger.test.js`; `docs/test_records/load-test.md` (load, 30-minute soak, fault tests) |

## 5. Summary

| | Met | Met (different design) | Partial | Not implemented | Not measured |
| :--- | ---: | ---: | ---: | ---: | ---: |
| Functional (18) | 2 | 8 | 7 | 1 | – |
| Use cases (5) | 1 | – | 3 | 1 | – |
| Non-functional (11) | 2 | – | 2 | – | 7 |

The "different design" rows are deliberate changes during development; Chapter 3 and 4 still describe the original design and are to be aligned in Stage D. The open functional items are planned in Stage C (headset alerts, geofence, headset-triggered live mode, history in the headset); the non-functional targets are measured in Stage D.
