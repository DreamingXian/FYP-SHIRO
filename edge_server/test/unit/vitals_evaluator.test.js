// Unit tests: vitals alarm rules, every threshold boundary (no database, injected clock)
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const thresholds = require('../../config/clinical_thresholds');
const { createVitalsEvaluator, classifyExtreme, classifyModerate } = require('../../services/alerts/vitals_evaluator');

const V = thresholds.vitals;
const NORMAL = { bpm: 72, spo2: 98 };

function setup() {
  const clock = { t: 1_000_000 };
  const evaluator = createVitalsEvaluator({ now: () => clock.t });
  return { clock, evaluator };
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

  test('low SpO2 alarms even when the heart rate is unknown', () => {
    const { clock, evaluator } = setup();
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

  test('many packets of one short measurement cycle do not alarm', () => {
    const { clock, evaluator } = setup();
    // A 15-second burst forwarded by three anchors at 5 Hz
    for (let i = 0; i < 15 * 15; i++) {
      assert.equal(evaluator.evaluate('TAG-1', ABNORMAL), null);
      clock.t += 67;
    }
  });

  test('alarms when the anomaly is seen again in the next measurement cycle', () => {
    const { clock, evaluator } = setup();
    assert.equal(feed(evaluator, clock, ABNORMAL, 15), null);
    clock.t += 165000; // the wristband sleeps until its next 3-minute cycle
    const result = evaluator.evaluate('TAG-1', ABNORMAL);
    assert.ok(result);
    assert.equal(result.severity, 'SUSTAINED');
    assert.match(result.reason, /2 measurement cycles/);
  });

  test('a normal cycle in between clears the verification', () => {
    const { clock, evaluator } = setup();
    assert.equal(feed(evaluator, clock, ABNORMAL, 15), null);
    clock.t += 165000;
    assert.equal(evaluator.evaluate('TAG-1', NORMAL), null);
    clock.t += 180000;
    assert.equal(evaluator.evaluate('TAG-1', ABNORMAL), null, 'counting starts again at cycle 1');
  });

  test('cycles further apart than the window are unrelated', () => {
    const { clock, evaluator } = setup();
    assert.equal(evaluator.evaluate('TAG-1', ABNORMAL), null);
    clock.t += V.moderate.cycleWindowMs + 1;
    assert.equal(evaluator.evaluate('TAG-1', ABNORMAL), null);
  });

  test('alarms when the anomaly is sustained in one continuous stream', () => {
    const { clock, evaluator } = setup();
    const out = feed(evaluator, clock, ABNORMAL, 120);
    assert.ok(out);
    assert.equal(out.result.severity, 'SUSTAINED');
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
