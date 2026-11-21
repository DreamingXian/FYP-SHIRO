// Unit tests: the shared dashboard pieces (public/js/ui_kit.js): which page
// buttons a pager shows, one page of a list, "time ago".
require('./no_database');

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { pageNumbers, paginate, ago, PAGE_SIZE } = require('../../public/js/ui_kit');

describe('page buttons', () => {
  test('the example of 22 Nov 2026: page 5 of 10 is 1 2 … 4 5 6 … 9 10', () => {
    assert.deepEqual(pageNumbers(5, 10), [1, 2, '…', 4, 5, 6, '…', 9, 10]);
  });

  test('the first and last pages', () => {
    assert.deepEqual(pageNumbers(1, 10), [1, 2, '…', 9, 10]);
    assert.deepEqual(pageNumbers(10, 10), [1, 2, '…', 9, 10]);
    assert.deepEqual(pageNumbers(2, 10), [1, 2, 3, '…', 9, 10]);
    assert.deepEqual(pageNumbers(9, 10), [1, 2, '…', 8, 9, 10]);
  });

  test('every gap is "…", even a gap of one page', () => {
    assert.deepEqual(pageNumbers(4, 10), [1, 2, 3, 4, 5, '…', 9, 10]);
    assert.deepEqual(pageNumbers(7, 10), [1, 2, '…', 6, 7, 8, 9, 10]);
    assert.deepEqual(pageNumbers(5, 9), [1, 2, '…', 4, 5, 6, '…', 8, 9]);
  });

  test('few pages: all of them', () => {
    assert.deepEqual(pageNumbers(1, 1), [1]);
    assert.deepEqual(pageNumbers(2, 3), [1, 2, 3]);
    assert.deepEqual(pageNumbers(3, 5), [1, 2, 3, 4, 5]);
  });

  test('a page out of range is taken as the nearest page', () => {
    assert.deepEqual(pageNumbers(0, 4), [1, 2, 3, 4]);
    assert.deepEqual(pageNumbers(99, 10), [1, 2, '…', 9, 10]);
  });
});

describe('one page of a list', () => {
  const items = Array.from({ length: 20 }, (_, i) => i + 1);

  test('8 a page', () => {
    assert.equal(PAGE_SIZE, 8);
    const p2 = paginate(items, 2);
    assert.deepEqual(p2.items, [9, 10, 11, 12, 13, 14, 15, 16]);
    assert.deepEqual([p2.page, p2.pages, p2.from, p2.to, p2.total], [2, 3, 9, 16, 20]);
    assert.deepEqual(paginate(items, 3).items, [17, 18, 19, 20]);
  });

  test('a page past the end shows the last page; an empty list is one empty page', () => {
    assert.equal(paginate(items, 7).page, 3);
    const empty = paginate([], 1);
    assert.deepEqual([empty.items, empty.page, empty.pages, empty.from, empty.to], [[], 1, 1, 0, 0]);
  });
});

describe('time ago', () => {
  const now = Date.parse('2026-11-22T10:00:00Z');
  test('in words', () => {
    assert.equal(ago(now - 3000, now), 'just now');
    assert.equal(ago(now - 40000, now), '40 s ago');
    assert.equal(ago(now - 5 * 60000, now), '5 min ago');
    assert.equal(ago(now - 2 * 3600000, now), '2 h ago');
    assert.equal(ago(now - 3 * 86400000, now), '3 days ago');
    assert.equal(ago(null, now), '');
  });
});
