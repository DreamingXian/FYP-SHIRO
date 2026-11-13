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

module.exports = {
  db,
  freshDatabase,
  restart,
  dropTestDatabase,
  influxAvailable,
  deleteInfluxPatientPoints
};
