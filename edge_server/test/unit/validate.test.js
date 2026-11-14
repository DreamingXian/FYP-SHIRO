// Unit tests: the input validators used by every HTTP, WebSocket and MQTT entry point.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const v = require('../../utils/validate');
const { HttpError } = require('../../utils/http');

/** The call must be refused with a 400 whose message names the field. */
function refuses(fn, field) {
  assert.throws(fn, (err) => err instanceof HttpError && err.status === 400 && err.message.includes(field));
}

describe('identifiers', () => {
  test('the identifiers in use are accepted', () => {
    for (const id of ['P-001', 'WARD-A1', 'BED-WARD-004-02', 'TAG-002', 'anchor-001', 'INC-20261114-0253', 'ITEST-A', '5', 'UNASSIGNED']) {
      assert.equal(v.requireId(id, 'id'), id);
    }
  });

  test('anything that could change a path, a query or a page is refused', () => {
    const bad = [
      '../../etc', '..\\x', 'P-001/../x', 'a b', 'P-001"', "P-001'", 'P-001" or r.x == "', '<img>', 'a;b', 'a\nb', 'a\u0000b',
      '-leading', '_leading', 'x'.repeat(33), 5, {}, [], true
    ];
    for (const id of bad) refuses(() => v.requireId(id, 'patient_id'), 'patient_id');
  });

  test('a required identifier that is missing is refused, never replaced', () => {
    for (const missing of [undefined, null, '']) refuses(() => v.requireId(missing, 'ward_id'), 'ward_id');
  });

  test('an optional identifier may be absent but not malformed', () => {
    assert.equal(v.optionalId(undefined, 'bed_id'), null);
    assert.equal(v.optionalId('', 'bed_id'), null);
    assert.equal(v.optionalId('BED-001-01', 'bed_id'), 'BED-001-01');
    refuses(() => v.optionalId('../x', 'bed_id'), 'bed_id');
  });

  test('anchor names of a ward plan may contain spaces', () => {
    assert.equal(v.requireLabel('Anchor A', 'anchor_id'), 'Anchor A');
    assert.equal(v.requireLabel('anchor-001', 'anchor_id'), 'anchor-001');
    for (const bad of ['<b>A</b>', 'A"', "A'", ' A', 'x'.repeat(33), '']) refuses(() => v.requireLabel(bad, 'anchor_id'), 'anchor_id');
  });
});

describe('MAC addresses', () => {
  test('a MAC address is returned in one form', () => {
    assert.equal(v.requireMac('58:e6:c5:1b:80:4e', 'mac'), '58:E6:C5:1B:80:4E');
    assert.equal(v.requireMac(' 58-E6-C5-1B-80-4E ', 'mac'), '58:E6:C5:1B:80:4E');
    assert.equal(v.normalizeMac('58:E6:C5:1B:80:4E'), '58:E6:C5:1B:80:4E');
  });

  test('anything else is refused', () => {
    for (const bad of ['58:E6:C5:1B:80', '58:E6:C5:1B:80:4E:00', '58E6C51B804E', 'GG:E6:C5:1B:80:4E', '<script>alert(1)</script>', 12, null]) {
      assert.equal(v.normalizeMac(bad), null, String(bad));
    }
    refuses(() => v.requireMac('not-a-mac', 'mac_address'), 'mac_address');
    refuses(() => v.requireMac(undefined, 'mac_address'), 'mac_address');
    assert.equal(v.optionalMac('', 'mac'), null);
  });

  test('a wristband may be named by its device ID or by its MAC address', () => {
    assert.equal(v.requireDeviceRef('TAG-002', 'tag_id'), 'TAG-002');
    assert.equal(v.requireDeviceRef('58:e6:c5:1b:80:4e', 'tag_id'), '58:E6:C5:1B:80:4E');
    refuses(() => v.requireDeviceRef('TAG 002', 'tag_id'), 'tag_id');
    refuses(() => v.requireDeviceRef(undefined, 'tag_id'), 'tag_id');
  });
});

describe('fixed lists and numbers', () => {
  test('only listed values are accepted', () => {
    assert.equal(v.requireOneOf('ANCHOR', ['WRISTBAND', 'ANCHOR'], 'type'), 'ANCHOR');
    refuses(() => v.requireOneOf('anchor', ['WRISTBAND', 'ANCHOR'], 'type'), 'type');
    refuses(() => v.requireOneOf(undefined, ['WRISTBAND', 'ANCHOR'], 'type'), 'type');
    assert.equal(v.optionalOneOf(null, ['A'], 'x', 'ALL'), 'ALL');
    refuses(() => v.optionalOneOf('B', ['A'], 'x', 'ALL'), 'x');
  });

  test('numbers must be finite and inside their range', () => {
    assert.equal(v.requireNumber('2.5', 'x', { min: 0, max: 10 }), 2.5);
    assert.equal(v.requireNumber(-59, 'A', { min: -120, max: 0 }), -59);
    for (const bad of ['abc', '', NaN, Infinity, '1e999', {}, [], true, 11, -1]) {
      refuses(() => v.requireNumber(bad, 'x', { min: 0, max: 10 }), 'x');
    }
    assert.equal(v.optionalNumber(undefined, 'n', { min: 0, max: 1 }, 0.5), 0.5);
  });

  test('whole numbers', () => {
    assert.equal(v.requireInt('50', 'limit', { min: 1, max: 500 }), 50);
    refuses(() => v.requireInt(1.5, 'limit', { min: 1, max: 500 }), 'limit');
    refuses(() => v.requireInt('50; DROP TABLE patients', 'limit', { min: 1, max: 500 }), 'limit');
    assert.equal(v.optionalInt(null, 'limit', { min: 1, max: 500 }, 50), 50);
  });
});

describe('text and lists', () => {
  test('text is trimmed, limited in length and must be text', () => {
    assert.equal(v.optionalText('  Tan Ah Kow ', 'full_name', 128), 'Tan Ah Kow');
    assert.equal(v.optionalText('', 'notes', 10), null);
    assert.equal(v.optionalText('   ', 'notes', 10), null);
    refuses(() => v.optionalText('x'.repeat(11), 'notes', 10), 'notes');
    refuses(() => v.optionalText({ $gt: '' }, 'notes', 10), 'notes');
    refuses(() => v.optionalText(['a'], 'notes', 10), 'notes');
  });

  test('a list must be a list of objects of limited length', () => {
    assert.deepEqual(v.optionalArray(undefined, 'beds', 5), []);
    assert.equal(v.optionalArray([{}, {}], 'beds', 5).length, 2);
    refuses(() => v.optionalArray('x', 'beds', 5), 'beds');
    refuses(() => v.optionalArray([1], 'beds', 5), 'beds');
    refuses(() => v.optionalArray(new Array(6).fill({}), 'beds', 5), 'beds');
  });

  test('a spatial anchor reference is a UUID or a plain name', () => {
    assert.equal(v.optionalAnchorRef('a1b2c3d4-e5f6-7890-abcd-ef0123456789', 'uuid'), 'a1b2c3d4-e5f6-7890-abcd-ef0123456789');
    assert.equal(v.optionalAnchorRef('ANCHOR-WARD-004-12345678', 'uuid'), 'ANCHOR-WARD-004-12345678');
    assert.equal(v.optionalAnchorRef('', 'uuid'), null);
    refuses(() => v.optionalAnchorRef('x" onload="alert(1)', 'uuid'), 'uuid');
  });
});
