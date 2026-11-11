// =============================================================================
// SHIRO Hospital Edge Server - MySQL Database Connection Pool
// =============================================================================
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

// Default XAMPP MySQL configuration
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

let pool = null;

function getPool() {
  if (!pool) {
    pool = mysql.createPool(dbConfig);
  }
  return pool;
}

/**
 * Tests connection to MySQL and auto-creates shiro_db if it does not exist yet.
 */
async function testAndInitDatabase() {
  try {
    // 1. Connect without database name first to verify MySQL server is running
    const connection = await mysql.createConnection({
      host: dbConfig.host,
      port: dbConfig.port,
      user: dbConfig.user,
      password: dbConfig.password,
      multipleStatements: true
    });

    console.log('[DATABASE] Connected to MySQL server successfully.');

    // 2. Ensure shiro_db exists
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
    await connection.end();

    // 3. Initialize pool with shiro_db
    const p = getPool();

    // 4. Run init_ward_config.sql script to ensure tables & default seed exist
    const sqlPath = path.join(__dirname, 'init_ward_config.sql');
    if (fs.existsSync(sqlPath)) {
      const sqlContent = fs.readFileSync(sqlPath, 'utf8');
      await p.query(sqlContent);
      console.log('[DATABASE] Verified Ward Configuration schema and seed data in MySQL.');
    }

    // 5. Run init_patients.sql script to ensure patients table & seed exist
    const patientsSqlPath = path.join(__dirname, 'init_patients.sql');
    if (fs.existsSync(patientsSqlPath)) {
      const patientsSql = fs.readFileSync(patientsSqlPath, 'utf8');
      await p.query(patientsSql);
      console.log('[DATABASE] Verified Inpatient Registry schema and benchmark patients in MySQL.');
    }

    // 6. Run init_devices.sql script to ensure hardware device registry table & seed exist
    const devicesSqlPath = path.join(__dirname, 'init_devices.sql');
    if (fs.existsSync(devicesSqlPath)) {
      const devicesSql = fs.readFileSync(devicesSqlPath, 'utf8');
      await p.query(devicesSql);
      console.log('[DATABASE] Verified Hardware Device Registry schema and benchmark fleet in MySQL.');
    }

    // 6b. Run init_emergency_logs.sql to ensure emergency audit log table exists
    const emergencySqlPath = path.join(__dirname, 'init_emergency_logs.sql');
    if (fs.existsSync(emergencySqlPath)) {
      const emergencySql = fs.readFileSync(emergencySqlPath, 'utf8');
      await p.query(emergencySql);
      console.log('[DATABASE] Verified Emergency Incident Audit Log schema (Table 4.13) in MySQL.');
    }

    // 7. Ensure availability_status column exists in devices table
    const { migrate } = require('./migrate_devices_availability');
    await migrate();

    // 8. Ensure calibrated_a, calibrated_n columns exist in ward_anchors table
    const { migrate: migrateAnchorCal } = require('./migrate_anchor_calibration');
    await migrateAnchorCal();

    return true;
  } catch (err) {
    console.error('[DATABASE ERROR] Could not connect to MySQL server:', err.message);
    console.error('[DATABASE TIP] Ensure XAMPP is running and MySQL service is started (Port 3306).');
    return false;
  }
}

module.exports = {
  getPool,
  testAndInitDatabase,
  dbConfig
};

