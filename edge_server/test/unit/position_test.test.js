// Unit tests: ward zones and the position test recorder
// (services/ips/zones.js, services/ips/position_test.js)
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildZones, zoneAt, bedFootprint } = require('../../services/ips/zones');
const { createPositionTest, memoryStore, errorStats } = require('../../services/ips/position_test');

// WARD-005 as configured on 20 Nov 2026: 2.29 x 3.39 m, door on the east wall, one bed along it
const WARD_005 = {
  ward_id: 'WARD-005', room_title: 'Standard Ward 005', length_x: 2.29, width_y: 3.39, height_z: 2.45,
  door: { wall: 'EAST', x: 2.57, y: 0, width: 0.79 },
  beds: [{ bed_id: 'B1', bed_code: 'Bed 1', x: 1.19, y: 0.0, width: 1.1, length: 2.0, rotation_deg: 180 }],
  obstacles: [
    { type: 'STORAGE', label: 'air conditional', x: 0, y: 0.47, width: 0.21, length: 0.78, height: 2.45 },
    { type: 'TABLE', label: 'table', x: 0, y: 2.68, width: 1.52, length: 0.71, height: 0.8 }
  ],
  anchors: [{ anchor_id: 'Anchor A', device_id: 'anchor-001', x: 1.89, y: 3.39, z: 2.4, calibrated_a: -58.4, calibrated_n: 3.2 }]
};

describe('ward zones', () => {
  const zones = buildZones(WARD_005);

  test('a bed rotated 90 or 270 degrees lies along x', () => {
    assert.deepEqual(bedFootprint({ x: 2.04, y: 2.31, width: 0.9, length: 2.0, rotation_deg: 90 }), { x: 2.04, y: 2.31, w: 2.0, l: 0.9 });
    assert.deepEqual(bedFootprint({ x: 1.19, y: 0, width: 1.1, length: 2.0, rotation_deg: 180 }), { x: 1.19, y: 0, w: 1.1, l: 2.0 });
  });

  test('the door zone is 1 m deep on the door wall, the bed zone 0.3 m around the bed, both inside the room', () => {
    const door = zones.zones.find(z => z.type === 'DOOR');
    assert.deepEqual(door.rect, { x: 1.29, y: 2.47, w: 1, l: 0.92 });   // clipped at the north wall
    const bed = zones.zones.find(z => z.type === 'BED');
    assert.deepEqual(bed.rect, { x: 0.89, y: 0, w: 1.4, l: 2.3 });
  });

  test('points get the door first, then a bed, then the rest of the room; far outside is OUTSIDE', () => {
    assert.equal(zoneAt(zones, 1.9, 3.0).id, 'DOOR');         // P7, door entry
    assert.equal(zoneAt(zones, 1.35, 1.0).id, 'BED:Bed 1');   // sitting on the bed edge
    assert.equal(zoneAt(zones, 0.7, 1.0).id, 'ROOM');         // P2, between the wall and the bed
    assert.equal(zoneAt(zones, 1.9, 2.25).id, 'BED:Bed 1');   // within 0.3 m of the foot end
    assert.equal(zoneAt(zones, 1.9, 2.35).id, 'ROOM');        // P6: 0.35 m from the foot end
    assert.equal(zoneAt(zones, 3.0, 3.0).id, 'OUTSIDE');
    assert.equal(zoneAt(zones, NaN, 1).id, 'UNKNOWN');
  });

  test('doors on the other walls', () => {
    const z = (wall) => buildZones({ length_x: 4, width_y: 3, door: { wall, x: 1, width: 0.9 }, beds: [] }).zones[0].rect;
    assert.deepEqual(z('SOUTH'), { x: 0.9, y: 0, w: 1.1, l: 1 });
    assert.deepEqual(z('NORTH'), { x: 0.9, y: 2, w: 1.1, l: 1 });
    assert.deepEqual(z('WEST'), { x: 0, y: 0.9, w: 1, l: 1.1 });
  });
});

describe('error statistics', () => {
  test('mean, median, 95% error, largest and the shares within 0.5, 1.0, 1.5 m', () => {
    const s = errorStats([0.2, 0.4, 0.6, 0.8, 1.0, 1.2, 1.4, 1.6, 1.8, 2.0]);
    assert.deepEqual(s, { n: 10, mean: 1.1, median: 1.1, p95: 1.91, max: 2, within_0_5: 20, within_1_0: 50, within_1_5: 70 });
    assert.equal(errorStats([]).mean, null);
    assert.equal(errorStats([NaN, null]).n, 0);
  });
});

/** A recorder with a hand-moved clock and a hand-run timer. */
function setup({ position = null } = {}) {
  let now = 1_800_000_000_000;
  let timer = null;
  const store = memoryStore();
  const state = {
    position: position || {
      x: 0.5, y: 1.0, raw_x: 0.3, raw_y: 1.0, ble_x: 0.5, ble_y: 1.0, has_ble: true, source: 'BLE',
      status: 'ONLINE', ward_id: 'WARD-005', confidence: 'HIGH', motion_state: 'STATIONARY', last_seen: now
    }
  };
  const recorder = createPositionTest({
    getPosition: (tagId) => (tagId === 'TAG-002' && state.position ? { ...state.position, last_seen: state.position.last_seen ?? now } : null),
    getAnchorReadings: () => [{ anchor_id: 'Anchor A', rssi: -63.2, raw_rssi: -61, distance: 2.35, age_ms: 100 }],
    getWardLayout: async (id) => (id === 'WARD-005' ? WARD_005 : null),
    store,
    now: () => now,
    setInterval: (fn) => { timer = fn; return 1; },
    clearInterval: () => { timer = null; }
  });
  return {
    recorder, store, state,
    // Moves the clock in 250 ms steps, running the sampler at each step
    run: (ms) => { for (let t = 0; t < ms; t += 250) { now += 250; if (state.position && state.keepFresh !== false) state.position.last_seen = now; if (timer) timer(); } },
    timerRunning: () => timer !== null
  };
}

const START = { ward_id: 'WARD-005', tag_id: 'TAG-002', x: 0.7, y: 1.0, spot: 'P2', facing: 'N', posture: 'STANDING', duration_s: 20, countdown_s: 5, session_name: 'Baseline, 3 anchors' };

describe('position test recorder', () => {
  test('a run counts down, records 4 readings a second for 20 s and is saved with its statistics', async () => {
    const t = setup();
    const started = await t.recorder.startRun(START, 'Integration Admin (ADMIN)');
    assert.equal(started.run.state, 'COUNTDOWN');
    assert.equal(started.seconds_to_start, 5);
    assert.equal(started.run.true_zone, 'ROOM');

    t.run(5000);
    assert.equal(t.recorder.getStatus().active.samples, 1, 'the first reading at the end of the countdown');
    t.run(20000);
    const status = t.recorder.getStatus();
    assert.equal(status.active, null);
    assert.equal(t.timerRunning(), false);
    const run = status.last_finished.run;
    assert.equal(run.samples.length, 81);   // 0 s to 20 s inclusive, every 0.25 s
    assert.equal(run.stats.available_pct, 100);
    assert.equal(run.stats.final.mean, 0.2);
    assert.equal(run.stats.raw.mean, 0.4);
    assert.equal(run.stats.zone_ok_pct, 100);
    assert.deepEqual(run.stats.sources, { BLE: 100 });
    assert.equal(run.stats.mean_anchors, 1);

    const sessions = t.recorder.listSessions('WARD-005');
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].name, 'Baseline, 3 anchors');
    assert.equal(sessions[0].runs, 1);
    assert.deepEqual(sessions[0].spots, [{ spot: 'P2', x: 0.7, y: 1 }]);
    const session = t.recorder.getSession(sessions[0].id);
    assert.equal(session.ward_snapshot.anchors[0].calibrated_a, -58.4, 'the anchor set-up is kept with the session');
    assert.equal(session.runs[0].samples, undefined, 'the session view leaves the readings out');
    assert.equal(session.summary.standing.final.mean, 0.2);
  });

  test('a wristband in the wrong zone, without a position or with an old one is counted', async () => {
    const t = setup();
    await t.recorder.startRun({ ...START, countdown_s: 0, duration_s: 5 });
    t.state.position.x = 1.9;                    // placed at the foot of the bed: wrong zone
    t.state.position.y = 2.2;
    t.run(1000);
    t.state.position = null;                     // no position at all
    t.run(1000);
    t.state.position = { x: 0.7, y: 1.0, ble_x: 0.7, ble_y: 1.0, source: 'BLE', status: 'ONLINE', ward_id: 'WARD-005', last_seen: 0 };
    t.state.keepFresh = false;                   // last heard long ago
    t.run(3500);
    const run = t.recorder.getStatus().last_finished.run;
    const statuses = run.samples.map(s => `${s.status}:${s.available}`);
    assert.ok(statuses.includes('NO_POSITION:false'));
    assert.ok(statuses.includes('ONLINE:false'), 'an old position is not available');
    assert.ok(run.stats.available_pct < 30);
    assert.equal(run.stats.zone_ok_pct, 0);
  });

  test('wrong input is refused with a message; only one run at a time', async () => {
    const t = setup();
    await assert.rejects(t.recorder.startRun({ ...START, ward_id: 'WARD-404' }), /Ward WARD-404 is not known/);
    await assert.rejects(t.recorder.startRun({ ...START, x: 5 }), /inside the ward/);
    await assert.rejects(t.recorder.startRun({ ...START, facing: 'NE' }), /facing must be N, E, S or W/);
    await assert.rejects(t.recorder.startRun({ ...START, duration_s: 600 }), /duration_s must be a whole number from 5 to 120/);
    await assert.rejects(t.recorder.startRun({ ...START, spot: '<b>x</b>' }), /spot must be a short name/);
    await assert.rejects(t.recorder.startRun({ ...START, tag_id: 'TAG-009' }), /has no position yet/);
    await t.recorder.startRun(START);
    await assert.rejects(t.recorder.startRun(START), /already in progress/);
    assert.equal(t.recorder.cancelRun(), true);
    assert.equal(t.recorder.getStatus().active, null);
    assert.equal(t.recorder.cancelRun(), false);
  });

  test('later runs join the session; a spoiled run can be removed; CSVs have a row per reading and per run', async () => {
    const t = setup();
    await t.recorder.startRun({ ...START, countdown_s: 0, duration_s: 5 });
    t.run(5000);
    const id = t.recorder.listSessions()[0].id;
    await t.recorder.startRun({ ...START, session_id: id, spot: 'P3', y: 1.6, facing: 'E', countdown_s: 0, duration_s: 5 });
    t.run(5000);
    await assert.rejects(t.recorder.startRun({ ...START, ward_id: 'WARD-005', session_id: 'PT-20000101-000000' }), /is not known/);

    let session = t.recorder.getSession(id);
    assert.deepEqual(session.runs.map(r => [r.number, r.spot, r.facing]), [[1, 'P2', 'N'], [2, 'P3', 'E']]);

    const samples = t.recorder.samplesCsv(id).replace(/^\uFEFF/, '').trim().split('\r\n');
    assert.equal(samples.length, 1 + 20 + 20);   // without a countdown the first reading is 0.25 s after the start
    assert.match(samples[0], /^Session,Session name,Ward,Run,Spot,Posture,Facing,True x \(m\)/);
    assert.match(samples[1], /Anchor A: -63.2 \/ -61 \/ 2.35$/);
    const summary = t.recorder.summaryCsv(id).replace(/^\uFEFF/, '').trim().split('\r\n');
    assert.equal(summary.length, 1 + 2 + 3);
    assert.match(summary[summary.length - 3], /,ALL,/);

    assert.deepEqual(t.recorder.discardRun(id, 1), { runs: 1 });
    session = t.recorder.getSession(id);
    assert.deepEqual(session.runs.map(r => r.spot), ['P3']);
    assert.throws(() => t.recorder.discardRun(id, 7), /has no run 7/);
  });
});
