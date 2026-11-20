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

## Six Bluetooth anchors (21 November 2026)

The same spots, facings and postures, after three anchors were added where the placement planner put them. The position shown is still Bluetooth only: the LiDAR was mounted and its turns were recorded with every run, but it did not yet give positions.

### Set-up

| Item | Value |
| :--- | :--- |
| Date and time | 21 November 2026, 05:58–06:24 |
| Tester | Project author |
| Code | edge server `94c9863` (Phase 10 step 5a); anchor firmware V4 on A–D, V4.1 on E and F (`830ca38`) |
| Ward | WARD-005, as in the baseline |
| Wristband | `TAG-002` |
| Anchors | A, B, C unchanged (2.40 m high); D, E, F added at 2.30 m where the placement planner put them. A–D are ESP32-WROOM-32E boards, E and F Seeed XIAO ESP32-C3. All six calibrated again with 🎯 Calibrate Anchors, the tester turning a full circle on the spot during the 10 s. |
| LiDAR | RPLIDAR C1 on the east wall at 2.12, 2.12 m, base 0.92 m, ▲ 272.5° (from 🎯 Align to walls); empty room learned (201 turns). Turns recorded with every run; not used for the position shown. |
| Session | `PT-20261121-055850` ("Re 6 anchors"), 31 runs, 2,417 readings. An earlier attempt the same morning (`PT-20261121-054324`, 14 runs) was stopped and is not used. |

| Anchor | Device | Board | Position (x, y, height) | Calibrated RSSI at 1 m | Path-loss exponent |
| :--- | :--- | :--- | :--- | :--- | :--- |
| A | `anchor-001` | ESP32-WROOM-32E | 1.89, 3.39, 2.40 m (north wall) | −41.4 dBm | 3.2 |
| B | `anchor-002` | ESP32-WROOM-32E | 2.29, 0.40, 2.40 m (east wall) | −51.1 dBm | 3.2 |
| C | `anchor-003` | ESP32-WROOM-32E | 0.00, 2.13, 2.40 m (west wall) | −64.8 dBm | 3.2 |
| D | `anchor-004` | ESP32-WROOM-32E | 0.80, 0.00, 2.30 m (south wall) | −48.9 dBm | 3.2 |
| E | `anchor-005` | XIAO ESP32-C3 | 0.90, 3.39, 2.30 m (north wall) | −43.6 dBm | 3.2 |
| F | `anchor-006` | XIAO ESP32-C3 | 2.29, 1.90, 2.30 m (east wall) | −56.4 dBm | 3.2 |

### Results

| Runs | Readings | Available | Mean error | Median | 95 % | Largest | Within 0.5 m | Within 1.0 m | Within 1.5 m | Zone correct |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| All | 2,417 | 100 % | 1.00 m | 0.95 m | 1.58 m | 1.71 m | 3.9 % | 57.5 % | 81.6 % | 20.1 % |
| Standing | 2,183 | 100 % | 0.99 m | 0.91 m | 1.60 m | 1.71 m | 4.4 % | 63.2 % | 79.6 % | 15.1 % |
| Sitting and lying | 234 | 100 % | 1.09 m | 1.09 m | 1.15 m | 1.21 m | 0 % | 4.3 % | 100 % | 66.7 % |

Every reading came from Bluetooth, with all six anchors heard.

| Spot | True position (m) | True zone | Runs | Mean position shown (m) | Mean error | Zone correct |
| :--- | :--- | :--- | ---: | :--- | ---: | ---: |
| P1 standing | 0.70, 0.40 | ROOM | 4 | 0.82, 1.86 | 1.50 m | 52 % |
| P2 standing | 0.70, 1.00 | ROOM | 4 | 1.07, 1.47 | 0.88 m | 25 % |
| P3 standing | 0.70, 1.60 | ROOM | 4 | 1.19, 1.78 | 0.54 m | 0 % |
| P4 standing | 0.60, 2.35 | ROOM | 4 | 1.14, 1.62 | 0.90 m | 0 % |
| P5 standing | 1.20, 2.35 | ROOM | 4 | 0.92, 1.81 | 0.64 m | 29 % |
| P6 standing | 1.90, 2.35 | ROOM | 4 | 1.37, 1.63 | 0.94 m | 0 % |
| P7 standing | 1.90, 3.00 | DOOR | 4 | 1.19, 1.61 | 1.56 m | 0 % |
| Bed edge, sitting | 1.35, 1.00 | BED | 1 | 0.24, 1.17 | 1.13 m | 0 % |
| Bed, lying | 1.74, 1.00 | BED | 1 | 1.19, 1.90 | 1.06 m | 100 % |
| Table, sitting | 0.80, 2.45 | ROOM | 1 | 0.21, 1.54 | 1.08 m | 100 % |

Mean error by facing (standing): north 0.98 m, east 1.04 m, south 0.98 m, west 0.97 m.

### Compared with the baseline

| | Baseline, 3 anchors | 6 anchors |
| :--- | ---: | ---: |
| Mean error | 1.29 m | 1.00 m |
| Median | 1.35 m | 0.95 m |
| 95 % | 1.93 m | 1.58 m |
| Within 1.0 m | 35.5 % | 57.5 % |
| Within 1.5 m | 58.1 % | 81.6 % |
| Zone correct | 80.6 % | 20.1 % |
| Raw solver result (before smoothing), mean | 1.36 m | 1.19 m |
| A fixed guess at the centre of the room, same spots | 0.94 m | 0.94 m |
| Lower bound from the placement planner | 0.96 m | 0.81 m |

### Findings

1. **Better than the baseline, but still no better than guessing the centre of the room.** The mean error fell from 1.29 m to 1.00 m and the share within 1.5 m rose from 58.1 % to 81.6 %. Always showing the centre of the room would score 0.94 m on the same runs. The positions shown no longer stay along the west wall. Instead they gather near the middle of the room (on average x 0.82–1.37 m, y 1.47–1.90 m at the standing spots), and still barely follow the tester: P1 at 0.70, 0.40 m was shown at 0.82, 1.86 m, and the door spot P7 at 1.90, 3.00 m was shown at 1.19, 1.61 m.
2. **Cause: again, distance estimates at their limit.** Anchor A's estimate was at its limit (the distance to its farthest room corner) in 99.9 % of readings, E's in 91.1 %, D's in 65.1 % and B's in 58.9 %. C's (16.1 %) and F's (18.9 %) were mostly below it. With A calibrated at −41.4 dBm, any filtered signal weaker than about −61 dBm already means "4 m or more", and A's median raw signal was −69 dBm. With most anchors saying "as far as possible", the solver settles where it is farthest from all of them: the middle.
3. **The calibration is not repeatable.** Anchor A's calibrated value was −48.4 dBm on 20 November, −61.1 dBm early on 21 November, and −41.4 dBm for this session. Each calibration is one 10-second reading at one spot. At P1, anchor A's averaged signal changed by 22.8 dB between facings, so a calibration taken while the body is on one side of the wristband or the other can differ by that much. A calibration fitted over several spots and facings would be steadier, but signal strength would still not place the patient much better in a room this size: the planner's lower bound for six anchors is 0.81 m.
4. **Zone correct fell from 80.6 % to 20.1 %; this is not a loss of accuracy.**
   - In the baseline the estimate never left the general ROOM zone along the west wall. 25 of the 31 runs are at ROOM spots, so "always ROOM" scores exactly 80.6 %.
   - Now the estimate sits in the middle of the room, which lies inside the bed zone: the bed plus 0.3 m around it covers x 0.89–2.29 m, y 0–2.30 m, 41 % of the floor. So readings at ROOM spots are placed in the bed zone.
   - With about 1 m of error in a room 2.29 m wide, Bluetooth cannot tell the bed zone from the floor beside it.
5. **The XIAO ESP32-C3 anchors work as well as the others after the firmware fix.** With anchor firmware V4, E and F restarted about every 25 s and passed on about half as many readings. The core version used (3.3.13) runs a different Bluetooth stack (NimBLE) on the C3, and the scan's device list ran the memory out. V4.1 fixed this before the session. In this session E and F were heard in 100 % of readings, and the median age of their latest reading was 149–150 ms, the same as the WROOM-32E anchors (150–156 ms).
6. **Motion state:** the wristband reported STATIONARY in 86 % of readings and HAND_MOVEMENT in 13 % (baseline: 99 % and 1 %), although the tester stood still in every run.

### What the LiDAR saw in the same runs (offline check, preliminary)

The LiDAR's turns were recorded with every run (6,208 turns while recording). This check is **not** the system's output: the person finder that turns scans into positions is still to be built (Phase 10, step 5b). In each turn:
- returns more than 10 cm closer than the learned empty room, inside the room, were grouped into clusters;
- the cluster nearest the taped spot was taken, moved 0.10 m further from the LiDAR (it sees the front of the body);
- its distance to the spot was measured.

| Spot | Turns | Nearest cluster: median distance to the spot | 95 % | Within 0.5 m |
| :--- | ---: | ---: | ---: | ---: |
| P1 standing | 805 | 0.12 m | 0.17 m | 100 % |
| P2 standing | 803 | 0.11 m | 0.15 m | 100 % |
| P3 standing | 800 | 0.07 m | 0.12 m | 100 % |
| P4 standing | 799 | 0.11 m | 0.19 m | 100 % |
| P5 standing | 799 | 0.05 m | 0.09 m | 100 % |
| P6 standing | 802 | 0.05 m | 0.09 m | 100 % |
| P7 standing (door) | 799 | 0.05 m | 0.10 m | 96 % |
| Bed edge, sitting | 201 | 0.07 m | 0.08 m | 100 % |
| Bed, lying | 200 | not seen | – | 0 % |
| Table, sitting | 200 | 0.13 m | 0.14 m | 100 % |
| All standing | 5,607 | 0.08 m | 0.17 m | 99.4 % |

- **Upper bound, not a result.** Taking the cluster nearest the true spot assumes the right cluster is chosen. The real finder must decide by itself which cluster is the patient and link it to the wristband.
- **A lying patient is not seen:** the body is below the scan slice at 0.95 m.
- **One other object was in the scan in 87 % of turns.** It was about 9 cm wide, near the west wall at about 0.3, 2.1 m, and was not there when the empty room was learned. The tester's body was 0.21 m wide on average (18 returns) and often appeared as two clusters (torso and an arm), so a person can be told from such clutter by size, after joining clusters that are close together.

### Against the requirement

With six anchors, 81.6 % of readings were within 1.5 m (mean 1.00 m), so Bluetooth now meets the 1.0–1.5 m band of NFR-ACC-01 most of the time. It does so no better than a fixed guess at the room centre (0.94 m), though: in WARD-005 the band is met because the room is small, not because the patient is located. The offline LiDAR check points to about 0.1 m for a standing or sitting patient, once the LiDAR's person is linked to the wristband.

## After: LiDAR and Bluetooth

To be added after the LiDAR positioning is built (Phase 10, steps 5b and 6): the same spots, facings and postures, with six anchors and the LiDAR. Each reading also records the Bluetooth-only position, so that test will also give the Bluetooth-only accuracy with six anchors next to the combined result.

## Raw data

- [data/ips-baseline-2026-11-20_summary.csv](data/ips-baseline-2026-11-20_summary.csv): one row per run plus the session totals (the "ALL", "STANDING" and "SITTING+LYING" rows).
- [data/ips-baseline-2026-11-20_samples.csv](data/ips-baseline-2026-11-20_samples.csv): every reading (time, position shown, error, zone, Bluetooth-only and raw positions, motion state, each anchor's RSSI and distance).
- [data/ips-6anchors-2026-11-21_summary.csv](data/ips-6anchors-2026-11-21_summary.csv) and [data/ips-6anchors-2026-11-21_samples.csv](data/ips-6anchors-2026-11-21_samples.csv): the same for the six-anchor session, with the LiDAR turns recorded per run.

All four files were downloaded from the Position test panel. The sessions themselves are `PT-20261120-223212.json` and `PT-20261121-055850.json` in `edge_server/data/position_tests/` on the edge server, together with the LiDAR turns of each run of the second (`PT-20261121-055850-run<n>.lidar.json.gz`, git-ignored).
