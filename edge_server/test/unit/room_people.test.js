// Unit tests: patient positions from the LiDAR (Phase 10, step 5b). Finding
// people in a turn, following them, linking them to wristbands by position,
// the live service and the replay tool. Simulated turns of WARD-005.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { learnBackground } = require('../../services/room_sensor/background');
const { findPeople } = require('../../services/room_sensor/people');
const { createPeopleTracker } = require('../../services/room_sensor/people_tracker');
const { createLidarLinker, nearBed } = require('../../services/room_sensor/lidar_linker');
const { createWardPeople, mergeAcrossLidars } = require('../../services/room_sensor/ward_people');
const { createPeopleService } = require('../../services/room_sensor/people_service');
const lidarPositions = require('../../services/ips/lidar_positions');
const lidarRecord = require('../../services/ips/lidar_record');
const { replaySession } = require('../../tools/replay_lidar_runs');
const { WARD_005, simulateTurns, simulateTurn, rng } = require('./lidar_scene');

const POSE = { x: 2.11, y: 2.08, heading_deg: 270, base_height: 0.92 };
const ROOM = { length_x: WARD_005.length_x, width_y: WARD_005.width_y };
const { model: MODEL } = learnBackground(simulateTurns(WARD_005, POSE, 60, { seed: 2 }));
const BED = WARD_005.beds[0];   // x 1.19 to 2.29, y 0 to 2 (rotated 180: not turned)

const near = (a, b, m) => Math.hypot(a.x - b.x, a.y - b.y) <= m;
const turnWith = (people, seed = 5) => simulateTurn(WARD_005, POSE, { random: rng(seed), people });

describe('people in one turn', () => {
  test('the empty room shows nobody', () => {
    for (const turn of simulateTurns(WARD_005, POSE, 10, { seed: 31 })) {
      assert.deepEqual(findPeople(turn, MODEL, POSE, ROOM).people, []);
    }
  });

  test('a standing person is found at the middle of the body, not its near side', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const { people } = findPeople(turnWith([{ x: 0.9, y: 1.5, r: 0.17 }], seed), MODEL, POSE, ROOM);
      assert.equal(people.length, 1, `seed ${seed}`);
      assert.ok(near(people[0], { x: 0.9, y: 1.5 }, 0.08), JSON.stringify(people[0]));
      assert.ok(people[0].width_m > 0.2 && people[0].points >= 9);
    }
  });

  test('a thin thing (a pole, a chair back) is not a person', () => {
    const { people, others } = findPeople(turnWith([{ x: 1.0, y: 2.8, r: 0.03 }]), MODEL, POSE, ROOM);
    assert.deepEqual(people, []);
    assert.equal(others.length, 1);
  });

  test('two people apart are two; torso and arm close together are one', () => {
    const two = findPeople(turnWith([{ x: 0.8, y: 1.2, r: 0.16 }, { x: 1.0, y: 2.6, r: 0.16 }]), MODEL, POSE, ROOM).people;
    assert.equal(two.length, 2);
    const body = findPeople(turnWith([{ x: 1.0, y: 1.6, r: 0.15 }, { x: 1.05, y: 1.95, r: 0.05 }]), MODEL, POSE, ROOM).people;
    assert.equal(body.length, 1, 'the arm is joined to the body');
  });

  test('a person straight ahead of the ▲ (directions 719 and 0) is one person', () => {
    const { people } = findPeople(turnWith([{ x: 1.3, y: 2.08, r: 0.17 }]), MODEL, POSE, ROOM);
    assert.equal(people.length, 1);
    assert.ok(near(people[0], { x: 1.3, y: 2.08 }, 0.08), JSON.stringify(people[0]));
  });

  test('returns beyond the walls are not people', () => {
    const turn = simulateTurns(WARD_005, POSE, 1, { seed: 3 })[0].slice();
    // A burst of returns 5 m away towards the north: outside the 3.39 m room
    for (let i = 170; i < 190; i++) turn[i] = 5000;
    assert.deepEqual(findPeople(turn, MODEL, POSE, ROOM).people, []);
  });
});

describe('following people from turn to turn', () => {
  test('confirmed after 3 of 5 turns, smoothed, let go after 1.5 s unseen', () => {
    const tr = createPeopleTracker();
    assert.deepEqual(tr.update([{ x: 1, y: 1 }], 0), []);
    assert.deepEqual(tr.update([{ x: 1.02, y: 1 }], 100), []);
    const seen = tr.update([{ x: 1.04, y: 1 }], 200);
    assert.equal(seen.length, 1);
    assert.ok(seen[0].x > 1.0 && seen[0].x < 1.04, 'smoothed');
    assert.equal(tr.update([], 1600).length, 1, 'still followed 1.4 s after the last sighting');
    assert.equal(tr.update([], 1800).length, 0, 'let go');
  });

  test('a single stray group never shows; two people keep their identities', () => {
    const tr = createPeopleTracker();
    tr.update([{ x: 2, y: 3 }], 0);
    for (let k = 1; k < 10; k++) assert.equal(tr.update([], k * 100).length, 0);

    const two = createPeopleTracker();
    let ids = null;
    for (let k = 0; k < 20; k++) {
      const out = two.update([{ x: 0.5 + 0.05 * k, y: 1 }, { x: 1.8 - 0.05 * k, y: 2 }], k * 100);
      if (k >= 2) {
        const byY = Object.fromEntries(out.map(p => [Math.round(p.y), p.id]));
        if (!ids) ids = byY;
        assert.deepEqual(byY, ids, `turn ${k}`);
      }
    }
  });
});

describe('linking people to wristbands, by position only', () => {
  const ble = (tagId, x, y, at) => ({ tagId, x, y, at });
  // Runs the linker every 100 ms for ms milliseconds with the given people and wristbands (functions of t)
  function run(linker, from, ms, peopleAt, wristbandsAt, beds = []) {
    let out = null;
    for (let t = from; t < from + ms; t += 100) out = linker.update({ t, people: peopleAt(t), wristbands: wristbandsAt(t), beds });
    return out;
  }

  test('one person near the Bluetooth position is linked after a second, not before', () => {
    const l = createLidarLinker();
    const people = () => [{ key: 'A#1', x: 1.0, y: 1.0, first_at: 0 }];
    const bands = (t) => [ble('TAG-1', 2.2, 1.6, t)];   // 1.34 m off, as Bluetooth often is
    let out = run(l, 0, 1000, people, bands);
    assert.deepEqual(out.positions, []);
    out = run(l, 1000, 400, people, bands);
    assert.deepEqual(out.positions.map(p => [p.tagId, p.key, p.held]), [['TAG-1', 'A#1', false]]);
    assert.equal(l.linkOf('TAG-1'), 'A#1');
  });

  test('not linked when the person is beyond 2 m, or when two people are about as near', () => {
    const far = createLidarLinker();
    assert.deepEqual(run(far, 0, 3000, () => [{ key: 'A#1', x: 0.3, y: 3.0 }], (t) => [ble('TAG-1', 2.0, 1.6, t)]).positions, []);

    const two = createLidarLinker();
    const both = () => [{ key: 'A#1', x: 1.0, y: 1.0 }, { key: 'A#2', x: 1.6, y: 1.0 }];
    assert.deepEqual(run(two, 0, 3000, both, (t) => [ble('TAG-1', 1.3, 1.4, t)]).positions, [], 'ambiguous');

    const clear = createLidarLinker();
    const out = run(clear, 0, 3000, both, (t) => [ble('TAG-1', 0.9, 1.2, t)]);
    assert.deepEqual(out.positions.map(p => p.key), ['A#1'], 'clearly nearer');
  });

  test('two wristbands, two people: each the nearest, never the same person twice', () => {
    const l = createLidarLinker();
    const people = () => [{ key: 'A#1', x: 0.6, y: 0.8 }, { key: 'A#2', x: 1.8, y: 2.8 }];
    const out = run(l, 0, 3000, people, (t) => [ble('TAG-1', 0.9, 1.1, t), ble('TAG-2', 1.6, 2.4, t)]);
    assert.deepEqual(out.positions.map(p => `${p.tagId}=${p.key}`).sort(), ['TAG-1=A#1', 'TAG-2=A#2']);

    const one = createLidarLinker();
    const single = () => [{ key: 'A#1', x: 1.0, y: 1.0 }];
    const res = run(one, 0, 3000, single, (t) => [ble('TAG-1', 1.2, 1.1, t), ble('TAG-2', 1.4, 1.3, t)]);
    assert.deepEqual(res.positions.map(p => p.tagId), ['TAG-1'], 'the nearer wristband gets the person');
  });

  test('a link ends when Bluetooth stays more than 2.5 m away for 5 s', () => {
    const l = createLidarLinker();
    const people = () => [{ key: 'A#1', x: 0.4, y: 0.4 }];
    run(l, 0, 2000, people, (t) => [ble('TAG-1', 0.8, 0.8, t)]);
    // Bluetooth 3.4 m away from t = 2 s: its 5 s average passes 2.5 m after about 4 s, then 5 s more
    let out = run(l, 2000, 8000, people, (t) => [ble('TAG-1', 2.2, 3.3, t)]);
    assert.equal(l.linkOf('TAG-1'), 'A#1', 'still linked at 10 s');
    out = run(l, 10000, 2000, people, (t) => [ble('TAG-1', 2.2, 3.3, t)]);
    assert.equal(l.linkOf('TAG-1'), null, 'ended by 12 s');
    assert.deepEqual(out.positions, []);
  });

  test('lost at the bed: held as lying in bed for as long as Bluetooth stays; a person who appears there is them again', () => {
    const l = createLidarLinker();
    const sitting = { key: 'A#1', x: 1.1, y: 1.0, first_at: 0, last_at: 0 };
    const band = (t) => [ble('TAG-1', 1.5, 1.3, t)];
    run(l, 0, 2000, (t) => [{ ...sitting, last_at: t }], band, [BED]);
    // The patient lies down: the LiDAR no longer sees them; a nurse was already standing at the bed
    const nurse = { key: 'A#2', x: 0.8, y: 1.3, first_at: 500, last_at: 0 };
    let out = run(l, 2000, 60000, (t) => [{ ...nurse, last_at: t }], band, [BED]);
    const held = out.positions.find(p => p.tagId === 'TAG-1');
    assert.equal(held.held, true);
    assert.equal(held.in_bed, true);
    assert.deepEqual([held.x, held.y], [1.1, 1.0]);
    assert.equal(l.linkOf('TAG-1'), null, 'the nurse who was already there is not taken for the patient');

    // The patient sits up: a new person where they were
    out = run(l, 62000, 300, (t) => [{ ...nurse, last_at: t }, { key: 'A#3', x: 1.2, y: 1.1, first_at: 62000, last_at: t }], band, [BED]);
    assert.equal(l.linkOf('TAG-1'), 'A#3');
    assert.equal(out.positions.find(p => p.tagId === 'TAG-1').held, false);
  });

  test('lost away from a bed: held for 10 s, then Bluetooth; a held position also ends when Bluetooth leaves', () => {
    const l = createLidarLinker();
    const band = (t) => [ble('TAG-1', 0.6, 2.9, t)];
    run(l, 0, 2000, (t) => [{ key: 'A#1', x: 0.5, y: 2.5, last_at: t }], band, [BED]);
    let out = run(l, 2000, 9000, () => [], band, [BED]);
    assert.deepEqual(out.positions.map(p => [p.held, p.in_bed]), [[true, false]]);
    out = run(l, 11000, 1500, () => [], band, [BED]);
    assert.deepEqual(out.positions, []);

    const b = createLidarLinker();
    run(b, 0, 2000, (t) => [{ key: 'A#1', x: 1.1, y: 1.0, last_at: t }], (t) => [ble('TAG-1', 1.4, 1.2, t)], [BED]);
    out = run(b, 2000, 3000, () => [], (t) => [ble('TAG-1', 1.4, 1.2, t)], [BED]);
    assert.equal(out.positions[0].in_bed, true);
    out = run(b, 5000, 11000, () => [], (t) => [ble('TAG-1', 0.4, 3.3, t)], [BED]);   // Bluetooth 2.4 m away
    assert.deepEqual(out.positions, [], 'Bluetooth left the bed');
  });

  test('a wristband no longer heard in the ward loses its LiDAR position at once', () => {
    const l = createLidarLinker();
    run(l, 0, 2000, () => [{ key: 'A#1', x: 1, y: 1 }], (t) => [ble('TAG-1', 1.2, 1.2, t)]);
    const out = l.update({ t: 2000, people: [{ key: 'A#1', x: 1, y: 1 }], wristbands: [] });
    assert.deepEqual(out.ended, ['TAG-1']);
    assert.deepEqual(out.positions, []);
  });

  test('bed footprint with its margin', () => {
    assert.equal(nearBed([BED], 1.0, 1.0, 0.5), true);
    assert.equal(nearBed([BED], 0.5, 1.0, 0.5), false);
    assert.equal(nearBed([BED], 1.5, 2.4, 0.5), true);
  });
});

describe('the people of a ward', () => {
  test('a walking person is followed and linked to the wristband whose Bluetooth estimate is about 1 m off', () => {
    const wp = createWardPeople();
    const random = rng(12);
    let last = null;
    for (let k = 0; k < 40; k++) {
      const x = 0.7 + 0.02 * k;
      const turn = simulateTurn(WARD_005, POSE, { random, people: [{ x, y: 2.4, r: 0.17 }] });
      last = wp.turn({
        deviceId: 'lidar-001', distancesMm: turn, model: MODEL, pose: POSE, room: ROOM, beds: WARD_005.beds,
        t: k * 100, wristbands: [{ tagId: 'TAG-1', x: x + 0.8 + 0.3 * (random() - 0.5), y: 1.8, at: k * 100 }]
      });
    }
    assert.equal(last.people.length, 1);
    assert.equal(last.people[0].tag_id, 'TAG-1');
    assert.equal(last.positions.length, 1);
    assert.ok(near(last.positions[0], { x: 0.7 + 0.02 * 39, y: 2.4 }, 0.1), JSON.stringify(last.positions[0]));
  });

  test('two LiDARs that see the same person give one entry', () => {
    const merged = mergeAcrossLidars([
      { key: 'a#1', device_id: 'a', x: 1, y: 1, last_at: 100 },
      { key: 'b#4', device_id: 'b', x: 1.2, y: 1.1, last_at: 200 },
      { key: 'b#5', device_id: 'b', x: 2, y: 3, last_at: 200 }
    ]);
    assert.deepEqual(merged.map(p => p.key).sort(), ['b#4', 'b#5']);
  });
});

describe('the live service', () => {
  function setup({ ready = true } = {}) {
    let listener = null;
    const applied = [];
    const ended = [];
    const messages = [];
    let setup_ = ready ? { ward_id: 'WARD-005', pose: { x: 2.11, y: 2.08, heading_deg: 270 }, model: MODEL, learned_at: 1 } : null;
    const service = createPeopleService({
      setupOf: () => setup_,
      onFrame: (fn) => { listener = fn; return () => { listener = null; }; },
      getWardLayout: async () => ({ ...WARD_005 }),
      getWardBluetooth: () => [{ tagId: 'TAG-1', x: 1.4, y: 2.2, at: clock }],
      applyPosition: (tagId, pos) => applied.push({ tagId, ...pos }),
      endPosition: (tagId) => ended.push(tagId),
      broadcast: (m) => messages.push(m)
    });
    service.start();
    let clock = 1000;
    const random = rng(21);
    return {
      service, applied, ended, messages,
      setReady: (v) => { setup_ = v ? { ward_id: 'WARD-005', pose: { x: 2.11, y: 2.08, heading_deg: 270 }, model: MODEL, learned_at: 1 } : null; },
      async turns(n, people = [{ x: 0.8, y: 2.3, r: 0.17 }]) {
        for (let k = 0; k < n; k++) {
          clock += 100;
          const distancesMm = simulateTurn(WARD_005, POSE, { random, people });
          if (listener) listener({ deviceId: 'lidar-001', frame: { distancesMm }, at: clock });
          await new Promise(r => setImmediate(r));
        }
      }
    };
  }

  test('links the person, gives the IPS their position, and sends the people at most 5 times a second', async () => {
    const t = setup();
    await t.turns(25);
    assert.ok(t.applied.length > 0, 'a LiDAR position was given');
    const last = t.applied[t.applied.length - 1];
    assert.equal(last.tagId, 'TAG-1');
    assert.equal(last.wardId, 'WARD-005');
    assert.equal(last.held, false);
    assert.ok(near(last, { x: 0.8, y: 2.3 }, 0.1), JSON.stringify(last));
    const people = t.messages.filter(m => m.type === 'ROOM_PEOPLE');
    assert.ok(people.length >= 10 && people.length <= 13, `${people.length} messages in 2.5 s: at most 5 a second`);
    for (let i = 1; i < people.length; i++) {
      if (people[i].people.length === people[i - 1].people.length) assert.ok(people[i].at - people[i - 1].at >= 200);
    }
    assert.equal(people[people.length - 1].people[0].tag_id, 'TAG-1');
    assert.deepEqual(t.service.peopleOfWard('WARD-005').people.map(p => p.tag_id), ['TAG-1']);
    assert.deepEqual(t.service.peopleOfWard('WARD-999'), { ward_id: 'WARD-999', at: null, people: [] });
  });

  test('a LiDAR that can no longer be used (moved, learning): its patients go back to Bluetooth', async () => {
    const t = setup();
    await t.turns(25);
    t.setReady(false);
    await t.turns(1);
    assert.deepEqual(t.ended, ['TAG-1']);
    const lastMessage = t.messages[t.messages.length - 1];
    assert.deepEqual([lastMessage.type, lastMessage.people], ['ROOM_PEOPLE', []]);
  });

  test('without an empty room nothing happens', async () => {
    const t = setup({ ready: false });
    await t.turns(20);
    assert.deepEqual([t.applied, t.ended, t.messages], [[], [], []]);
  });
});

describe('LiDAR positions in the IPS', () => {
  test('fresh for a second after each renewal; a change of kind is reported as new', () => {
    lidarPositions.clearAll();
    assert.equal(lidarPositions.set('TAG-1', { x: 1, y: 1, wardId: 'W', key: 'a#1' }, 0), true);
    assert.equal(lidarPositions.set('TAG-1', { x: 1.1, y: 1, wardId: 'W', key: 'a#1' }, 100), false);
    assert.equal(lidarPositions.set('TAG-1', { x: 1.1, y: 1, wardId: 'W', key: 'a#1', held: true, inBed: true }, 200), true);
    assert.equal(lidarPositions.fresh('TAG-1', 1200).inBed, true);
    assert.equal(lidarPositions.fresh('TAG-1', 1201), null);
    assert.deepEqual(lidarPositions.takeStale(1300), ['TAG-1']);
    assert.equal(lidarPositions.end('TAG-1'), false);
  });
});

describe('replay of recorded runs', () => {
  test('a recorded run gives the LiDAR position at the readings, scored against the spot', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiro-replay-'));
    try {
      const startsAt = 1_800_000_000_000;
      const spot = { x: 0.8, y: 2.3 };
      const random = rng(8);
      const frames = [];
      for (let t = -3000; t <= 5000; t += 100) {
        const d = simulateTurn(WARD_005, POSE, { random, people: [{ ...spot, r: 0.17 }] });
        frames.push(lidarRecord.frameEntry(t, 'lidar-001', { sequence: 0, turnMs: 100, samples: 500, valid: 480, distancesMm: Uint16Array.from(d) }));
      }
      const track = [];
      for (let t = -3000; t <= 5000; t += 250) track.push({ t_ms: t, status: 'ONLINE', source: 'BLE', x: 1.9, y: 1.5, raw_x: 1.7, raw_y: 1.6 });
      const sensor = { ...WARD_005.room_sensors[0], background: { learned_at: 1, turns: 60, coverage_pct: 99, unsteady_pct: 0, model: MODEL } };
      fs.writeFileSync(path.join(dir, 'PT-1-run1.lidar.json.gz'), lidarRecord.pack({
        session_id: 'PT-1', run: 1, ward_id: 'WARD-005', tag_id: 'TAG-1', created_at: startsAt - 3000, starts_at: startsAt, ends_at: startsAt + 5000,
        truth: { ...spot }, sensors: [lidarRecord.sensorEntry(sensor)], frames, track
      }));
      const samples = [];
      for (let t = 250; t <= 5000; t += 250) {
        samples.push({ t_ms: t, available: true, source: 'BLE', x: 1.9, y: 1.5, error_m: 1.39, zone_ok: false });
      }
      fs.writeFileSync(path.join(dir, 'PT-1.json'), JSON.stringify({
        id: 'PT-1', name: 'replay test', ward_snapshot: { ...WARD_005 },
        runs: [{ number: 1, spot: 'P1', tag_id: 'TAG-1', true_x: spot.x, true_y: spot.y, true_zone: 'ROOM', facing: 'N', posture: 'STANDING', duration_s: 5, samples }]
      }));
      const result = replaySession('PT-1', dir);
      const all = result.summary.all;
      assert.equal(all.readings, 20);
      assert.deepEqual(all.sources, { LIDAR: 100 });
      assert.ok(all.replay.mean < 0.08, JSON.stringify(all.replay));
      assert.equal(all.shown.mean, 1.39);
      assert.ok(result.runs[0].first_link_ms < 0, 'linked during the countdown');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
