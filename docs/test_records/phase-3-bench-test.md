# Bench Test Record: Fall Detection (Phase 3)

Purpose: measure how the wristband's fall detection behaves on real hardware after the accelerometer range fix, and decide whether the thesis thresholds need tuning.

| | |
| :--- | :--- |
| Date | |
| Tester | |
| Wristband firmware | V5, packet version 2 (branch `fix/phase-3-alarm-path`, commit: ) |
| Thresholds | Free-fall < 0.50 g for ≥ 150 ms, impact > 2.50 g within 500 ms, post-impact motion < 0.20 g for 2 s |
| Landing surface | |

## Safety

Use a mattress or thick cushions. Tests A1 and A2 use the wristband alone or strapped to a padded object; nobody needs to fall for them. Do test A3 only if you can do it without risk of injury, and skip it otherwise.

## Before you start

1. Wristband on USB with the Arduino IDE Serial Monitor open at 115200 baud, or on battery with the dashboard open.
2. At power-on the Serial Monitor must show `[OK] MPU-6050 ready: +/-8 g range` and `[SELF-TEST] Fall detector: PASS`. If either is missing, stop and report it.
3. Lying still on the table, the `G:` value in the `[BROADCAST …]` lines should read between 0.95 and 1.05. Record it: ______ g

## How to read a result

A detected fall prints one line about 2 seconds after the impact:

```
[ALERT] *** ON-CHIP KINEMATIC FALL CONFIRMED! #17 | free-fall min 0.12g | impact 4.37g | post-impact motion 0.06g ***
```

Copy the three numbers into the table. After a detected fall, wait 50 seconds before the next repetition: the wristband holds the alert for 45 seconds and detects nothing new during that time.

On the dashboard, each detected fall must produce exactly one pop-up, and the impact shown must match the Serial Monitor.

## Part A: events that should be detected

Leave the wristband completely still for 3 seconds after each landing.

### A1. Drop onto the mattress from about 1 metre (wristband strapped to a cushion or soft bag)

| # | Detected? (Y/N) | Free-fall min (g) | Impact (g) | Post-impact motion (g) | Dashboard pop-ups |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | | | | | |
| 2 | | | | | |
| 3 | | | | | |
| 4 | | | | | |
| 5 | | | | | |
| 6 | | | | | |
| 7 | | | | | |
| 8 | | | | | |
| 9 | | | | | |
| 10 | | | | | |

### A2. Drop onto the mattress from about 0.5 metre

| # | Detected? (Y/N) | Free-fall min (g) | Impact (g) | Post-impact motion (g) | Dashboard pop-ups |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | | | | | |
| 2 | | | | | |
| 3 | | | | | |
| 4 | | | | | |
| 5 | | | | | |

### A3. Optional: wearing the wristband, let yourself fall sideways from sitting on the bed edge onto the mattress, then lie still

| # | Detected? (Y/N) | Free-fall min (g) | Impact (g) | Post-impact motion (g) | Dashboard pop-ups |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | | | | | |
| 2 | | | | | |
| 3 | | | | | |
| 4 | | | | | |
| 5 | | | | | |

## Part B: everyday movements that must NOT be detected

Wear the wristband. Ten repetitions each. Write the number of fall alerts raised.

| Test | Movement | Repetitions | Fall alerts raised (expected 0) |
| :--- | :--- | :--- | :--- |
| B1 | Sit down hard on a chair | 10 | |
| B2 | Swing the arm vigorously, as in brisk walking | 10 | |
| B3 | Clap hands hard | 10 | |
| B4 | Put the arm down on a table firmly | 10 | |
| B5 | Walk normally for 2 minutes | 1 | |
| B6 | Lie down on the bed at normal speed | 10 | |

## Part C: one fall, one incident

| Check | Result |
| :--- | :--- |
| With all anchors running, one drop created exactly one incident in the dashboard history | |
| After acknowledging, the same fall did not pop up again during the 45-second hold | |
| A second drop after the hold created a second incident | |

## Part D: fault reporting (optional, needs the wristband open)

| Check | Result |
| :--- | :--- |
| With the MPU-6050 unplugged, Serial Monitor shows `[IMU] FAULT` within a second and the live map shows `SENSOR FAULT (motion sensor)` | |
| After plugging it back in, `[IMU] Accelerometer is delivering data again` appears and the fault clears | |
| With the wristband powered off, the live map shows `NO SIGNAL` after 5 seconds | |

## Summary

| Measure | Value |
| :--- | :--- |
| Sensitivity, Part A: detected ÷ performed | ___ / ___ |
| False alarms, Part B: alerts ÷ repetitions | ___ / ___ |
| Duplicate incidents, Part C | |

## Notes and observations

(For an undetected drop, copy a few `[BROADCAST …]` lines around the event if you can: the `G:` values show which phase was missed.)

## Decision

- [ ] Thresholds kept as in the thesis.
- [ ] Thresholds changed to: ______________________ (reason: ______________________). Tests repeated on: ____________
