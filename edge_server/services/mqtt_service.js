// =============================================================================
// MQTT Broker & Telemetry Dispatch Service (Aedes)
// =============================================================================
const { Aedes } = require('aedes');
const net = require('net');
const { KalmanFilter1D, calculateDistance, getCalibration } = require('./kalman_filter');
const { broadcastToClients } = require('./websocket_service');
const deviceService = require('./device_service');

let aedesInstance = null;
let tcpServer = null;

// Dynamic Kalman filter registry per Anchor ID
const anchorFilters = {};

function getAnchorFilter(anchorId) {
  if (!anchorFilters[anchorId]) {
    anchorFilters[anchorId] = new KalmanFilter1D(4.0, 0.05, -60.0);
  }
  return anchorFilters[anchorId];
}

async function startMqttBroker(port = 1883) {
  aedesInstance = await Aedes.createBroker();
  tcpServer = net.createServer(aedesInstance.handle);

  tcpServer.listen(port, '0.0.0.0', () => {
    console.log(`[MQTT BROKER] Listening on 0.0.0.0:${port}`);
  });

  // Client lifecycle events
  aedesInstance.on('client', (client) => {
    console.log(`[MQTT CLIENT CONNECTED] ID: ${client.id}`);
    const ip = client.conn?.remoteAddress ? client.conn.remoteAddress.replace(/^.*:/, '') : null;

    if (client.id.includes('Anchor')) {
      const hexMatch = client.id.match(/([0-9A-Fa-f]{12})$/);
      const mac = hexMatch ? hexMatch[1].match(/.{1,2}/g).join(':').toUpperCase() : null;
      const enrolled = mac ? deviceService.findEnrolledDeviceByMac(mac) : null;
      const anchorId = enrolled ? enrolled.device_id : (mac || 'anchor-001');
      deviceService.recordActiveDeviceTraffic(anchorId, 'ANCHOR', { mac, clientId: client.id, ip, model: 'ESP32-WROOM-32E', rssi: null });
    } else if (client.id.includes('Gateway') || client.id.includes('Edge_Node')) {
      const hexMatch = client.id.match(/([0-9A-Fa-f]{12})$/);
      const mac = hexMatch ? hexMatch[1].match(/.{1,2}/g).join(':').toUpperCase() : null;
      const enrolled = mac ? deviceService.findEnrolledDeviceByMac(mac) : null;
      const gatewayId = enrolled ? enrolled.device_id : 'EDGE-001';
      deviceService.recordActiveDeviceTraffic(gatewayId, 'EDGE_NODE', { mac, clientId: client.id, ip, model: 'ESP32-S3-N16R8 Dev Module', rssi: null });
    }
  });

  aedesInstance.on('clientDisconnect', (client) => {
    console.log(`[MQTT CLIENT DISCONNECTED] ID: ${client.id}`);
    // NOTE: We deliberately do NOT immediately broadcast status: 'OFFLINE' on socket drop.
    // Temporary TCP socket renegotiations or Wi-Fi reconnects (0.3s) cause false-positive OFFLINE flashes.
    // The server-side freshness watchdog (12-second timeout) reliably marks dead nodes offline when genuinely unplugged.
  });

  aedesInstance.on('connectionError', (client, error) => {
    console.error(`[MQTT ERROR] Client: ${client ? client.id : 'unknown'}`, error.message);
  });

  // Intercept incoming publish packets
  aedesInstance.on('publish', (packet, client) => {
    if (!client) return; // Ignore internal broker messages

    const topic = packet.topic;
    const messageStr = packet.payload.toString();

    try {
      const parsed = JSON.parse(messageStr);

      // Check if packet is a device discovery announcement
      if (topic.includes('discovery') || parsed.type === 'DISCOVERY' || parsed.type === 'ANNOUNCE') {
        deviceService.recordDiscoveredDevice(parsed);
        return;
      }

      // 1. Check if packet originates from stationary BLE anchor beacon
      if (topic.includes('anchor') || parsed.anchor || parsed.anchor_mac) {
        const rawRssi = parseFloat(parsed.rssi || 0);
        const ip = client?.conn?.remoteAddress ? client.conn.remoteAddress.replace(/^.*:/, '') : null;
        const isStandby = (rawRssi === 0 || parsed.status === 'STANDBY');
        const anchorMac = (parsed.anchor_mac || parsed.mac) ? (parsed.anchor_mac || parsed.mac).toUpperCase() : null;

        // Auto-resolve enrolled device ID from physical MAC address
        const enrolledAnchor = anchorMac ? deviceService.findEnrolledDeviceByMac(anchorMac) : null;
        const anchorId = enrolledAnchor ? enrolledAnchor.device_id : (parsed.anchor || anchorMac || 'anchor-001');

        // Update anchor activity in device manager with its real MAC address
        deviceService.recordActiveDeviceTraffic(anchorId, 'ANCHOR', {
          mac: anchorMac,
          rssi: isStandby ? null : rawRssi,
          ip,
          clientId: client?.id,
          model: 'ESP32-WROOM-32E',
          status_text: isStandby ? 'STANDBY' : 'TRACKING'
        });

        // If anchor detected a wristband tag, update that tag's presence with its real MAC and RSSI
        if (!isStandby && (parsed.tag_mac || parsed.tag || parsed.tag_id)) {
          const tagMac = (parsed.tag_mac || parsed.mac_tag || (parsed.mac && parsed.mac !== anchorMac ? parsed.mac : null)) 
            ? (parsed.tag_mac || parsed.mac_tag || parsed.mac).toUpperCase() 
            : null;
          const enrolledTag = tagMac ? deviceService.findEnrolledDeviceByMac(tagMac) : null;
          const detectedTag = enrolledTag ? enrolledTag.device_id : (parsed.tag || parsed.tag_id || tagMac || 'TAG-001');

          deviceService.recordActiveDeviceTraffic(detectedTag, 'WRISTBAND', {
            mac: tagMac,
            rssi: rawRssi,
            detected_by_anchor: anchorId,
            model: 'Seeed Studio XIAO ESP32-C6'
          });
        }

        // Only compute distance and broadcast chart if a valid RF signal is present (not standby 0)
        if (!isStandby && !isNaN(rawRssi)) {
          const filter = getAnchorFilter(anchorId);
          const filteredRssi = filter.update(rawRssi);
          const rawDist = calculateDistance(rawRssi);
          const filteredDist = calculateDistance(filteredRssi);

          broadcastToClients({
            type: 'ANCHOR_RSSI',
            topic: topic,
            anchor: anchorId,
            anchor_mac: anchorMac,
            raw_rssi: rawRssi,
            filtered_rssi: Math.round(filteredRssi * 10) / 10,
            raw_distance: rawDist,
            filtered_distance: filteredDist,
            calibration: getCalibration(),
            timestamp: new Date().toLocaleTimeString()
          });
        }
      } 
      // 2. Gateway standalone heartbeat packet
      else if (topic.includes('gateway') || parsed.gateway) {
        const ip = client?.conn?.remoteAddress ? client.conn.remoteAddress.replace(/^.*:/, '') : null;
        const gatewayMac = parsed.mac ? parsed.mac.toUpperCase() : null;
        const enrolledGw = gatewayMac ? deviceService.findEnrolledDeviceByMac(gatewayMac) : null;
        const gwId = enrolledGw ? enrolledGw.device_id : (parsed.gateway || 'EDGE-001');
        deviceService.recordActiveDeviceTraffic(gwId, 'EDGE_NODE', {
          mac: gatewayMac,
          ip,
          clientId: client?.id,
          model: 'ESP32-S3-N16R8 Dev Module',
          rssi: null
        });
      }
      // 3. Wristband Physiological Telemetry (HR, SpO2, Accelerometer)
      else {
        const ip = client?.conn?.remoteAddress ? client.conn.remoteAddress.replace(/^.*:/, '') : null;
        let gatewayMac = parsed.gateway_mac ? parsed.gateway_mac.toUpperCase() : null;
        if (!gatewayMac && client?.id && client.id.startsWith('SHIRO_Gateway_')) {
          const raw = client.id.replace('SHIRO_Gateway_', '');
          if (raw.length === 12) {
            gatewayMac = raw.match(/.{1,2}/g).join(':').toUpperCase();
          }
        }

        let activeGwId = null;
        if (gatewayMac) {
          const enrolledGw = deviceService.findEnrolledDeviceByMac(gatewayMac);
          activeGwId = enrolledGw ? enrolledGw.device_id : 'EDGE-001';
          deviceService.recordActiveDeviceTraffic(activeGwId, 'EDGE_NODE', {
            mac: gatewayMac,
            ip,
            clientId: client?.id,
            model: 'ESP32-S3-N16R8 Dev Module',
            rssi: null
          });
        }

        // STRICT CHECK: ONLY record a wristband if payload actually contains valid vitals/kinematics!
        // Never synthesize a phantom wristband on empty/gateway packets!
        const hasVitals = parsed.bpm !== undefined || parsed.ir !== undefined || parsed.spo2 !== undefined || parsed.g !== undefined;
        if ((parsed.tag_id || parsed.tag_mac) && hasVitals) {
          const tagMac = (parsed.tag_mac || parsed.mac) ? (parsed.tag_mac || parsed.mac).toUpperCase() : null;
          const enrolledTag = tagMac ? deviceService.findEnrolledDeviceByMac(tagMac) : null;
          const tagId = enrolledTag ? enrolledTag.device_id : (parsed.tag_id || tagMac || 'TAG-001');
          deviceService.recordActiveDeviceTraffic(tagId, 'WRISTBAND', {
            mac: tagMac,
            battery_level: parsed.bat !== undefined ? parsed.bat : (parsed.battery !== undefined ? parsed.battery : null),
            model: 'Seeed Studio XIAO ESP32-C6'
            // NOTE: Do not pass rssi here so existing anchor RSSI is NEVER overwritten or wiped to null!
          });
          parsed.tag_id = tagId;
        }

        broadcastToClients({
          type: 'TELEMETRY',
          topic: topic,
          data: parsed,
          gateway_id: activeGwId,
          timestamp: new Date().toLocaleTimeString()
        });
      }
    } catch (e) {
      // Fallback for non-JSON raw strings
      broadcastToClients({
        type: 'RAW',
        topic: topic,
        data: messageStr,
        timestamp: new Date().toLocaleTimeString()
      });
    }
  });

  return { aedes: aedesInstance, tcpServer };
}

module.exports = {
  startMqttBroker
};

