// Unit tests: the placement planner for anchors and the LiDAR (Phase 10).
require('./no_database');

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  planPlacement, PlacementError, mountingHeight, anchorCandidates, mountingSurfaces, clearLine, compassName, DEFAULTS
} = require('../../services/ips/placement');
const { WARD_TEMPLATES } = require('../../services/ward_service');

/** WARD-005 as stored on 20 Nov 2026 (the baseline test's ward). */
function ward005(changes = {}) {
  return {
    ward_id: 'WARD-005',
    length_x: 2.29, width_y: 3.39, height_z: 2.45,
    door: { wall: 'EAST', x: 2.57, y: 0, width: 0.79 },
    beds: [{ bed_id: 'BED-005-01', bed_code: 'Bed 1', x: 1.19, y: 0, width: 1.1, length: 2, rotation_deg: 180, status: 'AVAILABLE' }],
    obstacles: [
      { id: 'OBS-WARD-005-1', type: 'STORAGE', label: 'air conditioner', x: 0, y: 0.47, width: 0.21, length: 0.78, height: 2.45 },
      { id: 'OBS-WARD-005-2', type: 'TABLE', label: 'table', x: 0, y: 2.68, width: 1.52, length: 0.71, height: 0.8 }
    ],
    anchors: [
      { anchor_id: 'Anchor A', device_id: 'anchor-001', x: 1.89, y: 3.39, z: 2.4 },
      { anchor_id: 'Anchor B', device_id: 'anchor-002', x: 2.29, y: 0.4, z: 2.4 },
      { anchor_id: 'Anchor C', device_id: 'anchor-003', x: 0, y: 2.13, z: 2.4 }
    ],
    ...changes
  };
}

function template(id) {
  const t = WARD_TEMPLATES[id];
  return { ...t.dimensions, door: t.door, beds: t.beds, obstacles: t.obstacles, anchors: t.anchors };
}

const onWall = (a, L, W) => Math.abs(a.x) < 1e-6 || Math.abs(a.y) < 1e-6 || Math.abs(a.x - L) < 1e-6 || Math.abs(a.y - W) < 1e-6;

describe('mounting height', () => {
  test('2.40 m, or 15 cm below a lower ceiling, never above 3.0 m', () => {
    assert.equal(mountingHeight(3.2), 2.4);
    assert.equal(mountingHeight(2.45), 2.3);
    assert.equal(mountingHeight(2.6), 2.4);
  });

  test('a chosen height is kept below the ceiling and at most 3.0 m', () => {
    assert.equal(mountingHeight(2.6, 2.9), 2.55);
    assert.equal(mountingHeight(4.0, 3.5), 3.0);
    assert.equal(mountingHeight(3.0, 2.2), 2.2);
  });
});

describe('candidate spots for anchors', () => {
  const obstacles = (list) => list.map(o => ({ id: o.id, type: o.type, label: o.label, x: o.x, y: o.y, w: o.width, l: o.length, h: o.height }));

  test('along every wall, away from corners and the door', () => {
    const layout = { door: { wall: 'SOUTH', x: 1.0, width: 0.9 } };
    const c = anchorCandidates(4, 3, layout, [], 2.4, 0.1);
    assert.ok(c.length > 0);
    for (const s of c) {
      const along = s.along;
      assert.ok(along >= DEFAULTS.cornerGap - 1e-9 && along <= s.length - DEFAULTS.cornerGap + 1e-9, `${s.surface.id} ${along}`);
      if (s.surface.id === 'SOUTH') assert.ok(along < 0.8 - 1e-9 || along > 2.1 + 1e-9, `next to the door: ${along}`);
    }
    assert.deepEqual([...new Set(c.map(s => s.surface.id))].sort(), ['EAST', 'NORTH', 'SOUTH', 'WEST']);
  });

  test('not behind a tall cupboard against the wall, but above a table', () => {
    const list = obstacles([
      { id: 'cup', type: 'CUPBOARD', label: 'cupboard', x: 1.0, y: 2.4, width: 1.0, length: 0.6, height: 2.2 },
      { id: 'tab', type: 'TABLE', label: 'table', x: 2.5, y: 2.3, width: 1.0, length: 0.7, height: 0.8 }
    ]);
    const north = anchorCandidates(4, 3, {}, list, 2.3, 0.1).filter(s => s.surface.id === 'NORTH').map(s => s.x);
    assert.ok(!north.some(x => x > 1.0 && x < 2.0), 'behind the cupboard');
    assert.ok(north.some(x => x > 2.5 && x < 3.5), 'above the table');
  });

  test('the outer faces of a bathroom are mounting surfaces, facing away from it', () => {
    const list = obstacles(template('L_SHAPED').obstacles.map(o => ({ ...o, height: 2.6 })));
    const faces = mountingSurfaces(6.4, 4.8, list, 2.4).filter(s => s.mountedOn);
    const east = faces.find(f => f.id.endsWith(':east'));
    const south = faces.find(f => f.id.endsWith(':south'));
    assert.ok(east && south, 'east and south faces of the bathroom');
    assert.equal(east.facing, 90);
    assert.equal(south.facing, 180);
    assert.ok(!faces.some(f => f.id.endsWith(':west') || f.id.endsWith(':north')), 'faces against the room walls are not surfaces');
  });
});

describe('line of sight', () => {
  const cupboard = { id: 'c', x: 1, y: 0, w: 0.5, l: 3, h: 2.0 };
  const table = { id: 't', x: 1, y: 0, w: 0.5, l: 3, h: 0.75 };

  test('a tall cupboard between the anchor and the wrist blocks; a table does not', () => {
    assert.equal(clearLine(0, 1.5, 2.4, 2.5, 1.5, 0.85, [cupboard]), false);
    assert.equal(clearLine(0, 1.5, 2.4, 2.5, 1.5, 0.85, [table]), true);
  });

  test('the surface an anchor is mounted on does not block it', () => {
    assert.equal(clearLine(1.5, 1.5, 2.4, 2.5, 1.5, 0.85, [cupboard], 'c'), true);
  });
});

describe('anchor plan', () => {
  test('WARD-005, keeping A, B and C: three new anchors on free walls, apart, facing into the room', () => {
    const plan = planPlacement(ward005(), { anchorCount: 6, keepExisting: true });
    const { anchors } = plan.suggested;
    assert.equal(anchors.length, 6);
    assert.deepEqual(anchors.map(a => a.anchor_id), ['Anchor A', 'Anchor B', 'Anchor C', 'Anchor D', 'Anchor E', 'Anchor F']);
    assert.deepEqual(anchors.filter(a => a.action === 'KEEP').map(a => a.anchor_id), ['Anchor A', 'Anchor B', 'Anchor C']);
    const kept = anchors.slice(0, 3);
    assert.deepEqual(kept.map(a => [a.x, a.y, a.z]), [[1.89, 3.39, 2.4], [2.29, 0.4, 2.4], [0, 2.13, 2.4]], 'kept anchors do not move');

    for (const a of anchors.filter(x => x.action === 'NEW')) {
      assert.ok(onWall(a, 2.29, 3.39), `${a.anchor_id} on a wall`);
      assert.equal(a.z, 2.3, 'ceiling 2.45 m: 15 cm below it');
      const expected = a.y === 0 ? 0 : a.y === 3.39 ? 180 : a.x === 0 ? 90 : 270;
      assert.equal(a.facing_deg, expected, `${a.anchor_id} faces into the room`);
      for (const b of anchors) {
        if (b !== a) assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= DEFAULTS.minSeparation - 1e-9, `${a.anchor_id}-${b.anchor_id} apart`);
      }
      if (a.x === 2.29) assert.ok(a.y < 2.57 - 0.2 || a.y > 3.36 + 0.2, 'not at the door');
      assert.match(a.instruction, /m from the (north|south)-(east|west) corner\. Board centre 2\.30 m above the floor\. Upright, antenna end up/);
      assert.ok(a.wall_location.length <= 64);
    }
    assert.ok(plan.suggested.mean_error_m < plan.current.mean_error_m, 'six anchors beat three');
    assert.ok(plan.current.mean_error_m < plan.room_only_error_m, 'three anchors beat knowing only the room');
    assert.equal(plan.suggested.clear_to_3_pct, 100);
    assert.equal(plan.suggested.errors.length, plan.grid.points.length);
  });

  test('the same layout gives the same plan', () => {
    const a = planPlacement(ward005(), { anchorCount: 6, keepExisting: true });
    const b = planPlacement(ward005(), { anchorCount: 6, keepExisting: true });
    assert.deepEqual(a.suggested.anchors, b.suggested.anchors);
    assert.deepEqual(a.lidar.suggested, b.lidar.suggested);
  });

  test('more anchors never make the expected error worse', () => {
    let previous = Infinity;
    for (const n of [3, 4, 5, 6, 8]) {
      const e = planPlacement(ward005(), { anchorCount: n }).suggested.mean_error_m;
      assert.ok(e <= previous + 0.005, `${n} anchors: ${e} after ${previous}`);
      previous = e;
    }
  });

  test('replanning all: each mounted board goes to the nearest new spot, the others are new', () => {
    const plan = planPlacement(ward005(), { anchorCount: 6, keepExisting: false });
    const byId = Object.fromEntries(plan.suggested.anchors.map(a => [a.anchor_id, a]));
    assert.equal(byId['Anchor A'].device_id, 'anchor-001');
    assert.ok(['MOVE', 'KEEP'].includes(byId['Anchor A'].action));
    assert.ok(Number.isFinite(byId['Anchor A'].moved_m));
    assert.deepEqual(['Anchor D', 'Anchor E', 'Anchor F'].map(id => byId[id].action), ['NEW', 'NEW', 'NEW']);
  });

  test('fewer anchors than are placed: a warning names the ones dropped', () => {
    const layout = ward005({ anchors: [...ward005().anchors, { anchor_id: 'Anchor D', x: 0.8, y: 0, z: 2.3 }] });
    const plan = planPlacement(layout, { anchorCount: 3 });
    assert.equal(plan.suggested.anchors.length, 3);
    assert.ok(plan.warnings.some(w => w.includes('Anchor D') && w.includes('removes')), plan.warnings.join(' | '));
  });

  test('the ward templates are planned with 100 % of the floor in clear view of 3 anchors', () => {
    for (const id of Object.keys(WARD_TEMPLATES)) {
      const plan = planPlacement(template(id), { anchorCount: 6 });
      assert.equal(plan.suggested.anchors.length, 6, id);
      assert.equal(plan.suggested.clear_to_3_pct, 100, id);
      assert.ok(plan.suggested.mean_error_m < plan.current.mean_error_m, id);
    }
  });

  test('a large room is planned within a few seconds', () => {
    const started = Date.now();
    const plan = planPlacement({ length_x: 20, width_y: 12, height_z: 3.2, door: { wall: 'SOUTH', x: 9, width: 1.2 }, beds: [], obstacles: [], anchors: [] }, { anchorCount: 12 });
    assert.ok(Date.now() - started < 5000);
    assert.equal(plan.suggested.anchors.length, 12);
    assert.ok(plan.grid.points.length <= DEFAULTS.maxGridPoints + 100);
  });

  test('a room it cannot plan is refused with a plain reason', () => {
    assert.throws(() => planPlacement({ length_x: 0.5, width_y: 3 }), PlacementError);
    assert.throws(() => planPlacement({ length_x: 60, width_y: 60 }), PlacementError);
  });
});

describe('LiDAR plan', () => {
  test('WARD-005: against the south wall between the west wall and the bed head, seeing the floor', () => {
    const { lidar } = planPlacement(ward005(), { anchorCount: 6, keepExisting: true });
    const l = lidar.suggested;
    assert.equal(l.y, DEFAULTS.lidarOffset, '0.18 m out from the south wall');
    assert.ok(l.x >= 0.5 && l.x <= 1.1, `x ${l.x}`);
    assert.equal(l.heading_deg, 0, '▲ points north, into the room');
    assert.ok(l.visible_pct >= 98, `sees ${l.visible_pct} %`);
    assert.equal(l.on_walking_route, false);
    assert.equal(l.base_height, 0.92);
    assert.equal(l.slice_height, 0.95);
    assert.match(l.instruction, /south-west corner and 0\.18 m out from the wall\. Base 0\.92 m above the floor, level\. The ▲ on top points north \(0°\)/);
  });

  test('never on furniture or in the door area', () => {
    const { lidar } = planPlacement(ward005(), {});
    const l = lidar.suggested;
    assert.ok(!(l.x <= 1.57 && l.y >= 2.63), 'not on the table');
    assert.ok(!(l.x >= 1.29 - 0.1 && l.y >= 2.47 - 0.1), 'not in the door area');
  });

  test('a LiDAR already in the ward is scored too', () => {
    const layout = ward005({ room_sensors: [{ sensor_id: 'LiDAR 1', x: 2.11, y: 2.08, heading_deg: 270 }] });
    const { lidar } = planPlacement(layout, {});
    assert.ok(lidar.current);
    assert.equal(lidar.current.on_walking_route, true, 'at the foot of the bed, on the way to the door');
  });

  test('it can be left out', () => {
    assert.equal(planPlacement(ward005(), { includeLidar: false }).lidar, null);
  });
});

test('compass names', () => {
  assert.deepEqual([0, 90, 180, 270, 45, 359].map(compassName), ['north', 'east', 'south', 'west', 'north-east', 'north']);
});
