// Unit tests: pure positioning maths used by the IPS engine
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  getMedian,
  solveWeightedTrilateration,
  refinePositionWithinRoom,
  computeWeightedCentroid
} = require('../../services/ips/geometry');

// Anchor layout taken from the WARD-001 seed (metres)
const ANCHORS = [
  { x: 0.5, y: 4.3 },
  { x: 5.9, y: 4.3 },
  { x: 3.2, y: 0.5 }
];
const ROOM = { length_x: 6.4, width_y: 4.8 };

function withDistances(anchors, point, scale = 1) {
  return anchors.map(a => ({
    ...a,
    d: Math.hypot(a.x - point.x, a.y - point.y) * scale
  }));
}

function error(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

describe('getMedian', () => {
  test('odd count returns the middle value', () => {
    assert.equal(getMedian([5, 1, 3]), 3);
  });
  test('even count returns the mean of the two middle values', () => {
    assert.equal(getMedian([4, 1, 3, 2]), 2.5);
  });
  test('empty or missing input returns 0', () => {
    assert.equal(getMedian([]), 0);
    assert.equal(getMedian(null), 0);
  });
  test('does not modify the input array', () => {
    const input = [3, 1, 2];
    getMedian(input);
    assert.deepEqual(input, [3, 1, 2]);
  });
});

describe('solveWeightedTrilateration', () => {
  test('recovers the true point from exact distances (3 anchors)', () => {
    for (const truth of [{ x: 2.0, y: 2.0 }, { x: 4.5, y: 3.1 }, { x: 1.0, y: 1.0 }]) {
      const solved = solveWeightedTrilateration(withDistances(ANCHORS, truth));
      assert.ok(error(solved, truth) < 1e-6, `expected ${JSON.stringify(truth)}, got ${JSON.stringify(solved)}`);
    }
  });

  test('recovers the true point from exact distances (4 anchors)', () => {
    const truth = { x: 3.3, y: 2.7 };
    const anchors = [...ANCHORS, { x: 0.5, y: 0.5 }];
    const solved = solveWeightedTrilateration(withDistances(anchors, truth));
    assert.ok(error(solved, truth) < 1e-6);
  });

  test('returns null with fewer than 3 anchors', () => {
    assert.equal(solveWeightedTrilateration(withDistances(ANCHORS.slice(0, 2), { x: 2, y: 2 })), null);
    assert.equal(solveWeightedTrilateration(null), null);
  });

  test('collinear anchors fall back to a finite point', () => {
    const line = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 4, y: 0 }];
    const solved = solveWeightedTrilateration(withDistances(line, { x: 1, y: 1 }));
    assert.ok(Number.isFinite(solved.x) && Number.isFinite(solved.y));
  });

  test('does not reorder the caller\'s array', () => {
    const input = withDistances(ANCHORS, { x: 5.5, y: 4.0 });
    const snapshot = input.map(a => a.d);
    solveWeightedTrilateration(input);
    assert.deepEqual(input.map(a => a.d), snapshot);
  });
});

describe('refinePositionWithinRoom', () => {
  test('keeps an exact solution in place', () => {
    const truth = { x: 2.0, y: 2.0 };
    const refined = refinePositionWithinRoom(truth, withDistances(ANCHORS, truth), ROOM);
    assert.ok(error(refined, truth) < 1e-6);
  });

  test('pulls a start point outside the room back inside the walls', () => {
    const truth = { x: 2.0, y: 2.0 };
    const refined = refinePositionWithinRoom({ x: -3, y: 9 }, withDistances(ANCHORS, truth), ROOM);
    assert.ok(refined.x >= 0.15 && refined.x <= ROOM.length_x - 0.15);
    assert.ok(refined.y >= 0.15 && refined.y <= ROOM.width_y - 0.15);
  });

  test('moves a displaced start point closer to the true position', () => {
    const truth = { x: 2.0, y: 2.0 };
    const start = { x: 3.0, y: 3.0 };
    const refined = refinePositionWithinRoom(start, withDistances(ANCHORS, truth), ROOM);
    assert.ok(error(refined, truth) < error(start, truth));
  });
});

describe('computeWeightedCentroid', () => {
  test('lies nearer the anchor with the shorter distance', () => {
    const c = computeWeightedCentroid([
      { x: 0, y: 0, d: 1 },
      { x: 4, y: 0, d: 3 }
    ]);
    assert.ok(c.x < 2, `expected x below the midpoint, got ${c.x}`);
    assert.equal(c.y, 0);
  });

  test('equal distances give the midpoint', () => {
    const c = computeWeightedCentroid([
      { x: 0, y: 0, d: 2 },
      { x: 4, y: 2, d: 2 }
    ]);
    assert.ok(Math.abs(c.x - 2) < 1e-9 && Math.abs(c.y - 1) < 1e-9);
  });
});
