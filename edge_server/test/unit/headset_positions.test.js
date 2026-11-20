// Unit tests: positions of patients seen by a headset, and which position the maps get.
require('./no_database');

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const hp = require('../../services/ips/headset_positions');

const WARD = { length_x: 6.4, width_y: 4.8 };
const AT = { x: 2.0, y: 1.5, wardId: 'WARD-004', heightM: 1.62, manual: false, headsetId: 'QUEST3-001' };

describe('headset positions', () => {
  beforeEach(() => hp.clearAll());

  test('a position is used while it is renewed, and not after', () => {
    assert.equal(hp.set('TAG-002', AT, 1000), true, 'new');
    assert.equal(hp.set('TAG-002', AT, 1200), false, 'a renewal is not new');
    assert.ok(hp.fresh('TAG-002', 1200 + hp.FRESH_MS));
    assert.equal(hp.fresh('TAG-002', 1201 + hp.FRESH_MS), null);
    assert.deepEqual(hp.takeStale(1201 + hp.FRESH_MS), ['TAG-002']);
    assert.equal(hp.fresh('TAG-002', 1300), null, 'removed');
  });

  test('only the headset that gave a position can end it', () => {
    hp.set('TAG-002', AT, 1000);
    assert.equal(hp.end('TAG-002', 'QUEST3-002'), false);
    assert.ok(hp.fresh('TAG-002', 1100));
    assert.equal(hp.end('TAG-002', 'QUEST3-001'), true);
    assert.equal(hp.fresh('TAG-002', 1100), null);
  });

  test('a headset that disconnects ends its positions, not those of another headset', () => {
    hp.set('TAG-002', AT, 1000);
    hp.set('TAG-003', { ...AT, headsetId: 'QUEST3-002' }, 1000);
    assert.deepEqual(hp.takeFromHeadset('QUEST3-001'), ['TAG-002']);
    assert.ok(hp.fresh('TAG-003', 1100));
  });

  test('another headset taking over counts as new', () => {
    hp.set('TAG-002', AT, 1000);
    assert.equal(hp.set('TAG-002', { ...AT, headsetId: 'QUEST3-002' }, 1100), true);
  });

  test('broadcasts are limited per tag', () => {
    hp.set('TAG-002', AT, 1000);
    assert.equal(hp.broadcastDue('TAG-002', 1000, 140), true);
    assert.equal(hp.broadcastDue('TAG-002', 1100, 140), false);
    assert.equal(hp.broadcastDue('TAG-002', 1140, 140), true);
    assert.equal(hp.broadcastDue('TAG-404', 2000, 140), false);
  });

  test('only positions inside the ward (with a small margin) are used', () => {
    assert.equal(hp.insideWard(0, 0, WARD), true);
    assert.equal(hp.insideWard(6.8, 5.2, WARD), true);
    assert.equal(hp.insideWard(-0.6, 2, WARD), false);
    assert.equal(hp.insideWard(3, 5.4, WARD), false);
    assert.equal(hp.insideWard(1, 1, null), false);
  });
});

describe('the IPS service', () => {
  test('a wristband that is not tracked here is refused: no position is made up', () => {
    const ips = require('../../services/ips_service');
    const { HttpError } = require('../../utils/http');
    assert.throws(() => ips.applyHeadsetPosition('TAG-404', { x: 1, y: 1, wardId: 'WARD-004' }, 'QUEST3-001'),
      (err) => err instanceof HttpError && err.status === 404);
    assert.equal(ips.getTagPosition('TAG-404'), null);
    ips.endHeadsetPosition('TAG-404', 'QUEST3-001'); // nothing to end: no error
  });
});

describe('the position the maps get', () => {
  const ble = { x: 3.4, y: 2.6 };

  test('while a headset sees the patient: its position, with Bluetooth alongside', () => {
    assert.deepEqual(hp.positionFields(ble, AT), {
      source: 'HEADSET', has_ble: true, ble_x: 3.4, ble_y: 2.6,
      x: 2.0, y: 1.5, ward_id: 'WARD-004', seen_by: 'QUEST3-001', seen_manual: false
    });
  });

  test('otherwise: the Bluetooth position', () => {
    assert.deepEqual(hp.positionFields(ble, null), { source: 'BLE', has_ble: true, ble_x: 3.4, ble_y: 2.6, x: 3.4, y: 2.6 });
    assert.deepEqual(hp.positionFields(ble, null, null), { source: 'BLE', has_ble: true, ble_x: 3.4, ble_y: 2.6, x: 3.4, y: 2.6 });
  });

  test('a LiDAR position comes after the headset and before Bluetooth', () => {
    const lidar = { x: 1.234, y: 0.987, wardId: 'WARD-005', key: 'lidar-001#3', held: true, inBed: true };
    assert.deepEqual(hp.positionFields(ble, null, lidar), {
      source: 'LIDAR', has_ble: true, ble_x: 3.4, ble_y: 2.6,
      x: 1.23, y: 0.99, ward_id: 'WARD-005', lidar_person: 'lidar-001#3', lidar_held: true, lidar_in_bed: true
    });
    assert.equal(hp.positionFields(ble, AT, lidar).source, 'HEADSET', 'the headset comes first');
    assert.equal(hp.positionFields(ble, AT, lidar).x, 2.0);
  });
});
