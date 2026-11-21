// Unit tests: the door of a ward with a LiDAR (Phase 10). A patient who leaves
// through the door, or stands at it for 10 s, raises a geofence alert of that kind.
require('./no_database');

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createLidarLinker, inDoorZone } = require('../../services/room_sensor/lidar_linker');
const { createDoorWatch } = require('../../services/room_sensor/door_watch');
const { createPeopleService } = require('../../services/room_sensor/people_service');
const { createGeofenceAlerts } = require('../../services/alerts/geofence_alerts');
const { buildAlertMessage } = require('../../services/alert_service');
const { COLUMNS } = require('../../services/alerts/incident_csv');
const { attentionReasons } = require('../../services/reports/shift_rules');
const { buildZones } = require('../../services/ips/zones');
const { learnBackground } = require('../../services/room_sensor/background');
const { WARD_005, simulateTurns, simulateTurn, rng } = require('./lidar_scene');

// WARD-005: door on the east wall at y 2.57 to 3.36; its zone x 1.29 to 2.29, y 2.47 to 3.39
const DOOR = buildZones(WARD_005).zones.find(z => z.type === 'DOOR').rect;
const BED = WARD_005.beds[0];   // x 1.19 to 2.29, y 0 to 2
const AT_DOOR = { x: 1.9, y: 3.0 };
const MIDDLE = { x: 0.7, y: 1.6 };

const ble = (tagId, x, y, at) => ({ tagId, x, y, at });
const band = (x = 1.6, y = 2.4) => (t) => [ble('TAG-1', x, y, t)];

// Runs the linker every 100 ms for ms milliseconds; collects exits and returns
function run(linker, from, ms, peopleAt, wristbandsAt, { door = DOOR, beds = [BED] } = {}) {
  const all = { exits: [], returns: [], out: null };
  for (let t = from; t < from + ms; t += 100) {
    const out = linker.update({ t, people: peopleAt(t), wristbands: wristbandsAt(t), beds, door });
    all.exits.push(...out.exits.map(e => ({ ...e, t })));
    all.returns.push(...out.returns);
    all.out = out;
  }
  return all;
}

// The patient is linked at point for 2 s (from t = 0), then the LiDAR no longer sees them
const standAt = (point) => (t) => [{ key: 'A#1', ...point, first_at: 0, first_x: point.x, first_y: point.y, last_at: t }];

describe('the door zone', () => {
  test('WARD-005: 1 m into the room, the door plus 0.1 m on each side', () => {
    assert.deepEqual(DOOR, { x: 1.29, y: 2.47, w: 1, l: 0.92 });
    assert.equal(inDoorZone(DOOR, 1.9, 3.0), true);
    assert.equal(inDoorZone(DOOR, 1.2, 3.0), false);
    assert.equal(inDoorZone(DOOR, 1.2, 3.0, 0.5), true, 'with a margin');
    assert.equal(inDoorZone(null, 1.9, 3.0), false, 'no door, no zone');
  });
});

describe('leaving through the door (LiDAR linker)', () => {
  test('lost at the door and not seen again for 10 s: one exit, where last seen', () => {
    const l = createLidarLinker();
    run(l, 0, 2000, standAt(AT_DOOR), band());
    let r = run(l, 2000, 9800, () => [], band());
    assert.deepEqual(r.exits, [], 'not before 10 s');
    r = run(l, 11800, 500, () => [], band());
    assert.equal(r.exits.length, 1);
    assert.deepEqual([r.exits[0].tagId, r.exits[0].x, r.exits[0].y], ['TAG-1', 1.9, 3.0]);
    assert.ok(r.exits[0].t - r.exits[0].lastSeenAt >= 10000);
    assert.ok(l.leftAt('TAG-1') !== null);
    assert.deepEqual(r.out.positions, [], 'back to Bluetooth');
    r = run(l, 12300, 30000, () => [], band());
    assert.deepEqual(r.exits, [], 'only once');
  });

  test('lost in the middle of the room: held for 10 s, then Bluetooth, no exit', () => {
    const l = createLidarLinker();
    run(l, 0, 2000, standAt(MIDDLE), band(0.9, 1.7));
    const r = run(l, 2000, 15000, () => [], band(0.9, 1.7));
    assert.deepEqual(r.exits, []);
    assert.equal(l.leftAt('TAG-1'), null);
  });

  test('at the door and back within 10 s: the same patient again, no exit', () => {
    const l = createLidarLinker();
    run(l, 0, 2000, standAt(AT_DOOR), band());
    run(l, 2000, 5000, () => [], band());
    const back = (t) => [{ key: 'A#2', x: 1.8, y: 2.8, first_at: 7000, first_x: 1.8, first_y: 2.8, last_at: t }];
    const r = run(l, 7000, 10000, back, band());
    assert.deepEqual(r.exits, []);
    assert.equal(l.linkOf('TAG-1'), 'A#2');
  });

  test('lost at the door next to a bed: the door comes first, so not held as lying in bed', () => {
    const l = createLidarLinker();
    const corner = { x: 1.5, y: 2.48 };   // in the door zone and within 0.5 m of the bed
    run(l, 0, 2000, standAt(corner), band());
    let r = run(l, 2000, 3000, () => [], band());
    assert.deepEqual(r.out.positions.map(p => [p.held, p.in_bed]), [[true, false]]);
    r = run(l, 5000, 8000, () => [], band());
    assert.equal(r.exits.length, 1);
  });

  test('held at the door and the wristband is no longer heard: an exit at once', () => {
    const l = createLidarLinker();
    run(l, 0, 2000, standAt(AT_DOOR), band());
    run(l, 2000, 1000, () => [], band());
    const out = l.update({ t: 3000, people: [], wristbands: [], beds: [BED], door: DOOR });
    assert.deepEqual(out.exits.map(e => e.tagId), ['TAG-1']);
    assert.deepEqual(out.ended, ['TAG-1']);
  });

  test('without a door nobody leaves', () => {
    const l = createLidarLinker();
    run(l, 0, 2000, standAt(AT_DOOR), band(), { door: null });
    const r = run(l, 2000, 15000, () => [], band(), { door: null });
    assert.deepEqual(r.exits, []);
  });

  test('after leaving: not linked to someone already in the room, but to a person who comes in through the door', () => {
    const l = createLidarLinker();
    run(l, 0, 2000, standAt(AT_DOOR), band());
    run(l, 2000, 10500, () => [], band());
    const left = l.leftAt('TAG-1');
    assert.ok(left !== null);
    // A nurse who was in the room all along, right at the Bluetooth position
    const nurse = { key: 'A#5', x: 1.5, y: 2.3, first_at: 500, first_x: 0.6, first_y: 1.0 };
    let r = run(l, 12500, 5000, (t) => [{ ...nurse, last_at: t }], band());
    assert.equal(l.linkOf('TAG-1'), null, 'the nurse is not the patient');
    // A visitor who came in through the door after the exit, but stays at the far wall
    // only counts when first seen at the door; the patient walks in
    const patient = (t) => [{ ...nurse, last_at: t }, { key: 'A#6', x: 1.7, y: 2.6, first_at: 17500, first_x: 2.0, first_y: 3.1, last_at: t }];
    r = run(l, 17500, 3000, patient, band(1.7, 2.6));
    assert.equal(l.linkOf('TAG-1'), 'A#6');
    assert.deepEqual(r.returns, ['TAG-1']);
    assert.equal(l.leftAt('TAG-1'), null);
  });

  test('after leaving: someone first seen away from the door is not the patient coming back', () => {
    const l = createLidarLinker();
    run(l, 0, 2000, standAt(AT_DOOR), band());
    run(l, 2000, 10500, () => [], band());
    const r = run(l, 12500, 5000, (t) => [{ key: 'A#7', x: 0.6, y: 1.2, first_at: 13000, first_x: 0.6, first_y: 1.2, last_at: t }], band(0.8, 1.4));
    assert.equal(l.linkOf('TAG-1'), null);
    assert.deepEqual(r.returns, []);
  });
});

describe('standing at the door (door watch)', () => {
  const seenAt = (point, held = false) => [{ tagId: 'TAG-1', ...point, held }];
  function watch(w, from, ms, positionsAt, door = DOOR) {
    const events = [];
    for (let t = from; t < from + ms; t += 100) events.push(...w.update({ t, positions: positionsAt(t), door }).map(e => ({ ...e, t })));
    return events;
  }

  test('seen in the door zone for 10 s: one event, not before, not again while they stay', () => {
    const w = createDoorWatch();
    assert.deepEqual(watch(w, 0, 9900, () => seenAt(AT_DOOR)), []);
    const at10 = watch(w, 9900, 200, () => seenAt(AT_DOOR));
    assert.equal(at10.length, 1);
    assert.deepEqual([at10[0].tagId, at10[0].since, at10[0].t], ['TAG-1', 0, 10000]);
    assert.deepEqual(watch(w, 10100, 30000, () => seenAt(AT_DOOR)), []);
  });

  test('walking through the door zone, or a short step out of it, does not count; 3 s outside ends the visit', () => {
    const w = createDoorWatch();
    assert.deepEqual(watch(w, 0, 3000, () => seenAt(AT_DOOR)), [], 'passing through');
    watch(w, 3000, 2000, () => seenAt(MIDDLE));          // 2 s outside: still the same visit
    const events = watch(w, 5000, 5100, () => seenAt(AT_DOOR));
    assert.equal(events.length, 1, 'the 2 s outside did not restart the 10 s');
    assert.equal(events[0].t, 10000);

    const v = createDoorWatch();
    watch(v, 0, 6000, () => seenAt(AT_DOOR));
    watch(v, 6000, 3500, () => seenAt(MIDDLE));            // 3.5 s outside: the visit is over
    assert.deepEqual(watch(v, 9500, 9000, () => seenAt(AT_DOOR)), [], 'a new visit starts from 0');
  });

  test('at most one event a minute per patient', () => {
    const w = createDoorWatch();
    assert.equal(watch(w, 0, 10100, () => seenAt(AT_DOOR)).length, 1);
    watch(w, 10100, 5000, () => seenAt(MIDDLE));
    assert.deepEqual(watch(w, 15100, 20000, () => seenAt(AT_DOOR)), [], 'back at the door within the minute');
    watch(w, 35100, 5000, () => seenAt(MIDDLE));
    const later = watch(w, 40100, 31000, () => seenAt(AT_DOOR));
    assert.deepEqual(later.map(e => e.t), [70000], 'once the minute since the first is over');
  });

  test('a held position (the LiDAR lost them) does not count, and nothing happens without a door', () => {
    const w = createDoorWatch();
    assert.deepEqual(watch(w, 0, 15000, () => seenAt(AT_DOOR, true)), []);
    assert.deepEqual(watch(createDoorWatch(), 0, 15000, () => seenAt(AT_DOOR), null), []);
  });
});

describe('the live service reports the door events', () => {
  const POSE = { x: 2.11, y: 2.08, heading_deg: 270, base_height: 0.92 };
  const { model: MODEL } = learnBackground(simulateTurns(WARD_005, POSE, 60, { seed: 2 }));

  test('a patient at the door for 10 s, then gone for 10 s: AT_DOOR, then LEFT_WARD', async () => {
    let listener = null;
    let clock = 1000;
    const events = [];
    const service = createPeopleService({
      setupOf: () => ({ ward_id: 'WARD-005', pose: POSE, model: MODEL, learned_at: 1 }),
      onFrame: (fn) => { listener = fn; return () => { listener = null; }; },
      getWardLayout: async () => ({ ...WARD_005 }),
      getWardBluetooth: () => [{ tagId: 'TAG-1', x: 1.6, y: 2.6, at: clock }],
      applyPosition: () => true,
      endPosition: () => {},
      onGeofence: (e) => events.push(e)
    });
    service.start();
    const random = rng(7);
    const turns = async (n, people) => {
      for (let k = 0; k < n; k++) {
        clock += 100;
        listener({ deviceId: 'lidar-001', frame: { distancesMm: simulateTurn(WARD_005, POSE, { random, people }) }, at: clock });
        await new Promise(r => setImmediate(r));
      }
    };
    await turns(125, [{ x: 1.75, y: 2.85, r: 0.17 }]);
    assert.deepEqual(events.map(e => e.kind), ['AT_DOOR']);
    assert.equal(events[0].tagId, 'TAG-1');
    assert.equal(events[0].wardId, 'WARD-005');
    assert.ok(events[0].seconds >= 10 && events[0].seconds <= 11);
    assert.deepEqual(events[0].door, DOOR);
    // The tracker keeps a person 1.5 s after the last sighting; the 10 s hold starts then
    await turns(110, []);
    assert.deepEqual(events.map(e => e.kind), ['AT_DOOR'], 'not yet 11 s after the last sighting');
    await turns(20, []);
    assert.deepEqual(events.map(e => e.kind), ['AT_DOOR', 'LEFT_WARD']);
    assert.ok(Math.abs(events[1].x - 1.75) < 0.15 && Math.abs(events[1].y - 2.85) < 0.15, JSON.stringify(events[1]));
    assert.ok(events[1].seconds >= 11 && events[1].seconds <= 12, `${events[1].seconds} s`);
    service.stop();
  });
});

describe('from a door event to an alert', () => {
  function setup({ position = null, binding = { patient_id: 'P-001', device_id: 'TAG-1', mac_address: 'AA:BB:CC:00:00:01' } } = {}) {
    const recorded = [];
    const alerts = createGeofenceAlerts({
      getPosition: () => position,
      findActiveBinding: async () => binding,
      recordIncident: async (data) => { recorded.push(data); return { incident_id: 'INC-1', ...data }; },
      log: { info: () => {} }
    });
    return { alerts, recorded };
  }
  const event = (kind) => ({ kind, tagId: 'TAG-1', wardId: 'WARD-005', x: 1.9, y: 3.0, seconds: 10, door: DOOR });

  test('a bound wristband: one GEOFENCE_BREACH incident with its kind, place and time', async () => {
    const { alerts, recorded } = setup({ position: { source: 'LIDAR', ward_id: 'WARD-005', x: 1.9, y: 3.0, tag_mac: 'AA:BB:CC:00:00:01' } });
    const incident = await alerts.raise(event('LEFT_WARD'));
    assert.equal(incident.incident_id, 'INC-1');
    assert.deepEqual(recorded, [{
      incident_category: 'GEOFENCE_BREACH', geofence_kind: 'LEFT_WARD', geofence_seconds: 10,
      device_id: 'TAG-1', wristband_mac: 'AA:BB:CC:00:00:01', ward_id: 'WARD-005', pos_x: 1.9, pos_y: 3.0
    }]);
    await alerts.raise(event('AT_DOOR'));
    assert.equal(recorded[1].geofence_kind, 'AT_DOOR');
  });

  test('a wristband bound to nobody: no alert', async () => {
    const { alerts, recorded } = setup({ binding: null });
    assert.equal(await alerts.raise(event('LEFT_WARD')), null);
    assert.deepEqual(recorded, []);
  });

  test('a headset that sees the patient comes first', async () => {
    const inRoom = setup({ position: { source: 'HEADSET', ward_id: 'WARD-005', x: 0.8, y: 1.5 } });
    assert.equal(await inRoom.alerts.raise(event('LEFT_WARD')), null, 'seen in the room: has not left');
    assert.equal(await inRoom.alerts.raise(event('AT_DOOR')), null, 'seen away from the door');

    const atDoor = setup({ position: { source: 'HEADSET', ward_id: 'WARD-005', x: 1.8, y: 2.9 } });
    assert.equal(await atDoor.alerts.raise(event('LEFT_WARD')), null, 'seen at the door: has not left');
    assert.ok(await atDoor.alerts.raise(event('AT_DOOR')), 'seen at the door: at the door');

    const otherWard = setup({ position: { source: 'HEADSET', ward_id: 'WARD-004', x: 0.8, y: 1.5 } });
    assert.ok(await otherWard.alerts.raise(event('LEFT_WARD')), 'a headset in another ward says nothing about this one');
  });

  test('an unknown kind is ignored', async () => {
    const { alerts, recorded } = setup();
    assert.equal(await alerts.raise(event('OUTSIDE')), null);
    assert.deepEqual(recorded, []);
  });
});

describe('what the alert says', () => {
  const where = { wardId: 'WARD-005', bedId: 'BED-005-01', posX: 1.9, posY: 3.0, impactG: null, stillness: null, freefallMinG: null, bpm: null, spo2: null };

  test('alert text for each kind', () => {
    assert.equal(buildAlertMessage('GEOFENCE_BREACH', { ...where, geofenceKind: 'LEFT_WARD', seconds: 10 }),
      'LEFT THE WARD: last seen at the door, not seen in the room for 10 s; WARD-005, BED-005-01, position (1.9 m, 3 m).');
    assert.equal(buildAlertMessage('GEOFENCE_BREACH', { ...where, geofenceKind: 'AT_DOOR', seconds: 11 }),
      'AT THE DOOR: standing at the door for 11 s, may be about to leave; WARD-005, BED-005-01, position (1.9 m, 3 m).');
    assert.equal(buildAlertMessage('GEOFENCE_BREACH', where),
      'GEOFENCE: patient at the door or outside the ward; WARD-005, BED-005-01, position (1.9 m, 3 m).');
  });

  test('CSV type and shift report reason for each kind', () => {
    const type = COLUMNS.find(c => c[0] === 'Type')[1];
    assert.equal(type({ incident_category: 'GEOFENCE_BREACH', geofence_kind: 'AT_DOOR' }), 'At the door');
    assert.equal(type({ incident_category: 'GEOFENCE_BREACH', geofence_kind: 'LEFT_WARD' }), 'Left the ward');
    assert.equal(type({ incident_category: 'GEOFENCE_BREACH', geofence_kind: null }), 'Left the ward');
    assert.equal(type({ incident_category: 'FALL_ACCIDENT' }), 'Fall');

    const v = require('../../config/clinical_thresholds').vitals;
    const at = (ts) => ts;
    assert.deepEqual(attentionReasons({ incidents: [
      { incident_category: 'GEOFENCE_BREACH', geofence_kind: 'AT_DOOR', trigger_timestamp: '11:30', resolution_status: 'RESOLVED' },
      { incident_category: 'GEOFENCE_BREACH', geofence_kind: 'LEFT_WARD', trigger_timestamp: '11:31', resolution_status: 'RESOLVED' }
    ] }, v, at), ['at the door at 11:30', 'left the ward at 11:31']);
  });
});
