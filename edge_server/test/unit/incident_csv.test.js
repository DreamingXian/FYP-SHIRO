// Unit tests: the incident log as CSV (services/alerts/incident_csv.js).
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { COLUMNS, csvCell, incidentsToCsv, csvFileName, formatLocalTime } = require('../../services/alerts/incident_csv');

/** Splits one CSV line into fields, honouring quotes (enough for these tests). */
function parseLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const FALL = {
  incident_id: 'INC-20261119-0001',
  trigger_timestamp: new Date(2026, 10, 19, 9, 5, 7),
  incident_category: 'FALL_ACCIDENT',
  is_simulated: 0,
  patient_id: 'P-001',
  patient_name: 'Tan, Ah Kow "Uncle"',
  ward_id: 'WARD-004',
  bed_id: 'B-01',
  wristband_mac: 'C4:DE:E2:10:01:AB',
  pos_x: -1.234,
  pos_y: 2.5,
  kinematic_impact_force: 3.456,
  freefall_min_g: 0.21,
  post_impact_stillness: 0.04,
  heart_rate: 0,
  spo2: null,
  alert_message: 'Fall detected\nnear the bed',
  resolution_status: 'ACKNOWLEDGED',
  acknowledgment_time: new Date(2026, 10, 19, 9, 6, 0),
  response_latency_seconds: 52.97,
  attending_clinician: 'Nurse Lim (CLN-002)',
  notes: null
};

describe('csvCell', () => {
  test('plain text and numbers as they are; nothing missing is filled in', () => {
    assert.equal(csvCell('WARD-004'), 'WARD-004');
    assert.equal(csvCell(52.9), '52.9');
    assert.equal(csvCell(-1.23), '-1.23');            // a number: no apostrophe
    assert.equal(csvCell(0), '0');
    assert.equal(csvCell(null), '');
    assert.equal(csvCell(undefined), '');
    assert.equal(csvCell(NaN), '');
  });

  test('commas, quotes and line breaks are quoted; quotes doubled', () => {
    assert.equal(csvCell('a,b'), '"a,b"');
    assert.equal(csvCell('say "hi"'), '"say ""hi"""');
    assert.equal(csvCell('two\nlines'), '"two\nlines"');
  });

  test('a text that a spreadsheet would run as a formula gets a leading apostrophe', () => {
    for (const evil of ['=HYPERLINK("http://x","click")', '+1+1', '-2+3', '@SUM(A1)', '\t=1', '\r=1']) {
      const cell = csvCell(evil);
      const value = cell.startsWith('"') ? parseLine(cell)[0] : cell;
      assert.equal(value[0], "'", `not neutralised: ${JSON.stringify(evil)}`);
    }
    assert.equal(csvCell('Nurse = Lim'), 'Nurse = Lim'); // only at the start
  });
});

describe('incidentsToCsv', () => {
  const csv = incidentsToCsv([FALL]);

  test('starts with a UTF-8 byte order mark; CRLF line ends; a header and one row', () => {
    assert.equal(csv[0], '\uFEFF');
    assert.ok(csv.endsWith('\r\n'));
    assert.equal(parseLine(csv.slice(1).split('\r\n')[0]).length, COLUMNS.length);
  });

  test('values of the row, in column order', () => {
    // The alert message holds a line break inside quotes: split on CRLF only
    const lines = csv.slice(1).split('\r\n');
    const header = parseLine(lines[0]);
    const row = parseLine(lines[1]);
    const v = Object.fromEntries(header.map((h, i) => [h, row[i]]));
    assert.equal(v['Incident ID'], 'INC-20261119-0001');
    assert.equal(v['Time (local)'], '2026-11-19 09:05:07');
    assert.equal(v.Type, 'Fall');
    assert.equal(v['Live Lab test'], 'no');
    assert.equal(v['Patient name'], 'Tan, Ah Kow "Uncle"');
    assert.equal(v['Position x (m)'], '-1.23');
    assert.equal(v['Impact (g)'], '3.46');
    assert.equal(v['Heart rate (bpm)'], '');          // 0 = no reading, not "0 bpm"
    assert.equal(v['SpO2 indicative (%)'], '');
    assert.equal(v['Alert message'], 'Fall detected\nnear the bed');
    assert.equal(v['Acknowledged at (local)'], '2026-11-19 09:06:00');
    assert.equal(v['Response time (s)'], '53');
    assert.equal(v.Responder, 'Nurse Lim (CLN-002)');
    assert.equal(v.Notes, '');
  });

  test('a simulated, unacknowledged incident', () => {
    const lines = incidentsToCsv([{ ...FALL, is_simulated: 1, resolution_status: 'PENDING', acknowledgment_time: null, response_latency_seconds: null, attending_clinician: null }])
      .slice(1).split('\r\n');
    const header = parseLine(lines[0]);
    const row = parseLine(lines[1]);
    const v = Object.fromEntries(header.map((h, i) => [h, row[i]]));
    assert.equal(v['Live Lab test'], 'yes');
    assert.equal(v.Status, 'PENDING');
    assert.equal(v['Acknowledged at (local)'], '');
    assert.equal(v.Responder, '');
  });

  test('no incidents: only the header', () => {
    assert.equal(incidentsToCsv([]).slice(1).split('\r\n').filter(Boolean).length, 1);
  });
});

describe('csvFileName and formatLocalTime', () => {
  const now = new Date(2026, 10, 19, 15, 30, 0);
  test('names the scope, range, type and time; only safe characters', () => {
    assert.equal(csvFileName({ range: '30d', now }), 'shiro-incidents_all-patients_30d_20261119-1530.csv');
    assert.equal(csvFileName({ patientId: 'P-001', range: 'all', category: 'FALL_ACCIDENT', now }),
      'shiro-incidents_P-001_all_FALL_ACCIDENT_20261119-1530.csv');
    assert.match(csvFileName({ patientId: 'a"b/c', now }), /^[A-Za-z0-9_.-]+$/);
  });

  test('times: Date or text in, local "YYYY-MM-DD HH:MM:SS" out; nothing for no time', () => {
    assert.equal(formatLocalTime(new Date(2026, 0, 2, 3, 4, 5)), '2026-01-02 03:04:05');
    assert.equal(formatLocalTime(null), null);
    assert.equal(formatLocalTime('not a time'), null);
  });
});
