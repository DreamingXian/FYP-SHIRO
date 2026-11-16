// Integration test: incident history per patient and one-time acknowledgement,
// on the running server against shiro_test.
process.env.INFLUX_TOKEN = '';

const { db, freshDatabase, startServer, signIn, pairHeadset, TEST_NURSE } = require('./helper');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const HTTP_PORT = 3995;
const MQTT_PORT = 1885;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;

function call(path, { method = 'GET', cookie, bearer, body } = {}) {
  return fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function addPatient(pool, id, nric) {
  await pool.query(
    `INSERT INTO patients (patient_id, full_name, nric_passport, dob, gender, phone_number, status)
     VALUES (?, ?, ?, '1950-01-01', 'OTHER', '0123456789', 'ADMITTED')`,
    [id, `History ${id}`, nric]
  );
}

/** An incident that happened `daysAgo` days ago. */
async function addIncident(pool, { id, patientId, daysAgo, category = 'FALL_ACCIDENT', simulated = 0, ackAfterSeconds = null, clinician = null }) {
  await pool.query(
    `INSERT INTO emergency_incident_logs
       (incident_id, patient_id, patient_name, incident_category, trigger_timestamp, is_simulated,
        resolution_status, acknowledgment_time, response_latency_seconds, attending_clinician)
     VALUES (?, ?, ?, ?, NOW() - INTERVAL ? HOUR, ?, ?, ?, ?, ?)`,
    [
      id, patientId, `History ${patientId}`, category, daysAgo * 24, simulated,
      ackAfterSeconds === null ? 'PENDING' : 'ACKNOWLEDGED',
      ackAfterSeconds === null ? null : new Date(),
      ackAfterSeconds, clinician
    ]
  );
}

describe('incident history and acknowledgement', () => {
  let server;
  let pool;
  let admin;
  let nurse;

  before(async () => {
    pool = await freshDatabase();
    await addPatient(pool, 'P-901', 'IT-HIST-901');
    await addPatient(pool, 'P-902', 'IT-HIST-902');
    // P-901: four incidents over 40 days; P-902: one
    await addIncident(pool, { id: 'IT-INC-1', patientId: 'P-901', daysAgo: 0.1, ackAfterSeconds: null });
    await addIncident(pool, { id: 'IT-INC-2', patientId: 'P-901', daysAgo: 3, ackAfterSeconds: 30, clinician: 'Nurse A (CLN-009)' });
    await addIncident(pool, { id: 'IT-INC-3', patientId: 'P-901', daysAgo: 10, category: 'CRITICAL_VITALS', simulated: 1, ackAfterSeconds: 90, clinician: 'Nurse B (CLN-010)' });
    await addIncident(pool, { id: 'IT-INC-4', patientId: 'P-901', daysAgo: 40, ackAfterSeconds: 60, clinician: 'Nurse A (CLN-009)' });
    await addIncident(pool, { id: 'IT-INC-5', patientId: 'P-902', daysAgo: 1, ackAfterSeconds: null });

    server = startServer({ HTTP_PORT: String(HTTP_PORT), MQTT_PORT: String(MQTT_PORT) });
    await server.ready;
    admin = await signIn(BASE);
    nurse = await signIn(BASE, TEST_NURSE);
  });

  after(async () => {
    if (server) await server.stop();
    await db.closePool();
  });

  test('one patient\'s history only holds that patient\'s incidents, newest first', async () => {
    const res = await call('/api/alerts/history?patient_id=P-901', { cookie: nurse });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data.history.map(h => h.incident_id), ['IT-INC-1', 'IT-INC-2', 'IT-INC-3', 'IT-INC-4']);
    assert.equal(data.truncated, false);
    assert.deepEqual(data.summary, {
      total: 4, falls: 3, critical_vitals: 1, geofence: 0, pending: 1, acknowledged: 3,
      simulated: 1, avg_response_seconds: 60, max_response_seconds: 90
    });
  });

  test('the time range, type and Live Lab filters narrow the list and its summary', async () => {
    const week = await (await call('/api/alerts/history?patient_id=P-901&range=7d', { cookie: nurse })).json();
    assert.deepEqual(week.history.map(h => h.incident_id), ['IT-INC-1', 'IT-INC-2']);
    assert.equal(week.summary.total, 2);

    const month = await (await call('/api/alerts/history?patient_id=P-901&range=30d', { cookie: nurse })).json();
    assert.equal(month.summary.total, 3);

    const falls = await (await call('/api/alerts/history?patient_id=P-901&category=FALL_ACCIDENT', { cookie: nurse })).json();
    assert.equal(falls.summary.total, 3);
    assert.ok(falls.history.every(h => h.incident_category === 'FALL_ACCIDENT'));

    const real = await (await call('/api/alerts/history?patient_id=P-901&simulated=exclude', { cookie: nurse })).json();
    assert.ok(real.history.every(h => h.is_simulated === 0));
    assert.equal(real.summary.simulated, 0);
  });

  test('a limit cuts the list but not the summary, and says so', async () => {
    const data = await (await call('/api/alerts/history?patient_id=P-901&limit=1', { cookie: nurse })).json();
    assert.equal(data.history.length, 1);
    assert.equal(data.summary.total, 4);
    assert.equal(data.truncated, true);
  });

  test('without an acknowledged incident the response time is unknown, not 0 s', async () => {
    const data = await (await call('/api/alerts/history?patient_id=P-902', { cookie: nurse })).json();
    assert.equal(data.summary.total, 1);
    assert.equal(data.summary.avg_response_seconds, null);
  });

  test('all patients together when no patient is named', async () => {
    const data = await (await call('/api/alerts/history', { cookie: nurse })).json();
    assert.equal(data.summary.total, 5);
  });

  test('a paired headset may read the history; nobody else without signing in', async () => {
    const token = await pairHeadset(BASE, admin, 'QUEST3-HIST01', '02:AA:BB:CC:DD:01');
    assert.equal((await call('/api/alerts/history?patient_id=P-901', { bearer: token })).status, 200);
    assert.equal((await call('/api/alerts/history?patient_id=P-901')).status, 401);
  });

  test('the first acknowledgement is kept: a second one is a 409, an unknown incident a 404', async () => {
    const first = await call('/api/alerts/acknowledge', { method: 'POST', cookie: nurse, body: { incident_id: 'IT-INC-5' } });
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.match(firstBody.attending_clinician, /CLN-002/);

    const second = await call('/api/alerts/acknowledge', { method: 'POST', cookie: admin, body: { incident_id: 'IT-INC-5' } });
    assert.equal(second.status, 409);
    assert.match((await second.json()).error, /already acknowledged by .*CLN-002/);

    const [[row]] = await pool.query('SELECT attending_clinician, resolution_status FROM emergency_incident_logs WHERE incident_id = ?', ['IT-INC-5']);
    assert.equal(row.resolution_status, 'ACKNOWLEDGED');
    assert.match(row.attending_clinician, /CLN-002/, 'the second click did not overwrite who responded');

    const missing = await call('/api/alerts/acknowledge', { method: 'POST', cookie: nurse, body: { incident_id: 'IT-INC-404' } });
    assert.equal(missing.status, 404);
  });

  test('the history shows who acknowledged and how fast', async () => {
    const data = await (await call('/api/alerts/history?patient_id=P-902', { cookie: nurse })).json();
    const [inc] = data.history;
    assert.equal(inc.resolution_status, 'ACKNOWLEDGED');
    assert.match(inc.attending_clinician, /CLN-002/);
    assert.ok(inc.acknowledgment_time);
    assert.equal(typeof inc.response_latency_seconds, 'number');
  });
});
