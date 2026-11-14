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

Checks with generated signals (part of the host tests, 222 checks in total):

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

- On the outer side of the wrist this sensor delivers a usable pulse only part of the time. The wristband then shows no heart rate. Worn with the sensor on the inner side of the wrist, it showed a heart rate in about 70% of the seconds at rest.
- While the arm moves, no heart rate is reported.
- The reference was a manual pulse count over 30 or 60 seconds, not a medical device. Statements about accuracy are limited to "within ±10 BPM of the count".
- One tester, one day, at rest. Rates outside 82 to 100 BPM were tested with generated signals only.
- SpO2 is not validated.

## Round 2: check on the wristband (firmware with the new estimator)

Flash the wristband, then record with the sensor on the inner side of the wrist and on the fingertip. The script shows the counted pulse; the recording contains what the wristband reported (lines starting with `E,`).

| Check | Result |
| :--- | :--- |
| `.\record_ppg.bat r2_inside 180`: sensor on the inner side of the wrist, sitting still. Counted pulse | |
| `.\record_ppg.bat r2_finger 60`: fingertip on the sensor. Counted pulse | |
| `.\record_ppg.bat r2_outside 120`: worn on the outer side, sitting still. Counted pulse | |
| `.\record_ppg.bat r2_typing 120 -NoCount`: worn as you prefer, typing | |
| Worn for 20 minutes with the dashboard open: number of vitals alarms (expected 0) | |
| Heart rate on the live map: shows a value at rest and "no value" while moving (Y/N) | |
| One arm drop as in Phase 3: fall pop-up with three values still appears (Y/N) | |

## Decision

- [ ] Round 2 confirms the PC results on the wristband.
- [ ] Wearing position for the demonstration and the thesis: inner side / outer side of the wrist.
