// Unit tests: clinician sign-in, sessions, roles, headset pairing and the audit trail.
// Accounts are kept in memory (no database); the real request handler runs on a spare port.
const guard = require('./no_database');

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { handleRequest } = require('../../routes/index');
const db = require('../../database/db');
const authService = require('../../services/auth/auth_service');
const { memoryStore } = require('../../services/auth/stores');
const { hashPassword, verifyPassword } = require('../../services/auth/passwords');
const { requiredAccess, decide, decideCommand, ACCESS } = require('../../services/auth/permissions');
const { parseCookies, isLoopback } = require('../../services/auth/request_auth');
const audit = require('../../services/audit_service');

const ADMIN = { username: 'admin.one', fullName: 'Admin One', role: 'ADMIN', password: 'admin-password-1' };
const NURSE = { username: 'nurse.two', fullName: 'Nurse Two', role: 'CLINICIAN', password: 'nurse-password-2' };

let clock = 1_000_000;
let records = [];

function freshAuth() {
  clock = 1_000_000;
  records = [];
  authService.configure({ store: memoryStore(), now: () => clock });
  audit.configure({ sink: async (row) => { records.push(row); } });
}

test('this file cannot reach a real database', () => {
  assert.equal(db.dbConfig.port, guard.DB_PORT);
});

describe('passwords', () => {
  test('a password is stored as a salted hash and verified', async () => {
    const a = await hashPassword('correct horse battery');
    const b = await hashPassword('correct horse battery');
    assert.match(a, /^scrypt\$16384\$8\$1\$/);
    assert.notEqual(a, b, 'two hashes of one password differ (salt)');
    assert.doesNotMatch(a, /correct/);
    assert.equal(await verifyPassword('correct horse battery', a), true);
    assert.equal(await verifyPassword('correct horse batterY', a), false);
    assert.equal(await verifyPassword('', a), false);
    assert.equal(await verifyPassword('x', 'not-a-hash'), false);
  });

  test('a password shorter than 10 characters is refused', async () => {
    await assert.rejects(hashPassword('short'), /at least 10/);
  });
});

describe('permission table', () => {
  test('signing in and pairing are the only public API addresses', () => {
    assert.equal(requiredAccess('POST', '/api/auth/login'), ACCESS.PUBLIC);
    assert.equal(requiredAccess('POST', '/api/headset/pair'), ACCESS.PUBLIC);
    assert.equal(requiredAccess('GET', '/api/patients/list'), ACCESS.STAFF_OR_HEADSET);
    assert.equal(requiredAccess('POST', '/api/patients/admit'), ACCESS.STAFF);
    assert.equal(requiredAccess('GET', '/api/some/new/route'), ACCESS.STAFF, 'unlisted addresses are protected');
    assert.equal(requiredAccess('GET', '/api/admin/audit'), ACCESS.ADMIN);
    assert.equal(requiredAccess('POST', '/api/devices/enroll'), ACCESS.ADMIN);
  });

  test('roles decide who may do what', () => {
    const admin = { type: 'CLINICIAN', role: 'ADMIN' };
    const nurse = { type: 'CLINICIAN', role: 'CLINICIAN' };
    const headset = { type: 'HEADSET' };
    assert.equal(decide(ACCESS.STAFF, null), 'unauthenticated');
    assert.equal(decide(ACCESS.ADMIN, nurse), 'forbidden');
    assert.equal(decide(ACCESS.ADMIN, admin), 'ok');
    assert.equal(decide(ACCESS.STAFF, headset), 'forbidden');
    assert.equal(decide(ACCESS.STAFF_OR_HEADSET, headset), 'ok');
    assert.equal(decideCommand('DEVICE_HEARTBEAT', nurse), 'forbidden');
    assert.equal(decideCommand('DEVICE_HEARTBEAT', headset), 'ok');
    assert.equal(decideCommand('UPDATE_CALIBRATION', nurse), 'forbidden');
    assert.equal(decideCommand('SET_ACTIVE_MODE', headset), 'ok');
    assert.equal(decideCommand('SOMETHING_ELSE', admin), 'forbidden');
  });
});

describe('accounts and sessions', () => {
  before(freshAuth);

  test('accounts get numbered IDs and usernames are unique', async () => {
    const a = await authService.createClinician(ADMIN);
    const n = await authService.createClinician(NURSE, a.clinician_id);
    assert.equal(a.clinician_id, 'CLN-001');
    assert.equal(n.clinician_id, 'CLN-002');
    assert.equal(n.created_by, 'CLN-001');
    assert.equal('password_hash' in n, false, 'the hash is never returned');
    await assert.rejects(authService.createClinician({ ...NURSE, fullName: 'Someone Else' }), (e) => e.status === 409);
    await assert.rejects(authService.createClinician({ ...NURSE, username: 'Bad Name!' }), (e) => e.status === 400);
    await assert.rejects(authService.createClinician({ ...NURSE, username: 'x.y', role: 'GOD' }), (e) => e.status === 400);
  });

  test('the first-admin set-up works only while no account exists', async () => {
    await assert.rejects(authService.createFirstAdmin({ username: 'late', fullName: 'Late Admin', password: 'late-password-1' }), (e) => e.status === 409);
  });

  test('a session signs in until it expires or the clinician signs out', async () => {
    const { token, actor } = await authService.login('nurse.two', NURSE.password);
    assert.equal(actor.id, 'CLN-002');
    assert.equal((await authService.authenticateSession(token)).role, 'CLINICIAN');
    clock += authService.SESSION_TTL_MS + 1;
    assert.equal(await authService.authenticateSession(token), null, 'expired after 12 h');

    const second = await authService.login('nurse.two', NURSE.password);
    await authService.logout(second.token);
    assert.equal(await authService.authenticateSession(second.token), null, 'signed out');
    assert.equal(await authService.authenticateSession('not-a-real-token-at-all-000000'), null);
  });

  test('a wrong password and an unknown username get the same answer', async () => {
    const wrong = await authService.login('nurse.two', 'wrong-password-x').catch(e => e);
    const unknown = await authService.login('nobody', 'wrong-password-x').catch(e => e);
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal(wrong.message, unknown.message);
  });

  test('five wrong passwords lock the account for five minutes', async () => {
    for (let i = 0; i < authService.LOGIN_MAX_FAILURES; i++) {
      await authService.login('admin.one', 'wrong-password-x').catch(() => {});
    }
    await assert.rejects(authService.login('admin.one', ADMIN.password), (e) => e.status === 429);
    clock += 5 * 60 * 1000 + 1;
    assert.equal((await authService.login('admin.one', ADMIN.password)).actor.role, 'ADMIN');
  });

  test('deactivating an account ends its sessions; the last admin and yourself cannot be deactivated', async () => {
    const { token } = await authService.login('nurse.two', NURSE.password);
    const admin = { type: 'CLINICIAN', id: 'CLN-001', role: 'ADMIN' };
    await authService.setClinicianActive('CLN-002', false, admin);
    assert.equal(await authService.authenticateSession(token), null);
    await assert.rejects(authService.login('nurse.two', NURSE.password), (e) => e.status === 401);
    await assert.rejects(authService.setClinicianActive('CLN-001', false, admin), /own account/);
    await assert.rejects(authService.setClinicianActive('CLN-001', false, { id: 'CLN-099' }), /last active admin/);
    await authService.setClinicianActive('CLN-002', true, admin);
  });

  test('a password reset ends the sessions of that account', async () => {
    const { token } = await authService.login('nurse.two', NURSE.password);
    await authService.resetPassword('CLN-002', 'new-nurse-password-3');
    assert.equal(await authService.authenticateSession(token), null);
    assert.equal((await authService.login('nurse.two', 'new-nurse-password-3')).actor.id, 'CLN-002');
  });
});

describe('headset pairing', () => {
  before(freshAuth);

  test('a pairing code works once and gives the headset its own token', async () => {
    const { code } = authService.createPairingCode('CLN-001');
    assert.match(code, /^\d{6}$/);
    const { token, pairedBy } = await authService.pairHeadset('QUEST3-AAA111', code, '10.0.0.5');
    assert.equal(pairedBy, 'CLN-001');
    const actor = await authService.authenticateHeadset(token);
    assert.deepEqual(actor, { type: 'HEADSET', id: 'QUEST3-AAA111', pairedBy: 'CLN-001', user: null });
    assert.equal(authService.actorLabel(actor), 'QUEST3-AAA111 (no clinician assigned)');
    await assert.rejects(authService.pairHeadset('QUEST3-BBB222', code, '10.0.0.6'), (e) => e.status === 401, 'used once only');
  });

  test('a code expires after five minutes', async () => {
    const { code } = authService.createPairingCode('CLN-001');
    clock += authService.PAIRING_CODE_TTL_MS + 1;
    await assert.rejects(authService.pairHeadset('QUEST3-CCC333', code, '10.0.0.7'), (e) => e.status === 401);
  });

  test('wrong codes from one address are locked out', async () => {
    for (let i = 0; i < 5; i++) await authService.pairHeadset('QUEST3-DDD444', '000000', '10.0.0.8').catch(() => {});
    const { code } = authService.createPairingCode('CLN-001');
    await assert.rejects(authService.pairHeadset('QUEST3-DDD444', code, '10.0.0.8'), (e) => e.status === 429);
  });

  test('a revoked headset is no longer accepted; pairing again replaces the token', async () => {
    const first = await authService.pairHeadset('QUEST3-EEE555', authService.createPairingCode('CLN-001').code, '10.0.0.9');
    await authService.revokePairing('QUEST3-EEE555', 'CLN-001');
    assert.equal(await authService.authenticateHeadset(first.token), null);
    const second = await authService.pairHeadset('QUEST3-EEE555', authService.createPairingCode('CLN-001').code, '10.0.0.9');
    assert.equal((await authService.authenticateHeadset(second.token)).id, 'QUEST3-EEE555');
    assert.equal(await authService.authenticateHeadset(first.token), null, 'the old token stays invalid');
  });
});

describe('headset assignment', () => {
  let token;
  let nurse;
  before(async () => {
    freshAuth();
    await authService.createClinician({ username: 'admin.one', fullName: 'Admin One', role: 'ADMIN', password: 'admin-password-1' });
    nurse = await authService.createClinician({ username: 'nurse.lim', fullName: 'Nurse Lim', role: 'CLINICIAN', password: 'nurse-password-1' });
    ({ token } = await authService.pairHeadset('QUEST3-ASG001', authService.createPairingCode('CLN-001').code, '10.0.1.1'));
  });
  const admin = { type: 'CLINICIAN', id: 'CLN-001' };

  test('the headset acts for the clinician it is assigned to, not for the admin who paired it', async () => {
    const user = await authService.assignHeadset('QUEST3-ASG001', nurse.clinician_id, admin);
    assert.deepEqual(user, { id: nurse.clinician_id, name: 'Nurse Lim' });
    const actor = await authService.authenticateHeadset(token);
    assert.equal(authService.actorLabel(actor), `QUEST3-ASG001 (Nurse Lim, ${nurse.clinician_id})`);
    const [listed] = await authService.listPairings();
    assert.deepEqual(listed.assigned_user, user);
  });

  test('a deactivated clinician cannot be assigned, and a headset assigned to one acts for nobody', async () => {
    await authService.setClinicianActive(nurse.clinician_id, false, admin);
    assert.equal(authService.actorLabel(await authService.authenticateHeadset(token)), 'QUEST3-ASG001 (no clinician assigned)');
    await assert.rejects(authService.assignHeadset('QUEST3-ASG001', nurse.clinician_id, admin), (e) => e.status === 400);
    assert.deepEqual(await authService.headsetsAssignedTo(nurse.clinician_id), ['QUEST3-ASG001']);
    await authService.setClinicianActive(nurse.clinician_id, true, admin);
  });

  test('unassigning, unknown accounts and headsets without a pairing', async () => {
    assert.equal(await authService.assignHeadset('QUEST3-ASG001', null, admin), null);
    assert.equal((await authService.authenticateHeadset(token)).user, null);
    await assert.rejects(authService.assignHeadset('QUEST3-ASG001', 'CLN-999', admin), (e) => e.status === 404);
    await assert.rejects(authService.assignHeadset('QUEST3-NOPE01', nurse.clinician_id, admin), (e) => e.status === 404);
  });

  test('pairing again starts unassigned', async () => {
    await authService.assignHeadset('QUEST3-ASG001', nurse.clinician_id, admin);
    const again = await authService.pairHeadset('QUEST3-ASG001', authService.createPairingCode('CLN-001').code, '10.0.1.1');
    assert.equal((await authService.authenticateHeadset(again.token)).user, null);
  });
});

describe('audit trail', () => {
  before(freshAuth);

  test('an audited request records the IDs it changed, never passwords or free text', async () => {
    const actor = { type: 'CLINICIAN', id: 'CLN-002', name: 'Nurse Two', role: 'CLINICIAN' };
    await audit.recordRequest({
      method: 'POST', pathname: '/api/patients/admit', status: 201, actor,
      body: JSON.stringify({ full_name: 'Secret Name', medical_history: 'private', ward_id: 'WARD-001' }),
      query: {}, response: { success: true, patient: { patient_id: 'P-077' } }, ip: '10.0.0.2'
    });
    assert.equal(records.length, 1);
    const row = records[0];
    assert.equal(row.action, 'PATIENT_ADMIT');
    assert.equal(row.actor_label, 'Nurse Two (CLN-002)');
    assert.equal(row.target_id, 'P-077');
    assert.doesNotMatch(row.details, /Secret|private/);
  });

  test('failed requests and requests that change nothing are not recorded', async () => {
    records = [];
    await audit.recordRequest({ method: 'POST', pathname: '/api/patients/admit', status: 400, actor: null, body: '{}', query: {}, response: null });
    await audit.recordRequest({ method: 'GET', pathname: '/api/patients/list', status: 200, actor: null, body: '', query: {}, response: null });
    assert.equal(records.length, 0);
  });

  test('a failing audit store does not fail the action', async () => {
    audit.configure({ sink: async () => { throw new Error('db down'); } });
    await audit.record({ action: 'TEST' }); // resolves
    audit.configure({ sink: async (row) => { records.push(row); } });
  });
});

describe('requests', () => {
  let server;
  let base;
  let adminCookie;
  let nurseCookie;
  let headsetToken;

  before(async () => {
    freshAuth();
    await authService.createClinician(ADMIN);
    await authService.createClinician(NURSE);
    adminCookie = `shiro_session=${(await authService.login(ADMIN.username, ADMIN.password)).token}`;
    nurseCookie = `shiro_session=${(await authService.login(NURSE.username, NURSE.password)).token}`;
    headsetToken = (await authService.pairHeadset('QUEST3-FFF666', authService.createPairingCode('CLN-001').code, '10.0.0.3')).token;
    server = http.createServer((req, res) => { handleRequest(req, res).catch(() => { res.statusCode = 500; res.end(); }); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await db.closePool();
  });

  const call = (path, { method = 'GET', cookie, bearer, body } = {}) => fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  test('without sign-in the API answers 401, before reading any data', async () => {
    for (const path of ['/api/patients/list', '/api/devices/list', '/api/admin/audit', '/api/nothing']) {
      const res = await call(path);
      assert.equal(res.status, 401, path);
      assert.equal((await res.json()).success, false);
    }
  });

  test('a clinician cannot use admin addresses', async () => {
    const res = await call('/api/admin/clinicians', { cookie: nurseCookie });
    assert.equal(res.status, 403);
    const enroll = await call('/api/devices/enroll', { method: 'POST', cookie: nurseCookie, body: {} });
    assert.equal(enroll.status, 403);
  });

  test('an admin can list accounts; the list never contains password hashes', async () => {
    const res = await call('/api/admin/clinicians', { cookie: adminCookie });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /admin\.one/);
    assert.doesNotMatch(text, /scrypt|password_hash/);
  });

  test('a paired headset may read what it needs, but not use clinician-only addresses', async () => {
    const forbidden = await call('/api/patients/admit', { method: 'POST', bearer: headsetToken, body: {} });
    assert.equal(forbidden.status, 403);
    // The headset reads who it is assigned to; it learns nothing about other accounts
    const me = await call('/api/auth/me', { bearer: headsetToken });
    assert.equal(me.status, 200);
    const meBody = await me.json();
    assert.equal(meBody.user.type, 'HEADSET');
    assert.equal(meBody.user.assigned_clinician, null);
    assert.equal(meBody.user.password_hash, undefined);
    const wrong = await call('/api/patients/list', { bearer: 'x'.repeat(43) });
    assert.equal(wrong.status, 401);
  });

  test('signing in sets an HttpOnly, SameSite=Strict cookie; a wrong password is a 401', async () => {
    const ok = await call('/api/auth/login', { method: 'POST', body: { username: NURSE.username, password: NURSE.password } });
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get('set-cookie');
    assert.match(cookie, /^shiro_session=[A-Za-z0-9_-]{40,}/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    const body = await ok.json();
    assert.equal(body.user.role, 'CLINICIAN');

    const bad = await call('/api/auth/login', { method: 'POST', body: { username: NURSE.username, password: 'wrong-password-x' } });
    assert.equal(bad.status, 401);
    assert.ok(records.some(r => r.action === 'LOGIN_FAILED' && r.target_id === NURSE.username), 'the failed sign-in is recorded');
  });

  test('status tells the page whether anyone is signed in', async () => {
    const anonymous = await (await call('/api/auth/status')).json();
    assert.equal(anonymous.user, null);
    assert.equal(anonymous.setup_needed, false);
    const signedIn = await (await call('/api/auth/status', { cookie: adminCookie })).json();
    assert.equal(signedIn.user.role, 'ADMIN');
  });

  test('cookies are read as name=value pairs', () => {
    assert.deepEqual(parseCookies('a=1; shiro_session=abc%20d; b'), { a: '1', shiro_session: 'abc d' });
    assert.equal(isLoopback({ socket: { remoteAddress: '::ffff:127.0.0.1' } }), true);
    assert.equal(isLoopback({ socket: { remoteAddress: '192.168.1.20' } }), false);
  });
});
