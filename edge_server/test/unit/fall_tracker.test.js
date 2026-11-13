// Unit tests: one fall creates one incident, however many packets report it
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const thresholds = require('../../config/clinical_thresholds');
const { createFallTracker } = require('../../services/alerts/fall_tracker');

function setup() {
  const clock = { t: 5_000_000 };
  const tracker = createFallTracker({ now: () => clock.t });
  return { clock, tracker };
}

describe('fall de-duplication', () => {
  test('the first packet of a fall is new, every repeat is not', () => {
    const { clock, tracker } = setup();
    assert.equal(tracker.observe('WB-1', 7).isNew, true);
    // 45 seconds of repeats from three anchors at about 5 Hz
    for (let i = 0; i < 45 * 15; i++) {
      clock.t += 67;
      assert.equal(tracker.observe('WB-1', 7).isNew, false);
    }
  });

  test('three anchors reporting in the same instant give exactly one new fall', () => {
    const { tracker } = setup();
    const results = [tracker.observe('WB-1', 7), tracker.observe('WB-1', 7), tracker.observe('WB-1', 7)];
    assert.equal(results.filter(r => r.isNew).length, 1);
    assert.equal(results[1].session, results[0].session, 'repeats refer to the same session');
  });

  test('a new fall counter is a new fall, even shortly after the previous one', () => {
    const { clock, tracker } = setup();
    assert.equal(tracker.observe('WB-1', 7).isNew, true);
    clock.t += 50000;
    assert.equal(tracker.observe('WB-1', 8).isNew, true);
    assert.equal(tracker.observe('WB-1', 8).isNew, false);
  });

  test('the counter wrapping from 255 to 0 is a new fall', () => {
    const { clock, tracker } = setup();
    assert.equal(tracker.observe('WB-1', 255).isNew, true);
    clock.t += 50000;
    assert.equal(tracker.observe('WB-1', 0).isNew, true);
  });

  test('different wristbands are independent', () => {
    const { tracker } = setup();
    assert.equal(tracker.observe('WB-1', 7).isNew, true);
    assert.equal(tracker.observe('WB-2', 7).isNew, true);
  });

  test('the same counter after the session lifetime is a new fall (wristband restarted)', () => {
    const { clock, tracker } = setup();
    assert.equal(tracker.observe('WB-1', 7).isNew, true);
    clock.t += thresholds.fall.sessionTtlMs + 1;
    assert.equal(tracker.observe('WB-1', 7).isNew, true);
  });

  test('a short radio gap inside the session lifetime does not duplicate the fall', () => {
    const { clock, tracker } = setup();
    assert.equal(tracker.observe('WB-1', 7).isNew, true);
    clock.t += 30000; // out of range for 30 s, still inside the 45 s repeat window
    assert.equal(tracker.observe('WB-1', 7).isNew, false);
  });
});

describe('old firmware without a fall counter', () => {
  test('repeats are one fall while packets keep arriving', () => {
    const { clock, tracker } = setup();
    assert.equal(tracker.observe('WB-1', null).isNew, true);
    for (let i = 0; i < 100; i++) {
      clock.t += 200;
      assert.equal(tracker.observe('WB-1', null).isNew, false);
    }
  });

  test('mixed anchors (one with, one without the counter) still give one fall', () => {
    const { tracker } = setup();
    assert.equal(tracker.observe('WB-1', null).isNew, true);
    assert.equal(tracker.observe('WB-1', 7).isNew, false);
    assert.equal(tracker.observe('WB-1', 7).isNew, false);
  });
});

describe('session bookkeeping', () => {
  test('acknowledging finds the session by incident ID and keeps it open', () => {
    const { tracker } = setup();
    const { session } = tracker.observe('WB-1', 7);
    session.incidentId = 'INC-20261113-0001';
    assert.equal(tracker.markAcknowledged('INC-20261113-0001'), true);
    assert.equal(tracker.markAcknowledged('INC-20261113-9999'), false);
    assert.equal(tracker.observe('WB-1', 7).isNew, false, 'an acknowledged fall is not raised again');
  });

  test('sweep removes only expired sessions', () => {
    const { clock, tracker } = setup();
    tracker.observe('WB-1', 1);
    clock.t += thresholds.fall.sessionTtlMs - 1000;
    tracker.observe('WB-2', 1);
    clock.t += 2000;
    assert.equal(tracker.sweep(), 1);
    assert.equal(tracker.size(), 1);
  });
});
