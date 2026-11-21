// =============================================================================
// The rules of a ward layout (public/js/ward_config/ward_rules.js, Phase 11):
// everything inside the room, one LiDAR, at most 15 obstacles, beds by floor space.
// =============================================================================
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../../public/js/ward_config/ward_rules');

const anchors = [{ anchor_id: 'A', x: 0, y: 1 }, { anchor_id: 'B', x: 4, y: 0 }, { anchor_id: 'C', x: 2, y: 3 }];
const ward = (extra = {}) => ({
  ward_id: 'WARD-T', length_x: 4, width_y: 3, door: { wall: 'SOUTH', x: 1, width: 0.9 },
  beds: [{ bed_code: 'Bed 1', x: 0.2, y: 0.5, width: 0.9, length: 2, rotation_deg: 0 }],
  obstacles: [], anchors, room_sensors: [], ...extra
});

describe('ward layout rules', () => {
  test('a layout inside the room passes', () => {
    const r = rules.checkWardLayout(ward());
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.warnings, []);
  });

  test('a bed partly outside the room is refused, also when turned', () => {
    let r = rules.checkWardLayout(ward({ beds: [{ bed_code: 'Bed 4', x: 3.5, y: 0.5, width: 0.9, length: 2 }] }));
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /Bed 4 is partly outside the room/);
    // Turned 90°: 2.0 m along x from 2.5 reaches 4.5 > 4
    r = rules.checkWardLayout(ward({ beds: [{ bed_code: 'Bed 1', x: 2.5, y: 0.5, width: 0.9, length: 2, rotation_deg: 90 }] }));
    assert.match(r.errors.join(' '), /outside the room/);
    // Turned 90° and inside
    r = rules.checkWardLayout(ward({ beds: [{ bed_code: 'Bed 1', x: 2.0, y: 2.1, width: 0.9, length: 2, rotation_deg: 90 }] }));
    assert.deepEqual(r.errors, []);
  });

  test('a bed flush with the walls passes (values typed to the centimetre)', () => {
    const r = rules.checkWardLayout(ward({ beds: [{ bed_code: 'Bed 1', x: 3.1, y: 1.0, width: 0.9, length: 2 }] }));
    assert.deepEqual(r.errors, []);
  });

  test('obstacles, wall sensors, the LiDAR and the door must be inside', () => {
    const r = rules.checkWardLayout(ward({
      obstacles: [{ label: 'Table', x: 3.5, y: 0, width: 1, length: 0.5 }],
      anchors: [...anchors, { anchor_id: 'D', x: 4.3, y: 1 }],
      room_sensors: [{ sensor_id: 'LiDAR 1', x: -0.2, y: 1 }],
      door: { wall: 'EAST', x: 2.5, width: 0.9 }
    }));
    const text = r.errors.join(' ');
    assert.match(text, /Obstacle "Table" is partly outside/);
    assert.match(text, /D is outside the room/);
    assert.match(text, /LiDAR 1 is outside the room/);
    assert.match(text, /door does not fit on the east wall/);
  });

  test('one LiDAR per ward', () => {
    const r = rules.checkWardLayout(ward({ room_sensors: [{ x: 1, y: 1 }, { x: 2, y: 2 }] }));
    assert.match(r.errors.join(' '), /one LiDAR/);
  });

  test('at most 15 obstacles', () => {
    const small = (i) => ({ label: `Box ${i}`, x: (i % 4) * 0.5, y: 2.5, width: 0.2, length: 0.2 });
    assert.deepEqual(rules.checkWardLayout(ward({ obstacles: Array.from({ length: 15 }, (_, i) => small(i)) })).errors, []);
    assert.match(rules.checkWardLayout(ward({ obstacles: Array.from({ length: 16 }, (_, i) => small(i)) })).errors.join(' '), /at most 15 obstacles/);
  });

  test('beds by free floor: one per 5 m², at least one', () => {
    // 4 × 3 m = 12 m²: 2 beds
    assert.equal(rules.maxBeds(ward()), 2);
    // A 1.6 m² bathroom leaves 10.4 m²: still 2
    assert.equal(rules.maxBeds(ward({ obstacles: [{ x: 0, y: 2, width: 1.6, length: 1 }] })), 2);
    // A 3 m² bathroom leaves 9 m²: 1
    assert.equal(rules.maxBeds(ward({ obstacles: [{ x: 0, y: 2, width: 3, length: 1 }] })), 1);
    // A tiny room still takes one bed (the project's 2.29 × 3.39 m test room)
    assert.equal(rules.maxBeds({ length_x: 2.29, width_y: 3.39, obstacles: [] }), 1);
    const three = [0.2, 1.3, 2.4].map((x, i) => ({ bed_code: `Bed ${i + 1}`, x, y: 0.5, width: 0.9, length: 2 }));
    assert.match(rules.checkWardLayout(ward({ beds: three })).errors.join(' '), /floor space for 2 beds.*it has 3/);
  });

  test('beds on top of each other are a warning, not an error', () => {
    const r = rules.checkWardLayout(ward({ beds: [
      { bed_code: 'Bed 1', x: 0.2, y: 0.5, width: 0.9, length: 2 },
      { bed_code: 'Bed 2', x: 0.6, y: 0.8, width: 0.9, length: 2 }
    ] }));
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.warnings, ['Bed 1 and Bed 2 overlap.']);
  });

  test('values stored as text (from the database) are read as numbers', () => {
    const r = rules.checkWardLayout(ward({ length_x: '4.00', width_y: '3.00', beds: [{ bed_code: 'Bed 1', x: '0.20', y: '0.50', width: '0.90', length: '2.00', rotation_deg: 0 }] }));
    assert.deepEqual(r.errors, []);
  });
});
