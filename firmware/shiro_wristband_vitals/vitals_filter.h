/*
 * =========================================================================================
 *   SHIRO Wristband - Accepted Range of the Vitals
 *
 *   Plain C++ with no Arduino dependency (also compiled by firmware/tests).
 *
 *   The accepted range is wide on purpose: a heart rate of 35 or an SpO2 of 78
 *   is exactly what an alarm needs to see, so it must not be thrown away as
 *   "out of range". The same limits are used by the edge server
 *   (config/clinical_thresholds.js, "valid"). How the values are measured is in
 *   pulse_estimator.h.
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

#endif  // SHIRO_VITALS_FILTER_H
