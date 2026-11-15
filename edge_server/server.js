// =============================================================================
// SHIRO Central Ward Management System - Edge Server & IoT Gateway
// =============================================================================
const http = require('http');
const config = require('./config/app_config');
const logger = require('./utils/logger');
const { initDatabase, closePool } = require('./database/db');
const { handleRequest } = require('./routes/index');
const { startMqttBroker, stopMqttBroker } = require('./services/mqtt_service');
const { readAnchorCredentials } = require('./services/mqtt_access');
const { initWebSocketServer, closeWebSocketServer } = require('./services/websocket_service');
const ipsService = require('./services/ips_service');
const deviceService = require('./services/device_service');
const bindingCache = require('./services/binding_cache');
const timeSeriesService = require('./services/time_series_service');

// A shutdown that has not finished after this long ends the process anyway
const SHUTDOWN_TIMEOUT_MS = 8000;

let httpServer = null;
let shuttingDown = false;

async function bootstrap() {
  // The banner is console output for the person starting the server, not a log entry
  console.log('\n======================================================');
  console.log('  SHIRO Edge Server & Clinical IoT Gateway (Booting...)');
  console.log('======================================================');

  // 0. Settings that must be present before anything starts (throws with what to fix)
  const mqttCredentials = readAnchorCredentials();

  // 1. Connect and initialize MySQL Database schema & seed data
  logger.info('[DATABASE] Connecting to MySQL Database...');
  await initDatabase(); // throws when MySQL is unreachable: the server must not run without its database
  await ipsService.reloadWardAnchorsCache();
  await deviceService.syncEnrolledDevicesCache();
  await bindingCache.refresh();

  // Background work: device freshness, tag offline detection, batched presence writes
  deviceService.startFreshnessWatchdog();
  deviceService.startPresenceWriter();
  ipsService.startOfflineWatchdog();

  // 2. Start Aedes MQTT Broker on TCP 1883
  await startMqttBroker(config.MQTT_PORT, mqttCredentials);

  // 3. Create HTTP Web & REST API Server
  httpServer = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      logger.error('[HTTP UNHANDLED ERROR]', err);
      if (res.headersSent) {
        res.end();
        return;
      }
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: 'Internal server error. The details are in the server log.' }));
    });
  });

  // 4. Initialize WebSocket Bridge on the same HTTP server port 3000
  initWebSocketServer(httpServer);

  // 5. Start listening on 0.0.0.0:3000
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.HTTP_PORT, '0.0.0.0', () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  console.log(`\n======================================================`);
  console.log(`  SHIRO Clinical Dashboard & Gateway Ready`);
  console.log(`======================================================`);
  console.log(`[HTTP DASHBOARD] Accessible at:`);
  console.log(`  -> Localhost:  http://localhost:${config.HTTP_PORT}`);
  if (config.ALL_IPS && config.ALL_IPS.length > 0) {
    config.ALL_IPS.forEach(i => {
      console.log(`  -> ${i.name}: http://${i.address}:${config.HTTP_PORT}`);
    });
  } else {
    console.log(`  -> Network IP: http://${config.LOCAL_IP}:${config.HTTP_PORT}`);
  }
  console.log(`[MQTT BROKER]  tcp://${config.LOCAL_IP}:${config.MQTT_PORT} (ESP32 Gateway)`);
  console.log(`[WEBSOCKET]    ws://${config.LOCAL_IP}:${config.HTTP_PORT} (Web & Quest 3 HMD)`);
  console.log(`======================================================\n`);
}

/** Runs one shutdown step; a failure is logged and the next step still runs. */
async function step(name, fn) {
  try {
    return await fn();
  } catch (err) {
    logger.error(`[SHUTDOWN] ${name} failed:`, err);
    return undefined;
  }
}

/**
 * Clean shutdown: stop accepting work, write what is still in memory, close
 * the database. Pending InfluxDB points and device presence are not lost.
 */
async function shutdown(reason, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`[SHUTDOWN] ${reason}: stopping the server...`);

  const forced = setTimeout(() => {
    logger.error(`[SHUTDOWN] Not finished after ${SHUTDOWN_TIMEOUT_MS / 1000} s: ending the process.`);
    process.exit(exitCode || 1);
  }, SHUTDOWN_TIMEOUT_MS);
  forced.unref();

  deviceService.stopFreshnessWatchdog();
  ipsService.stopOfflineWatchdog();

  // 1. No new work: anchors, dashboards and headsets are disconnected
  await step('Stopping the MQTT broker', () => stopMqttBroker());
  await step('Closing WebSocket connections', () => closeWebSocketServer());
  if (httpServer) {
    await step('Closing the HTTP server', () => new Promise((resolve) => {
      httpServer.close(() => resolve());
      httpServer.closeAllConnections();
    }));
  }

  // 2. Write what is still waiting in memory
  const presence = await step('Writing device presence', () => deviceService.stopPresenceWriter());
  const points = await step('Writing InfluxDB points', () => timeSeriesService.closeTimeSeries());
  logger.info(`[SHUTDOWN] Written: presence of ${presence || 0} device(s), ${points || 0} InfluxDB point(s).`);

  // 3. Close the database
  await step('Closing the MySQL pool', () => closePool());

  logger.info('[SHUTDOWN] Done.');
  process.exit(exitCode);
}

// Ctrl+C in the terminal, or a service manager stopping the process
process.on('SIGINT', () => shutdown('Ctrl+C received'));
process.on('SIGTERM', () => shutdown('SIGTERM received'));
// Started by a test with an IPC channel: the test asks for a clean shutdown
// (Windows cannot send SIGINT to a child process).
if (typeof process.send === 'function') {
  process.on('message', (msg) => { if (msg === 'shutdown') shutdown('Shutdown requested by the parent process'); });
}

// A promise rejected without a handler is a bug, but one that must not stop
// alarms from working: it is logged with its stack and the server keeps running.
process.on('unhandledRejection', (reason) => {
  logger.error('[UNHANDLED REJECTION] A promise failed without a handler. The server keeps running.', reason instanceof Error ? (reason.stack || reason) : reason);
});

// An exception nobody caught leaves the process in an unknown state: log it,
// write what can still be written, and exit with an error so it is restarted.
process.on('uncaughtException', (err) => {
  logger.error('[UNCAUGHT EXCEPTION] The server stops to avoid running in an unknown state.', err && err.stack ? err.stack : err);
  shutdown('Uncaught exception', 1);
});

bootstrap().catch((err) => {
  logger.error('[FATAL STARTUP ERROR]', err.message);
  if (process.env.SHIRO_DEBUG) logger.error(err.stack || err);
  process.exit(1);
});
