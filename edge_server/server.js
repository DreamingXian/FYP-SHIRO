// =============================================================================
// SHIRO Central Ward Management System - Edge Server & IoT Gateway
// =============================================================================
const http = require('http');
const config = require('./config/app_config');
const { testAndInitDatabase } = require('./database/db');
const { handleRequest } = require('./routes/index');
const { startMqttBroker } = require('./services/mqtt_service');
const { initWebSocketServer } = require('./services/websocket_service');

async function bootstrap() {
  console.log('\n======================================================');
  console.log('  SHIRO Edge Server & Clinical IoT Gateway (Booting...)');
  console.log('======================================================');

  // 1. Connect and initialize MySQL Database schema & seed data
  console.log('[DATABASE] Connecting to MySQL Database...');
  await testAndInitDatabase();

  // 2. Start Aedes MQTT Broker on TCP 1883
  await startMqttBroker(config.MQTT_PORT);

  // 3. Create HTTP Web & REST API Server
  const httpServer = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error('[HTTP UNHANDLED ERROR]', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Internal Server Error' }));
    });
  });

  // 4. Initialize WebSocket Bridge on the same HTTP server port 3000
  initWebSocketServer(httpServer);

  // 5. Start listening on 0.0.0.0:3000
  httpServer.listen(config.HTTP_PORT, '0.0.0.0', () => {
    console.log(`\n======================================================`);
    console.log(`  SHIRO Clinical Dashboard & Gateway Ready`);
    console.log(`======================================================`);
    console.log(`[HTTP DASHBOARD] Accessible at:`);
    console.log(`  -> Localhost:  http://localhost:${config.HTTP_PORT}`);
    console.log(`  -> Network IP: http://${config.LOCAL_IP}:${config.HTTP_PORT}`);
    console.log(`[MQTT BROKER]  tcp://${config.LOCAL_IP}:${config.MQTT_PORT} (ESP32 Gateway)`);
    console.log(`[WEBSOCKET]    ws://${config.LOCAL_IP}:${config.HTTP_PORT} (Web & Quest 3 HMD)`);
    console.log(`======================================================\n`);
  });
}

bootstrap().catch((err) => {
  console.error('[FATAL STARTUP ERROR]', err);
  process.exit(1);
});
