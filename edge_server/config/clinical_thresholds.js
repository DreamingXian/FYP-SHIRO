// =============================================================================
// SHIRO Edge Server - Clinical Alarm Thresholds
// Every limit used to raise an alarm lives in this file, so it can be reviewed
// and changed in one place. Values are prototype defaults, not clinically
// validated limits.
// =============================================================================

module.exports = {
  vitals: {
    // Readings outside this range are treated as "no valid reading".
    // The wristband firmware applies the same range before transmitting.
    valid: {
      bpmMin: 30,
      bpmMax: 220,
      spo2Min: 70,
      spo2Max: 100
    },

    // Tier 1: life-threatening. Alarms once the reading has stayed extreme for
    // persistMs, so one noisy beat cannot raise an emergency.
    extreme: {
      bpmHigh: 160,   // above: critical tachycardia
      bpmLow: 40,     // below: severe bradycardia
      spo2Low: 85,    // below: severe desaturation
      persistMs: 5000,
      maxGapMs: 10000 // a longer silence between extreme readings restarts the timer
    },

    // SpO2 is shown but does not raise alarms. Reason (bench data of 14 Nov 2026,
    // docs/test_records/phase-3-bench-test.md): on a healthy tester 68% of 66,698
    // SpO2 readings were below 90% and 33% below 85%. The wristband's SpO2 formula
    // is not calibrated, so its value is indicative only. Set to true only after
    // the measurement has been validated against a reference pulse oximeter.
    spo2AlarmsEnabled: false,

    // Tier 2: abnormal. Judged on unbroken series of abnormal readings: a silence
    // longer than maxGapMs, or a reading that is not abnormal, ends a series.
    // Alarms when a series lasts sustainedMs (continuous stream), or when a series
    // of at least cycleConfirmMs is seen in requiredCycles separate measurement
    // cycles within cycleWindowMs (15-second measurement every 3 minutes).
    moderate: {
      bpmHigh: 120,
      bpmLow: 50,
      spo2Low: 90,
      maxGapMs: 10000,
      requiredCycles: 2,
      cycleConfirmMs: 5000,
      cycleGapMs: 60000,      // series further apart than this belong to different cycles
      cycleWindowMs: 600000,  // cycles further apart than this are unrelated
      sustainedMs: 30000
    },

    // A reading inside this band clears any pending verification.
    normal: {
      bpmMin: 55,
      bpmMax: 100,
      spo2Min: 94
    },

    // Quiet period after a vitals alarm for the same wristband.
    // Applies to vitals alarms only: a fall is never delayed by it.
    alertDebounceMs: 12000
  },

  fall: {
    // Repeated fall packets for the same wristband and fall counter within this
    // time belong to one incident. The wristband repeats the flag for 45 s.
    sessionTtlMs: 90000
  },

  kinematics: {
    // Acceleration above this cannot come from the +/-16 g sensor range
    // (sqrt(3) * 16 = 27.7 g) and is discarded.
    maxPlausibleG: 28
  }
};
