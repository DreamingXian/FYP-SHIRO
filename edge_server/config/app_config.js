// =============================================================================
// SHIRO Edge Server Configuration
// =============================================================================
require('./load_env');
const os = require('os');
const path = require('path');

function getAllIps() {
  const ips = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const netInfo of nets[name]) {
      if (netInfo.family === 'IPv4' && !netInfo.internal) {
        ips.push({ name, address: netInfo.address });
      }
    }
  }
  return ips;
}

function getLocalIp() {
  const all = getAllIps();
  // Prefer Wi-Fi if available, otherwise first non-internal adapter
  const wifi = all.find(i => /wi-?fi/i.test(i.name));
  if (wifi) return wifi.address;
  return all.length > 0 ? all[0].address : '127.0.0.1';
}

module.exports = {
  HTTP_PORT: process.env.HTTP_PORT ? parseInt(process.env.HTTP_PORT, 10) : 3000,
  MQTT_PORT: process.env.MQTT_PORT ? parseInt(process.env.MQTT_PORT, 10) : 1883,
  LOCAL_IP: getLocalIp(),
  ALL_IPS: getAllIps(),
  PUBLIC_DIR: path.join(__dirname, '..', 'public'),
  VIEWS_DIR: path.join(__dirname, '..', 'public', 'views'),

  // InfluxDB v2 Time-Series Database Configuration (Chapter 4, Table 4.10)
  INFLUX_URL: process.env.INFLUX_URL || 'http://127.0.0.1:8086',
  // Secret: set INFLUX_TOKEN in edge_server/.env. Empty disables time-series logging.
  INFLUX_TOKEN: process.env.INFLUX_TOKEN || '',
  INFLUX_ORG: process.env.INFLUX_ORG || 'shiro_org',
  INFLUX_BUCKET: process.env.INFLUX_BUCKET || 'shiro_telemetry'
};

