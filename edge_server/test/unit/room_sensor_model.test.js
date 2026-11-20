// Unit tests: LiDAR scan geometry, the empty-room model and lining a scan up
// with the ward's walls (Phase 10, step 5a). Simulated turns of WARD-005.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { BINS } = require('../../services/room_sensor/scan_frame');
const geometry = require('../../services/room_sensor/scan_geometry');
const background = require('../../services/room_sensor/background');
const { alignScan } = require('../../services/room_sensor/alignment');
const { WARD_005, simulateTurns, simulateTurn, rng } = require('./lidar_scene');

const POSE = { x: 2.11, y: 2.08, heading_deg: 270, base_height: 0.92 };

describe('scan geometry', () => {
  test('direction 0 is just clockwise of the ▲, and the heading turns it to the compass', () => {
    assert.equal(geometry.binAngleDeg(0), 0.25);
    assert.equal(geometry.binAngleDeg(719), 359.75);
    assert.equal(geometry.bearingDeg(0, 270), 270.25);
    assert.equal(geometry.bearingDeg(180, 270), 0.25, 'a quarter turn clockwise from west is north');
    assert.equal(geometry.bearingDeg(180, 270, true), 179.75, 'mirrored: a quarter turn the other way is south');
  });

  test('a return lands in ward coordinates: 1 m north of a LiDAR whose ▲ points west', () => {
    // direction 179 is centred at 89.75 degrees clockwise from the ▲: almost exactly north
    const p = geometry.returnToWard(POSE, 179, 1.0);
    assert.ok(Math.abs(p.x - 2.11) < 0.01 && Math.abs(p.y - 3.08) < 0.01, JSON.stringify(p));
    const west = geometry.returnToWard({ x: 1, y: 1, heading_deg: 270 }, 719, 0.5);
    assert.ok(Math.abs(west.x - 0.5) < 0.01 && Math.abs(west.y - 1) < 0.01, JSON.stringify(west));
  });

  test('surfaces: the four walls and the sides of obstacles at least as tall as the slice', () => {
    const segments = geometry.wardSurfaces(WARD_005, geometry.sliceHeight(0.92));
    // the table (0.8 m) is below the 0.95 m slice; the storage and both partitions are not
    assert.equal(segments.length, 4 + 3 * 4);
    assert.ok(!segments.some(s => s.source === 'table'));
    const near = geometry.nearestSurface(1.0, 1.0, segments);
    assert.equal(near.distance.toFixed(2), '0.40', 'nearest is the east side of partition 3, at x 0.6');
    assert.equal(near.segment.source, 'Partition Wall 3');
  });
});

describe('empty-room model', () => {
  const turns = simulateTurns(WARD_005, POSE, 120);

  test('learns a surface in nearly every direction of a closed room', () => {
    const learned = background.learnBackground(turns);
    assert.equal(learned.ok, true);
    assert.equal(learned.model.turns, 120);
    assert.equal(learned.model.median_mm.length, BINS);
    assert.ok(learned.model.coverage_pct > 95, `coverage ${learned.model.coverage_pct}`);
    assert.ok(learned.model.unsteady_pct < 5, `unsteady ${learned.model.unsteady_pct}`);
    assert.deepEqual(learned.warnings, []);
    assert.equal(background.checkModel(JSON.parse(JSON.stringify(learned.model))) !== null, true, 'survives JSON');
  });

  test('too few turns are refused', () => {
    const learned = background.learnBackground(turns.slice(0, 5));
    assert.equal(learned.ok, false);
    assert.match(learned.reason, /only 5 turns/);
  });

  test('someone walking about while it learns is reported', () => {
    const random = rng(3);
    const busy = Array.from({ length: 100 }, (_, k) => simulateTurn(WARD_005, POSE, {
      random, people: [{ x: 0.8 + 0.01 * k, y: 1.0 + 0.012 * k, r: 0.2 }]
    }));
    const learned = background.learnBackground(busy);
    assert.equal(learned.ok, true);
    assert.ok(learned.warnings.some(w => /changed while learning/.test(w)), JSON.stringify(learned.warnings));
  });

  test('a person shows up as new returns, the empty room does not', () => {
    const { model } = background.learnBackground(turns);
    const empty = simulateTurn(WARD_005, POSE, { random: rng(99) });
    assert.ok(background.foregroundBins(empty, model).length <= 2, 'at most a stray return in an empty room');

    const withPerson = simulateTurn(WARD_005, POSE, { random: rng(99), people: [{ x: 1.0, y: 2.3, r: 0.18 }] });
    const found = background.foregroundBins(withPerson, model);
    assert.ok(found.length >= 10, `${found.length} directions on the person`);
    for (const i of found.slice(0, 5)) {
      const p = geometry.returnToWard(POSE, i, withPerson[i] / 1000);
      assert.ok(Math.hypot(p.x - 1.0, p.y - 2.3) < 0.3, `return ${i} at ${p.x.toFixed(2)}, ${p.y.toFixed(2)} is on the person`);
    }
  });

  test('a person makes returns closer, never farther; a turned LiDAR makes many farther', () => {
    const { model } = background.learnBackground(turns);
    const withPerson = simulateTurn(WARD_005, POSE, { random: rng(5), people: [{ x: 1.0, y: 2.3, r: 0.18 }, { x: 1.6, y: 2.4, r: 0.18 }] });
    const c1 = background.compareWithBackground(withPerson, model);
    assert.ok(c1.closer > 10);
    assert.ok(c1.farther_pct < 3, `farther ${c1.farther_pct}%`);

    const turned = simulateTurn(WARD_005, { ...POSE, heading_deg: 250 }, { random: rng(5) });
    const c2 = background.compareWithBackground(turned, model);
    assert.ok(c2.farther_pct > 20, `farther ${c2.farther_pct}% after turning it 20 degrees`);
  });

  test('a damaged stored model is not used', () => {
    const { model } = background.learnBackground(turns);
    assert.equal(background.checkModel({ ...model, median_mm: model.median_mm.slice(1) }), null);
    assert.equal(background.checkModel({ ...model, version: 99 }), null);
    assert.equal(background.checkModel(null), null);
  });
});

describe('lining the scan up with the walls', () => {
  const real = { x: 2.09, y: 2.10, heading_deg: 271.5, base_height: 0.92 };
  const { model } = background.learnBackground(simulateTurns(WARD_005, real, 100, { seed: 21 }));

  test('finds the real position and heading from the one in the editor (2-3 cm and 1.5 degrees off)', () => {
    const t0 = Date.now();
    const r = alignScan({ distancesMm: model.median_mm, layout: WARD_005, pose: POSE });
    const ms = Date.now() - t0;
    assert.equal(r.ok, true, r.reason);
    assert.ok(Math.abs(r.pose.x - real.x) <= 0.01, `x ${r.pose.x}`);
    assert.ok(Math.abs(r.pose.y - real.y) <= 0.01, `y ${r.pose.y}`);
    assert.ok(Math.abs(r.pose.heading_deg - real.heading_deg) <= 0.3, `heading ${r.pose.heading_deg}`);
    assert.equal(r.quality, 'GOOD', JSON.stringify(r.warnings));
    assert.ok(r.after.on_surface_pct > r.before.on_surface_pct);
    assert.ok(r.after.median_residual_mm <= 10, `residual ${r.after.median_residual_mm} mm`);
    assert.equal(r.checks.mirrored_fits_better, false);
    assert.deepEqual(r.warnings, []);
    assert.ok(ms < 5000, `took ${ms} ms`);
  });

  test('a single live turn with a person in the room still lines up', () => {
    const live = simulateTurn(WARD_005, real, { random: rng(8), people: [{ x: 1.0, y: 2.3, r: 0.18 }] });
    const r = alignScan({ distancesMm: live, layout: WARD_005, pose: POSE });
    assert.ok(Math.abs(r.pose.x - real.x) <= 0.02 && Math.abs(r.pose.y - real.y) <= 0.02, JSON.stringify(r.pose));
    assert.ok(Math.abs(r.pose.heading_deg - real.heading_deg) <= 0.5, `heading ${r.pose.heading_deg}`);
  });

  test('a heading entered wrongly (▲ really points north) is reported', () => {
    const north = { ...real, heading_deg: 0 };
    const scan = background.learnBackground(simulateTurns(WARD_005, north, 60, { seed: 4 })).model.median_mm;
    const r = alignScan({ distancesMm: scan, layout: WARD_005, pose: POSE });
    assert.notEqual(r.quality, 'GOOD');
    assert.ok(r.warnings.some(w => /▲ pointing about (35[89]|0|1|2)°/.test(w)), JSON.stringify(r.warnings));
  });

  test('a scan read the wrong way round is reported', () => {
    const scan = background.learnBackground(simulateTurns(WARD_005, real, 60, { seed: 6, mirrored: true })).model.median_mm;
    const r = alignScan({ distancesMm: scan, layout: WARD_005, pose: real });
    assert.equal(r.checks.mirrored_fits_better, true);
    assert.ok(r.warnings.some(w => /mirrored/.test(w)));
  });

  test('too few returns are refused', () => {
    const r = alignScan({ distancesMm: new Array(BINS).fill(0), layout: WARD_005, pose: POSE });
    assert.equal(r.ok, false);
    assert.match(r.reason, /only 0 returns/);
  });
});
