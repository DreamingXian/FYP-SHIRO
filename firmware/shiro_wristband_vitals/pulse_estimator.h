/*
 * =========================================================================================
 *   SHIRO Wristband - Heart Rate and SpO2 from the Raw Pulse Signal
 *
 *   Plain C++ with no Arduino dependency (also compiled by firmware/tests).
 *
 *   Why this exists: the beat detector of the sensor library (checkForBeat) cuts the
 *   18-bit sensor value to 16 bits and ignores every pulse larger than 1000 counts.
 *   Bench recordings of 14 Nov 2026: on a fingertip, with a clean signal, it found
 *   6 of about 92 beats; on the wrist it reported 53 to 130 BPM for a pulse of 94.
 *
 *   Method. A rate is not taken from single beats but from how well the signal
 *   repeats itself:
 *
 *     100 samples/s  ->  pairs averaged (50/s)  ->  band-pass 0.6 to 3.5 Hz
 *     ->  last 8 seconds  ->  autocorrelation  ->  first strong peak
 *     ->  rate (from the lag of the peak) and strength (its height, 0 to 1)
 *
 *   The estimate is repeated every second. A rate is REPORTED only when
 *     - the strength is at least 0.6 (the signal really is periodic), and
 *     - three estimates in a row agree within 10 BPM.
 *   The reported value is the median of the last five accepted estimates. It is
 *   withdrawn when no new confirmation arrives for 4 seconds. With a poor signal
 *   (movement, loose strap, weak pulse) the result is therefore "no reading",
 *   not a wrong number.
 *
 *   SpO2 uses the part of the red signal that follows the infrared pulse
 *   (regression inside the same 8 seconds) and the textbook line 110 - 25 R.
 *   That line is NOT calibrated for this hardware: SpO2 stays indicative.
 *
 *   Memory: about 6 kB. Work per second: about 40,000 integer multiplications.
 * =========================================================================================
 */
#ifndef SHIRO_PULSE_ESTIMATOR_H
#define SHIRO_PULSE_ESTIMATOR_H

#include <math.h>
#include <stdint.h>

struct PulseConfig {
  // Signal validity
  uint32_t contactMin;      // infrared level below this: no skin in front of the sensor
  uint32_t saturated;       // level at or above this: the sensor is at its ceiling (18 bits)
  uint16_t invalidResetSamples;  // this many unusable samples in a row restart the measurement

  // Acceptance
  float minStrength;        // lowest autocorrelation peak that counts as a pulse
  float firstPeakShare;     // first peak at least this share of the highest one (a pulse repeats at T, 2T, ...)
  uint8_t confirm;          // estimates in a row that must agree before a rate is reported
  float agreeBpm;           // "agree" = within this many BPM of the previous estimate
  uint8_t withdrawAfter;    // seconds without a new confirmation until the value is withdrawn

  // Reported range (same as vitals_filter.h and the edge server)
  uint8_t validMinBpm;
  uint8_t validMaxBpm;

  // SpO2
  float spo2MinCorrelation; // red must follow infrared at least this closely
  float spo2A;              // SpO2 = A - B * R (uncalibrated textbook line)
  float spo2B;
};

inline PulseConfig defaultPulseConfig() {
  PulseConfig c;
  c.contactMin = 50000;
  c.saturated = 262000;
  c.invalidResetSamples = 50;   // 0.5 s
  c.minStrength = 0.6f;
  c.firstPeakShare = 0.8f;
  c.confirm = 3;
  c.agreeBpm = 10.0f;
  c.withdrawAfter = 4;
  c.validMinBpm = 30;
  c.validMaxBpm = 220;
  c.spo2MinCorrelation = 0.8f;
  c.spo2A = 110.0f;
  c.spo2B = 25.0f;
  return c;
}

class PulseEstimator {
 public:
  // Fixed by the sensor set-up (100 samples per second) and by the validation recordings
  static const int INPUT_HZ = 100;
  static const int DECIMATE = 2;
  static const int RATE_HZ = INPUT_HZ / DECIMATE;      // 50
  static const int WINDOW = 8 * RATE_HZ;               // 8 seconds
  static const int SETTLE = 2 * RATE_HZ;               // filter settling, not used
  static const int LAG_LOW = 4;                        // start of the autocorrelation curve
  static const int LAG_MIN = 13;                       // 230 BPM: search a little beyond the valid range
  static const int LAG_MAX = 108;                      // 28 BPM
  static const int MEDIAN_OF = 5;
  static const int SCALE = 4;                          // stored resolution: 1/4 sensor count

  explicit PulseEstimator(const PulseConfig& config = defaultPulseConfig()) : cfg(config) {
    designFilters();
    reset();
  }

  /** Forgets everything measured so far (sensor woken up, skin contact lost). */
  void reset() {
    for (int i = 0; i < 2; i++) {
      hpIr[i].primed = false;
      hpRed[i].primed = false;
    }
    lpIr.primed = false;
    lpRed.primed = false;
    pos = 0;
    filled = 0;
    seen = 0;
    sinceEstimate = 0;
    accIr = 0;
    accRed = 0;
    accN = 0;
    dcIr = 0;
    dcRed = 0;
    invalidRun = 0;
    clearSeries();
    reportedBpm = 0;
    reportedSpo2 = 0;
    lastStrength = 0;
    lastCandidate = 0;
    sinceConfirmed = 0;
  }

  /**
   * Feeds one sample pair (call for every sample, 100 per second).
   * Returns true when a new estimate was made (once per second, after the first 10 seconds).
   */
  bool addSample(uint32_t ir, uint32_t red) {
    if (ir < cfg.contactMin || ir >= cfg.saturated || red >= cfg.saturated) {
      // A short dip is skipped; a longer one means the measurement has to start again
      if (invalidRun < 0xFFFF) invalidRun++;
      if (invalidRun == cfg.invalidResetSamples) {
        reset();
        invalidRun = cfg.invalidResetSamples;
      }
      return false;
    }
    invalidRun = 0;

    accIr += ir;
    accRed += red;
    if (++accN < DECIMATE) return false;
    const double vi = (double)accIr / accN;
    const double vr = (double)accRed / accN;
    accIr = 0;
    accRed = 0;
    accN = 0;

    // Slow level of both colours (about 2 s) for the SpO2 ratio
    if (seen == 0) {
      dcIr = vi;
      dcRed = vr;
    } else {
      dcIr += (vi - dcIr) / (2.0 * RATE_HZ);
      dcRed += (vr - dcRed) / (2.0 * RATE_HZ);
    }

    const double yi = lpIr.step(hpIr[1].step(hpIr[0].step(vi)));
    const double yr = lpRed.step(hpRed[1].step(hpRed[0].step(vr)));

    if (seen < 0x7FFFFFFF) seen++;
    if (seen <= SETTLE) return false;

    bufIr[pos] = quantise(yi);
    bufRed[pos] = quantise(yr);
    pos = (pos + 1) % WINDOW;
    if (filled < WINDOW) filled++;

    if (++sinceEstimate < RATE_HZ) return false;
    sinceEstimate = 0;
    if (filled < WINDOW) return false;

    estimate();
    return true;
  }

  /** Heart rate in BPM, 0 = no reading. */
  uint8_t bpm() const { return reportedBpm; }
  /** SpO2 in percent (indicative), 0 = no reading. */
  uint8_t spo2() const { return reportedSpo2; }
  /** Strength of the last estimate, 0 to 1. */
  float strength() const { return lastStrength; }
  /** Rate of the last estimate before acceptance, 0 = none. For diagnostics. */
  float candidateBpm() const { return lastCandidate; }

 private:
  struct Biquad {
    double b0, b1, b2, a1, a2;
    double x1, x2, y1, y2;
    bool primed;
    double step(double x) {
      if (!primed) {
        // Start as if the input had always had this value: no start-up swing
        primed = true;
        x1 = x2 = x;
        y1 = y2 = x * (b0 + b1 + b2) / (1.0 + a1 + a2);
      }
      const double y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
      return y;
    }
  };

  static void design(Biquad& k, bool highPass, double cornerHz) {
    const double w = 2.0 * 3.14159265358979323846 * cornerHz / RATE_HZ;
    const double c = cos(w);
    const double alpha = sin(w) / (2.0 * 0.70710678118654752440);
    const double a0 = 1.0 + alpha;
    if (highPass) {
      k.b0 = (1.0 + c) / 2.0 / a0;
      k.b1 = -(1.0 + c) / a0;
      k.b2 = (1.0 + c) / 2.0 / a0;
    } else {
      k.b0 = (1.0 - c) / 2.0 / a0;
      k.b1 = (1.0 - c) / a0;
      k.b2 = (1.0 - c) / 2.0 / a0;
    }
    k.a1 = -2.0 * c / a0;
    k.a2 = (1.0 - alpha) / a0;
    k.primed = false;
  }

  void designFilters() {
    // Two high-pass sections at 0.6 Hz: breathing and slow movement (below 0.5 Hz) must
    // not reach the autocorrelation, where they would pull the rate upwards.
    for (int i = 0; i < 2; i++) {
      design(hpIr[i], true, 0.6);
      design(hpRed[i], true, 0.6);
    }
    design(lpIr, false, 3.5);
    design(lpRed, false, 3.5);
  }

  static int16_t quantise(double v) {
    double s = v * SCALE;
    s = s < 0 ? s - 0.5 : s + 0.5;
    if (s > 32767.0) return 32767;
    if (s < -32767.0) return -32767;
    return (int16_t)s;
  }

  void clearSeries() {
    acceptedCount = 0;
    spo2Count = 0;
    streak = 0;
    misses = 0;
  }

  static void pushLimited(float* values, uint8_t& count, float v) {
    if (count == MEDIAN_OF) {
      for (int i = 1; i < MEDIAN_OF; i++) values[i - 1] = values[i];
      count--;
    }
    values[count++] = v;
  }

  static float medianOf(const float* values, uint8_t count) {
    float sorted[MEDIAN_OF];
    for (uint8_t i = 0; i < count; i++) {
      uint8_t j = i;
      while (j > 0 && sorted[j - 1] > values[i]) {
        sorted[j] = sorted[j - 1];
        j--;
      }
      sorted[j] = values[i];
    }
    if (count % 2 == 1) return sorted[count / 2];
    return (sorted[count / 2 - 1] + sorted[count / 2]) / 2.0f;
  }

  static bool isPeak(const double* r, int lag) { return r[lag] > r[lag - 1] && r[lag] >= r[lag + 1]; }

  void estimate() {
    // The window in time order, with its mean removed
    int64_t sumIr = 0, sumRed = 0;
    for (int i = 0; i < WINDOW; i++) {
      const int k = (pos + i) % WINDOW;
      workIr[i] = bufIr[k];
      workRed[i] = bufRed[k];
      sumIr += workIr[i];
      sumRed += workRed[i];
    }
    const int32_t meanIr = (int32_t)(sumIr >= 0 ? (sumIr + WINDOW / 2) / WINDOW : -((-sumIr + WINDOW / 2) / WINDOW));
    const int32_t meanRed = (int32_t)(sumRed >= 0 ? (sumRed + WINDOW / 2) / WINDOW : -((-sumRed + WINDOW / 2) / WINDOW));
    int64_t energyIr = 0, energyRed = 0, cross = 0;
    for (int i = 0; i < WINDOW; i++) {
      workIr[i] -= meanIr;
      workRed[i] -= meanRed;
      energyIr += (int64_t)workIr[i] * workIr[i];
      energyRed += (int64_t)workRed[i] * workRed[i];
      cross += (int64_t)workIr[i] * workRed[i];
    }

    float candidate = 0;
    float strength = 0;
    float spo2 = 0;

    if (energyIr > 0) {
      // Autocorrelation of the infrared window. Long lags have fewer products and
      // are deliberately not scaled up: noise must not win at the slow end.
      for (int lag = LAG_LOW; lag <= LAG_MAX + 1; lag++) {
        int64_t acc = 0;
        const int n = WINDOW - lag;
        for (int i = 0; i < n; i++) acc += (int64_t)workIr[i] * workIr[i + lag];
        curve[lag] = (double)acc / (double)energyIr;
      }

      double best = 0;
      for (int lag = LAG_MIN; lag <= LAG_MAX; lag++) {
        if (isPeak(curve, lag) && curve[lag] > best) best = curve[lag];
      }
      if (best > 0) {
        int first = 0;
        for (int lag = LAG_MIN; lag <= LAG_MAX && first == 0; lag++) {
          if (isPeak(curve, lag) && curve[lag] >= cfg.firstPeakShare * best) first = lag;
        }
        const double a = curve[first - 1], b = curve[first], c = curve[first + 1];
        const double den = a - 2.0 * b + c;
        const double shift = den != 0.0 ? 0.5 * (a - c) / den : 0.0;
        candidate = (float)(60.0 * RATE_HZ / (first + shift));

        // Slow drift lifts the whole curve. The lowest point before the peak shows by how much.
        double low = curve[LAG_LOW];
        for (int lag = LAG_LOW; lag < first; lag++) {
          if (curve[lag] < low) low = curve[lag];
        }
        strength = (float)(low > 0 ? b - low : b);

        if (energyRed > 0 && dcIr > 0 && dcRed > 0) {
          const double correlation = (double)cross / sqrt((double)energyIr * (double)energyRed);
          if (correlation >= cfg.spo2MinCorrelation) {
            // R = (red pulse / red level) / (infrared pulse / infrared level)
            const double ratio = ((double)cross / (double)energyIr) * (dcIr / dcRed);
            spo2 = (float)(cfg.spo2A - cfg.spo2B * ratio);
          }
        }
      }
    }

    lastCandidate = candidate;
    lastStrength = strength;

    if (sinceConfirmed < 255) sinceConfirmed++;
    const bool accepted = candidate > 0 && strength >= cfg.minStrength;
    if (accepted) {
      const bool agrees = acceptedCount > 0 && misses == 0 &&
                          fabsf(candidate - acceptedBpm[acceptedCount - 1]) <= cfg.agreeBpm;
      streak = agrees ? (uint8_t)(streak < 255 ? streak + 1 : 255) : 1;
      if (streak == 1) {  // a new series starts
        acceptedCount = 0;
        spo2Count = 0;
      }
      pushLimited(acceptedBpm, acceptedCount, candidate);
      if (spo2 >= 70.0f && spo2 <= 100.0f) pushLimited(acceptedSpo2, spo2Count, spo2);
      misses = 0;

      if (streak >= cfg.confirm) {
        const int shown = (int)(medianOf(acceptedBpm, acceptedCount) + 0.5f);
        reportedBpm = (shown >= cfg.validMinBpm && shown <= cfg.validMaxBpm) ? (uint8_t)shown : 0;
        reportedSpo2 = (reportedBpm != 0 && spo2Count >= cfg.confirm)
                         ? (uint8_t)(medianOf(acceptedSpo2, spo2Count) + 0.5f) : 0;
        sinceConfirmed = 0;
      }
    } else if (misses < 255) {
      misses++;
    }

    // A reported value needs a fresh confirmation; without one it is withdrawn
    if (sinceConfirmed >= cfg.withdrawAfter) {
      reportedBpm = 0;
      reportedSpo2 = 0;
    }
  }

  PulseConfig cfg;
  Biquad hpIr[2], hpRed[2], lpIr, lpRed;

  int16_t bufIr[WINDOW];
  int16_t bufRed[WINDOW];
  int32_t workIr[WINDOW];
  int32_t workRed[WINDOW];
  double curve[LAG_MAX + 2];

  int pos;
  int filled;
  int32_t seen;
  int sinceEstimate;
  uint32_t accIr, accRed;
  uint8_t accN;
  double dcIr, dcRed;
  uint16_t invalidRun;

  float acceptedBpm[MEDIAN_OF];
  float acceptedSpo2[MEDIAN_OF];
  uint8_t acceptedCount, spo2Count;
  uint8_t streak, misses, sinceConfirmed;

  uint8_t reportedBpm, reportedSpo2;
  float lastStrength, lastCandidate;
};

#endif  // SHIRO_PULSE_ESTIMATOR_H
