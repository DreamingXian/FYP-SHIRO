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

## Still to do (with hardware)

- Soak: 30 minutes with the real anchors and wristband, memory read from the System Health tab at the start and every 10 minutes.
- Faults: MySQL stopped during operation, an anchor unplugged, the router switched off and on.

## How to repeat

On a server started against the test database (never `shiro_db`), with the anchors and wristbands of the test enrolled:

```powershell
cd d:\RSW\FYP\Code\edge_server
node tools/load_test.js --duration 300 --anchors 3 --tags 2 --rate 7 --http-port <port> --mqtt-port <port>
```
