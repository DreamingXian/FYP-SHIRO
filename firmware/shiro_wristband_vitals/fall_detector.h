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
 *     3. Stillness : after settleMs (the shock of the impact dying away), the mean
 *                    |acceleration - 1 g| over stillDurationMs stays below stillnessG.
 *                    After a soft impact (peak below softImpactG) the wrist must be
 *                    clearly still: below softStillnessG.
 *
 *   Feed one sample per call to update(). Time is passed in, never read here.
 *
 *   Fall-check report (V5.2, diagnostics only): every event that looks like a drop
 *   leaves one record (lastCheck(), counted by checkCount()) saying how it ended and
 *   with which values: a fall, moving after the impact, no impact, or a free-fall too
 *   short (including a dip that never went below freefallG) followed by an impact.
 *   A missed drop then shows which phase failed. The records never change a decision.
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
  float softImpactG;         // an impact whose peak stays below this is a soft one
  float softStillnessG;      // after a soft impact, mean post-impact motion must stay below this
  uint32_t freefallMinMs;    // free-fall must last at least this long
  uint32_t impactMaxMs;      // impact must follow the end of free-fall within this time
  uint32_t settleMs;         // time after the impact that is not counted as movement
  uint32_t stillDurationMs;  // length of the stillness observation window that follows
  uint32_t alertHoldMs;      // how long a confirmed fall stays flagged
};

// Thesis values (Chapter 4, Section 4.2.2 and Algorithm 3). settleMs comes from the
// bench tests of 14 Nov 2026: without it the impact shock itself (several samples
// far above 1 g, then ringing) was averaged into the "post-impact motion", so a
// harder impact was less likely to be confirmed than a soft one.
// softImpactG and softStillnessG come from the false alarms of 16 and 21 Nov 2026:
// a wearer who is standing lowers the arm quickly (free-fall), it stops against the
// leg (2.7 to 3.5 g) and then stands with small hand movements (0.10 to 0.16 g).
// Every deliberate arm drop below 4 g was followed by 0.02 to 0.03 g
// (firmware/tests/data/fall_values.csv). A hard impact keeps the 0.20 g limit, so
// a patient who falls hard and still moves a little raises the alarm.
inline FallConfig defaultFallConfig() {
  FallConfig c;
  c.freefallG = 0.50f;
  c.impactG = 2.50f;
  c.stillnessG = 0.20f;
  c.softImpactG = 4.00f;
  c.softStillnessG = 0.08f;
  c.freefallMinMs = 150;
  c.impactMaxMs = 500;
  c.settleMs = 500;
  c.stillDurationMs = 2000;
  c.alertHoldMs = 45000;
  return c;
}

enum FallPhase {
  FALL_PHASE_MONITORING = 0,
  FALL_PHASE_FREEFALL = 1,      // below the free-fall threshold, duration not yet reached or still falling
  FALL_PHASE_AWAIT_IMPACT = 2,  // free-fall was long enough, waiting for the impact
  FALL_PHASE_POST_IMPACT = 3,   // impact seen: settling, then measuring stillness
  FALL_PHASE_CONFIRMED = 4      // fall confirmed, flag held for alertHoldMs
};

// How a fall check ended (diagnostics, see lastCheck())
enum FallCheckOutcome {
  FALL_CHECK_NONE = 0,
  FALL_CHECK_CONFIRMED = 1,       // free-fall, impact, then still: a fall
  FALL_CHECK_MOVING = 2,          // free-fall and impact, then more movement than the limit
  FALL_CHECK_NO_IMPACT = 3,       // free-fall long enough, but no impact within impactMaxMs
  FALL_CHECK_FREEFALL_SHORT = 4   // a dip below 0.80 g that stayed below freefallG too briefly (or never),
                                  // followed by an impact or below freefallG for at least 60 ms
};

struct FallCheck {
  FallCheckOutcome outcome;
  uint32_t atMs;          // when the check ended
  uint32_t freefallMs;    // time below freefallG (the longest stretch for FREEFALL_SHORT; 0 if never below)
  float lowestG;          // lowest acceleration of the free-fall or dip
  float impactG;          // highest acceleration after it: the impact, or the highest value seen when there was none
  float motionG;          // mean post-impact motion (CONFIRMED, MOVING)
  float limitG;           // the stillness limit that applied (CONFIRMED, MOVING)
  uint32_t largestGapMs;  // largest time between two samples during the check (50 Hz: 20 ms)
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
    checks = 0;
    check = FallCheck();
  }

  // Feeds one acceleration sample (total magnitude in g) taken at nowMs.
  // Returns true exactly once per fall: on the sample that confirms it.
  bool update(float smv, uint32_t nowMs) {
    const uint32_t gapMs = noteSample(nowMs);  // diagnostics only
    if (phase == FALL_PHASE_CONFIRMED) {
      service(nowMs);
      return false;
    }
    if (!(smv >= 0.0f)) return false;  // rejects NaN and negative values
    const FallPhase before = phase;
    if (phase != FALL_PHASE_MONITORING && gapMs > checkGapMs) checkGapMs = gapMs;

    switch (phase) {
      case FALL_PHASE_MONITORING:
        if (smv < cfg.freefallG) {
          phase = FALL_PHASE_FREEFALL;
          freefallStartMs = nowMs;
          freefallEndMs = nowMs;
          runMinFreefallG = smv;
          checkGapMs = gapMs;
        }
        break;

      case FALL_PHASE_FREEFALL:
        if (smv < cfg.freefallG) {
          freefallEndMs = nowMs;
          if (smv < runMinFreefallG) runMinFreefallG = smv;
        } else if ((uint32_t)(nowMs - freefallStartMs) >= cfg.freefallMinMs) {
          // Free-fall lasted long enough and has just ended
          freefallEndMs = nowMs;
          freefallMs = nowMs - freefallStartMs;
          afterFreefallPeakG = smv;
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
          freefallMs = nowMs - freefallStartMs;
          if (smv < runMinFreefallG) runMinFreefallG = smv;
        } else if ((uint32_t)(nowMs - freefallEndMs) > cfg.impactMaxMs) {
          phase = FALL_PHASE_MONITORING;  // no impact followed
          record(FALL_CHECK_NO_IMPACT, nowMs, freefallMs, runMinFreefallG, afterFreefallPeakG, 0.0f, 0.0f, checkGapMs);
        } else {
          if (smv > afterFreefallPeakG) afterFreefallPeakG = smv;
          checkImpact(smv, nowMs);
        }
        break;

      case FALL_PHASE_POST_IMPACT:
        if (smv > runPeakImpactG) runPeakImpactG = smv;
        // The shock of the impact and its bounce are not movement of the person
        if ((uint32_t)(nowMs - impactMs) < cfg.settleMs) break;
        stillnessSum += fabsf(smv - 1.0f);
        stillnessSamples++;
        if ((uint32_t)(nowMs - impactMs) >= cfg.settleMs + cfg.stillDurationMs) {
          const float meanMotion = stillnessSamples > 0 ? stillnessSum / (float)stillnessSamples : 0.0f;
          if (meanMotion < stillnessLimit(runPeakImpactG)) {
            phase = FALL_PHASE_CONFIRMED;
            confirmedMs = nowMs;
            counter++;
            lastPeakImpactG = runPeakImpactG;
            lastMinFreefallG = runMinFreefallG;
            lastStillnessG = meanMotion;
            record(FALL_CHECK_CONFIRMED, nowMs, freefallMs, runMinFreefallG, runPeakImpactG, meanMotion,
                   stillnessLimit(runPeakImpactG), checkGapMs);
            return true;
          }
          phase = FALL_PHASE_MONITORING;  // the person is moving: not incapacitated
          record(FALL_CHECK_MOVING, nowMs, freefallMs, runMinFreefallG, runPeakImpactG, meanMotion,
                 stillnessLimit(runPeakImpactG), checkGapMs);
        }
        break;

      default:
        break;
    }
    watchDip(smv, nowMs, gapMs, before);
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

  // The post-impact motion must stay below this value after an impact with this peak
  float stillnessLimit(float peakImpactG) const {
    return peakImpactG < cfg.softImpactG ? cfg.softStillnessG : cfg.stillnessG;
  }

  // Fall-check report (diagnostics): the number of checks recorded so far (wraps),
  // and the most recent one. A caller prints a check when the count changes.
  uint16_t checkCount() const { return checks; }
  const FallCheck& lastCheck() const { return check; }

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
    // Diagnostics
    haveSample = false;
    lastSampleMs = 0;
    checkGapMs = 0;
    freefallMs = 0;
    afterFreefallPeakG = 0.0f;
    dipOpen = false;
    dipTaken = false;
    dipLastMs = 0;
    dipLowG = 0.0f;
    dipInBelow = false;
    dipBelowStartMs = 0;
    dipBelowRunMs = 0;
    dipPeakG = 0.0f;
    dipImpactMs = 0;
    dipGapMs = 0;
  }

  // ---- Diagnostics only: nothing below changes a decision ----

  // Time since the previous sample (0 for the first one)
  uint32_t noteSample(uint32_t nowMs) {
    const uint32_t gap = haveSample ? (uint32_t)(nowMs - lastSampleMs) : 0;
    haveSample = true;
    lastSampleMs = nowMs;
    return gap;
  }

  void record(FallCheckOutcome outcome, uint32_t nowMs, uint32_t ffMs, float lowestG, float highestG,
              float motionG, float limitG, uint32_t gapMs) {
    check.outcome = outcome;
    check.atMs = nowMs;
    check.freefallMs = ffMs;
    check.lowestG = lowestG;
    check.impactG = highestG;
    check.motionG = motionG;
    check.limitG = limitG;
    check.largestGapMs = gapMs;
    checks++;
  }

  // A dip below 0.80 g, and everything up to impactMaxMs after its last sample (or
  // 200 ms after an impact), is watched. When it ends it is recorded as
  // FREEFALL_SHORT, unless the state machine took it (a free-fall long enough: the
  // machine records its own outcome) or it was a small one: never below freefallG
  // for 60 ms and no impact after it.
  void watchDip(float smv, uint32_t nowMs, uint32_t gapMs, FallPhase before) {
    const float dipG = 0.80f;
    const uint32_t reportMinMs = 60;
    const uint32_t impactPeakMs = 200;
    if (smv < dipG) {
      if (!dipOpen) {
        dipOpen = true;
        dipTaken = false;
        dipLowG = smv;
        dipInBelow = false;
        dipBelowRunMs = 0;
        dipPeakG = 0.0f;
        dipImpactMs = 0;
        dipGapMs = gapMs;
      }
      dipLastMs = nowMs;
      if (smv < dipLowG) dipLowG = smv;
    }
    if (!dipOpen) return;
    if (phase == FALL_PHASE_AWAIT_IMPACT || phase == FALL_PHASE_POST_IMPACT || phase == FALL_PHASE_CONFIRMED) {
      dipTaken = true;
    }
    if (gapMs > dipGapMs) dipGapMs = gapMs;
    // Stretches below freefallG, measured as the state machine does: from the first
    // sample below to the first sample above
    if (smv < cfg.freefallG) {
      if (!dipInBelow) {
        dipInBelow = true;
        dipBelowStartMs = nowMs;
      }
    } else if (dipInBelow) {
      dipInBelow = false;
      const uint32_t run = nowMs - dipBelowStartMs;
      if (run > dipBelowRunMs) dipBelowRunMs = run;
    }
    if (smv >= dipG && smv > dipPeakG) dipPeakG = smv;
    if (smv > cfg.impactG && dipImpactMs == 0 && before != FALL_PHASE_AWAIT_IMPACT && before != FALL_PHASE_POST_IMPACT) {
      dipImpactMs = nowMs;
    }
    const bool ended = (uint32_t)(nowMs - dipLastMs) > cfg.impactMaxMs ||
                       (dipImpactMs != 0 && (uint32_t)(nowMs - dipImpactMs) >= impactPeakMs);
    if (!ended) return;
    dipOpen = false;
    if (dipTaken) return;
    if (dipImpactMs == 0 && dipBelowRunMs < reportMinMs) return;
    record(FALL_CHECK_FREEFALL_SHORT, nowMs, dipBelowRunMs, dipLowG, dipPeakG, 0.0f, 0.0f, dipGapMs);
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
  // Diagnostics
  uint16_t checks;
  FallCheck check;
  bool haveSample;
  uint32_t lastSampleMs;
  uint32_t checkGapMs;
  uint32_t freefallMs;
  float afterFreefallPeakG;
  bool dipOpen;
  bool dipTaken;
  uint32_t dipLastMs;
  float dipLowG;
  bool dipInBelow;
  uint32_t dipBelowStartMs;
  uint32_t dipBelowRunMs;
  float dipPeakG;
  uint32_t dipImpactMs;
  uint32_t dipGapMs;
};

// -----------------------------------------------------------------------------
// Built-in self-test: replays five synthetic 50 Hz traces through a private
// detector. Runs on the wristband at boot and on the PC in the test program.
// -----------------------------------------------------------------------------
struct FallSelfTestResult {
  bool fallDetected;      // free-fall + impact + stillness must confirm a fall
  bool softFallDetected;  // a soft impact followed by lying still must too
  bool shortDipIgnored;   // a dip shorter than freefallMinMs must not
  bool movementIgnored;   // free-fall + impact followed by movement must not
  bool armDropIgnored;    // soft impact, then standing with small hand movements, must not
  bool passed() const {
    return fallDetected && softFallDetected && shortDipIgnored && movementIgnored && armDropIgnored;
  }
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

// Feeds `durationMs` of small movement: alternating 0.88 g and 1.12 g (mean motion 0.12 g).
inline bool feedSmallMovement(FallDetector& d, uint32_t& t, uint32_t durationMs) {
  bool confirmed = false;
  uint32_t n = 0;
  for (uint32_t elapsed = 0; elapsed < durationMs; elapsed += 20, n++) {
    if (d.update((n % 2 == 0) ? 0.88f : 1.12f, t)) confirmed = true;
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
    c = feed(d, t, 1.02f, 3000) || c;
    r.fallDetected = c && d.emergency() && d.peakImpactG() > 3.9f && d.minFreefallG() < 0.2f;
  }
  {  // 2. A 60 ms dip followed by a knock: too short to be a fall
    FallDetector d;
    uint32_t t = 1000;
    bool c = feed(d, t, 1.0f, 1000);
    c = feed(d, t, 0.2f, 60) || c;
    c = feed(d, t, 4.0f, 40) || c;
    c = feed(d, t, 1.0f, 3000) || c;
    r.shortDipIgnored = !c && !d.emergency();
  }
  {  // 3. Free-fall and impact, then the person keeps moving: not incapacitated
    FallDetector d;
    uint32_t t = 1000;
    bool c = feed(d, t, 1.0f, 1000);
    c = feed(d, t, 0.15f, 300) || c;
    c = feed(d, t, 4.0f, 40) || c;
    c = feedMovement(d, t, 3000) || c;
    r.movementIgnored = !c && !d.emergency();
  }
  {  // 4. A soft fall: 3 g impact, then lying still
    FallDetector d;
    uint32_t t = 1000;
    bool c = feed(d, t, 1.0f, 1000);
    c = feed(d, t, 0.25f, 250) || c;
    c = feed(d, t, 3.0f, 40) || c;
    c = feed(d, t, 1.02f, 3000) || c;
    r.softFallDetected = c && d.emergency();
  }
  {  // 5. Standing: the arm drops against the leg (3 g), then small hand movements
    FallDetector d;
    uint32_t t = 1000;
    bool c = feed(d, t, 1.0f, 1000);
    c = feed(d, t, 0.25f, 250) || c;
    c = feed(d, t, 3.0f, 40) || c;
    c = feedSmallMovement(d, t, 3000) || c;
    r.armDropIgnored = !c && !d.emergency();
  }
  return r;
}

#endif  // SHIRO_FALL_DETECTOR_H
