/*
 * =========================================================================================
 *   SHIRO Wristband - Kinematic Fall State Machine (Chapter 4, Algorithm 3)
 *
 *   Plain C++ with no Arduino dependency, so the same file is compiled into the
 *   wristband firmware and into the PC test program (firmware/tests).
 *
 *   A fall is confirmed when three phases follow each other:
 *     1. Free-fall : total acceleration stays below freefallG for at least freefallMinMs
 *     2. Impact    : total acceleration exceeds impactG within impactMaxMs of the free-fall
 *     3. Stillness : mean |acceleration - 1 g| over stillDurationMs stays below stillnessG
 *
 *   Feed one sample per call to update(). Time is passed in, never read here.
 * =========================================================================================
 */
#ifndef SHIRO_FALL_DETECTOR_H
#define SHIRO_FALL_DETECTOR_H

#include <math.h>
#include <stdint.h>

struct FallConfig {
  float freefallG;           // below this the wrist is in free-fall
  float impactG;             // above this an impact has happened
  float stillnessG;          // mean post-impact motion below this means "not moving"
  uint32_t freefallMinMs;    // free-fall must last at least this long
  uint32_t impactMaxMs;      // impact must follow the end of free-fall within this time
  uint32_t stillDurationMs;  // length of the post-impact observation window
  uint32_t alertHoldMs;      // how long a confirmed fall stays flagged
};

// Thesis values (Chapter 4, Section 4.2.2 and Algorithm 3)
inline FallConfig defaultFallConfig() {
  FallConfig c;
  c.freefallG = 0.50f;
  c.impactG = 2.50f;
  c.stillnessG = 0.20f;
  c.freefallMinMs = 150;
  c.impactMaxMs = 500;
  c.stillDurationMs = 2000;
  c.alertHoldMs = 45000;
  return c;
}

enum FallPhase {
  FALL_PHASE_MONITORING = 0,
  FALL_PHASE_FREEFALL = 1,      // below the free-fall threshold, duration not yet reached or still falling
  FALL_PHASE_AWAIT_IMPACT = 2,  // free-fall was long enough, waiting for the impact
  FALL_PHASE_POST_IMPACT = 3,   // impact seen, measuring stillness
  FALL_PHASE_CONFIRMED = 4      // fall confirmed, flag held for alertHoldMs
};

class FallDetector {
 public:
  explicit FallDetector(const FallConfig& config = defaultFallConfig())
      : cfg(config) {
    reset();
    counter = 0;
    lastPeakImpactG = 0.0f;
    lastMinFreefallG = 0.0f;
    lastStillnessG = 0.0f;
  }

  // Feeds one acceleration sample (total magnitude in g) taken at nowMs.
  // Returns true exactly once per fall: on the sample that confirms it.
  bool update(float smv, uint32_t nowMs) {
    if (phase == FALL_PHASE_CONFIRMED) {
      service(nowMs);
      return false;
    }
    if (!(smv >= 0.0f)) return false;  // rejects NaN and negative values

    switch (phase) {
      case FALL_PHASE_MONITORING:
        if (smv < cfg.freefallG) {
          phase = FALL_PHASE_FREEFALL;
          freefallStartMs = nowMs;
          freefallEndMs = nowMs;
          runMinFreefallG = smv;
        }
        break;

      case FALL_PHASE_FREEFALL:
        if (smv < cfg.freefallG) {
          freefallEndMs = nowMs;
          if (smv < runMinFreefallG) runMinFreefallG = smv;
        } else if ((uint32_t)(nowMs - freefallStartMs) >= cfg.freefallMinMs) {
          // Free-fall lasted long enough and has just ended
          freefallEndMs = nowMs;
          phase = FALL_PHASE_AWAIT_IMPACT;
          checkImpact(smv, nowMs);
        } else {
          phase = FALL_PHASE_MONITORING;  // too short: a swing or a bump, not a fall
        }
        break;

      case FALL_PHASE_AWAIT_IMPACT:
        if (smv < cfg.freefallG) {
          // Still falling (or falling again): the impact window restarts
          freefallEndMs = nowMs;
          if (smv < runMinFreefallG) runMinFreefallG = smv;
        } else if ((uint32_t)(nowMs - freefallEndMs) > cfg.impactMaxMs) {
          phase = FALL_PHASE_MONITORING;  // no impact followed
        } else {
          checkImpact(smv, nowMs);
        }
        break;

      case FALL_PHASE_POST_IMPACT:
        if (smv > runPeakImpactG) runPeakImpactG = smv;
        stillnessSum += fabsf(smv - 1.0f);
        stillnessSamples++;
        if ((uint32_t)(nowMs - impactMs) >= cfg.stillDurationMs) {
          const float meanMotion = stillnessSamples > 0 ? stillnessSum / (float)stillnessSamples : 0.0f;
          if (meanMotion < cfg.stillnessG) {
            phase = FALL_PHASE_CONFIRMED;
            confirmedMs = nowMs;
            counter++;
            lastPeakImpactG = runPeakImpactG;
            lastMinFreefallG = runMinFreefallG;
            lastStillnessG = meanMotion;
            return true;
          }
          phase = FALL_PHASE_MONITORING;  // the person is moving: not incapacitated
        }
        break;

      default:
        break;
    }
    return false;
  }

  // Ends the hold of a confirmed fall when its time is over. update() calls this
  // itself; call it directly while no samples are available (sensor fault).
  void service(uint32_t nowMs) {
    if (phase == FALL_PHASE_CONFIRMED && (uint32_t)(nowMs - confirmedMs) >= cfg.alertHoldMs) {
      phase = FALL_PHASE_MONITORING;
    }
  }

  // Drops a fall that is still being evaluated (used when the sensor stops
  // delivering data). A confirmed fall keeps its hold.
  void cancelPending() {
    if (phase != FALL_PHASE_CONFIRMED) reset();
  }

  bool emergency() const { return phase == FALL_PHASE_CONFIRMED; }
  FallPhase currentPhase() const { return phase; }

  // Identifies the most recent confirmed fall. Starts at the seeded value and
  // increases by one per fall (wraps at 255), so receivers can tell a repeated
  // packet from a new fall.
  uint8_t eventCounter() const { return counter; }
  void seedCounter(uint8_t value) { counter = value; }

  // Measurements of the most recent confirmed fall (0 until the first fall)
  float peakImpactG() const { return lastPeakImpactG; }
  float minFreefallG() const { return lastMinFreefallG; }
  float stillnessG() const { return lastStillnessG; }

  const FallConfig& config() const { return cfg; }

 private:
  void reset() {
    phase = FALL_PHASE_MONITORING;
    freefallStartMs = 0;
    freefallEndMs = 0;
    impactMs = 0;
    confirmedMs = 0;
    runMinFreefallG = 0.0f;
    runPeakImpactG = 0.0f;
    stillnessSum = 0.0f;
    stillnessSamples = 0;
  }

  void checkImpact(float smv, uint32_t nowMs) {
    if (smv > cfg.impactG) {
      phase = FALL_PHASE_POST_IMPACT;
      impactMs = nowMs;
      runPeakImpactG = smv;
      stillnessSum = 0.0f;
      stillnessSamples = 0;
    }
  }

  FallConfig cfg;
  FallPhase phase;
  uint32_t freefallStartMs;
  uint32_t freefallEndMs;
  uint32_t impactMs;
  uint32_t confirmedMs;
  float runMinFreefallG;
  float runPeakImpactG;
  float stillnessSum;
  uint32_t stillnessSamples;
  uint8_t counter;
  float lastPeakImpactG;
  float lastMinFreefallG;
  float lastStillnessG;
};

// -----------------------------------------------------------------------------
// Built-in self-test: replays three synthetic 50 Hz traces through a private
// detector. Runs on the wristband at boot and on the PC in the test program.
// -----------------------------------------------------------------------------
struct FallSelfTestResult {
  bool fallDetected;      // free-fall + impact + stillness must confirm a fall
  bool shortDipIgnored;   // a dip shorter than freefallMinMs must not
  bool movementIgnored;   // free-fall + impact followed by movement must not
  bool passed() const { return fallDetected && shortDipIgnored && movementIgnored; }
};

namespace shiro_selftest {

// Feeds `durationMs` of a constant value at 50 Hz; returns true if a fall was confirmed.
inline bool feed(FallDetector& d, uint32_t& t, float g, uint32_t durationMs) {
  bool confirmed = false;
  for (uint32_t elapsed = 0; elapsed < durationMs; elapsed += 20) {
    if (d.update(g, t)) confirmed = true;
    t += 20;
  }
  return confirmed;
}

// Feeds `durationMs` of movement: acceleration alternating between 0.6 g and 1.6 g.
inline bool feedMovement(FallDetector& d, uint32_t& t, uint32_t durationMs) {
  bool confirmed = false;
  uint32_t n = 0;
  for (uint32_t elapsed = 0; elapsed < durationMs; elapsed += 20, n++) {
    if (d.update((n % 2 == 0) ? 0.6f : 1.6f, t)) confirmed = true;
    t += 20;
  }
  return confirmed;
}

}  // namespace shiro_selftest

inline FallSelfTestResult runFallSelfTest() {
  using namespace shiro_selftest;
  FallSelfTestResult r;

  {  // 1. A fall: rest, 300 ms free-fall, impact, lying still
    FallDetector d;
    uint32_t t = 1000;
    bool c = feed(d, t, 1.0f, 1000);
    c = feed(d, t, 0.15f, 300) || c;
    c = feed(d, t, 4.0f, 40) || c;
    c = feed(d, t, 1.02f, 2500) || c;
    r.fallDetected = c && d.emergency() && d.peakImpactG() > 3.9f && d.minFreefallG() < 0.2f;
  }
  {  // 2. A 60 ms dip followed by a knock: too short to be a fall
    FallDetector d;
    uint32_t t = 1000;
    bool c = feed(d, t, 1.0f, 1000);
    c = feed(d, t, 0.2f, 60) || c;
    c = feed(d, t, 4.0f, 40) || c;
    c = feed(d, t, 1.0f, 2500) || c;
    r.shortDipIgnored = !c && !d.emergency();
  }
  {  // 3. Free-fall and impact, then the person keeps moving: not incapacitated
    FallDetector d;
    uint32_t t = 1000;
    bool c = feed(d, t, 1.0f, 1000);
    c = feed(d, t, 0.15f, 300) || c;
    c = feed(d, t, 4.0f, 40) || c;
    c = feedMovement(d, t, 2500) || c;
    r.movementIgnored = !c && !d.emergency();
  }
  return r;
}

#endif  // SHIRO_FALL_DETECTOR_H
