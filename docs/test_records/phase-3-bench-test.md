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

| Measure | Round 1 | Round 2 | Round 4 (V5.2) |
| :--- | :--- | :--- | :--- |
| Part A, hard surface: arm drops detected ÷ performed | 9 / 10 | 41 / 47 in all four series; 18 / 20 after the power switch was replaced (Series 4) | 9 / 12 |
| Part A, soft surface | not tested | 7 / 7 | not repeated |
| Post-impact motion of detected drops, arm held still | 0.06 to 0.17 g | 0.02 to 0.04 g (hard surface), 0.03 to 0.09 g (soft surface) | 0.02 g |
| Part B, B1 to B6: fall alerts ÷ repetitions | 0 / 51 | 0 / 51 | not repeated |
| Part B, B7 | not tested | 3 / 6 | not repeated |
| Arm dropped against the leg while standing (Round 4): fall alerts ÷ repetitions | not tested | not tested | 3 / 21 (2 / 11 with the hand moving, 1 / 10 standing still) |
| Part C: duplicate incidents | 0 | one, caused by restarting the server during a fall hold (finding 9) | not checked |
| False vitals alarms raised during the test day | not counted | 68 (finding 10) | not counted |

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

## Round 4: false alarms while standing (21 November 2026)

### What happened

Three fall alarms were raised although nobody fell: one during a demonstration to the supervisor, two during the position test while the tester walked, turned and stood with some hand movement.

| Date and time | Situation | Free-fall min | Impact | Post-impact motion |
| :--- | :--- | ---: | ---: | ---: |
| 16 Nov 2026, 14:54:19 | Demonstration to the supervisor | 0.26 g | 3.47 g | 0.13 g |
| 21 Nov 2026, 06:00:49 | Position test, turning to the next facing during the countdown of run 4 | 0.25 g | 2.67 g | 0.10 g |
| 21 Nov 2026, 06:02:34 | Position test, countdown of run 6 | 0.28 g | 2.87 g | 0.16 g |

An ordinary movement met all three phases. The arm, lowered quickly, is briefly in free-fall; it stops against the leg or the body (2.7 to 3.5 g); then the wearer stands with only small hand movements, below the 0.20 g limit. Finding 5 already named this kind of limit for an arm dropped onto a table; these are the first cases from everyday movement. Part B (B1 to B6) did not contain this movement.

### The stored values

Values of every fall the wristband confirmed after the settling fix (14 Nov 2026, from 09:00), taken from the incident history: 50 deliberate arm drops (Round 2, Round 3 and later demonstrations on 15 to 17 Nov) and the 3 false alarms. Round 1 is left out because its stillness was measured differently, and so is the B7 series (arm moved after the drop). The values are in `firmware/tests/data/fall_values.csv`.

| Measure | 50 arm drops | 3 false alarms |
| :--- | :--- | :--- |
| Free-fall minimum | 0.05 to 0.36 g | 0.25 to 0.28 g |
| Impact | 2.88 to 25.43 g; below 4 g only 4 drops (2.88, 3.04, 3.72, 3.89 g) | 2.67 to 3.47 g |
| Post-impact motion, all | 0.01 to 0.09 g (0.09 g once, on a pillow, at 14.29 g) | 0.10 to 0.16 g |
| Post-impact motion after an impact below 4 g | 0.02 to 0.03 g | 0.10 to 0.16 g |

The free-fall minimum does not separate the two groups. The impact separates them only partly: the softest drops are as soft as the false alarms. The movement after a soft impact separates them clearly.

Candidate rules replayed on these values:

| Rule | Arm drops still detected | False alarms still raised |
| :--- | ---: | ---: |
| Until now: impact above 2.5 g, then motion below 0.20 g | 50 / 50 | 3 / 3 |
| Impact above 3.0 g | 49 / 50 | 1 / 3 |
| Impact above 3.5 g | 48 / 50 | 0 / 3 |
| **Chosen: after an impact below 4 g, motion below 0.08 g** | **50 / 50** | **0 / 3** |

### Change (wristband firmware V5.1)

- After an impact whose peak stays below 4 g, the post-impact motion must be below 0.08 g. After an impact of 4 g and above the limit stays 0.20 g, so a patient who falls hard and still moves a little raises the alarm (finding 12).
- All other thresholds are unchanged: free-fall below 0.50 g for at least 150 ms, impact above 2.50 g within 500 ms, 0.5 s settling, 2 s observation.
- The power-on self-test has two more traces: a soft fall followed by lying still (must be detected), and an arm drop while standing followed by small hand movements (must be ignored).
- Host tests: the three false alarms rebuilt as traces; the limit itself (0.07 g still, 0.09 g moving; 3.99 g soft, 4.0 g hard; the peak of the whole impact decides); the stored values (50 of 50 drops confirmed, 0 of 3 false alarms raised; with the old rule 3 of 3).

### Limits of the change

- The rule rests on three false alarms. More everyday wear will show whether 4 g and 0.08 g hold.
- Arm drops stand in for falls (see Method). A real fall with a soft landing, after which the patient moves a little (0.08 g or more), is no longer reported. A hard fall is reported as before.
- An arm drop while standing is still reported if the wearer then keeps completely still, or if the arm hits harder than 4 g. A wrist-worn threshold detector cannot tell standing still from lying still. The LiDAR, which sees a standing person but not one on the floor, could check this later.

### Hardware check after flashing V5.1

| Check | Result |
| :--- | :--- |
| At power-on the Serial Monitor shows `V5.1` and `[SELF-TEST] Fall detector: PASS (… arm drop while standing: ignored)` | Y (21 Nov, once **USB CDC On Boot** was set to Enabled; with it Disabled the Serial Monitor stayed empty) |
| 5 arm drops onto the table as in Part A, arm kept still for 3 s: falls detected | about 5 / 10 (the tester did 10; see below); with V5.2, 9 / 12 |
| 10 times, standing: turn on the spot, let the arm drop quickly against the leg, then keep moving the hand a little for 5 s: fall alarms (expected 0) | 2 / 11 (with V5.2, which detects as V5.1; see "Check with V5.2") |
| 10 times, the same, then stand completely still for 5 s: fall alarms (known limit, counted for the record) | 1 / 10 (with V5.2) |
| Fall alarms during the 31 runs of position-test session `PT-20261121-100601` (10:06–10:35: walking between spots, turning, standing, sitting, lying) | 0 (2 in the 31 runs of the morning session with V5.0) |

#### First check of V5.1: half of the drops missed, reason not recorded

- The tester counted about 5 alarms in 10 arm drops. Before each drop they waited until the 45 s hold was over (status back to 1 Hz or 3-minute mode), so the hold does not explain the misses.
- The server stored 8 falls between 09:38 and 10:03:
  - free-fall minimum 0.02–0.28 g;
  - impact 3.94–22.64 g, 7 of 8 at 4.63 g or more;
  - post-impact motion 0.02–0.03 g.
- V5.1 can only reject a drop whose impact stays below 4 g and that moves 0.08 g or more afterwards. The detected drops are far from that limit: 7 of 8 hit at 4.63 g or more, and the one at 3.94 g moved only 0.02 g.
- A missed drop leaves no record, so why the other drops were missed is not known (as in Round 2, finding 7). Earlier detection rates: 9 / 10 (Round 1), 41 / 47 and 18 / 20 (Round 2).

### Fall-check report (wristband firmware V5.2)

V5.2 adds a Serial Monitor line for every drop-like movement, so that a missed drop shows which phase failed. Detection itself is unchanged: the 316 earlier host-test checks still pass, and 42 new ones check the report.

| Line | Meaning |
| :--- | :--- |
| `[FALL CHECK] FALL` | free-fall, impact and stillness: alarm |
| `[FALL CHECK] no alarm: MOVING after the impact` | motion after the impact above the limit (0.20 g, or 0.08 g after an impact below 4 g) |
| `[FALL CHECK] no alarm: NO IMPACT` | free-fall of 150 ms or more, but no impact above 2.50 g within 0.5 s |
| `[FALL CHECK] no alarm: FREE-FALL TOO SHORT` | an impact (or a dip below 0.50 g of 60 ms or more) after less than 150 ms below 0.50 g; 0 ms means it never got below 0.50 g |

Each line also gives the values, the largest time between two accelerometer readings during the check (normally 20 ms), and the vitals mode. `[FALL] Alert hold over: watching for falls again.` marks the end of the 45 s hold.

#### Check with V5.2

Wristband on USB with the Serial Monitor open; keep the cable slack so that it does not hold the arm back. The banner must show `V5.2` and `[SELF-TEST] Fall detector: PASS`. Drop the relaxed arm from about 0.5 m onto the table and keep it still for 3 s, as in Part A. Before the next drop, wait for `[FALL] Alert hold over` after an alarm, or 5 s after a drop without one.

Done on 21 November 2026. The Serial Monitor output of the three series, without the status lines, is in [phase-3-round4-v52-fall-checks.txt](phase-3-round4-v52-fall-checks.txt). Every check after an alarm came after `[FALL] Alert hold over`, so the 45 s hold did not take any drop.

For `FREE-FALL TOO SHORT` the impact column holds the highest value after the dip, and the motion after the impact is not measured. "Motion after" is followed by the limit that applied.

**Series 1: arm dropped onto the table.** The tester counted 10 drops and 7 or 8 alarms. The log has 12 checks, each ending in a hard impact (16.56 to 22.63 g in the three without an alarm), and 9 alarms numbered #93 to #101 without a gap. The table follows the log.

| # | Alarm (Y/N) | `[FALL CHECK]` result | Free-fall (ms) | Lowest (g) | Impact (g) | Motion after (g) | Largest sample gap (ms) | Mode |
| :--- | :--- | :--- | ---: | ---: | ---: | ---: | ---: | :--- |
| 1 | Y | FALL | 213 | 0.21 | 5.24 | 0.02 (0.20) | 35 | 3m BURST |
| 2 | Y | FALL | 204 | 0.24 | 17.08 | 0.02 (0.20) | 42 | 1Hz ACTIVE |
| 3 | Y | FALL | 162 | 0.27 | 5.74 | 0.02 (0.20) | 35 | 1Hz ACTIVE |
| 4 | Y | FALL | 169 | 0.33 | 6.58 | 0.02 (0.20) | 36 | 1Hz ACTIVE |
| 5 | Y | FALL | 185 | 0.36 | 2.81 | 0.02 (0.08) | **496** | 1Hz ACTIVE |
| 6 | N | FREE-FALL TOO SHORT | 72 | 0.25 | 22.63 | – | 34 | 1Hz ACTIVE |
| 7 | Y | FALL | 236 | 0.26 | 13.35 | 0.02 (0.20) | 25 | 3m SLEEP |
| 8 | Y | FALL | 234 | 0.18 | 12.63 | 0.02 (0.20) | 26 | 1Hz ACTIVE |
| 9 | N | FREE-FALL TOO SHORT | 92 | 0.24 | 16.56 | – | 26 | 1Hz ACTIVE |
| 10 | Y | FALL | 163 | 0.32 | 3.74 | 0.02 (0.08) | 27 | 3m SLEEP |
| 11 | N | FREE-FALL TOO SHORT | 94 | 0.36 | 22.63 | – | 30 | 1Hz ACTIVE |
| 12 | Y | FALL | 163 | 0.33 | 3.42 | 0.02 (0.08) | 41 | 3m SLEEP |

**Series 2 and 3: standing, turn on the spot, arm dropped quickly against the leg**, then the hand kept moving a little for 5 s (series 2) or the tester stood completely still for 5 s (series 3). The tester counted 10 and 10; the log has 11 and 10 checks.

| Series | # | Alarm (Y/N) | `[FALL CHECK]` result | Free-fall (ms) | Lowest (g) | Impact (g) | Motion after (g) | Largest sample gap (ms) | Mode |
| :--- | :--- | :--- | :--- | ---: | ---: | ---: | ---: | ---: | :--- |
| 2, hand moving | 1 | N | FREE-FALL TOO SHORT | 46 | 0.45 | 9.59 | – | 25 | 3m BURST |
| 2, hand moving | 2 | N | FREE-FALL TOO SHORT | 71 | 0.21 | 9.81 | – | 25 | 3m BURST |
| 2, hand moving | 3 | N | FREE-FALL TOO SHORT | 115 | 0.05 | 5.68 | – | 26 | 3m BURST |
| 2, hand moving | 4 | N | FREE-FALL TOO SHORT | 81 | 0.42 | 15.87 | – | 35 | 3m BURST |
| 2, hand moving | 5 | **Y** | FALL | 164 | 0.34 | 21.66 | 0.04 (0.20) | 40 | 3m BURST |
| 2, hand moving | 6 | N | FREE-FALL TOO SHORT | 140 | 0.33 | 9.15 | – | 26 | 1Hz ACTIVE |
| 2, hand moving | 7 | N | FREE-FALL TOO SHORT | 21 | 0.49 | 8.08 | – | 27 | 3m SLEEP |
| 2, hand moving | 8 | **Y** | FALL | 163 | 0.38 | 10.52 | 0.05 (0.20) | 22 | 3m SLEEP |
| 2, hand moving | 9 | N | FREE-FALL TOO SHORT | 0 | 0.51 | 12.08 | – | 25 | 1Hz ACTIVE |
| 2, hand moving | 10 | N | FREE-FALL TOO SHORT | 60 | 0.45 | 18.10 | – | 22 | 3m SLEEP |
| 2, hand moving | 11 | N | FREE-FALL TOO SHORT | 81 | 0.44 | 18.12 | – | 22 | 3m SLEEP |
| 3, standing still | 1 | **Y** | FALL | 163 | 0.31 | 6.97 | 0.01 (0.20) | 32 | 3m BURST |
| 3, standing still | 2 | N | FREE-FALL TOO SHORT | 23 | 0.49 | 18.38 | – | 25 | 1Hz ACTIVE |
| 3, standing still | 3 | N | FREE-FALL TOO SHORT | 83 | 0.46 | 17.11 | – | 26 | 3m SLEEP |
| 3, standing still | 4 | N | FREE-FALL TOO SHORT | 0 | 0.53 | 13.87 | – | 22 | 3m SLEEP |
| 3, standing still | 5 | N | FREE-FALL TOO SHORT | 41 | 0.47 | 16.39 | – | 22 | 3m SLEEP |
| 3, standing still | 6 | N | FREE-FALL TOO SHORT | 63 | 0.42 | 11.88 | – | 22 | 3m SLEEP |
| 3, standing still | 7 | N | FREE-FALL TOO SHORT | 81 | 0.35 | 6.96 | – | 22 | 3m SLEEP |
| 3, standing still | 8 | N | FREE-FALL TOO SHORT | 41 | 0.35 | 13.91 | – | 22 | 3m SLEEP |
| 3, standing still | 9 | N | FREE-FALL TOO SHORT | 20 | 0.48 | 18.79 | – | 36 | 3m SLEEP |
| 3, standing still | 10 | N | FREE-FALL TOO SHORT | 20 | 0.48 | 8.43 | – | 22 | 3m SLEEP |

#### Findings from the V5.2 check

17. **Every drop without an alarm had a free-fall shorter than 150 ms.** Each of the 33 checks ended either in `FALL` or in `FREE-FALL TOO SHORT`; none ended with `NO IMPACT` or `MOVING`. The impact was far above the 2.50 g limit in every check. The readings came 22 to 42 ms apart in 32 of the 33 checks, so missed readings do not explain the misses. This answers finding 7 of Round 2, and most likely the first V5.1 check, which left no record.
18. **Table drops: 9 of 12.** The 9 alarms had 162 to 236 ms of free-fall, the 3 misses 72 to 94 ms. Four of the alarms were within 20 ms of the limit (162, 163, 163, 169 ms). How long the wrist is near free-fall depends on how the relaxed arm is let go: it pivots at the shoulder or the elbow and does not fall freely. The three soft impacts (2.81, 3.42 and 3.74 g) were detected: their motion after the impact was 0.02 g, below the 0.08 g limit of V5.1. So V5.1 cost no table drop here.
19. **Standing: 3 of 21 arm drops raised an alarm** (2 of 11 with the hand moving, 1 of 10 standing still). All three had 163 or 164 ms of free-fall, just over the limit. All three hit the leg harder than 4 g (6.97 to 21.66 g), so the 0.20 g limit applied. Moving the hand a little did not cancel the two alarms of series 2 (0.04 and 0.05 g after the impact). Turning the wrist changes the direction of gravity, not its size, and the detector uses only the size.
20. **No free-fall limit separates the two.** The same 33 checks, with other limits (free-fall phase only):

    | Free-fall limit | Table drops that pass the free-fall phase | Standing arm drops that pass it |
    | :--- | ---: | ---: |
    | 60 ms | 12 / 12 | 12 / 21 |
    | 80 ms | 11 / 12 | 9 / 21 |
    | 100 ms | 9 / 12 | 5 / 21 |
    | **150 ms (now)** | **9 / 12** | **3 / 21** |
    | 165 ms | 6 / 12 | 0 / 21 |
    | 200 ms | 4 / 12 | 0 / 21 |

    A drop that passes the free-fall phase raises an alarm only if it is still enough afterwards. That was not measured for the checks that stopped at the free-fall, but every drop in this round that passed it was still enough (0.01 to 0.05 g). A lower limit catches the three missed table drops only together with more than half of the standing drops. A higher limit removes the three standing alarms but also three of the nine detected table drops. The lowest value does not separate them either: 0.18 to 0.36 g in the table alarms, 0.31 to 0.38 g in the standing alarms. **The limit stays at 150 ms.**
21. **What tells them apart is not in the size of the acceleration.** After a table drop the forearm lies flat; after an arm drop while standing it hangs down. The direction of gravity in the wristband shows this, but the detector uses only the total acceleration (Algorithm 3). The LiDAR, which scans at hip height (finding 6 of `ips-accuracy-10.md`), still sees a person who stands but not one lying on the floor. Either could reject the standing case; both are new functions, not threshold changes.
22. **One long pause between readings.** In check 5 of series 1 (1 Hz active streaming) two readings were 496 ms apart. The drop was still detected, but its impact was the lowest of the series (2.81 g, against 3.42 to 17.08 g); the peak probably fell into the pause. It happened in 1 of 33 checks. The cause is not known: the same loop also reads the pulse sensor and the battery and sends the broadcast and the Serial output.

## Decision

- [x] Thresholds kept as in the thesis (0.50 g, 2.50 g, 0.20 g, 150 ms, 500 ms, 2 s).
- [x] Measurement changed after Round 1: stillness is observed for 2 s starting 0.5 s after the impact (finding 2), and the accelerometer range is ±16 g (finding 3). Round 2 repeated on 14 Nov 2026.
- [x] Round 2 accepted for fall detection: detection not worse than Round 1 (18 / 20 against 9 / 10), no false alarm in B1 to B6. B7 recorded as a known limit (finding 12).
- [x] After Round 2: SpO2 raises no alarm until it is calibrated; heart-rate alarm rules and heart-rate reporting corrected (finding 10).
- [x] Round 3 accepted for the alarm path: no false vitals alarm, one incident per fall, no second incident after a server restart.
- [ ] Open, outside Phase 3: stability of the heart-rate value (finding 15).
- [x] Round 4 (21 Nov 2026): after three false alarms while standing, an impact below 4 g now needs post-impact motion below 0.08 g (wristband firmware V5.1). This departs from the single 0.20 g limit of the thesis (Chapter 4, Algorithm 3); all other thresholds are unchanged.
- [x] Round 4 hardware check, with V5.2 (21 Nov 2026): 9 / 12 table drops detected; 3 / 21 arm drops while standing raised an alarm; no fall alarm in the 31 runs of the step 6 position test.
- [x] With V5.2: every drop without an alarm had a free-fall shorter than 150 ms (finding 17). No other free-fall limit separates the two kinds of drop (finding 20), so the thresholds are unchanged.
- [ ] Open: an arm dropped against the leg while standing raises an alarm in about 1 of 7 tries (3 / 21). Rejecting it needs more than the size of the acceleration: the orientation of the forearm after the impact, or the LiDAR (finding 21).
- [ ] Open: the 496 ms pause between two accelerometer readings (finding 22).
