// =============================================================================
// SHIRO Edge Server Configuration
// =============================================================================
const os = require('os');
const path = require('path');

function getLocalIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const netInfo of nets[name]) {
      if (netInfo.family === 'IPv4' && !netInfo.internal) {
        return netInfo.address;
      }
    }
  }
  return '127.0.0.1';
}

module.exports = {
  HTTP_PORT: process.env.HTTP_PORT ? parseInt(process.env.HTTP_PORT, 10) : 3000,
  MQTT_PORT: process.env.MQTT_PORT ? parseInt(process.env.MQTT_PORT, 10) : 1883,
  LOCAL_IP: getLocalIp(),
  PUBLIC_DIR: path.join(__dirname, '..', 'public'),
  VIEWS_DIR: path.join(__dirname, '..', 'public', 'views')
};

