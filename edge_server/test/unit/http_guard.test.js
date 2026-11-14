// Unit tests: the router refuses bad requests before any database is involved.
// The real request handler runs on a spare port. Every request here must be refused
// (or served from public/) before a query. no_database.js makes sure of it: a
// request that got past validation would find no database, and its test would fail.
const guard = require('./no_database');

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { handleRequest, resolvePublicFile } = require('../../routes/index');
const db = require('../../database/db');
const { JSON_BODY_LIMIT } = require('../../utils/http');

const PUBLIC_DIR = path.resolve(__dirname, '..', '..', 'public');
const UPLOAD_DIR = path.join(PUBLIC_DIR, 'uploads', 'patients');

let server;
let base;
let port;

before(async () => {
  server = http.createServer((req, res) => {
    handleRequest(req, res).catch(() => { res.statusCode = 500; res.end(); });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await db.closePool();
});

test('this file cannot reach a real database', () => {
  assert.equal(db.dbConfig.port, guard.DB_PORT);
  assert.equal(db.dbConfig.database, guard.DB_NAME);
});

const post = (pathname, body, headers = {}) => fetch(base + pathname, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body)
});

/** Sends a request line exactly as written: fetch() would tidy the path first. */
function rawGet(rawPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let answer = '';
    socket.on('connect', () => socket.write(`GET ${rawPath} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`));
    socket.on('data', (d) => { answer += d; });
    socket.on('end', () => resolve({ status: Number(answer.slice(9, 12)), text: answer }));
    socket.on('error', reject);
  });
}

async function expectError(res, status) {
  const data = await res.json();
  assert.equal(res.status, status, JSON.stringify(data));
  assert.equal(data.success, false);
  assert.equal(typeof data.error, 'string');
  return data;
}

describe('response headers', () => {
  test('every response forbids content-type guessing and framing', async () => {
    for (const pathname of ['/', '/js/app.js', '/api/nothing', '/missing.html']) {
      const res = await fetch(base + pathname);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff', pathname);
      assert.equal(res.headers.get('x-frame-options'), 'DENY', pathname);
      await res.arrayBuffer();
    }
  });

  test('no other website is given access', async () => {
    const res = await fetch(base + '/api/nothing', { headers: { Origin: 'http://evil.example' } });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    await res.arrayBuffer();
  });
});

describe('static files', () => {
  test('the dashboard is served', async () => {
    const res = await fetch(base + '/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(await res.text(), /<html/i);
  });

  test('a path that leaves public/ is never resolved', () => {
    const outside = [
      '/../.env', '/..%2f.env', '/%2e%2e/%2e%2e/.env', '/..\\.env', '/%2e%2e%5c.env', '/js/../../.env',
      '/uploads/patients/../../../server.js', '/a%00.html', '/%zz'
    ];
    for (const pathname of outside) assert.equal(resolvePublicFile(pathname), null, pathname);
    assert.equal(resolvePublicFile('/js/app.js'), path.join(PUBLIC_DIR, 'js', 'app.js'));
    assert.equal(resolvePublicFile('/'), path.join(PUBLIC_DIR, 'index.html'));
  });

  test('requests for files outside public/ do not return them', async () => {
    for (const rawPath of ['/../.env', '/..%2f.env', '/%2e%2e%5c.env', '/js/..%2f..%2fserver.js', '/..%5c..%5cpackage.json']) {
      const res = await rawGet(rawPath);
      assert.ok(res.status === 400 || res.status === 404, `${rawPath} -> ${res.status}`);
      assert.doesNotMatch(res.text, /DB_PASSWORD|INFLUX_TOKEN|"dependencies"|createServer/, rawPath);
    }
  });

  test('a missing file is a 404 that does not repeat the request path', async () => {
    const res = await fetch(base + '/%3Cscript%3Ealert(1)%3C/script%3E');
    assert.equal(res.status, 404);
    assert.doesNotMatch(await res.text(), /script/);
  });

  test('static files cannot be changed through the server', async () => {
    const res = await fetch(base + '/index.html', { method: 'DELETE' });
    assert.equal(res.status, 405);
    await res.arrayBuffer();
  });
});

describe('API requests', () => {
  test('an unknown API address is a JSON 404', async () => {
    await expectError(await fetch(base + '/api/nothing'), 404);
    await expectError(await fetch(base + '/api/patientsX'), 404);
  });

  test('a body that is not valid JSON is a 400', async () => {
    await expectError(await post('/api/patients/assign-bed', '{"patient_id": '), 400);
    await expectError(await post('/api/bindings/bind', '[1,2,3]'), 400);
    await expectError(await post('/api/ward/calibration/reset', 'ward_id=WARD-001'), 400);
  });

  test('a body over the limit is a 413', async () => {
    const res = await post('/api/patients/admit', { medical_history: 'x'.repeat(JSON_BODY_LIMIT + 10) });
    await expectError(res, 413);
  });

  test('a request sent by a page of another website is refused', async () => {
    const res = await post('/api/patients/delete', { patient_id: 'P-001' }, { Origin: 'http://evil.example' });
    await expectError(res, 403);
    const form = await fetch(base + '/api/patients/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Origin: 'http://evil.example' },
      body: '{"patient_id":"P-001"}'
    });
    await expectError(form, 403);
  });

  test('a missing identifier is a 400: no default patient, ward or device is used', async () => {
    assert.match((await expectError(await fetch(base + '/api/patients/vitals-history'), 400)).error, /id/);
    assert.match((await expectError(await fetch(base + '/api/patients/get'), 400)).error, /id/);
    assert.match((await expectError(await fetch(base + '/api/ward/config'), 400)).error, /ward_id/);
    assert.match((await expectError(await fetch(base + '/api/ward/ips-init'), 400)).error, /ward_id/);
    assert.match((await expectError(await post('/api/ward/save-anchor', { spatial_anchor_uuid: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789' }), 400)).error, /ward_id/);
    assert.match((await expectError(await post('/api/ward/calibration/reset', {}), 400)).error, /ward_id/);
    assert.match((await expectError(await post('/api/ward/config', { room_title: 'No ID' }), 400)).error, /ward_id/);
    assert.match((await expectError(await post('/api/patients/upload-photo', { image_data: 'data:image/png;base64,AAAA' }), 400)).error, /patient_id/);
    assert.match((await expectError(await post('/api/devices/ping', {}), 400)).error, /device_id/);
    assert.match((await expectError(await fetch(base + '/api/devices/next-id'), 400)).error, /type/);
  });

  test('identifiers and lists with an invalid form are a 400', async () => {
    await expectError(await fetch(base + '/api/patients/get?id=' + encodeURIComponent("P-001' OR '1'='1")), 400);
    await expectError(await fetch(base + '/api/patients/list?status=' + encodeURIComponent('ADMITTED; DROP TABLE patients')), 400);
    await expectError(await fetch(base + '/api/devices/list?type=TOASTER'), 400);
    await expectError(await fetch(base + '/api/alerts/history?limit=' + encodeURIComponent('5; DROP TABLE x')), 400);
    await expectError(await post('/api/bindings/bind', { patient_id: 'P-001', device_id: '<img src=x>' }), 400);
    await expectError(await post('/api/devices/enroll', { device_id: 'TAG-900', mac_address: 'not-a-mac', device_type: 'WRISTBAND' }), 400);
    await expectError(await post('/api/alerts/acknowledge', { incident_id: { $ne: null } }), 400);
    await expectError(await post('/api/patients/assign-bed', { patient_id: 'P-001', ward_id: '../x', bed_id: 'BED-001-01' }), 400);
  });

  test('a query injection in the vitals history range or patient ID is a 400', async () => {
    const range = encodeURIComponent('-1h) |> drop(columns: ["_value"]) //');
    assert.match((await expectError(await fetch(`${base}/api/patients/vitals-history?id=P-001&range=${range}`), 400)).error, /range/);
    const id = encodeURIComponent('P-001" or r._measurement == "spatial_trajectories');
    assert.match((await expectError(await fetch(`${base}/api/patients/vitals-history?id=${id}&range=-1h`), 400)).error, /id/);
  });

  test('a photo upload cannot name its own path or carry something that is not a photo', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(32, 1)]).toString('base64');
    const html = Buffer.from('<html><script>alert(1)</script></html>').toString('base64');
    const filesBefore = fs.existsSync(UPLOAD_DIR) ? fs.readdirSync(UPLOAD_DIR).sort() : [];
    const publicBefore = fs.readdirSync(PUBLIC_DIR).sort();

    await expectError(await post('/api/patients/upload-photo', { patient_id: '../../evil', image_data: `data:image/png;base64,${png}` }), 400);
    await expectError(await post('/api/patients/upload-photo', { patient_id: '..\\..\\evil', image_data: `data:image/png;base64,${png}` }), 400);
    await expectError(await post('/api/patients/upload-photo', { patient_id: 'UTEST-1', image_data: `data:image/html;base64,${html}` }), 415);
    await expectError(await post('/api/patients/upload-photo', { patient_id: 'UTEST-1', image_data: `data:text/html;base64,${html}` }), 400);
    await expectError(await post('/api/patients/upload-photo', { patient_id: 'UTEST-1', image_data: { not: 'text' } }), 400);

    assert.deepEqual(fs.existsSync(UPLOAD_DIR) ? fs.readdirSync(UPLOAD_DIR).sort() : [], filesBefore, 'nothing was written to the upload folder');
    assert.deepEqual(fs.readdirSync(PUBLIC_DIR).sort(), publicBefore, 'nothing was written next to it');
    assert.equal(fs.existsSync(path.join(PUBLIC_DIR, '..', 'evil')), false);
  });

  test('patient fields with a wrong type or value are a 400', async () => {
    const patient = { full_name: 'Test Patient', nric_passport: 'A1234567', dob: '1960-01-01', phone_number: '0123456789' };
    await expectError(await post('/api/patients/admit', { ...patient, gender: 'ROBOT' }), 400);
    await expectError(await post('/api/patients/admit', { ...patient, fall_risk_score: 'EXTREME' }), 400);
    await expectError(await post('/api/patients/admit', { ...patient, full_name: { toString: 1 } }), 400);
    await expectError(await post('/api/patients/admit', { ...patient, dob: '01/01/1960' }), 400);
    await expectError(await post('/api/patients/admit', { ...patient, photo_url: 'javascript:alert(1)' }), 400);
    await expectError(await post('/api/patients/admit', { ...patient, photo_url: 'https://evil.example/x.png' }), 400);
    await expectError(await post('/api/patients/admit', { ...patient, photo_url: '/uploads/patients/../../index.html' }), 400);
    await expectError(await post('/api/patients/admit', { ...patient, patient_id: 'P 1' }), 400);
  });
});
