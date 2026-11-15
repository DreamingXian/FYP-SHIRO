# Regression Run v1.0 (end of Stage A)

System test of the whole system on the real hardware before the tag `v1.0-fixes`: the version that is demonstrated and evaluated. Every check below is run once, in this order, and its result is recorded.

## Set-up

| Item | Value |
| :--- | :--- |
| Date and time | *to fill in* |
| Tester | Project author |
| Code | branch `fix/phase-7-release`, commit *to fill in* |
| Edge server | Development laptop, Windows 11, Node.js 24, MariaDB 10.4 (XAMPP), InfluxDB 2.x |
| Anchors | 3 × ESP32-WROOM-32E, flashed from the same commit |
| Wristband | XIAO ESP32-C6, flashed from the same commit |
| Headset | Meta Quest 3 via Quest Link, Unity `6000.3.28f1`, project `quest3_client` |
| Automatic tests at that commit | `npm run lint`, `npm test`, `npm run test:integration`: *to fill in*; GitHub Actions: *to fill in* |

Result values: **Pass**, **Fail** (with what happened), **Not run** (with why).

## 1. Start-up

| # | Check | Expected | Result |
| :--- | :--- | :--- | :--- |
| 1.1 | Start MySQL (XAMPP) and InfluxDB (`start_influxdb.bat`); `npm start` | Time-stamped `INFO` lines, no `ERROR`; banner "SHIRO Clinical Dashboard & Gateway Ready" | |
| 1.2 | Power the 3 anchors | One `[MQTT CLIENT CONNECTED] ID: SHIRO_Anchor_…` line per anchor within 30 s | |
| 1.3 | Open `http://localhost:3000`, open every tab (Patients, Devices, Bindings, Ward Config with its live map, System Health, Live Test Lab) | Every tab loads; no error toast; browser console (F12) without red errors | |
| 1.4 | System Health tab | Uptime, memory and queries per second update every 5 s; the 3 anchors ONLINE | |

## 2. Patient flow

| # | Check | Expected | Result |
| :--- | :--- | :--- | :--- |
| 2.1 | Admit a new test patient with a photo; assign a free bed | Patient listed with the bed; the bed shows as occupied | |
| 2.2 | Bindings tab: bind the wristband to this patient | Binding listed as ACTIVE | |
| 2.3 | Ward Config → live map of the ward: the wristband appears | Marker in the ward; name of the bound patient; battery shown | |
| 2.4 | Wear the wristband (or fingertip on the sensor) and keep still for 15 s | Heart rate appears; SpO2 marked as indicative; with the hand removed, `--` and no invented value | |
| 2.5 | Select the patient on the live map (1 Hz active mode) | Toast that active mode started through one named anchor; vitals update every second | |
| 2.6 | Unbind the wristband, then discharge the patient | Binding gone; bed free; wristband available again | |

## 3. Alerts

| # | Check | Expected | Result |
| :--- | :--- | :--- | :--- |
| 3.1 | One fall: drop the wristband onto a cushion from about 1 m, leave it still | Exactly one alarm on the dashboard with tone, with an incident ID `INC-…` | |
| 3.2 | Acknowledge the alarm | Alarm cleared; acknowledgement visible in the incident history | |
| 3.3 | Live Test Lab simulation button (with `ENABLE_SIMULATION=true`) | Alarm marked as simulated in the incident log | |

## 4. Positioning

| # | Check | Expected | Result |
| :--- | :--- | :--- | :--- |
| 4.1 | Walk with the wristband from one side of the ward to the other | Marker follows without jumps through walls; settles within about 2 s after stopping | |
| 4.2 | Live Test Lab: raw against Kalman-filtered RSSI | Filtered curve smoother than the raw one | |

## 5. Headset

| # | Check | Expected | Result |
| :--- | :--- | :--- | :--- |
| 5.1 | Play `SampleScene` with Quest Link | Console `[SHIRO NET] This headset is QUEST3-…`; the hand slate's System tab shows the same ID and "connected" | |
| 5.2 | Ward Setup tab: ward chosen; door-frame calibration | Ward overlay aligned with the room; beds over the real furniture | |
| 5.3 | Save the spatial anchor; stop and start Play; Re-Sync | Alignment restored | |
| 5.4 | Patient hologram | Floor ring at the patient's position; vitals panel with heart rate or `--`, SpO2 `~…%`, battery or `--%`, never stale values | |
| 5.5 | IPS Location tab | Only the loaded ward's beds and anchors; no invented values | |

## 6. Security

| # | Check | Expected | Result |
| :--- | :--- | :--- | :--- |
| 6.1 | Patient name `<img src=x onerror=alert(1)>` sent to the API (as in Phase 4) | Shown as text on every page; no alert | |
| 6.2 | Admit form with an invalid phone number | Refused with a clear message | |
| 6.3 | An MQTT client with a wrong password (for example MQTT Explorer) | Refused; server prints `[MQTT SECURITY] Refused …` | |

## 7. Reliability (short versions; the full tests passed on 15 Nov, `load-test.md`)

| # | Check | Expected | Result |
| :--- | :--- | :--- | :--- |
| 7.1 | Unplug one anchor, then power it again | OFFLINE on the System Health tab within about 14 s; ONLINE again | |
| 7.2 | Stop MySQL for 30 s, then start it | A few `ERROR`/`WARN` lines, no flood; recovery without restart | |
| 7.3 | Ctrl+C in the server terminal | `[SHUTDOWN] Written: …` and `[SHUTDOWN] Done.` | |

## Result

*To fill in after the run: number of checks passed, failed and not run; any failure with its fix or its planned stage.*
