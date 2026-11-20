// Unit tests: LiDAR room sensors in their wards (Phase 10, step 5a): learning
// the empty room, the moved check, what the ward editor gets, the scan used
// for aligning. No database: placements and empty rooms are passed in.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createRoomSensorManager } = require('../../services/room_sensor/room_sensor_manager');
const { learnBackground } = require('../../services/room_sensor/background');
const { WARD_005, simulateTurns, rng, simulateTurn } = require('./lidar_scene');

const PLACEMENT = { ward_id: 'WARD-005', sensor_id: 'LiDAR 1', device_id: 'lidar-001', x: 2.11, y: 2.08, base_height: 0.92, heading_deg: 270 };
const POSE = PLACEMENT;

/** A manager with a hand-moved clock, hand-run timers and a fake LiDAR node. */
async function setup({ placements = [PLACEMENT], backgrounds = [], saveFails = false } = {}) {
  let now = 1_800_000_000_000;
  const timers = [];
  const saved = [];
  const messages = [];
  let listener = null;
  const manager = createRoomSensorManager({
    loadPlacements: async () => placements,
    loadBackgrounds: async () => backgrounds,
    saveBackground: async (record) => {
      if (saveFails) throw new Error('database down');
      saved.push(record);
    },
    onFrame: (fn) => { listener = fn; return () => { listener = null; }; },
    broadcast: (m) => messages.push(m),
    now: () => now,
    setTimer: (fn, ms) => { const t = { fn, at: now + ms }; timers.push(t); return t; },
    clearTimer: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); }
  });
  await manager.start();
  let sequence = 0;
  const send = (distances, deviceId = 'lidar-001') => {
    if (listener) listener({ mac: '10:00:00:00:00:41', deviceId, frame: { sequence: sequence++, turnMs: 100, samples: 500, valid: 480, distancesMm: Uint16Array.from(distances) }, at: now });
  };
  return {
    manager, saved, messages, send,
    // Moves the clock in 100 ms steps (a turn each, from turnsOf(step)), running timers that are due
    async advance(ms, turnsOf = null) {
      for (let t = 0; t < ms; t += 100) {
        now += 100;
        const turn = turnsOf ? turnsOf(t) : null;
        if (turn) send(turn);
        for (const timer of timers.filter(x => x.at <= now)) {
          timers.splice(timers.indexOf(timer), 1);
          await timer.fn();
        }
      }
      await new Promise(r => setImmediate(r));
    }
  };
}

const EMPTY = simulateTurns(WARD_005, POSE, 60, { seed: 2 });
const emptyTurn = (t) => EMPTY[Math.floor(t / 100) % EMPTY.length];

describe('learning the empty room', () => {
  test('counts down, records the turns, stores the model and reports it', async () => {
    const t = await setup();
    t.send(EMPTY[0]);
    const started = t.manager.startLearning({ wardId: 'WARD-005', deviceId: 'lidar-001', countdownS: 3, durationS: 5, learnedBy: 'Admin (A-1)' });
    assert.equal(started.state, 'COUNTDOWN');
    assert.equal(started.seconds_to_start, 3);

    await t.advance(2000, emptyTurn);
    assert.equal(t.manager.learningStatus('lidar-001').turns, 0, 'nothing is kept during the countdown');
    await t.advance(2000, emptyTurn);
    const mid = t.manager.learningStatus('lidar-001');
    assert.equal(mid.state, 'RECORDING');
    assert.ok(mid.turns >= 9 && mid.turns <= 11, `turns ${mid.turns}`);

    await t.advance(4500, emptyTurn);
    const done = t.manager.learningStatus('lidar-001');
    assert.equal(done.state, 'DONE', done.error);
    assert.equal(done.turns, 50);
    assert.equal(done.result.coverage_pct > 95, true);
    assert.deepEqual(done.result.warnings, []);
    assert.equal(t.saved.length, 1);
    assert.equal(t.saved[0].learned_by, 'Admin (A-1)');
    assert.equal(t.saved[0].model.turns, 50);
    assert.ok(t.messages.some(m => m.type === 'ROOM_SENSOR_BACKGROUND' && m.device_id === 'lidar-001'));

    const bg = t.manager.getBackground('WARD-005', 'lidar-001');
    assert.equal(bg.turns, 50);
    assert.equal(t.manager.getBackground('WARD-001', 'lidar-001'), null, 'kept for this ward only');
    assert.equal(t.manager.scanForAlignment('WARD-005', 'lidar-001').source, 'EMPTY_ROOM');
  });

  test('too few turns: nothing is saved and the reason is given', async () => {
    const t = await setup();
    t.send(EMPTY[0]);
    t.manager.startLearning({ wardId: 'WARD-005', deviceId: 'lidar-001', countdownS: 0, durationS: 5 });
    await t.advance(6000, (ms) => (ms % 1000 === 0 ? EMPTY[0] : null));   // one turn a second only
    const status = t.manager.learningStatus('lidar-001');
    assert.equal(status.state, 'FAILED');
    assert.match(status.error, /Only \d turns arrived in 5 s \(about 50 expected\): is the LiDAR scanning\? Nothing was saved\./);
    assert.equal(t.saved.length, 0);
  });

  test('a database error is reported, not thrown away', async () => {
    const t = await setup({ saveFails: true });
    t.send(EMPTY[0]);
    t.manager.startLearning({ wardId: 'WARD-005', deviceId: 'lidar-001', countdownS: 0, durationS: 5 });
    await t.advance(6000, emptyTurn);
    const status = t.manager.learningStatus('lidar-001');
    assert.equal(status.state, 'FAILED');
    assert.match(status.error, /could not be saved \(database down\)/);
    assert.equal(t.manager.getBackground('WARD-005', 'lidar-001'), null);
  });

  test('refused: not in the saved ward, not scanning, already learning, bad durations; cancel', async () => {
    const t = await setup();
    assert.throws(() => t.manager.startLearning({ wardId: 'WARD-001', deviceId: 'lidar-001' }), /not in the saved setup of WARD-001/);
    assert.throws(() => t.manager.startLearning({ wardId: 'WARD-005', deviceId: 'lidar-001' }), /is not sending turns/);
    t.send(EMPTY[0]);
    assert.throws(() => t.manager.startLearning({ wardId: 'WARD-005', deviceId: 'lidar-001', durationS: 2 }), /duration_s must be a whole number from 5 to 60/);
    assert.throws(() => t.manager.startLearning({ wardId: 'WARD-005', deviceId: 'lidar-001', countdownS: 'soon' }), /countdown_s/);
    t.manager.startLearning({ wardId: 'WARD-005', deviceId: 'lidar-001' });
    assert.throws(() => t.manager.startLearning({ wardId: 'WARD-005', deviceId: 'lidar-001' }), /already being learned/);
    assert.equal(t.manager.cancelLearning('lidar-001'), true);
    assert.equal(t.manager.learningStatus('lidar-001'), null);
    assert.equal(t.manager.cancelLearning('lidar-001'), false);
    await t.advance(40000, emptyTurn);
    assert.equal(t.saved.length, 0, 'a cancelled learning saves nothing when its time would have ended');
  });
});

describe('the moved check and the ward editor view', () => {
  const { model } = learnBackground(EMPTY);
  const stored = [{ ward_id: 'WARD-005', device_id: 'lidar-001', learned_at: 1_700_000_000_000, learned_by: null, model }];

  test('a person in the room is new in the scan but never "moved"; a turned LiDAR is, until it is back', async () => {
    const t = await setup({ backgrounds: stored });
    const random = rng(4);
    const withPerson = Array.from({ length: 20 }, () => simulateTurn(WARD_005, POSE, { random, people: [{ x: 1.0, y: 2.3, r: 0.18 }] }));
    await t.advance(6000, (ms) => withPerson[(ms / 100) % 20]);
    let view = t.manager.getScanView('WARD-005', 'lidar-001');
    assert.equal(view.placed_in_ward, true);
    assert.equal(view.background.turns, 60);
    assert.ok(view.scan.foreground_bins.length >= 10, 'the person is new in the room');
    assert.equal(view.scan.distances_mm.length, 720);
    assert.equal(view.moved.suspected, false);

    const turned = simulateTurns(WARD_005, { ...POSE, heading_deg: 255 }, 20, { seed: 9 });   // knocked 15 degrees
    await t.advance(6000, (ms) => turned[(ms / 100) % 20]);
    view = t.manager.getScanView('WARD-005', 'lidar-001');
    assert.equal(view.moved.suspected, true, `farther ${view.moved.farther_pct}%`);
    assert.ok(t.messages.some(m => m.type === 'ROOM_SENSOR_MOVED' && m.suspected === true));

    await t.advance(8000, emptyTurn);
    assert.equal(t.manager.getScanView('WARD-005', 'lidar-001').moved.suspected, false, 'back in place');
  });

  test('without an empty room: no new-in-room directions, no moved check; the live median is used to align', async () => {
    const t = await setup();
    assert.equal(t.manager.scanForAlignment('WARD-005', 'lidar-001'), null, 'nothing heard yet');
    await t.advance(1500, emptyTurn);
    const view = t.manager.getScanView('WARD-005', 'lidar-001');
    assert.equal(view.background, null);
    assert.equal(view.moved, null);
    assert.equal(view.scan.foreground_bins, null);
    const scan = t.manager.scanForAlignment('WARD-005', 'lidar-001');
    assert.equal(scan.source, 'LIVE');
    assert.equal(scan.turns, 15);
    assert.ok(scan.distancesMm.filter(d => d > 0).length > 600);
  });

  test('a node in another ward, or not placed, gets no view of this ward\'s empty room', async () => {
    const t = await setup({ backgrounds: stored, placements: [{ ...PLACEMENT, ward_id: 'WARD-001' }] });
    await t.advance(500, emptyTurn);
    const view = t.manager.getScanView('WARD-005', 'lidar-001');
    assert.equal(view.placed_in_ward, false);
    assert.equal(view.moved, null);
    assert.deepEqual(t.manager.sensorsOfWard('WARD-005'), []);
    assert.equal(t.manager.sensorsOfWard('WARD-001').length, 1);
    assert.equal(t.manager.sensorsOfWard('WARD-001')[0].background, null);
  });
});
