// Unit tests: wristband -> patient binding cache
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createBindingCache } = require('../../services/binding_cache');

function fakeStore(initial) {
  const store = { rows: initial, loads: 0 };
  store.load = async () => { store.loads++; return store.rows; };
  return store;
}

describe('binding cache', () => {
  test('returns null before any binding is loaded', () => {
    const cache = createBindingCache({ load: async () => [], now: () => 0, maxAgeMs: Infinity });
    assert.equal(cache.getPatientIdForDevice('TAG-001'), null);
  });

  test('returns the bound patient after a refresh, ignoring case and spaces', async () => {
    const store = fakeStore([{ device_id: 'TAG-001', patient_id: 'P-001' }]);
    const cache = createBindingCache({ load: store.load, now: () => 1000 });
    await cache.refresh();
    assert.equal(cache.getPatientIdForDevice('TAG-001'), 'P-001');
    assert.equal(cache.getPatientIdForDevice(' tag-001 '), 'P-001');
    assert.equal(cache.getPatientIdForDevice('TAG-002'), null);
  });

  test('a wristband moved to another patient maps to the new patient only', async () => {
    const store = fakeStore([{ device_id: 'TAG-001', patient_id: 'P-001' }]);
    const cache = createBindingCache({ load: store.load, now: () => 1000 });
    await cache.refresh();

    store.rows = []; // unbound
    await cache.refresh();
    assert.equal(cache.getPatientIdForDevice('TAG-001'), null);

    store.rows = [{ device_id: 'TAG-001', patient_id: 'P-002' }]; // bound to someone else
    await cache.refresh();
    assert.equal(cache.getPatientIdForDevice('TAG-001'), 'P-002');
  });

  test('a stale cache answers from memory and refreshes in the background', async () => {
    let time = 1000;
    const store = fakeStore([{ device_id: 'TAG-001', patient_id: 'P-001' }]);
    const cache = createBindingCache({ load: store.load, now: () => time, maxAgeMs: 15000 });
    await cache.refresh();
    assert.equal(store.loads, 1);

    time += 5000; // still fresh: no reload
    cache.getPatientIdForDevice('TAG-001');
    assert.equal(store.loads, 1);

    store.rows = [{ device_id: 'TAG-001', patient_id: 'P-002' }];
    time += 20000; // stale: old answer now, reload started
    assert.equal(cache.getPatientIdForDevice('TAG-001'), 'P-001');
    await cache.refresh(); // joins the reload already in flight
    assert.equal(store.loads, 2);
    assert.equal(cache.getPatientIdForDevice('TAG-001'), 'P-002');
  });

  test('a failed reload keeps the last known bindings', async () => {
    let fail = false;
    const cache = createBindingCache({
      load: async () => { if (fail) throw new Error('db down'); return [{ device_id: 'TAG-001', patient_id: 'P-001' }]; },
      now: () => 1000
    });
    await cache.refresh();
    fail = true;
    await assert.rejects(cache.refresh(), /db down/);
    assert.equal(cache.getPatientIdForDevice('TAG-001'), 'P-001');
  });
});
