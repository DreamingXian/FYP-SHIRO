// =============================================================================
// SHIRO Hospital Edge Server - MySQL Connection Pool & Database Initialisation
// =============================================================================
const logger = require('../utils/logger');
require('../config/load_env');
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

const SCHEMA_DIR = path.join(__dirname, 'schema');
const SEED_DIR = path.join(__dirname, 'seed');

// Default XAMPP MySQL configuration (override in edge_server/.env)
const dbConfig = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '', // Default XAMPP root password is empty
  database: process.env.DB_NAME || 'shiro_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  multipleStatements: true // Allows executing multi-statement SQL setup scripts
};

if (!/^[A-Za-z0-9_]+$/.test(dbConfig.database)) {
  throw new Error(`Invalid DB_NAME "${dbConfig.database}": use letters, digits and underscores only.`);
}

let pool = null;

// Queries sent through the pool since start-up (for /api/system/stats and the load test)
let queryCount = 0;

function getPool() {
  if (!pool) {
    pool = mysql.createPool(dbConfig);
    for (const method of ['query', 'execute']) {
      const original = pool[method].bind(pool);
      pool[method] = (...args) => {
        queryCount++;
        return original(...args);
      };
    }
  }
  return pool;
}

function getQueryCount() {
  return queryCount;
}

async function closePool() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

/**
 * Returns the .sql files of a directory in name order (01_, 02_, ...).
 */
function listSqlFiles(dir) {
  return fs.readdirSync(dir)
    .filter(f => f.toLowerCase().endsWith('.sql'))
    .sort()
    .map(f => path.join(dir, f));
}

async function runSqlFile(filePath) {
  const sql = fs.readFileSync(filePath, 'utf8');
  await getPool().query(sql);
}

/**
 * Creates every table that does not exist yet. Never changes existing data.
 */
async function applySchema() {
  for (const file of listSqlFiles(SCHEMA_DIR)) {
    await runSqlFile(file);
  }

  // Column additions for databases created by older versions
  const { migrate: migrateDeviceAvailability } = require('./migrate_devices_availability');
  await migrateDeviceAvailability();
  const { migrate: migrateAnchorCalibration } = require('./migrate_anchor_calibration');
  await migrateAnchorCalibration();
  const { migrate: migrateIncidentSimulation } = require('./migrate_incident_simulation');
  await migrateIncidentSimulation();
  const { migrate: migrateIncidentFreefall } = require('./migrate_incident_freefall');
  await migrateIncidentFreefall();
  const { migrate: migrateBindingBoundBy } = require('./migrate_binding_bound_by');
  await migrateBindingBoundBy();
  const { migrate: migrateHeadsetAssignment } = require('./migrate_headset_assignment');
  await migrateHeadsetAssignment();
  const { migrate: migratePatientBody } = require('./migrate_patient_body');
  await migratePatientBody();
  const { migrate: migrateBindingHistory } = require('./migrate_binding_history');
  await migrateBindingHistory();
  const { migrate: migratePatientDischargeWard } = require('./migrate_patient_discharge_ward');
  await migratePatientDischargeWard();
  const { migrate: migrateRoomSensorType } = require('./migrate_room_sensor_type');
  await migrateRoomSensorType();
}

/**
 * True when the database holds no wards and no patients (a fresh install).
 */
async function isDatabaseEmpty() {
  const [rows] = await getPool().query(
    'SELECT (SELECT COUNT(*) FROM ward_rooms) AS wards, (SELECT COUNT(*) FROM patients) AS patients'
  );
  return Number(rows[0].wards) === 0 && Number(rows[0].patients) === 0;
}

/**
 * Loads the sample wards and patients.
 * Called automatically only for an empty database, or on purpose via `npm run db:seed`.
 */
async function applySeed() {
  for (const file of listSqlFiles(SEED_DIR)) {
    await runSqlFile(file);
  }
}

/**
 * Connects to MySQL, creates the database and its tables when missing, and
 * seeds sample data into an empty database. Existing data is never modified.
 * Throws when MySQL cannot be reached or the schema cannot be applied.
 */
async function initDatabase() {
  let connection;
  try {
    // 1. Connect without a database name to verify the MySQL server is running
    connection = await mysql.createConnection({
      host: dbConfig.host,
      port: dbConfig.port,
      user: dbConfig.user,
      password: dbConfig.password
    });
  } catch (err) {
    const wrapped = new Error(
      `Could not connect to MySQL at ${dbConfig.host}:${dbConfig.port} (${err.code || err.message}). ` +
      'Ensure XAMPP is running and the MySQL service is started.'
    );
    wrapped.code = err.code;
    wrapped.cause = err;
    throw wrapped;
  }

  try {
    logger.info('[DATABASE] Connected to MySQL server successfully.');
    // 2. Ensure the configured database exists
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`
    );
  } finally {
    await connection.end();
  }

  // 3. Create missing tables (wards, patients, devices, bindings, incident log)
  await applySchema();
  logger.info(`[DATABASE] Schema verified in "${dbConfig.database}".`);

  // 4. Sample data only for a fresh, empty database
  if (await isDatabaseEmpty()) {
    await applySeed();
    logger.info('[DATABASE] Empty database detected: sample wards and patients loaded.');
  }

  return true;
}

module.exports = {
  getPool,
  getQueryCount,
  closePool,
  initDatabase,
  applySchema,
  applySeed,
  isDatabaseEmpty,
  dbConfig,
  SEED_DIR
};
