// Integration test: the incident log as a CSV download (GET /api/alerts/history.csv),
// on the running server against shiro_test: filters, file name and headers,
// formula neutralising, sign-in, headsets refused, and the audit record.
process.env.INFLUX_TOKEN = '';

const { db, freshDatabase, startServer, signIn, pairHeadset, TEST_NURSE } = require('./helper');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const HTTP_PORT = 3988;
const MQTT_PORT = 1878;
const BASE = `http://127.0.0.1:${HTTP_PORT}`;

function call(path, { cookie, bearer } = {}) {
  return fetch(BASE + path, {
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {})
    }
  });
}

async function addPatient(pool, id, name, nric) {
  await pool.query(
    `INSERT INTO patients (patient_id, full_name, nric_passport, dob, gender, phone_number, status)
     VALUES (?, ?, ?, '1950-01-01', 'OTHER', '0123456789', 'ADMITTED')`,
    [id, name, nric]
  );
}

async function addIncident(pool, { id, patientId, name, hoursAgo, category = 'FALL_ACCIDENT', simulated = 0, notes = null }) {
  await pool.query(
    `INSERT INTO emergency_incident_logs
       (incident_id, patient_id, patient_name, incident_category, trigger_timestamp, is_simulated, notes)
     VALUES (?, ?, ?, ?, NOW() - INTERVAL ? HOUR, ?, ?)`,
    [id, patientId, name, category, hoursAgo, simulated, notes]
  );
}

/** CSV text (without the byte order mark) → rows of fields; enough for these files. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\r' && text[i + 1] === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; i++; }
    else cur += c;
  }
  return rows;
}

describe('incident log CSV export', () => {
  let server;
  let pool;
  let nurse;
  let headsetToken;

  before(async () => {
    pool = await freshDatabase();
    await addPatient(pool, 'P-911', 'Csv, "Test" Patient', 'IT-CSV-911');
    await addPatient(pool, 'P-912', 'Other Patient', 'IT-CSV-912');
    await addIncident(pool, { id: 'IT-CSV-1', patientId: 'P-911', name: 'Csv, "Test" Patient', hoursAgo: 1, notes: '=HYPERLINK("http://x")' });
    await addIncident(pool, { id: 'IT-CSV-2', patientId: 'P-911', name: 'Csv, "Test" Patient', hoursAgo: 30, category: 'CRITICAL_VITALS' });
    await addIncident(pool, { id: 'IT-CSV-3', patientId: 'P-912', name: 'Other Patient', hoursAgo: 2, simulated: 1 });
    await db.closePool();

    server = startServer({ HTTP_PORT: String(HTTP_PORT), MQTT_PORT: String(MQTT_PORT) });
    await server.ready;
    nurse = await signIn(BASE, TEST_NURSE);
    const admin = await signIn(BASE);
    headsetToken = await pairHeadset(BASE, admin, 'QUEST3-CSV001', 'AA:BB:CC:DD:EE:91');
    pool = db.getPool();
  });

  after(async () => {
    if (server) await server.stop();
    await db.closePool();
  });

  test('every incident: a CSV attachment with a file name, counts in the headers, newest first', async () => {
    const res = await call('/api/alerts/history.csv', { cookie: nurse });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/csv; charset=utf-8/);
    assert.match(res.headers.get('content-disposition'), /^attachment; filename="shiro-incidents_all-patients_all_\d{8}-\d{4}\.csv"$/);
    assert.equal(res.headers.get('x-shiro-total-count'), '3');
    assert.equal(res.headers.get('x-shiro-exported-count'), '3');

    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 3)], [0xEF, 0xBB, 0xBF]); // UTF-8 byte order mark
    const rows = parseCsv(new TextDecoder().decode(bytes.slice(3)));
    assert.equal(rows.length, 4);                      // header + 3
    assert.equal(rows[0][0], 'Incident ID');
    assert.deepEqual(rows.slice(1).map(r => r[0]), ['IT-CSV-1', 'IT-CSV-3', 'IT-CSV-2']);
  });

  test('the dashboard\'s filters apply: patient, range, type, Live Lab tests left out', async () => {
    const text = async (q) => {
      const res = await call(`/api/alerts/history.csv?${q}`, { cookie: nurse });
      assert.equal(res.status, 200);
      // res.text() decodes UTF-8 and drops the byte order mark (checked in the first test)
      return parseCsv(await res.text()).slice(1).map(r => r[0]);
    };
    assert.deepEqual(await text('patient_id=P-911'), ['IT-CSV-1', 'IT-CSV-2']);
    assert.deepEqual(await text('range=24h'), ['IT-CSV-1', 'IT-CSV-3']);
    assert.deepEqual(await text('category=CRITICAL_VITALS'), ['IT-CSV-2']);
    assert.deepEqual(await text('simulated=exclude'), ['IT-CSV-1', 'IT-CSV-2']);
  });

  test('names with commas and quotes survive; a formula in the notes cannot run', async () => {
    const res = await call('/api/alerts/history.csv?patient_id=P-911&range=24h', { cookie: nurse });
    const [header, row] = parseCsv(await res.text());
    const v = Object.fromEntries(header.map((h, i) => [h, row[i]]));
    assert.equal(v['Patient name'], 'Csv, "Test" Patient');
    assert.equal(v.Notes, '\'=HYPERLINK("http://x")');
    assert.equal(v['Heart rate (bpm)'], '');           // not measured: empty, not 0
  });

  test('not signed in: 401; a headset: 403 (the export is for clinicians)', async () => {
    assert.equal((await call('/api/alerts/history.csv')).status, 401);
    assert.equal((await call('/api/alerts/history.csv', { bearer: headsetToken })).status, 403);
  });

  test('a bad filter: 400 with a message, no file', async () => {
    const res = await call('/api/alerts/history.csv?range=forever', { cookie: nurse });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /range/);
  });

  test('every export is in the audit log with who, what and how many rows', async () => {
    await call('/api/alerts/history.csv?patient_id=P-912', { cookie: nurse });
    await new Promise(r => setTimeout(r, 300));       // the audit write follows the answer
    const [rows] = await pool.query(
      "SELECT actor_label, target_type, target_id, details FROM audit_log WHERE action = 'INCIDENTS_EXPORT' ORDER BY audit_id DESC LIMIT 1"
    );
    assert.equal(rows.length, 1);
    assert.match(rows[0].actor_label, /Integration Nurse/);
    assert.equal(rows[0].target_type, 'PATIENT');
    assert.equal(rows[0].target_id, 'P-912');
    assert.deepEqual(JSON.parse(rows[0].details), { range: 'all', simulated: 'include', rows: 1 });
  });
});
