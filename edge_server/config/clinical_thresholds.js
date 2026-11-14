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

    // Tier 2: abnormal. Alarms when seen in requiredCycles separate measurement
    // cycles within cycleWindowMs, or continuously for sustainedMs in one stream.
    moderate: {
      bpmHigh: 120,
      bpmLow: 50,
      spo2Low: 90,
      requiredCycles: 2,
      cycleGapMs: 60000,      // readings further apart than this belong to different cycles
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
