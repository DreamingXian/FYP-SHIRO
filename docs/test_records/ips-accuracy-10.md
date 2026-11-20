# Patient Position Accuracy in the Ward (Phase 10)

Test record of how accurately the system places a patient inside the ward. Phase 10 adds a LiDAR room sensor (RPLIDAR C1) to the Bluetooth anchors. This record holds the measurement before that change (the baseline) and will hold the measurement after it, taken the same way in the same room.

## Method

- **Tool:** Live Map → **📏 Position test** (edge server, code `1151f4d`). The raw data are kept as CSV files in [data/](data/).
- **Procedure:** the tester wears the wristband on the wrist, arm relaxed at the side, and stands on a spot taped on the floor. After a 10 s countdown the tool records the position shown by the system 4 times a second for 20 s (77–78 readings per run).
- **Error:** the straight-line distance on the floor between the position shown and the taped spot.
- **Zone:** DOOR (1 m into the room from the door), BED (the bed plus 0.3 m around it) or ROOM, from the ward layout. A reading is "zone correct" when the position shown is in the same zone as the spot.
- **Spots:** P1–P7 standing, each facing north, east, south and west; one run each for sitting on the bed edge, lying on the bed and sitting at the table.
- **Each reading also stores:** the Bluetooth-only position, the solver's raw result before smoothing, the motion state, and each anchor's filtered RSSI, raw RSSI and estimated distance.

## Baseline: three Bluetooth anchors (20 November 2026)

### Set-up

| Item | Value |
| :--- | :--- |
| Date and time | 20 November 2026, 22:32–23:10 |
| Tester | Project author |
| Code | branch `fix/phase-10-ips`, `1151f4d` |
| Ward | WARD-005: 2.29 m (west–east) × 3.39 m (south–north), ceiling 2.45 m. Origin at the south-west corner. Door on the east wall, 2.57–3.36 m from the south wall. Bed 1.10 × 2.00 m against the south wall, x 1.19–2.29 m, head at the south. |
| Wristband | `TAG-002` |
| Anchors | three ESP32-WROOM-32E, 2.40 m high, calibrated with 🎯 Calibrate Anchors |
| LiDAR | not used (switched off) |
| Session | `PT-20261120-223212`, 31 runs, 2,390 readings |

| Anchor | Device | Position (x, y, height) | Calibrated RSSI at 1 m | Path-loss exponent |
| :--- | :--- | :--- | :--- | :--- |
| A | `anchor-001` | 1.89, 3.39, 2.40 m (north wall) | −48.4 dBm | 3.2 |
| B | `anchor-002` | 2.29, 0.40, 2.40 m (east wall) | −50.1 dBm | 3.2 |
| C | `anchor-003` | 0.00, 2.13, 2.40 m (west wall) | −62.8 dBm | 3.2 |

### Results

| Runs | Readings | Available | Mean error | Median | 95 % | Largest | Within 0.5 m | Within 1.0 m | Within 1.5 m | Zone correct |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| All | 2,390 | 100 % | 1.29 m | 1.35 m | 1.93 m | 2.04 m | 0 % | 35.5 % | 58.1 % | 80.6 % |
| Standing | 2,159 | 100 % | 1.30 m | 1.35 m | 1.93 m | 2.04 m | 0 % | 35.8 % | 57.2 % | 85.7 % |
| Sitting and lying | 231 | 100 % | 1.17 m | 1.21 m | 1.54 m | 1.54 m | 0 % | 33.3 % | 66.7 % | 33.3 % |

Every reading came from Bluetooth (no LiDAR, no headset), with all three anchors heard.

| Spot | True position (m) | True zone | Runs | Mean position shown (m) | Mean error | Zone correct |
| :--- | :--- | :--- | ---: | :--- | ---: | ---: |
| P1 standing | 0.70, 0.40 | ROOM | 4 | 0.17, 1.57 | 1.28 m | 100 % |
| P2 standing | 0.70, 1.00 | ROOM | 4 | 0.15, 1.30 | 0.62 m | 100 % |
| P3 standing | 0.70, 1.60 | ROOM | 4 | 0.20, 1.28 | 0.59 m | 100 % |
| P4 standing | 0.60, 2.35 | ROOM | 4 | 0.15, 1.31 | 1.14 m | 100 % |
| P5 standing | 1.20, 2.35 | ROOM | 4 | 0.15, 1.04 | 1.68 m | 100 % |
| P6 standing | 1.90, 2.35 | ROOM | 4 | 0.21, 1.64 | 1.83 m | 100 % |
| P7 standing | 1.90, 3.00 | DOOR | 4 | 0.21, 2.05 | 1.94 m | 0 % |
| Bed edge, sitting | 1.35, 1.00 | BED | 1 | 0.24, 1.49 | 1.21 m | 0 % |
| Bed, lying | 1.74, 1.00 | BED | 1 | 0.20, 1.11 | 1.54 m | 0 % |
| Table, sitting | 0.80, 2.45 | ROOM | 1 | 0.19, 2.00 | 0.77 m | 100 % |

Mean error by facing (standing): north 1.24 m, east 1.27 m, south 1.33 m, west 1.36 m.

### Findings

1. **The position shown did not follow the tester.** In all 2,390 readings it was within 0.26 m of the west wall (x between 0.15 and 0.24 m on average at every spot), wherever the tester stood. The smaller errors at P2 and P3 come from those spots lying close to where the estimate stayed, not from tracking. The raw solver result before smoothing behaved the same way: mean error 1.36 m, 95 % 2.62 m.
2. **Cause: the distance estimates of anchors A and B were at their limit.** The server limits each anchor's distance estimate to the distance to that anchor's farthest room corner. A's estimate was at that limit in 79.1 % of readings, B's in 81.9 % and C's in 35.1 %. With A and B both reporting "as far away as possible", the solver puts the wristband where the room is farthest from both: along the west wall. With the calibration values above, any signal weaker than −67.8 dBm at A, or −69.1 dBm at B, already means "at the farthest corner or beyond". Most readings were weaker than that (per-run averages: A −64.6 to −81.4 dBm, B −66.1 to −91.1 dBm), often with the tester's body between the wristband and the anchor (finding 3).
3. **Turning on the spot changed the signals as much as moving across the room.** At P1, turning from one direction to another changed an anchor's averaged signal by up to 15.2 dB. At the door spot (P7) anchor B changed by 22.5 dB. With the path-loss model used (exponent 3.2), 15 dB corresponds to a factor of about 3 in estimated distance. The body between the wristband and an anchor absorbs the 2.4 GHz signal, which no calibration value can correct for every direction.
4. **Zones:** the system never placed the tester at the door or on the bed (0 % zone correct for P7 and both bed spots). The 80.6 % overall figure only reflects that the position shown was always in the general ROOM zone, where 7 of the 10 spots happen to be.
5. **The position shown held still within each run.** The wristband reported STATIONARY in 97–100 % of the readings of each run, and the server's motion lock then holds the position. That is correct for someone standing still. It also meant the position shown hardly changed between spots.

### Two references for the same room

| Reference | Mean error | Median | 95 % | Within 1.0 m | Within 1.5 m |
| :--- | ---: | ---: | ---: | ---: | ---: |
| Baseline system (measured above) | 1.29 m | 1.35 m | 1.93 m | 35.5 % | 58.1 % |
| A fixed guess: always the centre of the room (1.15, 1.70 m), scored on the same runs | 0.94 m | 0.85 m | 1.51 m | 74.2 % | 87.1 % |
| Lower bound for these three anchors from the placement planner (expected error over the floor, `services/ips/placement.js`) | 0.96 m | 0.95 m | 1.02 m | – | – |

- The baseline was worse than always showing the centre of this small room: it carried less information than none.
- The planner's lower bound is what Bluetooth signal strength from these three anchors could reach at best (signal spread 6 dB). The measured 1.29 m is above it, as a real system's error must be.
- Even at the bound, three anchors barely improve on knowing only the room (1.18 m expected error for the room alone). In a room 2.29 m wide, signal strength cannot place a patient much better than that.

### Against the requirement

The accuracy requirement (NFR-ACC-01) asks for a position within 1.0–1.5 m. The baseline has a mean error of 1.29 m, but only 58.1 % of readings were within 1.5 m (95 %: 1.93 m). It never recognised the door or the bed. In practice the baseline cannot tell where in WARD-005 the patient is. This is the reason for the LiDAR room sensor in Phase 10.

## After: LiDAR and Bluetooth

To be added after the LiDAR positioning is built (Phase 10, steps 5 and 6): the same spots, facings and postures, with six anchors and the LiDAR. Each reading also records the Bluetooth-only position, so that test will also give the Bluetooth-only accuracy with six anchors next to the combined result.

## Raw data

- [data/ips-baseline-2026-11-20_summary.csv](data/ips-baseline-2026-11-20_summary.csv): one row per run plus the session totals (the "ALL", "STANDING" and "SITTING+LYING" rows).
- [data/ips-baseline-2026-11-20_samples.csv](data/ips-baseline-2026-11-20_samples.csv): every reading (time, position shown, error, zone, Bluetooth-only and raw positions, motion state, each anchor's RSSI and distance).

Both files were downloaded from the Position test panel. The session itself is `edge_server/data/position_tests/PT-20261120-223212.json` on the edge server.
