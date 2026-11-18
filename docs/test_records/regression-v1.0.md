# Regression Run v1.0 (end of Stage A)

System test of the whole system on the real hardware before the tag `v1.0-fixes`: the version that is demonstrated and evaluated. Every check below is run once, in this order, and its result is recorded.

## Set-up

| Item | Value |
| :--- | :--- |
| Date | 16 November 2026 |
| Tester | Project author |
| Code | branch `fix/phase-7-release`, commit `0f95c7a` |
| Edge server | Development laptop, Windows 11, Node.js 24, MariaDB 10.4 (XAMPP), InfluxDB 2.x |
| Anchors | 3 × ESP32-WROOM-32E; firmware of Phase 6, unchanged in Phase 7 |
| Wristband | XIAO ESP32-C6; firmware unchanged in Phase 7 |
| Headset | Meta Quest 3 via Quest Link, Unity `6000.3.28f1`, project `quest3_client` |
| Ward | WARD-004, a room of about 4 m × 3 m |
| Automatic tests at that commit | `npm run lint` clean; `npm test` 244 passed; `npm run test:integration` 83 passed; GitHub Actions run 43728832248: all jobs passed (server tests on Linux with MariaDB 10.4, firmware host tests, wristband and anchor compile) |

Result values: **Pass**, **Pass, finding** (the check passed; something else was observed, see Findings), **Fail** (with what happened), **Not run** (with why).

## 1. Start-up

| # | Check | Expected | Result |
| :--- | :--- | :--- | :--- |
| 1.1 | Start MySQL (XAMPP) and InfluxDB (`start_influxdb.bat`); `npm start` | Time-stamped `INFO` lines, no `ERROR`; banner "SHIRO Clinical Dashboard & Gateway Ready" | Pass |
| 1.2 | Power the 3 anchors | One `[MQTT CLIENT CONNECTED] ID: SHIRO_Anchor_…` line per anchor within 30 s | Pass |
| 1.3 | Open `http://localhost:3000`, open every tab (Patients, Devices, Bindings, Ward Config with its live map, System Health, Live Test Lab) | Every tab loads; no error toast; browser console (F12) without red errors | Pass |
| 1.4 | System Health tab | Uptime, memory and queries per second update every 5 s; the 3 anchors ONLINE | Pass |

## 2. Patient flow

| # | Check | Expected | Result |
| :--- | :--- | :--- | :--- |
| 2.1 | Admit a new test patient with a photo; assign a free bed | Patient listed with the bed; the bed shows as occupied | Pass |
| 2.2 | Bindings tab: bind the wristband to this patient | Binding listed as ACTIVE | Pass |
| 2.3 | Ward Config → live map of the ward: the wristband appears | Marker in the ward; name of the bound patient; battery shown | Pass |
| 2.4 | Wear the wristband (or fingertip on the sensor) and keep still for 15 s | Heart rate appears; SpO2 marked as indicative; with the hand removed, `--` and no invented value | Pass |
| 2.5 | Select the patient on the live map (1 Hz active mode) | Toast that active mode started through one named anchor; vitals update every second | Pass |
| 2.6 | Unbind the wristband, then discharge the patient | Binding gone; bed free; wristband available again | Pass |

## 3. Alerts

| # | Check | Expected | Result |
| :--- | :--- | :--- | :--- |
| 3.1 | One fall: drop the wristband onto a cushion from about 1 m, leave it still | Exactly one alarm on the dashboard with tone, with an incident ID `INC-…` | Pass |
| 3.2 | Acknowledge the alarm | Alarm cleared; acknowledgement visible in the incident history | Pass, finding F-1 (alarm cleared; the dashboard has no page that shows the incident history) |
| 3.3 | Live Test Lab simulation button (with `ENABLE_SIMULATION=true`) | Alarm marked as simulated in the incident log | Pass |

## 4. Positioning

| # | Check | Expected | Result |
| :--- | :--- | :--- | :--- |
| 4.1 | Walk with the wristband from one side of the ward to the other | Marker follows without jumps through walls; settles within about 2 s after stopping | **Fail**, findings F-2 and F-3 (the marker does not follow the real position most of the time, even after calibration) |
| 4.2 | Live Test Lab: raw against Kalman-filtered RSSI | Filtered curve smoother than the raw one | Pass, finding F-4 (only slightly smoother) |

## 5. Headset

| # | Check | Expected | Result |
| :--- | :--- | :--- | :--- |
| 5.1 | Play `SampleScene` with Quest Link | Console `[SHIRO NET] This headset is QUEST3-…`; the hand slate's System tab shows the same ID and "connected" | Pass |
| 5.2 | Ward Setup tab: ward chosen; door-frame calibration | Ward overlay aligned with the room; beds over the real furniture | Pass |
| 5.3 | Save the spatial anchor; stop and start Play; Re-Sync | Alignment restored | Pass, finding F-5 (alignment lost after the headset sleeps; saving again fails) |
| 5.4 | Patient hologram | Floor ring at the patient's position; vitals panel with heart rate or `--`, SpO2 `~…%`, battery or `--%`, never stale values | Pass |
| 5.5 | IPS Location tab | Only the loaded ward's beds and anchors; no invented values | Pass |

## 6. Security

| # | Check | Expected | Result |
| :--- | :--- | :--- | :--- |
| 6.1 | Patient name `<img src=x onerror=alert(1)>` sent to the API (as in Phase 4) | Shown as text on every page; no alert | Pass |
| 6.2 | Admit form with an invalid phone number | Refused with a clear message | Pass |
| 6.3 | An MQTT client with a wrong password (for example MQTT Explorer) | Refused; server prints `[MQTT SECURITY] Refused …` | Pass |

## 7. Reliability (short versions; the full tests passed on 15 Nov, `load-test.md`)

| # | Check | Expected | Result |
| :--- | :--- | :--- | :--- |
| 7.1 | Unplug one anchor, then power it again | OFFLINE on the System Health tab within about 14 s; ONLINE again | Pass |
| 7.2 | Stop MySQL for 30 s, then start it | A few `ERROR`/`WARN` lines, no flood; recovery without restart | Pass |
| 7.3 | Ctrl+C in the server terminal | `[SHUTDOWN] Written: …` and `[SHUTDOWN] Done.` | Pass |

## Findings

Observations made during the run, in the tester's words, with the stage where each is to be handled. None of them was caused by the Phase 7 changes.

| ID | Check | Observation | Planned |
| :--- | :--- | :--- | :--- |
| F-1 | 3.2 | The incident history cannot be viewed on the dashboard. The server has it (`GET /api/alerts/history`), but no page shows it. Enhancement: show each patient's incident history on the Patients page. | Stage C. **Fixed in Phase 8B:** 🚨 Incidents on each patient row and in the patient profile, 🚨 Incident log for every patient |
| F-2 | 4.1 | Positioning accuracy is low: in WARD-004 (about 4 m × 3 m) the marker is not at the real position most of the time, even after the current landmark calibration, and it cannot really follow the person wearing the wristband. | Stage D: measure the error at fixed points (NFR-ACC-01) and improve (calibration method, anchor placement, filter and path-loss parameters) |
| F-3 | 4.1 | The motion state shows hand movement while walking; the walking state is hard to trigger. | Stage D, with F-2 |
| F-4 | 4.2 | The Kalman-filtered RSSI is almost the same as the raw RSSI most of the time; only spikes are smoothed, so the curve is only a little smoother. | Stage D, with F-2 (filter parameters) |
| F-5 | 5.3 | After the headset is taken off long enough to go to sleep and is put on again, the ward overlay has moved away from its calibrated position, and Re-Sync keeps the moved position. Calibrating again and pressing Save Spatial Anchor then fails with `ErrorHandleInvalid xrSaveSpacesMETA` (log below). | Stage C (headset work): reload and relocalize the anchor when the headset wakes, and create a new anchor when the old handle is no longer valid. **Fixed in Phase 8C**, confirmed on the headset on 19 Nov 2026 (`person-linking-8d.md`, 4.9): on wake and on Re-Sync the anchor is loaded again by its ID; saving checks localization and retries with a fresh anchor |

<details>
<summary>F-5: Unity Console log of the failed save</summary>

```
[MetaXRFeature]: ErrorHandleInvalid xrSaveSpacesMETA
UnityEngine.Debug:LogErrorFormat (string,object[])
Meta.XR.Extensions:LogErrorFormat (string,object) (at ./Library/PackageCache/com.meta.xr.sdk.core@d4cd875f54ee/Scripts/OpenXRFeatures/XrResult.cs:205)
Meta.XR.Extensions:OrLogFormat (Meta.XR.XrResult,string) (at ./Library/PackageCache/com.meta.xr.sdk.core@d4cd875f54ee/Scripts/OpenXRFeatures/XrResult.cs:269)
Meta.XR.MetaXRFeature:ovrp_SaveSpaces (uint,ulong*,ulong&) (at ./Library/PackageCache/com.meta.xr.sdk.core@d4cd875f54ee/Scripts/OpenXRFeatures/MetaXRSpatialEntityOVRPluginShim.cs:496)
OVRPlugin/Shim:ovrp_SaveSpaces (uint,ulong*,ulong&) (at ./Library/PackageCache/com.meta.xr.sdk.core@d4cd875f54ee/Scripts/OVRPluginShim.cs:304)
OVRPlugin:SaveSpaces (ulong*,int,ulong&) (at ./Library/PackageCache/com.meta.xr.sdk.core@d4cd875f54ee/Scripts/OVRPlugin.cs:12954)
OVRAnchor:SaveSpacesAsync (System.ReadOnlySpan`1<ulong>) (at ./Library/PackageCache/com.meta.xr.sdk.core@d4cd875f54ee/Scripts/OVRAnchor/OVRAnchor.cs:872)
OVRAnchor:SaveAsync () (at ./Library/PackageCache/com.meta.xr.sdk.core@d4cd875f54ee/Scripts/OVRAnchor/OVRAnchor.cs:834)
OVRSpatialAnchor:SaveAnchorAsync () (at ./Library/PackageCache/com.meta.xr.sdk.core@d4cd875f54ee/Scripts/OVRSpatialAnchor.cs:607)
ShiroMR.WardSpatialManager/<SaveNativeSpatialAnchorAsync>d__35:MoveNext () (at Assets/Scripts/ShiroMR/WardSpatialManager.cs:642)
System.Runtime.CompilerServices.AsyncMethodBuilderCore/MoveNextRunner:Run ()
OVRTask`1<bool>:TryInvokeContinuation () (at ./Library/PackageCache/com.meta.xr.sdk.core@d4cd875f54ee/Scripts/Util/Async/OVRTask.cs:519)
OVRTask`1<bool>:SetResult (bool) (at ./Library/PackageCache/com.meta.xr.sdk.core@d4cd875f54ee/Scripts/Util/Async/OVRTask.cs:547)
OVRTaskBuilder`1<bool>:SetResult (bool) (at ./Library/PackageCache/com.meta.xr.sdk.core@d4cd875f54ee/Scripts/Util/Async/OVRTask.cs:1591)
OVRSpatialAnchor/<WhenLocalizedAsync>d__26:MoveNext () (at ./Library/PackageCache/com.meta.xr.sdk.core@d4cd875f54ee/Scripts/OVRSpatialAnchor.cs:225)
OVRTaskBuilder`1/PooledStateMachine`1<bool, OVRSpatialAnchor/<WhenLocalizedAsync>d__26>:ExecuteMoveNext () (at ./Library/PackageCache/com.meta.xr.sdk.core@d4cd875f54ee/Scripts/Util/Async/OVRTask.cs:1500)
OVRTask`1<bool>:TryInvokeContinuation () (at ./Library/PackageCache/com.meta.xr.sdk.core@d4cd875f54ee/Scripts/Util/Async/OVRTask.cs:519)
OVRTask`1<bool>:SetResult (bool) (at ./Library/PackageCache/com.meta.xr.sdk.core@d4cd875f54ee/Scripts/Util/Async/OVRTask.cs:547)
OVRTaskBuilder`1<bool>:SetResult (bool) (at ./Library/PackageCache/com.meta.xr.sdk.core@d4cd875f54ee/Scripts/Util/Async/OVRTask.cs:1591)
OVRSpatialAnchor/<WhenCreatedAsync>d__19:MoveNext () (at ./Library/PackageCache/com.meta.xr.sdk.core@d4cd875f54ee/Scripts/OVRSpatialAnchor.cs:161)
OVRTaskBuilder`1/PooledStateMachine`1<bool, OVRSpatialAnchor/<WhenCreatedAsync>d__19>:ExecuteMoveNext () (at ./Library/PackageCache/com.meta.xr.sdk.core@d4cd875f54ee/Scripts/Util/Async/OVRTask.cs:1500)
UnityEngine.UnitySynchronizationContext:ExecuteTasks ()
```

</details>

## Result

| | Count |
| :--- | ---: |
| Checks run | 26 of 26 |
| Pass | 22 |
| Pass, with a finding | 3 (3.2, 4.2, 5.3) |
| Fail | 1 (4.1, positioning accuracy; findings F-2 and F-3) |
| Not run | 0 |

Every function of Stage A works end to end on the real hardware: start-up, the patient flow, fall alarms and acknowledgement, the headset with its own identity and calibration, the security checks and the recovery from faults. The one failed check, positioning accuracy in a small room (F-2, F-3), is a known limitation of RSSI positioning, not a regression: it is recorded in the traceability table under NFR-ACC-01 and is to be measured and improved in Stage D. The other findings are planned for Stage C.
