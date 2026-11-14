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
  // key (wristband) -> {
  //   extremeSince, extremeLast,          Tier 1 timer
  //   run: { start, last, counted },      unbroken series of abnormal readings (Tier 2)
  //   cycles: { count, lastSeen },        measurement cycles in which a run was confirmed
  //   lastAlertAt
  // }
  const states = new Map();

  function getState(key) {
    let s = states.get(key);
    if (!s) {
      s = { extremeSince: null, extremeLast: 0, run: null, cycles: null, lastAlertAt: 0 };
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
    const reportedSpo2 = reading && Number.isFinite(reading.spo2) ? reading.spo2 : null;
    // SpO2 takes part in alarm decisions only when the deployment says the
    // measurement can be trusted (see spo2AlarmsEnabled in clinical_thresholds.js).
    const spo2 = config.spo2AlarmsEnabled ? reportedSpo2 : null;
    if (bpm === null && spo2 === null) return null; // nothing that may be judged

    const t = now();
    const s = getState(key);

    // Quiet period after an alarm for this wristband
    if (s.lastAlertAt && t - s.lastAlertAt < config.alertDebounceMs) return null;

    function raise(severity, reason) {
      s.extremeSince = null;
      s.run = null;
      s.cycles = null;
      s.lastAlertAt = t;
      // The alarm reports the SpO2 that was measured, whether or not it was judged
      return { severity, reason, bpm, spo2: reportedSpo2 };
    }

    // ----- Tier 1: extreme, must persist -----
    const extremeReason = classifyExtreme(bpm, spo2, config.extreme);
    if (extremeReason) {
      if (s.extremeSince === null || t - s.extremeLast > config.extreme.maxGapMs) {
        s.extremeSince = t;
      }
      s.extremeLast = t;
      if (t - s.extremeSince >= config.extreme.persistMs) {
        return raise('EXTREME', extremeReason);
      }
    } else {
      s.extremeSince = null;
    }

    // ----- Tier 2: abnormal, verified by an unbroken series of readings -----
    // An extreme reading is also abnormal, so it counts here while Tier 1 waits.
    const moderateReason = classifyModerate(bpm, spo2, config.moderate);
    if (!moderateReason) {
      // Any judged reading that is not abnormal ends the series
      s.run = null;
      if (isNormal(bpm, spo2, config.normal)) s.cycles = null;
      return null;
    }

    // A series is unbroken while abnormal readings follow each other closely.
    // A silence (sleeping sensor, fall being handled, lost contact) ends it:
    // two readings far apart say nothing about the time in between.
    if (!s.run || t - s.run.last > config.moderate.maxGapMs) {
      s.run = { start: t, last: t, counted: false };
    } else {
      s.run.last = t;
    }
    const runMs = t - s.run.start;

    // Rule A: abnormal without a break for sustainedMs (continuous 1 Hz stream)
    if (runMs >= config.moderate.sustainedMs) {
      return raise('SUSTAINED', `${moderateReason}, sustained for ${Math.round(runMs / 1000)} s`);
    }

    // Rule B: confirmed in requiredCycles separate measurement cycles. A cycle
    // counts once its series has lasted cycleConfirmMs, not on a single reading.
    if (s.run.counted && s.cycles) {
      s.cycles.lastSeen = t;
    } else if (runMs >= config.moderate.cycleConfirmMs) {
      s.run.counted = true;
      const previous = s.cycles;
      const gap = previous ? s.run.start - previous.lastSeen : null;
      if (previous && gap >= config.moderate.cycleGapMs && gap <= config.moderate.cycleWindowMs) {
        s.cycles = { count: previous.count + 1, lastSeen: t };
      } else if (previous && gap < config.moderate.cycleGapMs) {
        s.cycles = { count: previous.count, lastSeen: t }; // same cycle, briefly interrupted
      } else {
        s.cycles = { count: 1, lastSeen: t };
      }
      if (s.cycles.count >= config.moderate.requiredCycles) {
        return raise('SUSTAINED', `${moderateReason}, seen in ${s.cycles.count} measurement cycles`);
      }
    }

    return null;
  }

  /** Verification progress for one wristband, for logging and tests. */
  function getProgress(key) {
    const s = states.get(key);
    if (!s) return null;
    return {
      extremePending: s.extremeSince !== null,
      cycles: s.cycles ? s.cycles.count : 0
    };
  }

  function reset(key) {
    if (key === undefined) states.clear();
    else states.delete(key);
  }

  return { evaluate, getProgress, reset };
}

module.exports = { createVitalsEvaluator, classifyExtreme, classifyModerate, isNormal };
