# Bench Test Record: Fall Detection (Phase 3)

Purpose: measure how the wristband's fall detection behaves on real hardware after the accelerometer range fix, and decide whether the thesis thresholds need tuning.

| | Round 1 | Round 2 |
| :--- | :--- | :--- |
| Date | 14 Nov 2026 | |
| Tester | | |
| Wristband firmware | V5, packet version 2, commit `7d582ca` | V5, packet version 2, commit `e09175c` |
| Accelerometer range | ±8 g | ±16 g |
| Stillness check | 2 s, starting at the impact | 2 s, starting 0.5 s after the impact |
| Thresholds (both rounds) | Free-fall < 0.50 g for ≥ 150 ms, impact > 2.50 g within 500 ms, post-impact motion < 0.20 g | same |
| Landing surface | | |

## Method

The planned object drops (wristband strapped to a bottle, dropped from 1 m and 0.5 m) could not be used: the bottle bounced and rolled after every landing, so the stillness condition was never met and no drop was detected. That is the intended behaviour for an object that keeps moving.

Replacement used in both rounds: the wristband is worn on the wrist, the relaxed arm is dropped from about 0.5 m onto the landing surface and kept still for 3 seconds.

This is a stand-in for a fall, not a fall. It shows that the three phases (free-fall, impact, stillness) are detected on real hardware and that one event gives one incident. It does not measure sensitivity for whole-body falls, which cannot be tested safely without a test dummy.

## Safety

Do not drop the arm onto an edge or a surface that hurts. Nobody needs to fall for these tests.

## Before you start

1. Wristband on USB with the Arduino IDE Serial Monitor open at 115200 baud, or on battery with the dashboard open.
2. At power-on the Serial Monitor must show `[OK] MPU-6050 ready: +/-16 g range` (Round 1: `+/-8 g range`) and `[SELF-TEST] Fall detector: PASS`. If either is missing, stop and report it.
3. Lying still on the table, the `G:` value in the `[BROADCAST …]` lines should read between 0.95 and 1.05.
   - Round 1: 0.96 to 1.04 g, depending on the orientation of the wristband
   - Round 2: ______ g

## How to read a result

A detected fall prints one line about 2.5 seconds after the impact (Round 1: 2 seconds):

```
[ALERT] *** ON-CHIP KINEMATIC FALL CONFIRMED! #17 | free-fall min 0.12g | impact 4.37g | post-impact motion 0.06g ***
```

After a detected fall, wait 50 seconds before the next repetition: the wristband holds the alert for 45 seconds and detects nothing new during that time.

On the dashboard, each detected fall must produce exactly one pop-up. The pop-up shows the same three numbers as **Free-fall Min**, **Impact Force** and **Post-impact Motion**, so the tests can be done on battery, without the USB cable. Checked once on USB that the pop-up and the Serial Monitor agree: yes (Round 1, impact value compared).

If a pop-up was closed before the numbers were written down, every incident with its three values is listed at `http://localhost:3000/api/alerts/history` (`freefall_min_g`, `kinematic_impact_force`, `post_impact_stillness`). The times in that list are in UTC (they end in `Z`): add 8 hours for Malaysian time.

## Part A: events that should be detected

Arm drop from about 0.5 m, arm kept still for 3 seconds after landing.

### Round 1 (commit `7d582ca`)

| # | Detected? (Y/N) | Free-fall min (g) | Impact (g) | Post-impact motion (g) |
| :--- | :--- | :--- | :--- | :--- |
| 1 | Y | 0.08 | 12.44 | 0.17 |
| 2 | Y | 0.03 | 9.32 | 0.17 |
| 3 | Y | 0.14 | 8.10 | 0.15 |
| 4 | Y | 0.14 | 8.36 | 0.07 |
| 5 | Y | 0.09 | 11.60 | 0.06 |
| 6 | Y | 0.07 | 6.33 | 0.12 |
| 7 | Y | 0.08 | 6.73 | 0.11 |
| 8 | N | | | |
| 9 | Y | 0.06 | 7.88 | 0.10 |
| 10 | Y | 0.08 | 10.88 | 0.09 |

### Round 2 (commit `e09175c`)

| # | Detected? (Y/N) | Free-fall min (g) | Impact (g) | Post-impact motion (g) |
| :--- | :--- | :--- | :--- | :--- |
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |
| 4 | | | | |
| 5 | | | | |
| 6 | | | | |
| 7 | | | | |
| 8 | | | | |
| 9 | | | | |
| 10 | | | | |

### Round 2, optional: the same arm drop onto a pillow or mattress

Shows how far a soft landing is above the 2.50 g impact threshold.

| # | Detected? (Y/N) | Free-fall min (g) | Impact (g) | Post-impact motion (g) |
| :--- | :--- | :--- | :--- | :--- |
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |
| 4 | | | | |
| 5 | | | | |

## Part B: everyday movements that must NOT be detected

Wear the wristband. Write the number of fall alerts raised (expected 0).

| Test | Movement | Repetitions | Round 1 | Round 2 |
| :--- | :--- | :--- | :--- | :--- |
| B1 | Sit down hard on a chair | 10 | 0 | |
| B2 | Swing the arm vigorously, as in brisk walking | 10 | 0 | |
| B3 | Clap hands hard | 10 | 0 | |
| B4 | Put the arm down on a table firmly | 10 | 0 | |
| B5 | Walk normally for 2 minutes | 1 | 0 | |
| B6 | Lie down on the bed at normal speed | 10 | 0 | |
| B7 | Drop the arm as in Part A, then lift it again within one second and keep moving it for 3 seconds | 5 | not tested | |

B7 is new in Round 2: it checks that the settling time did not weaken the stillness condition.

## Part C: one fall, one incident (Round 1)

| Check | Result |
| :--- | :--- |
| With all anchors running, one drop created exactly one incident in the dashboard history | Y |
| After acknowledging, the same fall did not pop up again during the 45-second hold | Y |
| A second drop after the hold created a second incident | Y |

## Part D: fault reporting (Round 1)

| Check | Result |
| :--- | :--- |
| With the MPU-6050 unplugged, Serial Monitor shows `[IMU] FAULT` within a second and the live map shows `SENSOR FAULT (motion sensor)` | Y |
| After plugging it back in, `[IMU] Accelerometer is delivering data again` appears and the fault clears | Y |
| With the wristband powered off, the live map shows `NO SIGNAL` after 5 seconds | Y |

Parts C and D do not depend on the Round 2 changes and are not repeated.

## Summary

| Measure | Round 1 | Round 2 |
| :--- | :--- | :--- |
| Part A: arm drops detected ÷ performed | 9 / 10 | ___ / 10 |
| Part B: fall alerts ÷ repetitions | 0 / 51 | ___ / 56 |
| Part C: duplicate incidents | 0 | not repeated |

## Findings from Round 1

Taken from the 10 drops above and from all 41 falls the server recorded on 14 Nov 2026.

1. **Free-fall and impact have a wide margin.** Free-fall minimum 0.02 to 0.32 g against a limit of 0.50 g; impact 3.85 g and above against a limit of 2.50 g.
2. **The stillness value was measuring the landing, not the stillness.** 12 of the 41 recorded falls had a post-impact motion of 0.17 to 0.20 g, directly under the 0.20 g limit, although the arm was held still. The 2-second window started at the impact, so the shock of the landing and its ringing were averaged in. One sample of 12 g alone adds 0.11 g to that average. A harder impact was therefore less likely to be confirmed. Drop 8 was most probably lost this way (not proven: it was done on battery).
3. **Impact values were clipped.** The recorded impacts cluster at 8.0, 11.3 and 13.86 g. These are the ceiling values of a ±8 g sensor with one, two and three axes at their limit. The Round 1 impact values above 8 g are therefore lower bounds, not measurements.
4. **No false alarm** in 51 everyday movements.
5. **Known limit, by design:** an arm dropped onto a hard surface and then kept still is reported as a fall. A wrist-worn threshold detector cannot tell it from a fall of the body.

## Decision

- [x] Thresholds kept as in the thesis (0.50 g, 2.50 g, 0.20 g, 150 ms, 500 ms, 2 s).
- [x] Measurement changed after Round 1: stillness is observed for 2 s starting 0.5 s after the impact (reason: finding 2), and the accelerometer range is ±16 g (reason: finding 3). Round 2 repeated on: ____________
- [ ] Round 2 accepted: detection not worse than Round 1, no false alarm in Part B.
