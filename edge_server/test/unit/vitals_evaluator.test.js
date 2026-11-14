// Unit tests: vitals alarm rules, every threshold boundary (no database, injected clock)
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const thresholds = require('../../config/clinical_thresholds');
const { createVitalsEvaluator, classifyExtreme, classifyModerate } = require('../../services/alerts/vitals_evaluator');

const V = thresholds.vitals;
const NORMAL = { bpm: 72, spo2: 98 };

function setup(overrides = {}) {
  const clock = { t: 1_000_000 };
  const evaluator = createVitalsEvaluator({ config: { ...V, ...overrides }, now: () => clock.t });
  return { clock, evaluator };
}

/** An evaluator for a deployment whose SpO2 measurement has been validated. */
function setupWithSpo2Alarms() {
  return setup({ spo2AlarmsEnabled: true });
}

/** Feeds the same reading once per second for `seconds`; returns the first alarm, or null. */
function feed(evaluator, clock, reading, seconds, key = 'TAG-1') {
  for (let i = 0; i <= seconds; i++) {
    const result = evaluator.evaluate(key, reading);
    if (result) return { result, afterMs: i * 1000 };
    clock.t += 1000;
  }
  return null;
}

describe('threshold boundaries', () => {
  test('extreme limits are exclusive', () => {
    assert.equal(classifyExtreme(V.extreme.bpmHigh, 98, V.extreme), null);
    assert.match(classifyExtreme(V.extreme.bpmHigh + 1, 98, V.extreme), /Tachycardia/);
    assert.equal(classifyExtreme(V.extreme.bpmLow, 98, V.extreme), null);
    assert.match(classifyExtreme(V.extreme.bpmLow - 1, 98, V.extreme), /Bradycardia/);
    assert.equal(classifyExtreme(72, V.extreme.spo2Low, V.extreme), null);
    assert.match(classifyExtreme(72, V.extreme.spo2Low - 1, V.extreme), /Desaturation/);
  });

  test('moderate limits are exclusive', () => {
    assert.equal(classifyModerate(V.moderate.bpmHigh, 98, V.moderate), null);
    assert.match(classifyModerate(V.moderate.bpmHigh + 1, 98, V.moderate), /Tachycardia/);
    assert.equal(classifyModerate(V.moderate.bpmLow, 98, V.moderate), null);
    assert.match(classifyModerate(V.moderate.bpmLow - 1, 98, V.moderate), /Bradycardia/);
    assert.equal(classifyModerate(72, V.moderate.spo2Low, V.moderate), null);
    assert.match(classifyModerate(72, V.moderate.spo2Low - 1, V.moderate), /Hypoxia/);
  });

  test('an unknown value never classifies as abnormal', () => {
    assert.equal(classifyExtreme(null, null, V.extreme), null);
    assert.equal(classifyModerate(null, null, V.moderate), null);
  });

  test('the configured limits are ordered sensibly', () => {
    assert.ok(V.valid.bpmMin < V.extreme.bpmLow && V.extreme.bpmLow < V.moderate.bpmLow);
    assert.ok(V.moderate.bpmHigh < V.extreme.bpmHigh && V.extreme.bpmHigh < V.valid.bpmMax);
    assert.ok(V.valid.spo2Min < V.extreme.spo2Low && V.extreme.spo2Low < V.moderate.spo2Low);
    assert.ok(V.moderate.bpmLow < V.normal.bpmMin && V.normal.bpmMax < V.moderate.bpmHigh);
  });
});

describe('normal and missing readings', () => {
  test('normal vitals never alarm', () => {
    const { clock, evaluator } = setup();
    assert.equal(feed(evaluator, clock, NORMAL, 600), null);
  });

  test('no valid reading never alarms', () => {
    const { clock, evaluator } = setup();
    assert.equal(feed(evaluator, clock, { bpm: null, spo2: null }, 600), null);
  });
});

describe('extreme readings (Tier 1)', () => {
  test('a single extreme reading does not alarm', () => {
    const { evaluator } = setup();
    assert.equal(evaluator.evaluate('TAG-1', { bpm: 190, spo2: 98 }), null);
  });

  test('alarms once the reading has stayed extreme for the persistence time', () => {
    const { clock, evaluator } = setup();
    const out = feed(evaluator, clock, { bpm: 190, spo2: 98 }, 30);
    assert.ok(out, 'an alarm is expected');
    assert.equal(out.result.severity, 'EXTREME');
    assert.equal(out.afterMs, V.extreme.persistMs);
    assert.equal(out.result.bpm, 190);
  });

  test('a normal reading in between restarts the timer', () => {
    const { clock, evaluator } = setup();
    assert.equal(feed(evaluator, clock, { bpm: 190, spo2: 98 }, 3), null);
    assert.equal(evaluator.evaluate('TAG-1', NORMAL), null);
    clock.t += 1000;
    const out = feed(evaluator, clock, { bpm: 190, spo2: 98 }, 30);
    assert.equal(out.afterMs, V.extreme.persistMs);
  });

  test('a long silence between extreme readings restarts the timer', () => {
    const { clock, evaluator } = setup();
    assert.equal(evaluator.evaluate('TAG-1', { bpm: 35, spo2: 98 }), null);
    clock.t += V.extreme.maxGapMs + 1;
    assert.equal(evaluator.evaluate('TAG-1', { bpm: 35, spo2: 98 }), null, 'two readings far apart are not "persisting"');
  });

  test('low SpO2 alarms even when the heart rate is unknown (SpO2 alarms switched on)', () => {
    const { clock, evaluator } = setupWithSpo2Alarms();
    const out = feed(evaluator, clock, { bpm: null, spo2: 80 }, 30);
    assert.equal(out.result.severity, 'EXTREME');
    assert.match(out.result.reason, /Desaturation/);
  });

  test('wristbands are judged independently', () => {
    const { clock, evaluator } = setup();
    for (let i = 0; i < 4; i++) {
      evaluator.evaluate('TAG-1', { bpm: 190, spo2: 98 });
      clock.t += 1000;
    }
    assert.equal(evaluator.evaluate('TAG-2', { bpm: 190, spo2: 98 }), null, 'TAG-2 has only just started');
  });
});

describe('abnormal readings (Tier 2)', () => {
  const ABNORMAL = { bpm: 130, spo2: 97 };
  const IN_BETWEEN = { bpm: 110, spo2: 97 }; // neither abnormal nor inside the normal band

  test('many packets of one short measurement cycle do not alarm', () => {
    const { clock, evaluator } = setup();
    // A 15-second burst forwarded by three anchors at 5 Hz
    for (let i = 0; i < 15 * 15; i++) {
      assert.equal(evaluator.evaluate('TAG-1', ABNORMAL), null);
      clock.t += 67;
    }
  });

  test('alarms when the anomaly is confirmed again in the next measurement cycle', () => {
    const { clock, evaluator } = setup();
    assert.equal(feed(evaluator, clock, ABNORMAL, 15), null);
    clock.t += 165000; // the wristband sleeps until its next 3-minute cycle
    const out = feed(evaluator, clock, ABNORMAL, 15);
    assert.ok(out);
    assert.equal(out.result.severity, 'SUSTAINED');
    assert.match(out.result.reason, /2 measurement cycles/);
    assert.equal(out.afterMs, V.moderate.cycleConfirmMs, 'the second cycle must be confirmed too, not just glimpsed');
  });

  test('single abnormal readings in two cycles do not alarm', () => {
    const { clock, evaluator } = setup();
    for (let cycle = 0; cycle < 5; cycle++) {
      assert.equal(evaluator.evaluate('TAG-1', ABNORMAL), null);
      clock.t += 1000;
      assert.equal(evaluator.evaluate('TAG-1', IN_BETWEEN), null);
      clock.t += 179000;
    }
  });

  test('a normal cycle in between clears the verification', () => {
    const { clock, evaluator } = setup();
    assert.equal(feed(evaluator, clock, ABNORMAL, 15), null);
    clock.t += 165000;
    assert.equal(evaluator.evaluate('TAG-1', NORMAL), null);
    clock.t += 180000;
    assert.equal(feed(evaluator, clock, ABNORMAL, 15), null, 'counting starts again at cycle 1');
  });

  test('cycles further apart than the window are unrelated', () => {
    const { clock, evaluator } = setup();
    assert.equal(feed(evaluator, clock, ABNORMAL, 15), null);
    clock.t += V.moderate.cycleWindowMs + 1;
    assert.equal(feed(evaluator, clock, ABNORMAL, 15), null);
  });

  test('alarms when the anomaly is sustained in one continuous stream', () => {
    const { clock, evaluator } = setup();
    const out = feed(evaluator, clock, ABNORMAL, 120);
    assert.ok(out);
    assert.equal(out.result.severity, 'SUSTAINED');
    assert.equal(out.afterMs, V.moderate.sustainedMs);
  });

  test('two readings with a long silence in between are not "sustained"', () => {
    // Bench finding of 14 Nov 2026: a reading before a fall and one after its
    // 45-second hold were reported as "sustained for 57 s".
    const { clock, evaluator } = setup();
    assert.equal(feed(evaluator, clock, ABNORMAL, 3), null);
    clock.t += 45000;
    assert.equal(evaluator.evaluate('TAG-1', ABNORMAL), null);
    clock.t += 1000;
    assert.equal(evaluator.evaluate('TAG-1', ABNORMAL), null);
  });

  test('a reading that is not abnormal breaks the series', () => {
    const { clock, evaluator } = setup();
    // 20 s abnormal, one in-between reading, 20 s abnormal: never 30 s without a break
    assert.equal(feed(evaluator, clock, ABNORMAL, 20), null);
    assert.equal(evaluator.evaluate('TAG-1', IN_BETWEEN), null);
    clock.t += 1000;
    assert.equal(feed(evaluator, clock, ABNORMAL, 20), null);
  });
});

describe('SpO2 alarm switch', () => {
  test('SpO2 alarms are off by default: the measurement is not calibrated', () => {
    assert.equal(V.spo2AlarmsEnabled, false);
  });

  test('with the switch off, low SpO2 never raises an alarm', () => {
    const { clock, evaluator } = setup();
    assert.equal(feed(evaluator, clock, { bpm: 72, spo2: 75 }, 600), null);
    assert.equal(feed(evaluator, clock, { bpm: null, spo2: 75 }, 600), null);
  });

  test('with the switch off, a heart-rate alarm still reports the SpO2 that was measured', () => {
    const { clock, evaluator } = setup();
    const out = feed(evaluator, clock, { bpm: 190, spo2: 82 }, 30);
    assert.match(out.result.reason, /Tachycardia/);
    assert.equal(out.result.spo2, 82);
  });

  test('with the switch off, a low SpO2 does not keep a heart-rate verification alive', () => {
    const { clock, evaluator } = setup();
    assert.equal(feed(evaluator, clock, { bpm: 130, spo2: 80 }, 15), null);
    clock.t += 165000;
    // Heart rate back to normal, SpO2 still low: the verification is cleared
    assert.equal(evaluator.evaluate('TAG-1', { bpm: 72, spo2: 80 }), null);
    assert.equal(evaluator.getProgress('TAG-1').cycles, 0);
  });

  test('with the switch on, sustained low SpO2 alarms', () => {
    const { clock, evaluator } = setupWithSpo2Alarms();
    const out = feed(evaluator, clock, { bpm: 72, spo2: 88 }, 120);
    assert.equal(out.result.severity, 'SUSTAINED');
    assert.match(out.result.reason, /Hypoxia/);
    assert.equal(out.afterMs, V.moderate.sustainedMs);
  });
});

describe('quiet period after an alarm', () => {
  test('no second vitals alarm inside the quiet period, a new one after it', () => {
    const { clock, evaluator } = setup();
    const first = feed(evaluator, clock, { bpm: 190, spo2: 98 }, 30);
    assert.ok(first);

    const quietSeconds = Math.floor(V.alertDebounceMs / 1000) - 1;
    assert.equal(feed(evaluator, clock, { bpm: 190, spo2: 98 }, quietSeconds - 1), null);

    const second = feed(evaluator, clock, { bpm: 190, spo2: 98 }, 60);
    assert.ok(second, 'the alarm is raised again when the condition continues');
  });
});
