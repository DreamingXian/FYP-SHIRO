# Requirement Traceability

Each requirement of the thesis (Chapter 3: Tables 3.3 to 3.6, use cases UC-01 to UC-05, non-functional requirements in Section 3.4.3) traced to the code that implements it and the evidence that it works.

State on 19 November 2026, branch `fix/phase-8-features` (Phase 8 complete: clinician sign-in, incident history, headset alerts and Live Map, person linking on the headset).

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
- *Manual* means checked by hand on the hardware or headset; the regression run of 16 Nov 2026 (`docs/test_records/regression-v1.0.md`: 26 checks, 25 passed, 1 failed, findings F-1 to F-5) records it.
- *Headset tests* are `quest3_client/Tests~/DetectionTests` (person detection and linking outside Unity, also in CI); their results and the device tests of Phase 8D are in `docs/test_records/person-linking-8d.md`.

## 1. Functional requirements

### 1.1 Embedded IoT wearable (Table 3.3)

| ID | Requirement (short) | Status | Implementation | Evidence |
| :--- | :--- | :--- | :--- | :--- |
| FR-IOT-01 | Capture heart rate and SpO2 from the MAX30102 over I2C | **Partial** | `firmware/shiro_wristband_vitals/pulse_estimator.h`, `vitals_filter.h`, `shiro_wristband_vitals.ino`. Heart rate from the regularity of the pulse signal over 8 s, reported only when three estimates agree; SpO2 computed but not calibrated | Host tests (pulse estimation on recorded signals); `docs/test_records/heart-rate-measurement.md`; `docs/test_records/phase-3-bench-test.md`. Heart rate at the wrist depends on the sensor position; SpO2 is shown as indicative and raises no alarm |
| FR-IOT-02 | On-chip fall detection: free fall, impact, stillness | **Met** | `firmware/shiro_wristband_vitals/fall_detector.h` (free fall < 0.5 g for ≥ 150 ms, impact > 2.5 g within 500 ms, 0.5 s settling, 2 s stillness: < 0.20 g, or < 0.08 g after an impact under 4 g); only the result is broadcast | Host tests (falls, dips, claps, arm swings, sitting down, arm dropped while standing, the stored values of 50 arm drops and 3 false alarms in `firmware/tests/data/fall_values.csv`); power-on self-test; `docs/test_records/phase-3-bench-test.md` (Round 4 with V5.2: 9 / 12 arm drops onto a table detected, 3 / 21 arm drops while standing alarmed; every drop without an alarm had less than 150 ms of free-fall; known limit: the false alarm from an arm dropped while standing, a forearm-orientation check planned after Phase 11); unit `fall_tracker.test.js`; integration `alarm_path.test.js` |
| FR-IOT-03 | Passive mode every 3 min, 1 Hz live mode on a trigger from the edge server | **Met (different design)** | Passive cycle `PASSIVE_CYCLE_INTERVAL` (3 min) and 1 Hz active mode for 120 s in the wristband firmware (V5.3; 60 s before). The trigger is sent by the server through the anchor that hears the wristband most strongly (`services/websocket_service.js`, `services/telemetry/tag_hearing.js`, anchor firmware) instead of over Wi-Fi to the wristband | Unit `websocket_commands.test.js`, `tag_hearing.test.js`; integration `http_hardening.test.js` (strongest anchor named), `mqtt_access.test.js`; manual (live map "Active mode") |
| FR-IOT-04 | Wearable measures RSSI of three anchors and sends JSON over Wi-Fi/MQTT | **Met (different design)** | Reversed roles: the wristband only broadcasts BLE (no Wi-Fi, lower power); each anchor measures the wristband's RSSI and publishes JSON over MQTT (`firmware/shiro_anchor_node`, `docs/protocol.md`, `services/telemetry/anchor_message.js`) | Unit `anchor_message.test.js`, `firmware_contract.test.js`, `telemetry_normalize.test.js`; integration `telemetry_pipeline.test.js` |

### 1.2 BLE indoor positioning (Table 3.4)

| ID | Requirement (short) | Status | Implementation | Evidence |
| :--- | :--- | :--- | :--- | :--- |
| FR-IPS-01 | Three fixed wall-mounted ESP32 anchors in a 5 m × 5 m ward | **Met (different design)** | Three ESP32-WROOM-32E anchors, one firmware, identity assigned at enrollment. They scan for the wristband instead of broadcasting. Ward size is configured per ward on the dashboard | Manual (three anchors ONLINE on the System Health tab); integration `device_presence.test.js` |
| FR-IPS-02 | Tag measures RSSI of all anchors and sends the array | **Met (different design)** | As FR-IOT-04: each anchor reports the RSSI it measures; the server collects them per wristband (`services/ips_service.js`) | Integration `telemetry_pipeline.test.js` |
| FR-IPS-03 | Extended Kalman filter on raw RSSI | **Met (different design)** | 5-sample median, then a linear 1D Kalman filter per anchor–wristband pair (`services/kalman_filter.js`, `services/ips_service.js`). The state (RSSI) is observed directly, so the linear filter is the exact form; an extended filter is not needed | Unit `kalman_filter.test.js`; Live Lab shows raw against filtered RSSI (only slightly smoother in the regression run, F-4) |
| FR-IPS-04 | KNN radio fingerprinting to (X, Y) | **Met (different design)** | Log-distance path-loss model with per-anchor calibration (landmark calibration on the dashboard, `services/calibration_service.js`) and weighted least-squares multilateration with a weighted-centroid fallback, kept inside the room (`services/ips/geometry.js`). Needs no fingerprint survey | Unit `ips_geometry.test.js`. Accuracy: see NFR-ACC-01 (not measured); the regression run found it low in a 4 m × 3 m room (`regression-v1.0.md`, F-2, F-3) |

### 1.3 Edge processing and databases (Table 3.5)

| ID | Requirement (short) | Status | Implementation | Evidence |
| :--- | :--- | :--- | :--- | :--- |
| FR-EDG-01 | Mosquitto MQTT broker on the edge server | **Met (different design)** | Aedes broker embedded in the Node.js server (`services/mqtt_service.js`), with anchor login, client-ID rule, topic rules and lockout (`services/mqtt_access.js`) | Unit and integration `mqtt_access.test.js`; integration `telemetry_pipeline.test.js` |
| FR-EDG-02 | Python engine parses payloads and finds the patient bound to the wristband in MySQL | **Met (different design)** | Node.js instead of Python. Payload validation (`services/telemetry/normalize.js`, `utils/validate.js`); wristband → patient from an in-memory binding cache refreshed from MySQL (`services/binding_cache.js`, `services/binding_service.js`, `services/patient_service.js`) | Unit `telemetry_normalize.test.js`, `validate.test.js`, `binding_cache.test.js`; integration `binding_vitals.test.js` |
| FR-EDG-03 | Timestamped HR, SpO2, RSSI vectors and coordinates in InfluxDB | **Partial** | Measured vitals (`patient_vitals`) and positions (`spatial_trajectories`) are written (`services/time_series_service.js`); RSSI vectors are not stored | Unit `time_series_format.test.js`, `time_series_injection.test.js`, `time_series_disabled.test.js`; integration `telemetry_pipeline.test.js` (InfluxDB part runs when InfluxDB is up) |
| FR-EDG-04 | Push coordinates, vitals and alerts to the Quest 3 over MQTT/WebSocket | **Met** | WebSocket broadcasts `IPS_POSITION_UPDATE`, `TELEMETRY` and `EMERGENCY_ALERT` to every client (`services/websocket_service.js`); the headset handles all three (`ShiroNetworkManager.cs`, `ShiroAlertManager.cs`) and fetches pending alerts again after every reconnection | Integration `telemetry_pipeline.test.js`, `alarm_path.test.js`, `incident_history.test.js` (headset acknowledge); manual (headset) |

### 1.4 Mixed Reality application (Table 3.6)

| ID | Requirement (short) | Status | Implementation | Evidence |
| :--- | :--- | :--- | :--- | :--- |
| FR-MR-01 | Colour passthrough with a 2D/3D ward mini-map showing live patient markers | **Partial** | Passthrough with a full-scale 3D digital twin of the ward aligned to the room (`WardVisualizer.cs`) and the patient hologram with a floor ring at the live position (`PatientHologram.cs`). A 2D mini-map on the hand slate's Live Map tab shows the ward (walls, door, beds, anchors), each wristband's BLE position, the headset's own position and heading, and alerting patients in red (`ShiroWardMiniMap.cs`). A patient linked to a person the headset sees is shown at that person's position (violet dot, 👁), with the BLE estimate as a faint dot, on the headset and on the dashboard's live map (`PATIENT_SEEN`, `services/ips/headset_positions.js`). No 3D mini-map | Manual (regression run; `person-linking-8d.md` 4.7); unit `headset_positions.test.js`, `websocket_commands.test.js`; integration `headset_seen.test.js` |
| FR-MR-02 | Hands-free mid-air gestures (pinch, air-tap) to open panels, drag charts, navigate the map | **Partial** | Hand tracking with ray pointer and pinch (`ShiroVRPointer.cs`), fingertip touch on the hand slate (`ShiroHandSlate.cs`, `ShiroHandVisualizer.cs`), pinch-drag of the vitals panel. No charts or map to drag | Manual |
| FR-MR-03 | 3D health badge at the bedside opening vital charts and trend panels on air-tap | **Partial** | Vitals panel docked at the bed headboard or bedside, or following the patient, with live heart rate, indicative SpO2, battery and motion state. Charts and history in the headset: not implemented (Stage C); the dashboard shows the history (`/api/patients/vitals-history`) | Manual |
| FR-MR-04 | Spatial anchor lifecycle (OVRSpatialAnchor) aligning the floor plan to the room | **Met** | Door-frame two-point calibration (`WardAlignmentTool.cs`), save, restore and purge of an `OVRSpatialAnchor`; its ID is kept on the headset and sent to the server (`WardSpatialManager.cs`, `/api/ward/save-anchor`). A failed save is reported, nothing invented is sent | Regression run 5.2, 5.3. Alignment after the headset sleeps (F-5): anchor loaded again on wake, confirmed on the headset on 19 Nov (`person-linking-8d.md`, 4.9). One anchor per headset and ward on the server (integration `headset_anchors.test.js`); a calibrated ward is recognised from its saved anchor (one room tested). Drift: see NFR-ACC-02 (not measured) |
| FR-MR-05 | Non-optical identity linking of BLE coordinates to the person in view, with manual re-sync | **Met** | People are found from the headset's depth sensor (distances only, no camera image): a person-sized object that has moved is a person candidate (`ShiroDepthProbe.cs`, `ShiroPersonDetection.cs`). A wristband is linked to the candidate within 0.5 m of its BLE position, scored also on the patient's recorded height and the wristband's motion state; two that fit equally give "unclear", no guess (`ShiroPersonLinking.cs`, `ShiroPatientLinking.cs`). The panel and the maps then follow that person. Manual re-sync: Re-Attach, aim at a person and pinch; aiming where nobody is seen pins the panel there; "Auto" undoes either. Limitations in `person-linking-8d.md`, section 5 | Headset tests (69, in CI) and a 100-seed stress test of 23 simulated scenes; device tests 4.1–4.10 in `docs/test_records/person-linking-8d.md` |
| FR-MR-06 | Flashing alerts on the mini-map and in the spatial view on a fall or geofence breach | **Partial** | Falls and critical vitals: the patient's panel and floor ring flash red, an alarm tone plays, the hand slate opens the alert with acknowledge, and the patient blinks red on the Live Map tab (`ShiroAlertManager.cs`, `PatientHologram.cs`, `ShiroWardMiniMap.cs`). Every dashboard and headset shows who acknowledged. Geofence (Phase 10, ward with a LiDAR): **At the door** and **Left the ward** alerts take the same path, with their kind on the dashboard and the headset (`services/alerts/geofence_alerts.js`). Not checked on the headset yet | Integration `alarm_path.test.js`, `incident_ids.test.js`, `incident_history.test.js` (headset acknowledge), `geofence_alerts.test.js`; unit `geofence_door.test.js`; headset: manual |

## 2. Use cases

| ID | Use case | Status | What works | What is missing |
| :--- | :--- | :--- | :--- | :--- |
| UC-01 | Inspect live biometrics and trends | **Partial** | Selecting a patient on the dashboard's live map, or tapping a patient on the headset's Live Map tab, starts 1 Hz streaming through the strongest anchor; the headset shows the patient card with live vitals and the time left; live vitals on the dashboard and on the headset's vitals panel; "NO SIGNAL" after 5 s without packets on the dashboard (alternative flow A2) | Trend charts in the headset, explicit return to passive mode (the 1 Hz mode ends after 60 s) |
| UC-02 | Receive fall and geofence alerts | **Partial** | Fall on the wristband → anchor → server → dashboard and headset alarm with tone (flashing panel and floor ring on the headset); acknowledge recorded in the MySQL incident log with its ID, once: the first clinician to acknowledge is kept. Incident history per patient and for every patient on the Patients page, with time range, type filter, response time and responder (F-1, fixed in Phase 8B). Geofence (alternative flow A1), Phase 10, in a ward with a LiDAR: **At the door** (10 s in the door zone) and **Left the ward** (lost at the door, not seen again) incidents (`room_sensor/door_watch.js`, `lidar_linker.js`, `alerts/geofence_alerts.js`). Not in wards without a LiDAR; a wristband taken off is not followed | Unit `geofence_door.test.js`; integration `geofence_alerts.test.js`; live check `docs/test_records/ward-exit-10.md`: 7 / 7 walk-outs (alert 12 s after the last sighting), 3 / 3 doorway stays, no false alert |
| UC-03 | Navigate the 3D ward mini-map | **Partial** | A live 2D ward map on the hand slate (Live Map tab) with patients, the headset and alerting patients; the dashboard's live ward map gives the ward-wide view | 3D mini-map, zoom and pan by gestures — to be stated as a limitation |
| UC-04 | Calibrate the spatial ward geometry | **Met** | Door-frame calibration by two laser points, saved spatial anchor, restore by re-sync (alternative flow A1) | The calibration uses two points on the door frame instead of a marker above the door |
| UC-05 | Query patient profiles and history | **Partial** | Patient profile, medical history and 24-hour vitals history from InfluxDB on the dashboard | Profile and history in the headset — Stage C |

## 3. Non-functional requirements

| ID | Requirement | Target | Status | Evidence / plan |
| :--- | :--- | :--- | :--- | :--- |
| NFR-PERF-01 | Telemetry latency, sensor to headset | ≤ 500 ms | **Not measured** | Stage D: time stamps at the anchor, server and headset. The load test shows the server side is not the bottleneck (API p95 5.1 ms at 37 messages/s, `docs/test_records/load-test.md`) |
| NFR-PERF-02 | Headset frame rate | ≥ 72 FPS | **Not measured** | Stage D: OVR Metrics Tool on the Quest 3 during a ward round |
| NFR-PERF-03 | Fall alert propagation | ≤ 200 ms | **Not measured** | Stage D: time from the anchor's MQTT message to the dashboard/headset alert |
| NFR-ACC-01 | Positioning error | 1.0–1.5 m average | **Partial** | Position test in WARD-005, 31 runs at marked spots (`docs/test_records/ips-accuracy-10.md`): Bluetooth with 3 anchors 1.29 m mean; with 6 anchors 1.00 m, inside the band but no better than a fixed guess at the room centre (0.94 m). LiDAR positioning (Phase 10, step 5b; `services/room_sensor/`) replayed on the same recorded runs: 0.13 m mean, 95 % within 0.28 m. **Live with the LiDAR (step 6, 31 runs): 0.08 m mean, 95 % within 0.22 m, 100 % within 0.5 m, zone 97.1 %; Bluetooth alone on the same readings 1.02 m.** One room, one tester. Getting out of bed fixed after the session; live re-check 5 / 5, but the tester was always first seen within 0.7 m of the bed spot, so the case seen 0.9 m or more away is covered by unit tests only |
| NFR-ACC-02 | Spatial anchor drift across restarts | ≤ 2.0 cm | **Not measured** | Restored correctly after restarting Play (regression 5.3) and after the headset sleeps (F-5, fixed in Phase 8C, confirmed 19 Nov). Stage D: measure the offset of a reference point after restarts |
| NFR-USAB-01 | Touchless operation | 100 % contactless | **Partial** | The headset is operated entirely by hand tracking (pinch, fingertip touch); the dashboard at the nurse station uses mouse and keyboard by design |
| NFR-USAB-02 | Gesture response | ≤ 100 ms | **Not measured** | Stage D |
| NFR-PRIV-01 | No cameras for patient tracking | 0 % camera use in IPS | **Met** | Positioning uses BLE signal strength (`services/ips_service.js`) and the distances of a 2D LiDAR, 720 per turn at one height, no image (`firmware/shiro_lidar_node`, `services/room_sensor/`). The headset's person linking uses only distances from Meta's Depth API (`EnvironmentRaycastManager`): no camera image is read; depth points are used for one update only (a coarse map of empty space stays in the headset's memory), never recorded or sent. The edge server receives only a linked person's floor position and measured height |
| NFR-PRIV-02 | Local processing, no cloud dependency | 0 external services | **Met** | Broker, server, MySQL and InfluxDB run on the edge PC; MySQL and InfluxDB listen on that PC only; MQTT requires the anchor login; the dashboard, API and WebSocket need a signed-in clinician or a paired headset (`docs/security.md`). Known limit: no TLS |
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
| Only signed-in clinicians and paired headsets use the dashboard, API and WebSocket; every change, sign-in and pairing is recorded with who did it (Phase 8A) | `services/auth/`, `services/audit_service.js`, `routes/index.js` | Unit `auth.test.js`; integration `auth_flow.test.js` |
| Nursing shift summary report for handover (thesis section 4.7.1): census, vitals min/mean/max per patient with ATTN reasons, incidents and responses, device status, sign-off lines; printable. Mobility is left out (motion state and positioning not validated, F-2, F-3) | `config/shifts.js`, `services/reports/` (`GET /api/reports/shift-summary`), `public/shift_report.html` | Unit `shift_rules.test.js` (shift windows across midnight, ATTN rules, Flux query and parsing); integration `shift_report.test.js` (census, bindings, incidents, InfluxDB summary, 400/401/403, audit) |
| Binding history: who wore which wristband, and when (thesis Table 4.8). Unbinding, discharge and deleting a wristband end a binding instead of deleting it; one active binding per patient and per wristband, enforced by the database | `database/schema/04_bindings.sql`, `database/migrate_binding_history.js`, `services/binding_service.js` (`GET /api/bindings/history`), Bindings tab and patient profile | Integration `binding_history.test.js`, `binding_vitals.test.js` |
| One incident per fall, with a unique ID, recorded even when the database is slow | `services/alerts/` | Unit `fall_tracker.test.js`, `incident_id.test.js`, `vitals_evaluator.test.js`; integration `alarm_path.test.js`, `incident_ids.test.js` |
| The first acknowledgement of an incident is kept; the history per patient filters by time, type and Live Lab tests, and downloads as a CSV file with the same filters (thesis 4.7.2; no spreadsheet formula can run from it; each export is in the audit log) | `services/alert_service.js`, `services/alerts/incident_history.js`, `services/alerts/incident_csv.js` (`GET /api/alerts/history.csv`) | Unit `incident_history.test.js`, `incident_csv.test.js`, `http_guard.test.js`; integration `incident_history.test.js`, `incident_csv.test.js` |
| Stable under continuous telemetry; recovers from a database outage; clean shutdown | `services/device_service.js`, `server.js`, `services/binding_cache.js`, `utils/logger.js` | Integration `device_presence.test.js`, `db_unreachable.test.js`, `db_init.test.js`; unit `binding_cache.test.js`, `logger.test.js`; `docs/test_records/load-test.md` (load, 30-minute soak, fault tests) |

## 5. Summary

| | Met | Met (different design) | Partial | Not implemented | Not measured |
| :--- | ---: | ---: | ---: | ---: | ---: |
| Functional (18) | 4 | 8 | 6 | – | – |
| Use cases (5) | 1 | – | 4 | – | – |
| Non-functional (11) | 2 | – | 2 | – | 7 |

The "different design" rows are deliberate changes during development; Chapter 3 and 4 still describe the original design and are to be aligned in Stage D. The open functional items are trend charts and history in the headset, and the explicit return to passive mode; the non-functional targets are measured in Stage D.
