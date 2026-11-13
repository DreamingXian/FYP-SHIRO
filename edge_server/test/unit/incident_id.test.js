// Unit tests: incident ID sequence
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { dateKey, formatIncidentId, createIncidentIdGenerator } = require('../../services/alerts/incident_id');

describe('incident ID format', () => {
  test('date key is YYYYMMDD in local time, zero padded', () => {
    assert.equal(dateKey(new Date(2026, 0, 5, 23, 59)), '20260105');
    assert.equal(dateKey(new Date(2026, 10, 13)), '20261113');
  });

  test('sequence is zero padded to four digits and can grow beyond', () => {
    assert.equal(formatIncidentId('20261113', 1), 'INC-20261113-0001');
    assert.equal(formatIncidentId('20261113', 123), 'INC-20261113-0123');
    assert.equal(formatIncidentId('20261113', 12345), 'INC-20261113-12345');
  });
});

describe('incident ID generator', () => {
  test('starts at 1 on a day with no incidents', async () => {
    const next = createIncidentIdGenerator({ loadMaxSequence: async () => 0, now: () => new Date(2026, 10, 13) });
    assert.equal(await next(), 'INC-20261113-0001');
    assert.equal(await next(), 'INC-20261113-0002');
  });

  test('continues after the highest number already stored', async () => {
    const next = createIncidentIdGenerator({ loadMaxSequence: async () => 9876, now: () => new Date(2026, 10, 13) });
    assert.equal(await next(), 'INC-20261113-9877');
  });

  test('100 concurrent requests receive 100 distinct IDs and load the store once', async () => {
    let loads = 0;
    const next = createIncidentIdGenerator({
      loadMaxSequence: async () => { loads++; await new Promise(r => setTimeout(r, 5)); return 40; },
      now: () => new Date(2026, 10, 13)
    });
    const ids = await Promise.all(Array.from({ length: 100 }, () => next()));
    assert.equal(new Set(ids).size, 100);
    assert.equal(loads, 1);
    assert.ok(ids.includes('INC-20261113-0041') && ids.includes('INC-20261113-0140'));
  });

  test('restarts the sequence on a new day', async () => {
    let today = new Date(2026, 10, 13, 23, 59);
    const stored = { '20261113': 7, '20261114': 0 };
    const next = createIncidentIdGenerator({ loadMaxSequence: async (key) => stored[key], now: () => today });
    assert.equal(await next(), 'INC-20261113-0008');
    today = new Date(2026, 10, 14, 0, 1);
    assert.equal(await next(), 'INC-20261114-0001');
  });

  test('still produces IDs when the store cannot be read', async () => {
    const next = createIncidentIdGenerator({
      loadMaxSequence: async () => { throw new Error('db down'); },
      now: () => new Date(2026, 10, 13)
    });
    assert.equal(await next(), 'INC-20261113-0001');
  });
});
