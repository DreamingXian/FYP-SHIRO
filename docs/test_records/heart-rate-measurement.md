# Test Record: Heart-Rate Measurement of the Wristband

Purpose: find out why the wristband's heart rate was unstable (bench test Round 3: 53 to 130 BPM at rest against a counted pulse of 94), correct it, and state what the hardware can and cannot do.

| | |
| :--- | :--- |
| Date | 14 Nov 2026 |
| Tester | Tan Shou Xian |
| Hardware | Seeed XIAO ESP32-C6, HW-605 (MAX30102, red and infrared light), LED current 0x24 (about 7 mA), 100 samples per second |
| Recording firmware | commit `53c0266` (raw signal recorder) |
| Reference | pulse counted by hand at the neck during the recording |

## Method

The wristband wrote every raw sample (infrared, red), every beat its firmware detected, and the acceleration to the USB port (`firmware/tools/record_ppg.bat`). Six recordings were made. On the PC the recordings were then replayed through the old beat detector and through the new estimator. Four of the recordings are kept as test data in `firmware/tests/data` and are replayed by `firmware/tests/run_host_tests.bat`.

## Recordings

| # | Recording | Position and activity | Length | Counted pulse |
| :--- | :--- | :--- | :--- | :--- |
| 1 | `wrist_rest` | Outer side of the wrist (as usually worn), sitting still | 180 s | 93 BPM |
| 2 | `wrist_tight` | As 1, strap one hole tighter | 120 s | 93 BPM |
| 3 | `wrist_inside` | Sensor on the inner side of the wrist, sitting still | 120 s | 92 BPM |
| 4 | `wrist_led_high` | As 1, LED current 0x7F | 120 s | 90 BPM |
| 5 | `finger` | Fingertip resting on the sensor | 60 s | 92 BPM |
| 6 | `wrist_typing` | As 1, typing on a keyboard | 120 s | not counted |

No samples were lost (99.75 to 99.78 samples per second in every recording), and the sensor saw skin all the time.

## What the signal looks like

"Pulse amplitude" is the size of the heartbeat line in the spectrum. "Periodicity" is the height of the autocorrelation peak over 8 seconds: 1 = perfectly repeating, 0 = no repetition.

| Recording | Infrared level (counts) | Pulse amplitude (counts) | Periodicity, median |
| :--- | :--- | :--- | :--- |
| `finger` | 144,073 | 335 | 0.97 |
| `wrist_inside` | 126,496 | 10 | 0.75 |
| `wrist_rest` | 130,785 | 10 | 0.14 |
| `wrist_tight` | 134,314 | 6 | 0.15 |
| `wrist_typing` | 135,638 | not separable | 0.19 |
| `wrist_led_high` | 262,143 (sensor ceiling) | none | 0 |

## Findings

1. **The beat detector of the sensor library was the main fault, not the wrist.** On the fingertip, with a clean signal, it detected 6 of about 92 beats. Reading its source (SparkFun MAX3010x library 1.1.2, `heartRate.cpp`) shows why:
   - It takes the sensor value as a 16-bit number. The sensor delivers 18 bits, and the level on this wristband is about 130,000, right at a multiple of 65,536 (131,072). Every time the signal crosses that value, the detector sees a jump of 65,535 counts. In `wrist_rest` that happened 51 times.
   - It ignores every pulse larger than 1000 counts peak to peak. On the fingertip 85 of 91 pulses were ignored for that reason.
   - It accepts any wave larger than 20 counts as a beat, which on the wrist is mostly noise.

   A copy of that detector on the PC, fed with the recordings, reproduces every beat the wristband logged (89, 71, 170, 0, 6 and 191 beats in the six recordings).
2. **The pulse on the wrist is about 30 times weaker than on the fingertip** (10 counts against 335, on a level of about 130,000). This is the limit of the hardware: the MAX30102 uses red and infrared light and is built for a fingertip.
3. **The position on the wrist decides.** On the inner side the pulse is clearly periodic (0.75). On the outer side it was clear only during the first 30 seconds of recording 1 and not at all in recording 2. A tighter strap did not help.
4. **More LED current is not possible.** With 0x7F the sensor is at its ceiling in both colours and delivers nothing.
5. **Breathing and slow movement are 6 to 10 times stronger than the pulse on the wrist** (60 to 100 counts below 0.6 Hz). An estimator that lets them through reports a rate that is too high, with full confidence. The new estimator therefore uses a steep high-pass filter at 0.6 Hz.
6. **SpO2:** the old calculation took the highest and lowest value of each second as the pulse amplitude, which on the wrist is mostly drift and noise. Calculated from the pulse itself, the fingertip gives 97 to 99%. On the wrist the result stays too low (89 to 96%). The conversion line is not calibrated for this hardware, so SpO2 stays an indicative value without alarms.

## The correction

The heart rate is no longer taken from single beats. Once per second the wristband checks how well the last 8 seconds of the signal repeat themselves (autocorrelation) and takes the rate from the repetition time. A value is reported only when the periodicity is at least 0.6 and three estimates in a row agree within 10 BPM. It is the median of the last five estimates and is withdrawn after 4 seconds without a new confirmation. Details are in `firmware/shiro_wristband_vitals/pulse_estimator.h`.

Consequences:

- With a poor signal the wristband reports **no reading** instead of a wrong number.
- The first value of a measurement takes about 13 seconds. The passive measurement was therefore lengthened from 15 to 30 seconds.

## Result on the recordings

"Shown" is the share of seconds in which a heart rate was reported. The first 10 seconds of every recording are included, in which the new estimator cannot report yet.

| Recording | Counted | Old firmware: shown | within ±10 BPM | range (BPM) | New estimator: shown | within ±10 BPM | range (BPM) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `finger` | 92 | 10% | 100% | 93 | 78% | 100% | 89 to 98 |
| `wrist_inside` | 92 | 97% | 83% | 42 to 117 | 65% | 100% | 88 to 100 |
| `wrist_rest` | 93 | 46% | 22% | 38 to 114 | 11% | 68% (see note) | 82 to 85 |
| `wrist_tight` | 93 | 60% | 27% | 41 to 104 | 0% | | no reading |
| `wrist_typing` | about 92 | 96% | 34% | 53 to 175 | 0% | | no reading |
| `wrist_led_high` | 90 | 0% | | no reading | 0% | | no reading |

Note on `wrist_rest`: the 19 values (82 to 85 BPM) fall in seconds 14 to 32. The pulse was counted from second 20 to 80 and was 93 BPM on average, so the values are 8 to 11 BPM below the count. Whether the pulse was lower in those seconds or the values are too low cannot be decided from this recording. In `finger` the rate moved from 98 to 89 BPM within one minute.

Checks with generated signals (part of the host tests):

| Check | Result |
| :--- | :--- |
| Pulse of 30, 35, 40, 48, 60, 75, 93, 120, 150, 180, 200 and 220 BPM | reported within ±1 BPM, first value within 14 s |
| Weak pulse (15 counts) on a breathing level, 93 to 190 BPM, 5 noise patterns each | within ±3 BPM |
| Noise only, breathing only, jumping level (movement), sensor at its ceiling, no skin | no reading |
| Pulse disappears | value withdrawn within 12 s |
| Skin contact lost for more than 0.5 s | value withdrawn at once |
| Rate changes from 70 to 130 BPM | new rate reported within 12 s, no value between the two rates |
| Red to infrared ratio 0.4, 0.5, 0.8, 1.0 | SpO2 99 to 100, 97 to 98, 89 to 91, 84 to 86% |

## Limits that remain

- On the outer side of the wrist the result depends on where exactly the sensor sits: in Round 1 it delivered a pulse for 30 seconds of two recordings, in Round 2 for 94% of a recording. Without a pulse the wristband shows no heart rate. On the inner side of the wrist it showed a heart rate in about 70% of the seconds at rest in both rounds.
- While the arm moves, no heart rate is reported.
- The reference was a manual pulse count over 30 or 60 seconds, not a medical device. Statements about accuracy are limited to "within ±10 BPM of the count".
- One tester, one day, at rest. Rates outside 82 to 100 BPM were tested with generated signals only.
- SpO2 is not validated.

## Round 2: check on the wristband (firmware `532e586`, new estimator)

Recordings made with the wristband running the new estimator. Each contains the raw signal and what the wristband itself reported once per second.

| Recording | Position | Counted pulse | Seconds with a heart rate | Within ±10 BPM | Reported range | SpO2 reported |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `r2_inside` (180 s) | Inner side of the wrist, sitting still | 87 BPM | 124 of 170 (73%) | 100% | 82 to 96 BPM | 89 to 96% |
| `r2_finger` (60 s) | Fingertip on the sensor | 92 BPM (46 beats in 30 s) | 47 of 50 (94%) | 100% | 83 to 98 BPM | 98 to 100% |
| `r2_outside` (120 s) | Outer side of the wrist, sitting still | 88 BPM | 103 of 110 (94%) | 96% | 45 to 92 BPM | 98 to 100% |
| `r2_typing` (120 s) | Worn, typing | not counted | 0 of 110 | | no reading | none |

"Seconds with a heart rate" counts from second 10 of each recording, when the first estimate is possible.

| Check | Result |
| :--- | :--- |
| The wristband reports what the PC model calculates from the same samples | identical in 437 of 440 estimates, within 1 BPM in 439 |
| Time the wristband needs for one estimate | 4.0 ms (longest 4.3 ms), once per second |
| Samples lost | none (99.77 samples per second) |
| Worn for 20 minutes with the dashboard open (22:55 to 23:15): number of vitals alarms (expected 0) | 0, and none while it was worn afterwards |
| Heart rate on the live map: shows a value at rest and no value while the arm moves | Y: the value drops to "no value" as soon as the hand moves |
| One arm drop as in Phase 3: fall pop-up with three values still appears | Y |

Observations of the tester:

- From 22:55 to 23:15 no heart rate was reported at all: every 3-minute measurement showed 0 until it ended, and the vitals trend had no new point after 22:49. Later measurements delivered values again. See finding 8.
- For one activation of the 1 Hz mode from the live map, the wristband logged two or three connections, each with its own `ACTIVE` command. See finding 10.

Server records (InfluxDB) of the evening: values during the three still recordings (22:39 to 22:49), none from 22:50 to 23:17, then measurements with a heart rate at 23:17 (81 to 89 BPM), 23:24 (79 to 84 BPM) and from 23:27 (78 to 88 BPM).

## Findings from Round 2

7. **The estimator works on the wristband as calculated on the PC**, and one estimate takes 4 ms. With a still arm it reported a heart rate within ±10 BPM of the count on the fingertip, on the inner side and, in this round, also on the outer side of the wrist. In Round 1 the outer side gave a pulse only for 30 seconds: whether the outer side works depends on where exactly the sensor sits.
8. **Measurements without any value were caused by movement, not by a fault.** Replaying the three still recordings from 165 different starting moments gives a value within 30 seconds in 164 cases (typically after 12 seconds). The two typing recordings give none within 90 seconds from any of 30 starting moments. With a fixed measurement of 30 seconds every 3 minutes, a person who uses the hands gets no reading for long stretches. Changed in commit `b16faff`: a passive measurement now runs until it has delivered a heart rate for 10 seconds (about 22 seconds with a still arm) and keeps trying for at most 90 seconds. It ends after 5 seconds when the sensor sees no skin. This helps a wearer whose arm is still for part of the time. During continuous hand movement there is still no reading.
9. **One wrong value: 45 BPM for 4 seconds, half the true rate of 88** (`r2_outside`, seconds 87 to 90). A small jolt at second 82 lowered the autocorrelation peak at one beat (0.35 to 0.41) below the peak at two beats (0.57 to 0.67). Corrected in commit `b16faff`: when a clear peak stands at half or a third of the chosen period, that one is taken. On the same recording the wristband now reports nothing for those seconds and 84 to 92 BPM for the rest. A slow pulse with a strong second harmonic (30 to 100 BPM, generated signals) is still reported correctly and not doubled. The recording is kept as test data.
10. **One activation of the 1 Hz mode makes every anchor in range connect to the wristband.** The command is sent to all anchors, and each anchor that hears the wristband well connects and writes `ACTIVE`. With two or three anchors in range this gives two or three connections. It does no harm (each command only restarts the same 60-second timer), but the wristband pauses its broadcast during every connection. Not changed here; noted for Phase 5 (device and network security), where this command is reworked.

   Serial Monitor of the wristband for one activation (status lines between the events left out; the first activation showed three connections, the second two):

   ```
   [BLE SERVER] Central Client Connected!
   [BLE GATT CMD] Received 'ACTIVE' -> Escalating to 1 Hz Active Mode!
   [POWER] Escalated to 1 Hz Active Streaming (MAX30102 Awake)
   [BLE SERVER] Central Client Disconnected. Resuming advertisement.
   [BLE SERVER] Central Client Connected!
   [BLE GATT CMD] Received 'ACTIVE' -> Escalating to 1 Hz Active Mode!
   [BLE SERVER] Central Client Disconnected. Resuming advertisement.
   ```

## Round 3: short check after commit `b16faff`

Wristband reflashed with commit `b16faff`. Worn from 00:30 to 01:00 on 15 Nov 2026.

| Check | Result |
| :--- | :--- |
| Serial Monitor, arm still: a passive measurement ends with `done (10 s with a heart rate)` | Y: `[POWER] Vitals measurement ended after 22 s: done (10 s with a heart rate).` |
| Arm moving during a whole measurement: it ends after 90 s with `no steady pulse found` | Y |
| Wristband taken off: the measurement ends after 5 s with `no skin contact` | Y |
| Worn for 30 minutes of normal activity: number of 3-minute measurements with a heart rate in the vitals trend, out of about 8 | 8 |
| Vitals alarms during that time (expected 0) | 0 |
| Any value on the live map that was clearly wrong (for example half or double the pulse) | N |

Server records of the same 30 minutes:

| Record | Result |
| :--- | :--- |
| Passive measurements stored (InfluxDB), 00:32 to 00:57 | 8, each with about 10 seconds of heart rate |
| Time from one measurement to the next | 3 min 23 s to 3 min 38 s (3 minutes of sleep plus the measurement) |
| Heart rate over all 8 measurements | 75 to 82 BPM |
| Largest spread inside one measurement | 5 BPM |
| SpO2 over all 8 measurements | 94 to 100% |
| Incidents stored (MariaDB) after the arm-drop fall of 23:34 | none |

Before the 30 minutes, one measurement at about 00:29 stored no value (the measurements before and after it, at 00:25 and 00:32, did).

## Decision

- [x] Round 2 confirms the PC results on the wristband (finding 7).
- [x] Round 3 check passed.
- [x] Wearing position for the demonstration and the thesis: **outer side of the wrist** (chosen by the tester on 15 Nov 2026).

What this choice means, from the rounds above:

- The outer side gave a heart rate in 94% of the seconds at rest in Round 2 (`r2_outside`), but only during 30 seconds of the two Round 1 recordings. The difference is where exactly the sensor sits.
- For the demonstration and every further test, the sensor sits at the same marked spot, with the strap snug enough that the sensor does not move on the skin.
- The thesis reports the outer side as the wearing position, together with this dependence on placement and the inner-side results as the comparison.
