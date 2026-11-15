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
const { checkAnchorMessage, checkDiscoveryMessage, MAX_PAYLOAD_BYTES } = require('./telemetry/anchor_message');
const tagHearing = require('./telemetry/tag_hearing');
const { createAccessControl, anchorMacFromClientId } = require('./mqtt_access');

const DISCOVERY_TOPIC = 'shiro/discovery';

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

// Messages that are refused: one warning per client and reason every 10 seconds,
// so a faulty or hostile device cannot flood the log.
const REFUSED_WARNING_INTERVAL_MS = 10000;
const lastRefusedWarning = new Map();

function warnRefusedMessage(client, topic, reason) {
  const clientId = client && typeof client.id === 'string' ? client.id.slice(0, 60) : 'unknown';
  const key = `${clientId}|${reason}`;
  const now = Date.now();
  if (now - (lastRefusedWarning.get(key) || 0) < REFUSED_WARNING_INTERVAL_MS) return;
  if (lastRefusedWarning.size > 500) lastRefusedWarning.clear();
  lastRefusedWarning.set(key, now);
  console.warn(`[MQTT] Message from "${clientId}" on "${String(topic).slice(0, 80)}" ignored: ${reason}.`);
}

// Dynamic Kalman filter registry per Anchor ID
const anchorFilters = {};

function getAnchorFilter(anchorId) {
  if (!anchorFilters[anchorId]) {
    anchorFilters[anchorId] = new KalmanFilter1D(4.0, 0.05, -60.0);
  }
  return anchorFilters[anchorId];
}

/**
 * Starts the broker. Only clients with the anchor login may connect, and they
 * may use the anchor topics only (services/mqtt_access.js).
 * @param {number} port
 * @param {{username: string, password: string}} credentials  from readAnchorCredentials()
 */
async function startMqttBroker(port, credentials) {
  if (!credentials || !credentials.username || !credentials.password) {
    throw new Error('The MQTT broker needs the anchor login (MQTT_ANCHOR_USER, MQTT_ANCHOR_PASSWORD).');
  }
  aedesInstance = await Aedes.createBroker(createAccessControl(credentials));
  tcpServer = net.createServer(aedesInstance.handle);

  await new Promise((resolve, reject) => {
    tcpServer.once('error', reject);
    tcpServer.listen(port, '0.0.0.0', () => {
      tcpServer.off('error', reject);
      console.log(`[MQTT BROKER] Listening on 0.0.0.0:${port} (anchor login required)`);
      resolve();
    });
  });

  // Client lifecycle events. Only logged-in anchors get here.
  aedesInstance.on('client', (client) => {
    console.log(`[MQTT CLIENT CONNECTED] ID: ${client.id}`);
    const ip = client.conn?.remoteAddress ? client.conn.remoteAddress.replace(/^.*:/, '') : null;
    const mac = anchorMacFromClientId(client.id);
    if (mac) {
      const enrolled = deviceService.findEnrolledDeviceByMac(mac);
      const anchorId = enrolled ? enrolled.device_id : mac;
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
    // Refused logins are already reported, once per address, by mqtt_access.js
    if (error && error.errorCode >= 2 && error.errorCode <= 5) return;
    console.error(`[MQTT ERROR] Client: ${client ? client.id : 'unknown'}`, error.message);
  });

  aedesInstance.on('clientError', (client, error) => {
    // A refused publish ends the connection; mqtt_access.js has already said why
    if (error && /not allowed/.test(error.message)) return;
    console.warn(`[MQTT CLIENT ERROR] ${client ? client.id : 'unknown'}: ${error.message}`);
  });

  // Intercept incoming publish packets
  aedesInstance.on('publish', (packet, client) => {
    if (!client) return; // Ignore internal broker messages

    const topic = packet.topic;
    if (packet.payload.length > MAX_PAYLOAD_BYTES) {
      warnRefusedMessage(client, topic, `payload larger than ${MAX_PAYLOAD_BYTES} bytes`);
      return;
    }
    const messageStr = packet.payload.toString();

    try {
      const parsed = JSON.parse(messageStr);

      // Device announcement (discovery topic)
      if (topic === DISCOVERY_TOPIC || (parsed && (parsed.type === 'DISCOVERY' || parsed.type === 'ANNOUNCE'))) {
        const announcement = checkDiscoveryMessage(parsed);
        if (announcement) deviceService.recordDiscoveredDevice(announcement);
        else warnRefusedMessage(client, topic, 'announcement without a valid MAC address');
        return;
      }

      // Everything else must be an anchor message as defined in docs/protocol.md.
      // It is checked before any value is looked up, stored or shown.
      const message = checkAnchorMessage(parsed);
      if (!message.ok) {
        warnRefusedMessage(client, topic, message.reason);
        return;
      }
      // An anchor reports under its own MAC address only: the one in its login client ID
      if (message.anchorMac !== anchorMacFromClientId(client.id)) {
        warnRefusedMessage(client, topic, `anchor_mac ${message.anchorMac} is not the MAC address of this anchor's client ID`);
        return;
      }
      if (message.tagMacInvalid) warnRefusedMessage(client, topic, 'tag_mac is not a MAC address, so the wristband part was skipped');

      {
        const rawRssi = message.rssi;
        const ip = client?.conn?.remoteAddress ? client.conn.remoteAddress.replace(/^.*:/, '') : null;
        const isStandby = message.standby;
        const anchorMac = message.anchorMac;

        // An enrolled anchor is known by its device ID, any other by its MAC address
        const enrolledAnchor = deviceService.findEnrolledDeviceByMac(anchorMac);
        const anchorId = enrolledAnchor ? enrolledAnchor.device_id : anchorMac;

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
        if (!isStandby && message.tagMac) {
          const tagMac = message.tagMac;
          tagHearing.recordHearing(tagMac, anchorMac, rawRssi);
          const enrolledTag = deviceService.findEnrolledDeviceByMac(tagMac);
          const detectedTag = enrolledTag ? enrolledTag.device_id : tagMac;

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
        if (!isStandby) {
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
    } catch (e) {
      // Not JSON, or a fault while handling it. Nothing of the message is passed on.
      warnRefusedMessage(client, topic, e instanceof SyntaxError ? 'not valid JSON' : `could not be processed (${e.message})`);
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

