/*
 * =========================================================================================
 *   SHIRO Wristband - Vitals Validity and Smoothing
 *
 *   Plain C++ with no Arduino dependency (also compiled by firmware/tests).
 *
 *   The accepted range is wide on purpose: a heart rate of 35 or an SpO2 of 78
 *   is exactly what an alarm needs to see, so it must not be thrown away as
 *   "out of range". The same limits are used by the edge server
 *   (config/clinical_thresholds.js, "valid").
 * =========================================================================================
 */
#ifndef SHIRO_VITALS_FILTER_H
#define SHIRO_VITALS_FILTER_H

#include <stdint.h>

const float BPM_VALID_MIN = 30.0f;
const float BPM_VALID_MAX = 220.0f;
const float SPO2_VALID_MIN = 70.0f;
const float SPO2_VALID_MAX = 100.0f;

inline bool isValidBpm(float bpm) { return bpm >= BPM_VALID_MIN && bpm <= BPM_VALID_MAX; }
inline bool isValidSpo2(float spo2) { return spo2 >= SPO2_VALID_MIN && spo2 <= SPO2_VALID_MAX; }

// Median of the non-zero entries (0 marks an empty slot). Returns 0 when all are empty.
// Used for the beat-to-beat heart rate: one missed or doubled beat among four
// does not move the result, while a real change shows after two to three beats.
inline int medianOfNonZero(const uint8_t* values, uint8_t count) {
  uint8_t sorted[8];
  uint8_t n = 0;
  for (uint8_t i = 0; i < count && n < 8; i++) {
    if (values[i] == 0) continue;
    uint8_t j = n++;
    while (j > 0 && sorted[j - 1] > values[i]) {
      sorted[j] = sorted[j - 1];
      j--;
    }
    sorted[j] = values[i];
  }
  if (n == 0) return 0;
  if (n % 2 == 1) return sorted[n / 2];
  return (sorted[n / 2 - 1] + sorted[n / 2] + 1) / 2;
}

#endif  // SHIRO_VITALS_FILTER_H
