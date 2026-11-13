// =============================================================================
// SHIRO Edge Server - Vitals Alarm Evaluation
// Decides when heart rate or SpO2 readings justify an alarm. Pure logic: no
// database, no network, and the clock is injected so every rule can be tested.
// Limits come from config/clinical_thresholds.js.
// =============================================================================
const thresholds = require('../../config/clinical_thresholds');

function classifyExtreme(bpm, spo2, limits) {
  if (bpm !== null && bpm > limits.bpmHigh) return `Critical Tachycardia (${bpm} BPM > ${limits.bpmHigh})`;
  if (bpm !== null && bpm < limits.bpmLow) return `Severe Bradycardia (${bpm} BPM < ${limits.bpmLow})`;
  if (spo2 !== null && spo2 < limits.spo2Low) return `Severe Desaturation (SpO2 ${spo2}% < ${limits.spo2Low}%)`;
  return null;
}

function classifyModerate(bpm, spo2, limits) {
  if (bpm !== null && bpm > limits.bpmHigh) return `Tachycardia (${bpm} BPM > ${limits.bpmHigh})`;
  if (bpm !== null && bpm < limits.bpmLow) return `Bradycardia (${bpm} BPM < ${limits.bpmLow})`;
  if (spo2 !== null && spo2 < limits.spo2Low) return `Hypoxia (SpO2 ${spo2}% < ${limits.spo2Low}%)`;
  return null;
}

function isNormal(bpm, spo2, limits) {
  const bpmOk = bpm === null || (bpm >= limits.bpmMin && bpm <= limits.bpmMax);
  const spo2Ok = spo2 === null || spo2 >= limits.spo2Min;
  return bpmOk && spo2Ok;
}

function createVitalsEvaluator({ config = thresholds.vitals, now = () => Date.now() } = {}) {
  // key (wristband) -> { extremeSince, extremeLast, streak, lastAlertAt }
  const states = new Map();

  function getState(key) {
    let s = states.get(key);
    if (!s) {
      s = { extremeSince: null, extremeLast: 0, streak: null, lastAlertAt: 0 };
      states.set(key, s);
    }
    return s;
  }

  /**
   * @param {string} key  wristband identity
   * @param {{bpm: number|null, spo2: number|null}} reading  validated values, null when unknown
   * @returns {null | {severity: 'EXTREME'|'SUSTAINED', reason: string, bpm, spo2}}
   */
  function evaluate(key, reading) {
    const bpm = reading && Number.isFinite(reading.bpm) ? reading.bpm : null;
    const spo2 = reading && Number.isFinite(reading.spo2) ? reading.spo2 : null;
    if (bpm === null && spo2 === null) return null; // no valid reading: nothing to judge

    const t = now();
    const s = getState(key);

    // Quiet period after an alarm for this wristband
    if (s.lastAlertAt && t - s.lastAlertAt < config.alertDebounceMs) return null;

    // ----- Tier 1: extreme, must persist -----
    const extremeReason = classifyExtreme(bpm, spo2, config.extreme);
    if (extremeReason) {
      if (s.extremeSince === null || t - s.extremeLast > config.extreme.maxGapMs) {
        s.extremeSince = t;
      }
      s.extremeLast = t;
      if (t - s.extremeSince >= config.extreme.persistMs) {
        s.extremeSince = null;
        s.streak = null;
        s.lastAlertAt = t;
        return { severity: 'EXTREME', reason: extremeReason, bpm, spo2 };
      }
    } else {
      s.extremeSince = null;
    }

    // ----- Tier 2: abnormal, verified over separate cycles or a sustained stream -----
    // An extreme reading is also abnormal, so it counts here while Tier 1 waits.
    const moderateReason = classifyModerate(bpm, spo2, config.moderate);
    if (moderateReason) {
      const st = s.streak;
      if (!st || t - st.lastSeen > config.moderate.cycleWindowMs) {
        s.streak = { count: 1, cycleStart: t, lastSeen: t };
      } else {
        if (t - st.lastSeen >= config.moderate.cycleGapMs) {
          st.count++;
          st.cycleStart = t;
        }
        st.lastSeen = t;
      }

      const streak = s.streak;
      const verifiedByCycles = streak.count >= config.moderate.requiredCycles;
      const verifiedByDuration = t - streak.cycleStart >= config.moderate.sustainedMs;
      if (verifiedByCycles || verifiedByDuration) {
        const how = verifiedByCycles
          ? `seen in ${streak.count} measurement cycles`
          : `sustained for ${Math.round((t - streak.cycleStart) / 1000)} s`;
        s.streak = null;
        s.extremeSince = null;
        s.lastAlertAt = t;
        return { severity: 'SUSTAINED', reason: `${moderateReason}, ${how}`, bpm, spo2 };
      }
    } else if (isNormal(bpm, spo2, config.normal)) {
      s.streak = null;
    }

    return null;
  }

  /** Verification progress for one wristband, for logging and tests. */
  function getProgress(key) {
    const s = states.get(key);
    if (!s) return null;
    return {
      extremePending: s.extremeSince !== null,
      cycles: s.streak ? s.streak.count : 0
    };
  }

  function reset(key) {
    if (key === undefined) states.clear();
    else states.delete(key);
  }

  return { evaluate, getProgress, reset };
}

module.exports = { createVitalsEvaluator, classifyExtreme, classifyModerate, isNormal };
