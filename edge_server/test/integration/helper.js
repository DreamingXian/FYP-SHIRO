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
function startServer(extraEnv) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..', '..'),
    env: { ...process.env, DB_NAME: process.env.DB_NAME, INFLUX_TOKEN: '', ...extraEnv }
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
  return state;
}

// ----- a minimal MQTT 3.1.1 client: CONNECT and QoS 0 PUBLISH are all an anchor uses -----
const ANCHOR_TOPIC = 'shiro/ward-A1/anchor/telemetry';

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

/** Connects like an anchor. publish(payload, topic) sends text as it is and anything else as JSON. */
function connectMqtt(port, clientId) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('error', reject);
    socket.once('connect', () => {
      const body = Buffer.concat([mqttString('MQTT'), Buffer.from([0x04, 0x02, 0x00, 0x3C]), mqttString(clientId)]);
      socket.write(mqttPacket(0x10, body));
    });
    socket.once('data', (data) => {
      if (data[0] === 0x20 && data[3] === 0x00) {
        resolve({
          publish: (payload, topic = ANCHOR_TOPIC) => socket.write(mqttPacket(0x30, Buffer.concat([
            mqttString(topic),
            Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload))
          ]))),
          close: () => socket.destroy()
        });
      } else {
        reject(new Error('MQTT connection refused'));
      }
    });
  });
}

module.exports = {
  db,
  freshDatabase,
  startServer,
  connectMqtt,
  ANCHOR_TOPIC,
  restart,
  dropTestDatabase,
  influxAvailable,
  deleteInfluxPatientPoints
};
