// =============================================================================
// Integration test helper. Require this FIRST in every integration test file.
// Points the server code at a throw-away database and refuses anything else,
// so a test run can never touch real patient data.
// =============================================================================
process.env.DB_NAME = process.env.SHIRO_TEST_DB || 'shiro_test';
if (!/_test$/.test(process.env.DB_NAME)) {
  throw new Error(`Refusing to run integration tests on "${process.env.DB_NAME}": the database name must end with "_test".`);
}

const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const mysql = require('mysql2/promise');
const db = require('../../database/db');
const config = require('../../config/app_config');

async function dropTestDatabase() {
  if (!/_test$/.test(db.dbConfig.database)) {
    throw new Error('Safety check failed: not a test database.');
  }
  await db.closePool();
  const conn = await mysql.createConnection({
    host: db.dbConfig.host,
    port: db.dbConfig.port,
    user: db.dbConfig.user,
    password: db.dbConfig.password
  });
  try {
    await conn.query(`DROP DATABASE IF EXISTS \`${db.dbConfig.database}\``);
  } finally {
    await conn.end();
  }
}

/** Drops and recreates the test database: empty tables plus sample data. */
async function freshDatabase() {
  await dropTestDatabase();
  await db.initDatabase();
  return db.getPool();
}

/** Simulates a server restart: new pool, initialisation runs again. */
async function restart() {
  await db.closePool();
  await db.initDatabase();
  return db.getPool();
}

// ----- InfluxDB helpers (used only when a token is configured and the server answers) -----
function influxRequest(method, path, headers = {}, body = null, timeoutMs = 4000) {
  const url = new URL(config.INFLUX_URL);
  return new Promise((resolve) => {
    const req = http.request({
      host: url.hostname,
      port: url.port || 8086,
      path,
      method,
      timeout: timeoutMs,
      headers: { Authorization: `Token ${config.INFLUX_TOKEN}`, ...headers }
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
    req.on('error', err => resolve({ status: 0, body: err.message }));
    if (body) req.write(body);
    req.end();
  });
}

async function influxAvailable() {
  if (!config.INFLUX_TOKEN) return false;
  const res = await influxRequest('GET', '/health');
  return res.status === 200;
}

/** Removes the points written by a test (identified by their test patient IDs). */
async function deleteInfluxPatientPoints(patientIds) {
  const org = encodeURIComponent(config.INFLUX_ORG);
  const bucket = encodeURIComponent(config.INFLUX_BUCKET);
  for (const id of patientIds) {
    if (!/^ITEST-/.test(id)) throw new Error(`Refusing to delete points of non-test patient "${id}".`);
    await influxRequest('POST', `/api/v2/delete?org=${org}&bucket=${bucket}`, { 'Content-Type': 'application/json' },
      JSON.stringify({
        start: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
        stop: new Date(Date.now() + 60 * 1000).toISOString(),
        predicate: `patient_id="${id}"`
      }));
  }
}

// ----- the real server as a child process, on spare ports, against the test database -----
// The anchor login of the test server (never the one in .env)
const TEST_MQTT_LOGIN = { username: 'itest-anchor', password: 'itest-password-0123456789' };

function startServer(extraEnv) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..', '..'),
    // IPC channel: lets a test ask for a clean shutdown (Windows has no SIGINT for child processes)
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {
      ...process.env,
      DB_NAME: process.env.DB_NAME,
      INFLUX_TOKEN: '',
      MQTT_ANCHOR_USER: TEST_MQTT_LOGIN.username,
      MQTT_ANCHOR_PASSWORD: TEST_MQTT_LOGIN.password,
      ...extraEnv
    }
  });
  const state = { child, output: '' };
  child.stdout.on('data', d => { state.output += d; });
  child.stderr.on('data', d => { state.output += d; });
  state.ready = new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (/Gateway Ready/.test(state.output)) { clearInterval(timer); resolve(); }
      else if (child.exitCode !== null || Date.now() - started > 30000) {
        clearInterval(timer);
        reject(new Error(`server did not start:\n${state.output}`));
      }
    }, 100);
  });
  state.stop = () => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill();
  });
  /** Asks the server for a clean shutdown (as Ctrl+C does). Resolves with the exit code. */
  state.shutdown = () => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    child.once('exit', (code) => resolve(code));
    child.send('shutdown');
  });
  return state;
}

// ----- a minimal MQTT 3.1.1 client: what an anchor uses (CONNECT, QoS 0 PUBLISH, SUBSCRIBE) -----
const ANCHOR_TOPIC = 'shiro/ward-A1/anchor/telemetry';

/** The client ID the anchor firmware uses for a MAC address: SHIRO_Anchor_A00000000011 */
const anchorClientId = (mac) => `SHIRO_Anchor_${mac.replace(/:/g, '')}`;

function mqttString(text) {
  const body = Buffer.from(text, 'utf8');
  const length = Buffer.alloc(2);
  length.writeUInt16BE(body.length);
  return Buffer.concat([length, body]);
}

function mqttPacket(firstByte, body) {
  const lengthBytes = [];
  let remaining = body.length;
  do {
    let digit = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) digit |= 0x80;
    lengthBytes.push(digit);
  } while (remaining > 0);
  return Buffer.concat([Buffer.from([firstByte, ...lengthBytes]), body]);
}

/**
 * Splits a byte stream into MQTT packets. Calls onPacket(type, body) for each.
 * Returns a function that takes the next chunk.
 */
function packetReader(onPacket) {
  let pending = Buffer.alloc(0);
  return (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      if (pending.length < 2) return;
      let length = 0, multiplier = 1, i = 1, digit;
      do {
        if (i >= pending.length) return;
        digit = pending[i++];
        length += (digit & 0x7F) * multiplier;
        multiplier *= 128;
      } while (digit & 0x80);
      if (pending.length < i + length) return;
      const type = pending[0] >> 4;
      const body = pending.subarray(i, i + length);
      pending = pending.subarray(i + length);
      onPacket(type, body);
    }
  };
}

/**
 * Connects like an anchor, by default with the test server's login.
 * login: { username, password } or null for no login.
 * Resolves with publish(payload, topic), subscribe(topic) -> granted QoS byte
 * (0x80 = refused), messages (received PUBLISH packets: { topic, payload }),
 * closed (a promise that resolves when the server ends the connection) and close().
 * Rejects with err.returnCode when the server refuses the connection.
 */
function connectMqtt(port, clientId, login = TEST_MQTT_LOGIN) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const messages = [];
    const subscribeWaiters = new Map();
    let nextPacketId = 1;
    let connected = false;
    const closed = new Promise((resolveClosed) => socket.once('close', resolveClosed));

    socket.once('error', reject);
    socket.on('error', () => {});
    socket.once('connect', () => {
      let flags = 0x02; // clean session
      const parts = [mqttString(clientId)];
      if (login) {
        flags |= 0x80 | 0x40;
        parts.push(mqttString(login.username), mqttString(login.password));
      }
      const body = Buffer.concat([mqttString('MQTT'), Buffer.from([0x04, flags, 0x00, 0x3C]), ...parts]);
      socket.write(mqttPacket(0x10, body));
    });
    socket.once('close', () => {
      if (!connected) reject(Object.assign(new Error('MQTT connection closed before CONNACK'), { returnCode: null }));
    });

    socket.on('data', packetReader((type, body) => {
      if (type === 2) { // CONNACK
        if (body[1] !== 0x00) {
          reject(Object.assign(new Error(`MQTT connection refused (return code ${body[1]})`), { returnCode: body[1] }));
          return;
        }
        connected = true;
        resolve({
          messages,
          closed,
          publish: (payload, topic = ANCHOR_TOPIC) => socket.write(mqttPacket(0x30, Buffer.concat([
            mqttString(topic),
            Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload))
          ]))),
          subscribe: (topic) => new Promise((resolveSub) => {
            const id = nextPacketId++;
            const idBytes = Buffer.alloc(2);
            idBytes.writeUInt16BE(id);
            subscribeWaiters.set(id, resolveSub);
            socket.write(mqttPacket(0x82, Buffer.concat([idBytes, mqttString(topic), Buffer.from([0x00])])));
          }),
          close: () => socket.destroy()
        });
      } else if (type === 9) { // SUBACK
        const waiter = subscribeWaiters.get(body.readUInt16BE(0));
        if (waiter) waiter(body[2]);
      } else if (type === 3) { // PUBLISH, QoS 0
        const topicLength = body.readUInt16BE(0);
        messages.push({
          topic: body.subarray(2, 2 + topicLength).toString('utf8'),
          payload: body.subarray(2 + topicLength).toString('utf8')
        });
      }
    }));
  });
}

module.exports = {
  db,
  freshDatabase,
  startServer,
  connectMqtt,
  ANCHOR_TOPIC,
  TEST_MQTT_LOGIN,
  anchorClientId,
  restart,
  dropTestDatabase,
  influxAvailable,
  deleteInfluxPatientPoints
};
