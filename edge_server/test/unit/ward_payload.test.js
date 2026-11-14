// Unit tests: the check a ward plan passes before the ward editor's save is stored.
require('./no_database');

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { checkWardPayload } = require('../../controllers/ward_controller');
const { HttpError } = require('../../utils/http');

/** A plan as the ward editor sends it. */
function plan(changes = {}) {
  return {
    ward_id: 'WARD-004',
    room_title: 'Acute Care Ward 004',
    length_x: 6.4, width_y: 4.8, height_z: 2.6,
    layout_type: 'L_SHAPED',
    spatial_anchor_uuid: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789',
    door: { wall: 'SOUTH', x: 2.8, y: 0, width: 0.9 },
    obstacles: [{ id: 'OBS-004-01', type: 'TOILET', label: 'Bathroom', x: 0, y: 3.2, width: 1.8, length: 1.6, height: 2.6 }],
    beds: [{ bed_id: 'BED-WARD-004-01', bed_code: 'Bed 1', status: 'AVAILABLE', x: 0.5, y: 0.4, width: 0.9, length: 2, rotation_deg: 0 }],
    anchors: [{ anchor_id: 'Anchor A', device_id: 'anchor-001', mac_address: 'C4:DE:E2:10:02:BA', x: 0.5, y: 4.3, z: 1.8, wall_location: 'North-West Wall', calibrated_a: -59, calibrated_n: 2.4, status: 'ONLINE' }],
    stats: { anything: 'fields the server does not store are not checked' },
    ...changes
  };
}

function refuses(payload, field) {
  assert.throws(() => checkWardPayload(payload), (err) => err instanceof HttpError && err.status === 400 && err.message.includes(field), field);
}

describe('ward plan', () => {
  test('a plan from the ward editor is accepted', () => {
    assert.doesNotThrow(() => checkWardPayload(plan()));
  });

  test('a new plan with unassigned anchors and no stored calibration is accepted', () => {
    assert.doesNotThrow(() => checkWardPayload(plan({
      spatial_anchor_uuid: '',
      anchors: [{ anchor_id: 'Anchor B', device_id: null, mac_address: '', x: '5.9', y: '4.3', z: 1.8, calibrated_a: null, calibrated_n: null }]
    })));
  });

  test('a plan without a ward ID is refused: it must never be stored under a default ward', () => {
    refuses(plan({ ward_id: undefined }), 'ward_id');
    refuses(plan({ ward_id: '' }), 'ward_id');
    refuses(plan({ ward_id: 'WARD 4' }), 'ward_id');
  });

  test('text in place of a number is refused', () => {
    refuses(plan({ length_x: 'wide' }), 'length_x');
    refuses(plan({ width_y: -3 }), 'width_y');
    refuses(plan({ door: { wall: 'SOUTH', x: 'left' } }), 'door.x');
    refuses(plan({ beds: [{ x: {} }] }), 'beds[0].x');
    refuses(plan({ anchors: [{ anchor_id: 'Anchor A', z: 'high' }] }), 'anchors[0].z');
  });

  test('values outside the fixed lists are refused', () => {
    refuses(plan({ layout_type: 'ROUND' }), 'layout_type');
    refuses(plan({ door: { wall: 'UP' } }), 'door.wall');
    refuses(plan({ obstacles: [{ type: 'PIANO' }] }), 'obstacles[0].type');
    refuses(plan({ beds: [{ status: 'BROKEN' }] }), 'beds[0].status');
  });

  test('names that would become markup on the dashboard are refused where a name has a fixed form', () => {
    refuses(plan({ anchors: [{ anchor_id: '<img src=x onerror=alert(1)>' }] }), 'anchors[0].anchor_id');
    refuses(plan({ anchors: [{ anchor_id: 'Anchor A', device_id: 'x y' }] }), 'anchors[0].device_id');
    refuses(plan({ anchors: [{ anchor_id: 'Anchor A', mac_address: 'not-a-mac' }] }), 'anchors[0].mac_address');
    refuses(plan({ beds: [{ bed_id: '../x' }] }), 'beds[0].bed_id');
    refuses(plan({ spatial_anchor_uuid: '"><script>' }), 'spatial_anchor_uuid');
  });

  test('lists must be lists of objects and not unbounded', () => {
    refuses(plan({ beds: 'four' }), 'beds');
    refuses(plan({ beds: [1, 2] }), 'beds');
    refuses(plan({ anchors: new Array(33).fill({ anchor_id: 'Anchor A' }) }), 'anchors');
    refuses(plan({ door: [] }), 'door');
  });
});
