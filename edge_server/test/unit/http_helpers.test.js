// Unit tests: request body reading, JSON parsing and what an error may tell the client.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const h = require('../../utils/http');

/** A stand-in for a response object that records what was sent. */
function fakeResponse() {
  return {
    headersSent: false,
    status: null,
    body: null,
    writeHead(status) { this.status = status; this.headersSent = true; },
    end(text) { this.body = text ? JSON.parse(text) : null; }
  };
}

function quietly(fn) {
  const original = console.error;
  const logged = [];
  console.error = (...args) => { logged.push(args); };
  try { fn(); } finally { console.error = original; }
  return logged;
}

describe('JSON request bodies', () => {
  test('an object is returned, an empty body is an empty object', () => {
    assert.deepEqual(h.parseJsonBody('{"a":1}'), { a: 1 });
    assert.deepEqual(h.parseJsonBody(''), {});
    assert.deepEqual(h.parseJsonBody('   '), {});
    assert.deepEqual(h.parseJsonBody(undefined), {});
  });

  test('invalid JSON is a 400, not a server error', () => {
    for (const body of ['{', 'patient_id=P-001', '{"a":}', "{'a':1}"]) {
      assert.throws(() => h.parseJsonBody(body), (err) => err instanceof h.HttpError && err.status === 400, body);
    }
  });

  test('JSON that is not an object is a 400', () => {
    for (const body of ['[]', '[{"a":1}]', '"text"', '5', 'null', 'true']) {
      assert.throws(() => h.parseJsonBody(body), (err) => err instanceof h.HttpError && err.status === 400, body);
    }
  });
});

describe('what a failed request tells the client', () => {
  test('a validation error keeps its status and message', () => {
    const res = fakeResponse();
    h.sendFailure(res, new h.HttpError(404, 'Patient "P-999" not found'), 'test');
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { success: false, error: 'Patient "P-999" not found' });
  });

  test('a rule broken by the request is a 400 with its message', () => {
    const res = fakeResponse();
    h.sendFailure(res, new Error('Bed BED-001-01 is currently OCCUPIED and cannot be assigned.'), 'test');
    assert.equal(res.status, 400);
    assert.match(res.body.error, /OCCUPIED/);
  });

  test('a database error is logged on the server and not sent to the client', () => {
    const dbError = Object.assign(new Error("Duplicate entry 'P-001' for key 'PRIMARY'"), {
      code: 'ER_DUP_ENTRY', errno: 1062, sqlState: '23000',
      sqlMessage: "Duplicate entry 'P-001' for key 'PRIMARY'", sql: 'INSERT INTO patients (patient_id) VALUES (\'P-001\')'
    });
    const res = fakeResponse();
    const logged = quietly(() => h.sendFailure(res, dbError, 'admitPatient'));
    assert.equal(res.status, 500);
    assert.equal(res.body.error, h.GENERIC_SERVER_ERROR);
    assert.doesNotMatch(JSON.stringify(res.body), /Duplicate|INSERT|patients|PRIMARY/);
    assert.equal(logged.length, 1, 'the full error must be in the server log');
  });

  test('a lost database connection and a programming error are answered the same way', () => {
    const errors = [
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3306'), { code: 'ECONNREFUSED', errno: -4078 }),
      new TypeError("Cannot read properties of undefined (reading 'trim')")
    ];
    for (const err of errors) {
      const res = fakeResponse();
      quietly(() => h.sendFailure(res, err, 'test'));
      assert.equal(res.status, 500);
      assert.equal(res.body.error, h.GENERIC_SERVER_ERROR);
    }
  });

  test('nothing is written when the response has already started', () => {
    const res = fakeResponse();
    res.headersSent = true;
    h.sendError(res, 400, 'late');
    assert.equal(res.status, null);
  });
});

describe('requests from other websites', () => {
  const request = (headers) => ({ headers });

  test('the dashboard itself and clients without an Origin header are accepted', () => {
    assert.equal(h.isCrossSiteRequest(request({ host: '192.168.1.20:3000', origin: 'http://192.168.1.20:3000' })), false);
    assert.equal(h.isCrossSiteRequest(request({ host: 'localhost:3000', origin: 'http://localhost:3000' })), false);
    assert.equal(h.isCrossSiteRequest(request({ host: '192.168.1.20:3000' })), false);
  });

  test('a page of another site is recognised', () => {
    assert.equal(h.isCrossSiteRequest(request({ host: '192.168.1.20:3000', origin: 'http://evil.example' })), true);
    assert.equal(h.isCrossSiteRequest(request({ host: '192.168.1.20:3000', origin: 'http://192.168.1.20:8080' })), true);
    assert.equal(h.isCrossSiteRequest(request({ host: '192.168.1.20:3000', origin: 'null' })), true);
  });
});

describe('reading a request body', () => {
  const LIMIT = 1024;
  let server;
  let url;

  before(async () => {
    server = http.createServer(async (req, res) => {
      try {
        const body = await h.readBody(req, LIMIT);
        h.sendJson(res, 200, { length: Buffer.byteLength(body), body });
      } catch (err) {
        h.sendFailure(res, err, 'readBody test');
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}/`;
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  test('a body inside the limit is returned unchanged, including non-ASCII text', async () => {
    const text = JSON.stringify({ name: 'Nur Aisyah – 陈大文', note: 'x'.repeat(500) });
    const res = await fetch(url, { method: 'POST', body: text });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.body, text);
  });

  test('a body over the limit is answered with 413', async () => {
    const res = await fetch(url, { method: 'POST', body: 'x'.repeat(LIMIT + 1) });
    const data = await res.json();
    assert.equal(res.status, 413);
    assert.equal(data.success, false);
    assert.match(data.error, /too large/);
  });

  test('a body several times over the limit is still answered with 413', async () => {
    const res = await fetch(url, { method: 'POST', body: 'x'.repeat(LIMIT * 4) });
    assert.equal(res.status, 413);
  });
});
