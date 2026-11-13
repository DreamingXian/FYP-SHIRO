// =============================================================================
// MQTT Broker & Telemetry Dispatch Service (Aedes)
// =============================================================================
const { Aedes } = require('aedes');
const net = require('net');
const { KalmanFilter1D, calculateDistance, getCalibration } = require('./kalman_filter');
const { broadcastToClients } = require('./websocket_service');
const deviceService = require('./device_service');
const ipsService = require('./ips_service');
const alertService = require('./alert_service');
const timeSeriesService = require('./time_series_service');
const bindingCache = require('./binding_cache');
const { normalizeTelemetry } = require('./telemetry/normalize');

let aedesInstance = null;
let tcpServer = null;

// Wristbands whose packet the anchors cannot decode: warn once a minute per tag
const UNSUPPORTED_WARNING_INTERVAL_MS = 60000;
const lastUnsupportedWarning = new Map();

function warnUnsupportedPacket(tagMac) {
  const key = tagMac || 'UNKNOWN';
  const now = Date.now();
  if (now - (lastUnsupportedWarning.get(key) || 0) < UNSUPPORTED_WARNING_INTERVAL_MS) return;
  lastUnsupportedWarning.set(key, now);
  console.warn(`[PROTOCOL] Wristband ${key} sends a packet version this system does not support. Position is tracked, vitals and fall alerts are NOT. Reflash the wristband.`);
}

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

        // If anchor detected a wristband tag, update that tag's presence with its real MAC, RSSI, and live vitals
        if (!isStandby && (parsed.tag_mac || parsed.tag || parsed.tag_id)) {
          const tagMac = (parsed.tag_mac || parsed.mac_tag || (parsed.mac && parsed.mac !== anchorMac ? parsed.mac : null)) 
            ? (parsed.tag_mac || parsed.mac_tag || parsed.mac).toUpperCase() 
            : null;
          const enrolledTag = tagMac ? deviceService.findEnrolledDeviceByMac(tagMac) : null;
          const detectedTag = enrolledTag ? enrolledTag.device_id : (parsed.tag || parsed.tag_id || tagMac || 'TAG-001');

          // One validated view of the packet: unknown values are null, never invented
          const telemetry = normalizeTelemetry(parsed);
          if (telemetry.protocolVersion === 0) warnUnsupportedPacket(tagMac);

          const isCharging = telemetry.charging;
          const batLevel = telemetry.battery;

          deviceService.recordActiveDeviceTraffic(detectedTag, 'WRISTBAND', {
            mac: tagMac,
            rssi: rawRssi,
            detected_by_anchor: anchorId,
            battery_level: batLevel,
            status: isCharging ? 'CHARGING' : 'ONLINE',
            is_charging: isCharging,
            model: 'Seeed Studio XIAO ESP32-C6'
          });

          // Feed into IPS Real-Time Multilateration Engine
          ipsService.recordAnchorReading({
            anchorId,
            anchorMac,
            tagId: detectedTag,
            tagMac,
            rawRssi,
            timestamp: Date.now()
          });

          if (telemetry.hasTelemetry) {
            // Feed IMU kinematics into IPS 4-State Motion Filter (only real accelerometer values)
            if (telemetry.g !== null) {
              ipsService.recordKinematics(detectedTag, telemetry.g, Date.now(), telemetry.motion);
            }

            // Evaluate Fall Anomaly & Critical Vitals Alarm Pipeline.
            // A failure here must be visible and must not stop telemetry processing.
            alertService.evaluateTelemetry(telemetry, detectedTag, tagMac).catch((err) => {
              console.error(`[ALERT PIPELINE ERROR] ${detectedTag}: ${err.message}`);
            });

            // Broadcast live vitals for Patient Monitors, Live Map & VR Headsets.
            // bpm / spo2 of 0 mean "no valid reading". g and motion are left out
            // when the accelerometer has failed.
            broadcastToClients({
              type: 'TELEMETRY',
              topic: topic,
              data: {
                tag_id: detectedTag,
                tag_mac: tagMac,
                bpm: telemetry.bpm ?? 0,
                spo2: telemetry.spo2 ?? 0,
                g: telemetry.g ?? undefined,
                motion: telemetry.motion ?? undefined,
                touch: telemetry.touch ? 1 : 0,
                active: telemetry.active,
                battery: batLevel,
                charging: isCharging,
                fall: telemetry.fall,
                imu_fault: telemetry.imuFault,
                ppg_fault: telemetry.ppgFault,
                protocol_version: telemetry.protocolVersion,
                detected_by_anchor: anchorId
              },
              timestamp: new Date().toLocaleTimeString()
            });

            // Log time-series telemetry to InfluxDB (Table 4.10): measured values only
            if (telemetry.bpm !== null || telemetry.spo2 !== null) {
              timeSeriesService.logVitals({
                patientId: bindingCache.getPatientIdForDevice(detectedTag) || 'UNASSIGNED',
                wristbandMac: tagMac,
                bpm: telemetry.bpm,
                spo2: telemetry.spo2,
                quality: telemetry.touch ? 0.95 : 0.40,
                mode: telemetry.active ? 'ACTIVE_STREAM' : 'PASSIVE_3MIN'
              });
            }
          }
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
      // 2. Generic direct telemetry fallback
      else if (parsed.bpm !== undefined || parsed.battery !== undefined || parsed.g !== undefined) {
        broadcastToClients({
          type: 'TELEMETRY',
          topic: topic,
          data: parsed,
          timestamp: new Date().toLocaleTimeString()
        });
      }
    } catch (e) {
      console.warn(`[MQTT PARSE WARNING] Malformed or truncated packet on "${topic}": ${messageStr.slice(0, 120)}... (${e.message})`);
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

/**
 * Publish an MQTT message to connected nodes/anchors
 */
function publishMqtt(topic, payload) {
  if (!aedesInstance) {
    console.warn('[MQTT PUBLISH] Broker not started yet.');
    return false;
  }
  const message = typeof payload === 'string' ? payload : JSON.stringify(payload);
  aedesInstance.publish({
    topic,
    payload: Buffer.from(message),
    qos: 0,
    retain: false
  }, (err) => {
    if (err) console.error('[MQTT PUBLISH ERROR]', err.message);
  });
  return true;
}

module.exports = {
  startMqttBroker,
  publishMqtt
};

