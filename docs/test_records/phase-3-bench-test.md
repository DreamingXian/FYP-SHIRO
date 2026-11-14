# Bench Test Record: Fall Detection (Phase 3)

Purpose: measure how the wristband's fall detection behaves on real hardware after the accelerometer range fix, and decide whether the thesis thresholds need tuning.

| | Round 1 | Round 2 | Round 3 (short check) |
| :--- | :--- | :--- | :--- |
| Date | 14 Nov 2026 | 14 Nov 2026 | 14 Nov 2026 |
| Tester | Tan Shou Xian | Tan Shou Xian | Tan Shou Xian |
| Wristband firmware | V5, packet version 2, commit `7d582ca` | V5, packet version 2, commit `e09175c` | commit `8452374` |
| Accelerometer range | ±8 g | ±16 g | ±16 g |
| Stillness check | 2 s, starting at the impact | 2 s, starting 0.5 s after the impact | as Round 2 |
| Heart rate reporting | first beat interval onwards | as Round 1 | after 3 beat intervals, withdrawn after 6 s without a beat |
| Thresholds (all rounds) | Free-fall < 0.50 g for ≥ 150 ms, impact > 2.50 g within 500 ms, post-impact motion < 0.20 g | same | same |
| Landing surface | wooden table | wooden table | wooden table |

## Method

The planned object drops (wristband strapped to a bottle, dropped from 1 m and 0.5 m) could not be used: the bottle bounced and rolled after every landing, so the stillness condition was never met and no drop was detected. That is the intended behaviour for an object that keeps moving.

Replacement used in all rounds: the wristband is worn on the wrist, the relaxed arm is dropped from about 0.5 m onto the landing surface and kept still for 3 seconds.

This is a stand-in for a fall, not a fall. It shows that the three phases (free-fall, impact, stillness) are detected on real hardware and that one event gives one incident. It does not measure sensitivity for whole-body falls, which cannot be tested safely without a test dummy.

## Safety

Do not drop the arm onto an edge or a surface that hurts. Nobody needs to fall for these tests.

## Before you start

1. Wristband on USB with the Arduino IDE Serial Monitor open at 115200 baud, or on battery with the dashboard open.
2. At power-on the Serial Monitor must show `[OK] MPU-6050 ready: +/-16 g range` (Round 1: `+/-8 g range`) and `[SELF-TEST] Fall detector: PASS`. If either is missing, stop and report it.
3. Lying still on the table, the `G:` value in the `[BROADCAST …]` lines should read between 0.95 and 1.05.
   - Round 1: 0.96 to 1.04 g, depending on the orientation of the wristband
   - Round 2: 0.96 to 1.04 g

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

"n.r." means the fall was detected and raised an alert, but the pop-up showed "not reported" for the three values. The cause is explained in finding 8.

**Series 1** (09:27 to 09:44)

| # | Detected? (Y/N) | Free-fall min (g) | Impact (g) | Post-impact motion (g) | Note |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | Y | 0.11 | 5.81 | 0.02 | |
| 2 | Y | 0.09 | 10.70 | 0.02 | |
| 3 | Y | n.r. | n.r. | n.r. | |
| 4 | Y | n.r. | n.r. | n.r. | |
| 5 | Y | n.r. | n.r. | n.r. | |
| 6 | Y | 0.13 | 5.68 | 0.02 | |
| 7 | N | | | | |
| 8 | Y | n.r. | n.r. | n.r. | |
| 9 | Y | 0.33 | 2.88 | 0.03 | |
| 10 | Y | n.r. | n.r. | n.r. | |

**Series 2** (11:08 to 11:22, after charging the battery to 50%)

| # | Detected? (Y/N) | Free-fall min (g) | Impact (g) | Post-impact motion (g) | Note |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | Y | 0.20 | 8.60 | 0.03 | |
| 2 | N | | | | |
| 3 | Y | 0.17 | 4.21 | 0.03 | |
| 4 | N | | | | |
| 5 | Y | n.r. | n.r. | n.r. | |
| 6 | Y | 0.12 | 5.70 | 0.03 | |
| 7 | Y | n.r. | n.r. | n.r. | |
| 8 | Y | 0.06 | 5.97 | 0.03 | |
| 9 | Y | n.r. | n.r. | n.r. | |
| 10 | Y | n.r. | n.r. | n.r. | |

**Series 3** (from 11:27; battery connection watched, values recorded only while the supply looked normal)

| # | Detected? (Y/N) | Free-fall min (g) | Impact (g) | Post-impact motion (g) | Note |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | Y | 0.19 | 8.35 | 0.02 | |
| 2 | Y | 0.25 | 11.46 | 0.02 | |
| 3 | Y | 0.21 | 3.72 | 0.02 | |
| 4 | Y | 0.15 | 7.02 | 0.04 | |
| 5 | Y | 0.29 | 3.89 | 0.02 | |
| 6 | Y | 0.08 | 3.04 | 0.02 | |
| 7 | N | | | | Series stopped here: see hardware fault below |

Hardware fault found during Series 3: the battery level fell from 20% to 0% within seconds. The battery measured 3.62 V directly, but only 3.1 to 3.4 V (unstable) on the wire to BAT+ and D0. Cause: the soldered power switch was defective and did not pass the full voltage. The switch was replaced before Series 4.

**Series 4** (13:05 to 14:30, new power switch)

| # | Detected? (Y/N) | Free-fall min (g) | Impact (g) | Post-impact motion (g) | Note |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | Y | 0.25 | 7.44 | 0.03 | |
| 2 | Y | 0.24 | 8.21 | 0.03 | |
| 3 | Y | n.r. | n.r. | n.r. | |
| 4 | Y | n.r. | n.r. | n.r. | battery at 4% |
| 5 | Y | 0.05 | 13.25 | 0.03 | after 5 minutes of charging, 8% |
| 6 | Y | 0.06 | 9.19 | 0.03 | |
| 7 | Y | 0.15 | 7.31 | 0.03 | |
| 8 | Y | 0.28 | 8.75 | 0.03 | |
| 9 | N | | | | |
| 10 | Y | 0.14 | 8.14 | 0.03 | |
| 11 | Y | n.r. | n.r. | n.r. | battery at 15%. Serial Monitor at the same moment: `#244, free-fall min 0.24g, impact 17.19g, post-impact motion 0.03g` |
| | | | | | edge server restarted here |
| 12 | Y | 0.12 | 6.11 | 0.03 | |
| 13 | N | | | | |
| 14 | Y | 0.11 | 17.91 | 0.03 | |
| 15 | Y | 0.16 | 6.79 | 0.03 | |
| 16 | Y | 0.18 | 16.15 | 0.03 | |
| 17 | Y | 0.07 | 5.37 | 0.03 | |
| 18 | Y | 0.21 | 7.91 | 0.03 | |
| 19 | Y | 0.22 | 15.93 | 0.03 | |
| 20 | Y | 0.21 | 5.86 | 0.03 | |

### Round 2: the same arm drop onto a pillow or mattress

| # | Detected? (Y/N) | Free-fall min (g) | Impact (g) | Post-impact motion (g) | Note |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | Y | 0.12 | 15.75 | 0.07 | |
| 2 | Y | 0.12 | 13.72 | 0.07 | |
| 3 | Y | n.r. | n.r. | n.r. | battery at 4% |
| 4 | Y | n.r. | n.r. | n.r. | battery at 3% |
| 5 | Y | 0.05 | 14.55 | 0.03 | battery recharged |
| 6 | Y | 0.08 | 14.29 | 0.09 | |
| 7 | Y | 0.07 | 17.95 | 0.04 | |

## Part B: everyday movements that must NOT be detected

Wear the wristband. Number of fall alerts raised (expected 0).

| Test | Movement | Repetitions | Round 1 | Round 2 |
| :--- | :--- | :--- | :--- | :--- |
| B1 | Sit down hard on a chair | 10 | 0 | 0 |
| B2 | Swing the arm vigorously, as in brisk walking | 10 | 0 | 0 |
| B3 | Clap hands hard | 10 | 0 | 0 |
| B4 | Put the arm down on a table firmly | 10 | 0 | 0 |
| B5 | Walk normally for 2 minutes | 1 | 0 | 0 |
| B6 | Lie down on the bed at normal speed | 10 | 0 | 0 |
| B7 | Drop the arm as in Part A, then lift it again within one second and keep moving it for 3 seconds | 6 | not tested | 3 |

Values of the three B7 alerts:

| Free-fall min (g) | Impact (g) | Post-impact motion (g) |
| :--- | :--- | :--- |
| 0.10 | 5.41 | 0.15 |
| 0.22 | 3.87 | 0.20 |
| 0.18 | 24.03 | 0.16 |

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

## Summary

| Measure | Round 1 | Round 2 |
| :--- | :--- | :--- |
| Part A, hard surface: arm drops detected ÷ performed | 9 / 10 | 41 / 47 in all four series; 18 / 20 after the power switch was replaced (Series 4) |
| Part A, soft surface | not tested | 7 / 7 |
| Post-impact motion of detected drops, arm held still | 0.06 to 0.17 g | 0.02 to 0.04 g (hard surface), 0.03 to 0.09 g (soft surface) |
| Part B, B1 to B6: fall alerts ÷ repetitions | 0 / 51 | 0 / 51 |
| Part B, B7 | not tested | 3 / 6 |
| Part C: duplicate incidents | 0 | one, caused by restarting the server during a fall hold (finding 9) |
| False vitals alarms raised during the test day | not counted | 68 (finding 10) |

## Findings from Round 1

Taken from the 10 drops above and from all 41 falls the server recorded up to 08:25 on 14 Nov 2026.

1. **Free-fall and impact have a wide margin.** Free-fall minimum 0.02 to 0.32 g against a limit of 0.50 g; impact 3.85 g and above against a limit of 2.50 g.
2. **The stillness value was measuring the landing, not the stillness.** 12 of the 41 recorded falls had a post-impact motion of 0.17 to 0.20 g, directly under the 0.20 g limit, although the arm was held still. The 2-second window started at the impact, so the shock of the landing and its ringing were averaged in. One sample of 12 g alone adds 0.11 g to that average.
3. **Impact values were clipped.** The recorded impacts cluster at 8.0, 11.3 and 13.86 g. These are the ceiling values of a ±8 g sensor with one, two and three axes at their limit.
4. **No false alarm** in 51 everyday movements.
5. **Known limit, by design:** an arm dropped onto a hard surface and then kept still is reported as a fall. A wrist-worn threshold detector cannot tell it from a fall of the body.

## Findings from Round 2

6. **The settling time works.** With the arm held still, post-impact motion is now 0.02 to 0.04 g on a hard surface and at most 0.09 g on a pillow, far below the 0.20 g limit. Finding 2 is resolved.
7. **Detection rate is unchanged, about 9 in 10.** Six of 47 hard-surface drops were not detected. The reason was not recorded (tests on battery). The stillness margin is now large, so the most likely phase is the free-fall: a relaxed arm pivots at the shoulder and is not always in free-fall for 150 ms. The recorded free-fall minimum reached 0.33 g in a detected drop, which is not far from the 0.50 g limit.
8. **"Not reported" was a server setting, not the battery.** Until the edge server was restarted at about 14:07 it still ran with the old plausibility limit of 16 g and discarded the values of every fall whose impact was higher. Evidence: before the restart no stored impact exceeds 15.75 g and 35 of 60 falls have no values; after the restart 9 of 17 falls exceed 15.9 g and none is without values. Drop 11 of Series 4 shows it directly (17.19 g on the Serial Monitor, "not reported" in the pop-up). The falls themselves were always detected and alarmed. The limit is now 28 g, above what the sensor can deliver.
9. **A server restart during a fall hold raised the same fall twice** (incidents 0218 and 0219, 43 seconds apart). Fixed in commit `8452374`: after a start the server checks the audit log before opening a new fall incident.
10. **Vitals alarms were not usable.** 68 vitals alarms were raised on a healthy tester during the day, 63 of them for low SpO2. Of 66,698 SpO2 readings stored that day, 68% were below 90% and 33% below 85%. The SpO2 formula of the wristband is not calibrated and reads far too low on this hardware. Two rule errors added to it: "sustained for 57 s" was reported for two readings with a 45-second silence between them, and 9 of 13 false "below 40 BPM" episodes were the first beat interval of a measurement. Fixed in commit `8452374`: SpO2 is displayed as indicative only and raises no alarm; heart-rate rules need an unbroken series of readings; the wristband reports a heart rate only after three beat intervals. Replaying the stored readings of the day gives 229 alarms with the old rules and 16 with the new server rules (all heart rate, before the firmware change).
11. **Impact values above 16 g are lower bounds.** Values at 16.0 to 18 g and 24.03 g show one or two axes at the ±16 g ceiling, which is the widest range of the MPU-6050. This does not affect detection (limit 2.50 g).
12. **B7: gentle movement after the impact does not always cancel the alert** (3 of 6). The measured values separate cleanly: arm still at most 0.09 g, arm moving 0.15 g and above. A limit near 0.12 g would cancel these alerts. It is kept at 0.20 g on purpose: a fallen patient who moves a little must still raise an alarm, and missing that is worse than a false alarm.
13. **Hardware:** a defective power switch caused an unstable supply in Series 1 to 3 and was replaced. Detection and the measured values were not visibly affected by it.

## Round 3: short check after commit `8452374`

The fall detector is unchanged, so drops are not repeated in full. This round checks the vitals changes. The wristband was worn from 15:22 to 15:58.

| Check | Result |
| :--- | :--- |
| Edge server restarted and wristband reflashed | Y |
| Wear the wristband for 20 minutes of normal activity (sitting, typing, walking), 15:22 to 15:42. Number of vitals alarms (expected 0) | 0 |
| Heart rate shown while sitting still is plausible (compare with a manual pulse count): counted 94 BPM, shown 53 to 130 BPM within one minute, mean 96 BPM | Not stable (finding 15) |
| SpO2 on the live map is shown in grey, and Live Lab shows "Indicative only" | Y |
| 3 arm drops: each gives one fall pop-up with three values, and no vitals alarm follows within 2 minutes | Y |
| Restart the edge server within 30 seconds after a fall pop-up: no second incident for the same fall | Y (finding 16) |

Observations of the tester:

- The vitals trend of the patient (P-006) showed readings only from 15:22 to 15:28, although the Serial Monitor showed a measurement burst every 3 minutes for the whole 20 minutes. See finding 14.
- After a server restart there was no second pop-up when the alarm had been acknowledged before the restart. An alarm that had not been acknowledged yet popped up again after the restart. See finding 16.

### Server records of the round

Read from the alert history and from InfluxDB after the test.

| Measure | Value |
| :--- | :--- |
| Vitals alarms raised, 15:03 to 15:58 | 0 |
| Fall incidents | 4 (INC-20261114-0249 to 0252, at 15:54:03, 15:55:15, 15:56:14 and 15:57:11): the 3 arm drops and the drop for the restart check. One incident per fall. |
| Values of the 4 falls | free-fall minimum 0.22, 0.32, 0.31, 0.35 g; impact 18.48, 10.12, 15.80, 13.57 g; post-impact motion 0.03 g each |
| Passive measurement bursts stored | every 3 minutes: 15:22, 15:25, 15:28, 15:31, 15:35, 15:38, 15:41, 15:44, about one minute each |
| Readings stored, 15:22 to 15:58 | 5,603, of which 3,295 (59%) carry a heart rate |
| The same readings replayed through the alarm rules | 0 alarms |
| Heart-rate readings above 120 BPM / below 50 BPM | 10% / 5% |
| Longest unbroken series of abnormal heart-rate readings | 11.8 s, directly after an arm drop (an alarm needs 30 s, or two confirmed series with no normal reading between them) |

### Heart rate against a manual pulse count

Sitting still, active streaming, about one minute. The complete Serial Monitor log (298 broadcast lines) is in `phase-3-round3-serial-log.txt`.

| Measure | Value |
| :--- | :--- |
| Manual pulse count | 94 BPM |
| Heart-rate values shown, in order | 115, 103, 85, 62, 53, 60, 78, 96, 105, 96, 101, 130, none (26 lines), 106, 104, 91, 80, 91, 90, 85, 77, 87, 93, 103, 96, 80 |
| Lowest and highest value | 53 and 130 BPM |
| Mean and median of the lines with a heart rate | 96 and 96 BPM |
| Lines within ±10 BPM of the count | 48% |
| Lines within ±20 BPM of the count | 72% |
| Lines before the first heart rate | 68 of 298 (about 14 seconds) |
| SpO2 during the same minute | 85 to 93%, median 89% |

## Findings from Round 3

14. **The vitals trend showed only the oldest readings.** All readings were stored (a burst every 3 minutes, see the table above). The history query kept the first 500 points of each stored series, which are the oldest of the selected range, and returned the passive and the active readings as two blocks instead of in time order. Fixed in commit `de46bce`: the trend shows one point per interval (the median of the readings in it: 10 s for 1 hour, 1 min for 6 hours, 5 min for 24 hours, 30 min for 7 days, 2 h for 30 days), so every range is shown completely. Checked against the stored readings of this round: the 1-hour trend now runs from 15:22 to 15:58.
15. **The alarm rules hold, but the heart rate itself is not stable.** No vitals alarm was raised in 36 minutes of wear, live and in the replay. The heart rate behind it is noisy: sitting still with a counted pulse of 94 BPM, the wristband showed values from 53 to 130 BPM within one minute. The average is right (96 BPM), single values are not. The first value took about 14 seconds, and one value (130) stayed until it was withdrawn after 6 seconds without a beat. Cause: on the wrist the beat detection misses beats and detects extra ones, and a median of four beats does not absorb that. This is a limit of the measurement, not of the alarm path. It is open and is handled as a separate task (heart-rate measurement quality), with recorded beat intervals as the basis.
16. **An unacknowledged alarm is shown again after a server restart. This is intended.** No second incident is created: the history holds one incident per fall. When the dashboard reconnects it asks the server for the alarms that are still open and shows them again. An alarm that nobody has acknowledged must not disappear because the server was restarted.

## Decision

- [x] Thresholds kept as in the thesis (0.50 g, 2.50 g, 0.20 g, 150 ms, 500 ms, 2 s).
- [x] Measurement changed after Round 1: stillness is observed for 2 s starting 0.5 s after the impact (finding 2), and the accelerometer range is ±16 g (finding 3). Round 2 repeated on 14 Nov 2026.
- [x] Round 2 accepted for fall detection: detection not worse than Round 1 (18 / 20 against 9 / 10), no false alarm in B1 to B6. B7 recorded as a known limit (finding 12).
- [x] After Round 2: SpO2 raises no alarm until it is calibrated; heart-rate alarm rules and heart-rate reporting corrected (finding 10).
- [x] Round 3 accepted for the alarm path: no false vitals alarm, one incident per fall, no second incident after a server restart.
- [ ] Open, outside Phase 3: stability of the heart-rate value (finding 15).
