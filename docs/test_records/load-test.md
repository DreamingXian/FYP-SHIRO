# Load Test: Edge Server Under Continuous Telemetry

Date: 15 Nov 2026. Phase 6 of the remediation, item 6.1: the server stopped reading and writing the `devices` table on every MQTT message. This record compares the same load before and after that change.

## Set-up

| Item | Value |
| :--- | :--- |
| Load | 3 anchors × 2 wristbands, each anchor sending one message per wristband at 7 Hz: about 37 messages per second, as `tools/load_test.js` replays them |
| Duration | 300 s per run |
| Devices | All 3 anchors and 2 wristbands enrolled, anchors assigned to WARD-001, so every message runs the full path (device registry, positioning, telemetry, dashboard broadcast) |
| Database | `shiro_test` on the local MariaDB 10.4 (XAMPP), recreated before each run |
| InfluxDB | Off (no token), so only MySQL is measured |
| Server | Started fresh for each run on spare ports, `LOG_LEVEL=warn` |
| Before | `main` at commit `84a087f` (Phase 5 merged) |
| After | branch `fix/phase-6-reliability` |
| PC | The development laptop (Windows 11, Node.js 24) |

Measurements:

- **Database queries per second.** Before: MariaDB's `Questions` counter during the run, minus the queries other programs sent in a 10-second idle period just before (another SHIRO server was running on the same database server against `shiro_db`). After: the server's own query counter (`/api/system/stats`), which counts only its queries; MariaDB's counter is listed as well.
- **Memory.** Working set of the server process (Windows `tasklist`), every 5 seconds.
- **API answer time.** `GET /api/devices/list` once per second, a call that reads MySQL.

## Results

| | Before | After |
| :--- | ---: | ---: |
| Messages received per second | 37.3 | 37.3 |
| MySQL queries per second (server's own) | about 150 (193 total − 43 background) | 2.6 |
| MySQL: SELECT / UPDATE per second (whole database server) | 97.6 / 95.4 | 10.7 / 9.6 (includes background) |
| Server memory at start → end of 5 min | 68 → 203 MB | 68 → 95 MB |
| Highest memory during the run | 202 MB | 96 MB |
| API answer time p50 / p95 | 2.4 / 8.1 ms | 2.3 / 5.1 ms |
| API answer time, slowest of 296 | 304 ms | 19 ms |
| Failed API calls | 0 | 0 |
| Errors in the server log | 0 | 0 |

The expected number of queries before the change is 2 per device per message (one SELECT, one UPDATE), with 2 devices (anchor and wristband) per message: 37.3 × 2 × 2 ≈ 149 per second, which matches the measured value. After the change, the remaining 2.6 queries per second are the batched presence writes (one per device every 5 s), the OFFLINE check (every 2 s) and the API calls of the test itself.

Event-loop delay (after only, from `/api/system/stats`): the 99th percentile stayed at 32 to 34 ms during the run, the same as an idle Node.js process on this PC with the same 20 ms sampling (31 to 32 ms). That figure is the sampling interval plus the Windows timer granularity, not load. Since this test, `/api/system/stats` subtracts the 20 ms sampling interval.

## Conclusion

- Database load from telemetry fell by about 98 %, from about 150 to 2.6 queries per second, with the same number of messages handled.
- Memory no longer grows with the message count: before, it rose by about 135 MB in 5 minutes; after, it settled at about 95 MB.
- The slowest API answer fell from 304 ms to 19 ms.
- Nothing was lost: the integration test `device_presence.test.js` checks that the last battery value and last-seen time reach the database within one batch interval, that a silent device is marked OFFLINE after 12 s, and that a clean shutdown writes what is still in memory.

## Soak with the real hardware

Date: 15 Nov 2026, server started at 21:59. The 3 real anchors and the wristband ran normally against `shiro_db`, with the dashboard open; branch `fix/phase-6-reliability` at commit `fee3dd3`. Readings from the System Health tab (`/api/system/stats`):

| Server uptime | Memory in use (RSS) | JavaScript heap | Event-loop delay, 99th percentile |
| ---: | ---: | ---: | ---: |
| 0 min 25 s | 79.2 MB | 23.5 MB | 21.7 ms |
| 10 min 25 s | 82.8 MB | 27.3 MB | 23.3 ms |
| 20 min 35 s | 83.4 MB | 27.9 MB | 18.4 ms |
| 31 min 10 s | 81.4 MB | 27.8 MB | 16.1 ms |

Memory rose by 3.6 MB in the first 10 minutes while caches filled, then stayed level (82.8 → 81.4 MB over the last 20 minutes): no sign of a leak. The event-loop delay (already minus the 20 ms sampling interval) stayed below 25 ms and did not grow.

## Fault tests with the real hardware

Date: 15 Nov 2026, same set-up.

| Fault | Expected | Result |
| :--- | :--- | :--- |
| MySQL stopped for about 40 s during operation, then started | Server keeps running; each problem logged at most once per 30 s; after MySQL is back the server and dashboard recover without a restart | Passed after two fixes made during this test (below) |
| An anchor unplugged, then powered again | OFFLINE on the System Health tab within about 14 s, ONLINE again after power-up | Passed |
| Router switched off, then on | Anchors reconnect to Wi-Fi and MQTT by themselves, no manual reset | Passed |

Found and fixed during the MySQL test:

- The binding cache retried its reload on every wristband reading while MySQL was down (about 5 warnings per second). It now waits 5 s after a failed reload and warns at most once per 30 s (commit `8c875a1`).
- The Ward page fetched the whole device list on every anchor signal message when the anchor was missing from its list, and the server logged every failed request (dozens of lines per second). Now at most one fetch per 5 s, and the same failure is logged at most once per 30 s (commit `fee3dd3`).
- Not a SHIRO fault: after MySQL restarted, `shiro_app` lost its access to `shiro_db` because MySQL's own grant table `mysql.db` was damaged (Aria error 176). The table was repaired and the grants applied again; the startup guide now has a troubleshooting row for it.

## How to repeat

On a server started against the test database (never `shiro_db`), with the anchors and wristbands of the test enrolled:

```powershell
cd d:\RSW\FYP\Code\edge_server
node tools/load_test.js --duration 300 --anchors 3 --tags 2 --rate 7 --http-port <port> --mqtt-port <port>
```
