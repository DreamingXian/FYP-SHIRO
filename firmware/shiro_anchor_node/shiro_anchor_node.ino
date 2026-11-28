/*
 * =========================================================================================
 *   SHIRO Anchor Node - Combined RSSI Localization & Vitals Gateway (V4.1 - Protocol 2)
 *   Hardware: ESP32-WROOM-32E (or generic ESP32); also ESP32-S3 and Seeed XIAO ESP32-C3
 *             (with its FPC antenna attached), unchanged. Partition scheme "Huge APP" on all.
 *   Bluetooth: Arduino-ESP32 3.3 uses Bluedroid on the ESP32 and NimBLE on the ESP32-S3
 *             and ESP32-C3. On NimBLE the scan is passive and keeps no list of devices
 *             (4.1, see onResult); on Bluedroid it is unchanged from V4.
 *   Function: Continuously scans for SHIRO-WRISTBAND BLE broadcasts, records raw RSSI
 *             for IPS multilateration, unpacks physiological/kinematic telemetry,
 *             and streams unified telemetry packets to the Edge Server over Wi-Fi/MQTT.
 *   Note:     UNIVERSAL FIRMWARE - Flash the EXACT same code to all anchor boards!
 *             Device Identifiers are auto-assigned by the Central Edge Server.
 *   Protocol: Telemetry packet version 2 (shiro_packet.h, docs/protocol.md).
 *             The wristband and ALL anchors must run the same version: flash them together.
 *   Project:  MR-Patient Connect (SHIRO) - Final Year Project (RSWG7)
 * =========================================================================================
 */

#include <WiFi.h>
#include <PubSubClient.h>
#include <BLEDevice.h>
#include <BLEUtils.h>
#include <BLEScan.h>
#include <BLEAdvertisedDevice.h>
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "shiro_packet.h"

// =============================================================================
// 1. Wi-Fi & MQTT Server Configuration
// =============================================================================
// Site settings live in secrets.h (git-ignored). Copy secrets.example.h to
// secrets.h in this sketch folder and fill in your own values.
#if __has_include("secrets.h")
#include "secrets.h"
#else
#error "secrets.h not found: copy secrets.example.h to secrets.h and fill in your Wi-Fi and MQTT settings"
#endif

// The edge server refuses anchors without the MQTT login (edge_server/.env)
#if !defined(SHIRO_MQTT_USER) || !defined(SHIRO_MQTT_PASSWORD)
#error "secrets.h needs SHIRO_MQTT_USER and SHIRO_MQTT_PASSWORD: the same values as MQTT_ANCHOR_USER and MQTT_ANCHOR_PASSWORD in edge_server/.env (see secrets.example.h)"
#endif

const char* ssid        = SHIRO_WIFI_SSID;
const char* password    = SHIRO_WIFI_PASSWORD;
const char* mqtt_server = SHIRO_MQTT_SERVER;
const int   mqtt_port   = SHIRO_MQTT_PORT;
const char* mqtt_user   = SHIRO_MQTT_USER;
const char* mqtt_pass   = SHIRO_MQTT_PASSWORD;

// Shared MQTT Topic for all anchors
const char* mqtt_topic  = "shiro/ward-A1/anchor/telemetry";

// Target Wristband BLE Service UUID
static BLEUUID serviceUUID("4fafc201-1fb5-459e-8fcc-c5c9c331914b");
static BLEUUID controlCharUUID("beb5483e-36e1-4688-b7f5-ea07361b26a8");

// Network & BLE Objects
WiFiClient espClient;
PubSubClient mqttClient(espClient);
BLEScan* pBLEScan = nullptr;

// This anchor's own MAC address as text, read once at start-up
char anchorMac[18] = {0};

// =============================================================================
// 2. Tracking table for the wristbands this anchor can hear
// =============================================================================
// The BLE scan callback (Bluetooth task) writes this table while loop() (Arduino
// task) reads it. Every access goes through tagTableMutex. Entries hold plain
// data only, so a copy taken under the lock can be used after releasing it.
struct HeardTag {
  char mac[18];
  int rssi;
  unsigned long lastHeardMs;
  bool pending;             // heard since the last publish
  bool telemetryFresh;      // a decodable telemetry packet arrived since the last publish
  bool unsupportedPacket;   // a SHIRO packet of another version arrived since the last publish
  shiro::Telemetry telemetry;
};

const int MAX_TRACKED_TAGS = 16;
const unsigned long TAG_EVICT_AFTER_MS = 30000;  // a silent wristband frees its slot after 30 s
HeardTag trackedTags[MAX_TRACKED_TAGS];
int trackedTagCount = 0;
SemaphoreHandle_t tagTableMutex = nullptr;
volatile uint32_t droppedPackets = 0;            // table full or lock busy
// Written by the Bluetooth task only, read by loop() for the 30 s health line
volatile uint32_t bluetoothReports = 0;          // every advertisement reported by the scanner
volatile uint32_t wristbandReports = 0;          // of those, from a SHIRO wristband

volatile bool pendingCmd = false;
char pendingTargetMac[24] = {0};

unsigned long lastPublishTime = 0;
unsigned long lastPacketHeard = 0;
const unsigned long PUBLISH_INTERVAL = 150; // Publish ~6-7 times per second (every 150 ms)

// The largest telemetry message is about 330 characters
const size_t PAYLOAD_BUFFER_SIZE = 512;
const uint16_t MQTT_BUFFER_SIZE = 768;      // payload + topic + MQTT header

// Finds a tag by MAC. Call only while holding tagTableMutex.
int findTagIndex(const char* mac) {
  for (int i = 0; i < trackedTagCount; i++) {
    if (strcasecmp(trackedTags[i].mac, mac) == 0) return i;
  }
  return -1;
}

// Removes wristbands that have been silent too long. Call only while holding tagTableMutex.
void evictSilentTags(unsigned long now) {
  int kept = 0;
  for (int i = 0; i < trackedTagCount; i++) {
    if (now - trackedTags[i].lastHeardMs <= TAG_EVICT_AFTER_MS) {
      if (kept != i) trackedTags[kept] = trackedTags[i];
      kept++;
    }
  }
  trackedTagCount = kept;
}

// -----------------------------------------------------------------------------
// BLE Advertised Device Callback (Triggers whenever an RF packet is heard)
// -----------------------------------------------------------------------------
class MyAdvertisedDeviceCallbacks : public BLEAdvertisedDeviceCallbacks {
  void onResult(BLEAdvertisedDevice advertisedDevice) {
    bluetoothReports = bluetoothReports + 1;
    handleAdvertisement(advertisedDevice);
#if defined(CONFIG_NIMBLE_ENABLED)
    // NimBLE (ESP32-S3, ESP32-C3): during a scan that never ends, the library keeps
    // every device it has heard in a list that is never emptied, and adds the
    // device's service UUIDs to it again with every advertisement. Near phones,
    // which change their address every few minutes, the memory runs out within a
    // minute and the board aborts (seen on a XIAO C3 on 21 Nov 2026: a std::vector
    // of BLEUUID growing in BLEAdvertisedDevice::parseAdvertisement). So the device
    // is removed again as soon as it has been handled. Checked against core 3.3.13:
    // after onResult() returns, BLEScan::handleGAPEvent() uses the device only when
    // the result limit is 0, which is not the default (0xFF), so it is not touched again.
    if (pBLEScan) pBLEScan->erase(advertisedDevice.getAddress());
#endif
  }

  // KEY LOGIC: called for every BLE advertisement the anchor hears. It keeps only SHIRO
  // wristbands (magic bytes "SH" in the manufacturer data, or the wristband's name / service
  // UUID), records the RSSI (signal strength: used for the position), and decodes the
  // telemetry packet (shiro::decodePacket). The latest result per wristband is kept in a
  // small table; loop() publishes it to the edge server over MQTT about 6.7 times a second.
  void handleAdvertisement(BLEAdvertisedDevice& advertisedDevice) {
    bool isWristband = false;
    bool decoded = false;
    bool unsupported = false;
    shiro::Telemetry telemetry;

    // 1. Telemetry packet in the manufacturer data
    if (advertisedDevice.haveManufacturerData()) {
      String mfg = advertisedDevice.getManufacturerData();
      shiro::DecodeResult result = shiro::decodePacket((const uint8_t*)mfg.c_str(), mfg.length(), telemetry);
      if (result == shiro::DECODE_OK) {
        isWristband = true;
        decoded = true;
      } else if (result != shiro::DECODE_NOT_SHIRO) {
        // A SHIRO wristband with another packet version: track its position,
        // but do not guess its telemetry.
        isWristband = true;
        unsupported = true;
      }
    }

    // 2. Otherwise match by device name or service UUID (RSSI only)
    if (!isWristband) {
      if (advertisedDevice.haveName() && advertisedDevice.getName() == "SHIRO-WRISTBAND") {
        isWristband = true;
      } else if (advertisedDevice.haveServiceUUID() && advertisedDevice.isAdvertisingService(serviceUUID)) {
        isWristband = true;
      }
    }

    if (!isWristband) return;

    String tagMac = advertisedDevice.getAddress().toString();
    int rssi = advertisedDevice.getRSSI();
    unsigned long now = millis();

    if (xSemaphoreTake(tagTableMutex, pdMS_TO_TICKS(20)) != pdTRUE) {
      droppedPackets = droppedPackets + 1;
      return;
    }

    int idx = findTagIndex(tagMac.c_str());
    if (idx < 0 && trackedTagCount < MAX_TRACKED_TAGS) {
      idx = trackedTagCount++;
      memset(&trackedTags[idx], 0, sizeof(HeardTag));
      strncpy(trackedTags[idx].mac, tagMac.c_str(), sizeof(trackedTags[idx].mac) - 1);
    }

    if (idx >= 0) {
      wristbandReports = wristbandReports + 1;
      HeardTag& tag = trackedTags[idx];
      tag.rssi = rssi;
      tag.lastHeardMs = now;
      tag.pending = true;
      if (decoded) {
        tag.telemetry = telemetry;
        tag.telemetryFresh = true;
      }
      if (unsupported) tag.unsupportedPacket = true;
    } else {
      droppedPackets = droppedPackets + 1; // table full: every slot holds a wristband heard in the last 30 s
    }

    xSemaphoreGive(tagTableMutex);
  }
};

// -----------------------------------------------------------------------------
// MQTT Incoming Message Callback (Listens for Mode / Vitals Commands)
// -----------------------------------------------------------------------------
// Copies the text value of "key":"value" from a flat JSON message into out.
// Returns false when the key is missing or the value does not fit.
bool jsonTextField(const char* msg, const char* key, char* out, size_t outSize) {
  char pattern[40];
  snprintf(pattern, sizeof(pattern), "\"%s\":\"", key);
  const char* p = strstr(msg, pattern);
  if (!p || outSize == 0) return false;
  p += strlen(pattern);
  size_t i = 0;
  while (*p && *p != '\"') {
    if (i + 1 >= outSize) return false;
    out[i++] = *p++;
  }
  out[i] = '\0';
  return *p == '\"';
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  char msg[256];
  if (length >= sizeof(msg)) length = sizeof(msg) - 1;
  memcpy(msg, payload, length);
  msg[length] = '\0';

  if (strstr(msg, "SET_ACTIVE") != nullptr) {
    char targetMac[24] = {0};
    char targetAnchor[24] = {0};
    jsonTextField(msg, "target_mac", targetMac, sizeof(targetMac));

    // The server sends the command through one anchor only: the one that hears
    // the wristband best. Two anchors connecting at once would both fail.
    if (!jsonTextField(msg, "target_anchor", targetAnchor, sizeof(targetAnchor))) {
      Serial.println("[ANCHOR] 1 Hz command without target_anchor ignored (edge server too old?).");
      return;
    }
    if (strcasecmp(targetAnchor, anchorMac) != 0) {
      return; // meant for another anchor
    }

    if (strlen(targetMac) >= 12) {
      // Connect only if this anchor heard the target tag within 3.5s with strong RSSI (>= -82 dBm)
      bool inRange = false;
      int heardRssi = 0;
      if (xSemaphoreTake(tagTableMutex, pdMS_TO_TICKS(50)) == pdTRUE) {
        int idx = findTagIndex(targetMac);
        if (idx >= 0 && (millis() - trackedTags[idx].lastHeardMs < 3500) && trackedTags[idx].rssi >= -82) {
          inRange = true;
          heardRssi = trackedTags[idx].rssi;
        }
        xSemaphoreGive(tagTableMutex);
      }

      if (inRange) {
        strncpy(pendingTargetMac, targetMac, sizeof(pendingTargetMac) - 1);
        pendingTargetMac[sizeof(pendingTargetMac) - 1] = '\0';
        pendingCmd = true;
        Serial.printf("\n[ANCHOR] Chosen for tag %s (RSSI: %d). Queued 1 Hz Active Mode Escalation!\n", targetMac, heardRssi);
      } else {
        Serial.printf("\n[ANCHOR] Chosen for tag %s, but it is not heard here now (weaker than -82 dBm or silent > 3.5 s). Command not carried out.\n", targetMac);
      }
    }
  }
}

// -----------------------------------------------------------------------------
// BLE GATT Client Command Dispatcher (Relays Edge Server Commands to Tags)
// -----------------------------------------------------------------------------
// KEY LOGIC: the only time a BLE connection is made. The edge server picks the anchor that
// hears this wristband most strongly (tag_hearing.strongestAnchor) and sends it an MQTT
// command; the anchor stops scanning, connects to the wristband, writes "ACTIVE" to its
// control characteristic (the wristband then streams vitals at 1 Hz for 120 s), disconnects
// and resumes scanning.
void executeActiveModeCommand(const char* targetMacStr) {
  if (!targetMacStr || strlen(targetMacStr) < 11) return;

  Serial.printf("\n[BLE CLIENT] Stopping scan to connect to wristband %s...\n", targetMacStr);
  if (pBLEScan) pBLEScan->stop();
  delay(40);

  BLEAddress targetAddr(targetMacStr);
  BLEClient* pClient = BLEDevice::createClient();
  if (pClient != nullptr) {
    if (pClient->connect(targetAddr)) {
      BLERemoteService* pRemoteService = pClient->getService(serviceUUID);
      if (pRemoteService != nullptr) {
        BLERemoteCharacteristic* pRemoteChar = pRemoteService->getCharacteristic(controlCharUUID);
        if (pRemoteChar != nullptr) {
          pRemoteChar->writeValue(String("ACTIVE"), false);
          Serial.printf("[BLE CLIENT SUCCESS] Sent 'ACTIVE' to wristband %s!\n", targetMacStr);
        }
      }
      pClient->disconnect();
    } else {
      Serial.printf("[BLE CLIENT] Connection to %s failed or timed out.\n", targetMacStr);
    }
    delete pClient;
  }

  // Immediately resume continuous scanning
  if (pBLEScan) pBLEScan->start(0, nullptr, false);
  mqttClient.loop();
}

// -----------------------------------------------------------------------------
// Wi-Fi Connection Helper
// -----------------------------------------------------------------------------
// The board restarts when Wi-Fi does not come up at power-on within this time,
// or stays lost for WIFI_LOST_RESTART_MS: a restart clears a stuck radio state.
const unsigned long WIFI_START_TIMEOUT_MS = 20000;
const unsigned long WIFI_RETRY_INTERVAL_MS = 5000;
const unsigned long WIFI_LOST_RESTART_MS = 120000;
const unsigned long MQTT_RETRY_INTERVAL_MS = 2000;

void setupWifi() {
  delay(10);
  Serial.printf("\nConnecting to Wi-Fi: %s ", ssid);
  WiFi.mode(WIFI_STA);
  WiFi.persistent(false);       // do not rewrite flash at every connection
  WiFi.setAutoReconnect(true);  // the Wi-Fi driver also retries on its own
  WiFi.begin(ssid, password);

  const unsigned long started = millis();
  while (WiFi.status() != WL_CONNECTED) {
    if (millis() - started > WIFI_START_TIMEOUT_MS) {
      Serial.printf("\n[FAILED] No Wi-Fi after %lu s. Check SHIRO_WIFI_SSID / SHIRO_WIFI_PASSWORD and that the network is 2.4 GHz. Restarting...\n",
                    WIFI_START_TIMEOUT_MS / 1000);
      delay(1000);
      ESP.restart();
    }
    delay(500);
    Serial.print(".");
  }
  Serial.println("\n[OK] Wi-Fi Connected!");
  Serial.print("Anchor IP Address: ");
  Serial.println(WiFi.localIP());
  Serial.print("Anchor MAC Address: ");
  Serial.println(WiFi.macAddress());
}

// -----------------------------------------------------------------------------
// Keeps Wi-Fi up without blocking loop(). Returns true while connected.
// A lost connection is retried every 5 s; after 2 minutes the board restarts.
// -----------------------------------------------------------------------------
bool maintainWifi(unsigned long now) {
  static bool wasConnected = true;
  static unsigned long lostSince = 0;
  static unsigned long lastAttempt = 0;

  if (WiFi.status() == WL_CONNECTED) {
    if (!wasConnected) {
      Serial.printf("[OK] Wi-Fi back after %lu s. IP %s\n", (now - lostSince) / 1000, WiFi.localIP().toString().c_str());
      wasConnected = true;
    }
    return true;
  }

  if (wasConnected) {
    Serial.println("[WARN] Wi-Fi lost. Reconnecting in the background; BLE scanning continues.");
    wasConnected = false;
    lostSince = now;
    lastAttempt = now;
  }
  if (now - lostSince > WIFI_LOST_RESTART_MS) {
    Serial.printf("[FAILED] Wi-Fi lost for %lu s. Restarting...\n", WIFI_LOST_RESTART_MS / 1000);
    delay(500);
    ESP.restart();
  }
  if (now - lastAttempt >= WIFI_RETRY_INTERVAL_MS) {
    lastAttempt = now;
    WiFi.reconnect();
  }
  return false;
}

// -----------------------------------------------------------------------------
// MQTT Reconnection Helper: one attempt at most every 2 s, never a loop, so
// commands, scanning and the Wi-Fi check keep running between attempts.
// -----------------------------------------------------------------------------
void reconnectMQTT(unsigned long now) {
  static unsigned long lastAttempt = 0;
  static bool firstAttempt = true;
  if (!firstAttempt && now - lastAttempt < MQTT_RETRY_INTERVAL_MS) return;
  firstAttempt = false;
  lastAttempt = now;

  Serial.printf("[ANCHOR %s] Connecting to MQTT Broker on %s... ", anchorMac, mqtt_server);
  String macClean = WiFi.macAddress();
  macClean.replace(":", "");
  char clientId[50];
  snprintf(clientId, sizeof(clientId), "SHIRO_Anchor_%s", macClean.c_str());

  if (mqttClient.connect(clientId, mqtt_user, mqtt_pass)) {
    Serial.println("[OK] Connected to MQTT Broker!");
    if (!mqttClient.subscribe("shiro/control/mode")) {
      Serial.println("[WARN] Could not subscribe to shiro/control/mode: 1 Hz commands will not arrive.");
    }
  } else {
    const int rc = mqttClient.state();
    if (rc == MQTT_CONNECT_BAD_CREDENTIALS || rc == MQTT_CONNECT_UNAUTHORIZED) {
      Serial.printf("[FAILED] rc=%d: login refused. Check SHIRO_MQTT_USER / SHIRO_MQTT_PASSWORD in secrets.h against edge_server/.env. Retrying in 2 seconds...\n", rc);
    } else {
      Serial.printf("[FAILED] rc=%d. Retrying in 2 seconds...\n", rc);
    }
  }
}

// -----------------------------------------------------------------------------
// Builds the JSON message for one wristband. Fields are specified in docs/protocol.md.
// Returns the length, or 0 when the message does not fit the buffer.
// -----------------------------------------------------------------------------
size_t buildTelemetryJson(const HeardTag& tag, unsigned long now, char* out, size_t outSize) {
  int n = snprintf(out, outSize,
                   "{\"anchor_mac\":\"%s\",\"tag_mac\":\"%s\",\"rssi\":%d",
                   anchorMac, tag.mac, tag.rssi);
  if (n < 0 || (size_t)n >= outSize) return 0;

  // "v": 2 = telemetry follows; 0 = the wristband sends a packet version this
  // anchor cannot read. No "v" at all = heard, but no telemetry packet this time.
  if (tag.telemetryFresh || tag.unsupportedPacket) {
    int v = snprintf(out + n, outSize - n, ",\"v\":%u",
                     (unsigned)(tag.telemetryFresh ? shiro::PACKET_VERSION : 0));
    if (v < 0 || (size_t)(n + v) >= outSize) return 0;
    n += v;
  }

  // Telemetry is included only when a packet was decoded since the last publish:
  // an old or unreadable packet is never replaced by default values.
  if (tag.telemetryFresh) {
    const shiro::Telemetry& t = tag.telemetry;
    int m = snprintf(out + n, outSize - n,
                     ",\"bpm\":%u,\"spo2\":%u,\"battery\":%u,\"charging\":%s,\"motion\":\"%s\",\"g\":%.2f,"
                     "\"touch\":%d,\"active\":%s,\"fall\":%s,\"fall_seq\":%u,"
                     "\"impact_g\":%.2f,\"freefall_g\":%.2f,\"still_g\":%.2f,"
                     "\"imu_fault\":%s,\"ppg_fault\":%s",
                     (unsigned)t.bpm, (unsigned)t.spo2, (unsigned)t.battery,
                     t.charging ? "true" : "false",
                     shiro::motionName(t.motion), t.g,
                     t.contact ? 1 : 0,
                     t.active ? "true" : "false",
                     t.fall ? "true" : "false", (unsigned)t.fallSeq,
                     t.impactG, t.freefallG, t.stillG,
                     t.imuFault ? "true" : "false",
                     t.ppgFault ? "true" : "false");
    if (m < 0 || (size_t)(n + m) >= outSize) return 0;
    n += m;
  }

  int k = snprintf(out + n, outSize - n, ",\"ts\":%lu}", now);
  if (k < 0 || (size_t)(n + k) >= outSize) return 0;
  return (size_t)(n + k);
}

// -----------------------------------------------------------------------------
// Arduino Setup
// -----------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(1500);

  Serial.println("\n==========================================================");
  Serial.println("  SHIRO Wall Anchor - Dual RSSI & Telemetry Gateway (V4.1)");
  Serial.println("  Universal Firmware - Identity Managed by Edge Server");
  Serial.printf("  Telemetry packet version %u\n", (unsigned)shiro::PACKET_VERSION);
  Serial.println("==========================================================");

  tagTableMutex = xSemaphoreCreateMutex();
  if (tagTableMutex == nullptr) {
    Serial.println("[FATAL] Could not create the tag table lock. Restarting...");
    delay(2000);
    ESP.restart();
  }

  // 1. Connect to Wi-Fi
  setupWifi();
  strncpy(anchorMac, WiFi.macAddress().c_str(), sizeof(anchorMac) - 1);

  // 2. Configure MQTT Client
  mqttClient.setServer(mqtt_server, mqtt_port);
  // Wait at most 4 s for the broker's answer (default 15 s), so a server that
  // is down does not hold up loop() for long
  mqttClient.setSocketTimeout(4);
  if (!mqttClient.setBufferSize(MQTT_BUFFER_SIZE)) {
    Serial.println("[WARN] Could not allocate the MQTT buffer: large messages will be dropped.");
  }
  mqttClient.setCallback(mqttCallback);

  // 3. Initialize BLE Radio Scanner
  Serial.println("Initializing BLE Radio Scanner...");
  BLEDevice::init("SHIRO-ANCHOR");
  pBLEScan = BLEDevice::getScan();
  pBLEScan->setAdvertisedDeviceCallbacks(new MyAdvertisedDeviceCallbacks(), true);
#if defined(CONFIG_NIMBLE_ENABLED)
  // Passive: NimBLE reports a device that accepts scan requests only once its scan
  // response has arrived as well, and with Wi-Fi sharing the radio many are missed
  // (a C3 passed on about half as many readings as a WROOM-32E). The wristband's
  // telemetry is in the advertisement itself; only its name is in the scan response.
  pBLEScan->setActiveScan(false);
  Serial.println("Bluetooth: NimBLE, passive scan.");
#else
  pBLEScan->setActiveScan(true);  // Bluedroid: request the scan response (the wristband's name)
  Serial.println("Bluetooth: Bluedroid, active scan.");
#endif
  pBLEScan->setInterval(100);     // Scan interval: 100ms
  pBLEScan->setWindow(99);        // Scan window: 99ms

  Serial.println("[OK] Anchor Node ready! Scanning for 'SHIRO-WRISTBAND'...\n");

  // 4. Start Continuous Background BLE Scanner (0 = scan continuously)
  pBLEScan->start(0, nullptr, false);
}

// -----------------------------------------------------------------------------
// Arduino Main Loop
// -----------------------------------------------------------------------------
void loop() {
  unsigned long now = millis();

  // 1. Maintain Wi-Fi and MQTT without blocking: while either is down, the
  //    table of heard wristbands keeps being cleaned and nothing is published
  if (maintainWifi(now)) {
    if (!mqttClient.connected()) {
      reconnectMQTT(now);
    }
    mqttClient.loop();
  }

  // 2. Execute pending BLE write command outside of MQTT callback
  if (pendingCmd) {
    pendingCmd = false;
    executeActiveModeCommand(pendingTargetMac);
  }

  // 3. Publish Combined Telemetry updates to Edge Server at ~6.7 Hz
  now = millis();
  if (now - lastPublishTime >= PUBLISH_INTERVAL) {
    lastPublishTime = now;

    // Copy what needs publishing while holding the lock, publish after releasing it:
    // the network must never block the Bluetooth task.
    static HeardTag toPublish[MAX_TRACKED_TAGS];
    int publishCount = 0;
    const bool linkUp = mqttClient.connected();

    if (xSemaphoreTake(tagTableMutex, pdMS_TO_TICKS(50)) == pdTRUE) {
      evictSilentTags(now);
      if (linkUp) {
        for (int i = 0; i < trackedTagCount; i++) {
          if (trackedTags[i].pending) {
            toPublish[publishCount++] = trackedTags[i];
            trackedTags[i].pending = false;
            trackedTags[i].telemetryFresh = false;
            trackedTags[i].unsupportedPacket = false;
          }
        }
      }
      xSemaphoreGive(tagTableMutex);
    }

    if (linkUp) {
      static char payload[PAYLOAD_BUFFER_SIZE];

      for (int i = 0; i < publishCount; i++) {
        lastPacketHeard = now;
        size_t length = buildTelemetryJson(toPublish[i], now, payload, sizeof(payload));
        if (length == 0) {
          Serial.printf("[ANCHOR %s] Message for %s does not fit the buffer: not sent.\n", anchorMac, toPublish[i].mac);
          continue;
        }
        if (!mqttClient.publish(mqtt_topic, payload)) {
          Serial.printf("[ANCHOR %s] MQTT publish failed (%u bytes).\n", anchorMac, (unsigned)length);
          continue;
        }
        Serial.printf("[ANCHOR %s STREAM] -> %s\n", anchorMac, payload);
      }

      // Standby Heartbeat when no wristbands are heard
      if (publishCount == 0 && (now - lastPacketHeard >= 2000)) {
        lastPacketHeard = now;

        snprintf(payload, sizeof(payload),
                 "{\"anchor_mac\":\"%s\",\"status\":\"STANDBY\",\"rssi\":0,\"ts\":%lu}",
                 anchorMac, now);

        mqttClient.publish(mqtt_topic, payload);
        Serial.printf("[ANCHOR %s STANDBY] -> %s\n", anchorMac, payload);
      }
    }
  }

  // 4. Health line every 30 s: how many wristband readings arrive, and whether the
  //    free memory stays level (it must not fall run after run)
  static unsigned long lastHealthReport = 0;
  static uint32_t lastBluetoothReports = 0;
  static uint32_t lastWristbandReports = 0;
  if (now - lastHealthReport >= 30000) {
    const uint32_t bt = bluetoothReports;
    const uint32_t wb = wristbandReports;
    const float seconds = lastHealthReport == 0 ? now / 1000.0f : (now - lastHealthReport) / 1000.0f;
    Serial.printf("[ANCHOR %s HEALTH] %.0f s: %lu wristband advertisements (%.1f/s), %lu Bluetooth reports in all. "
                  "Free memory %lu bytes (lowest %lu). Wi-Fi %d dBm, MQTT %s.\n",
                  anchorMac, seconds, (unsigned long)(wb - lastWristbandReports), seconds > 0 ? (wb - lastWristbandReports) / seconds : 0.0f,
                  (unsigned long)(bt - lastBluetoothReports), (unsigned long)ESP.getFreeHeap(), (unsigned long)ESP.getMinFreeHeap(),
                  (int)WiFi.RSSI(), mqttClient.connected() ? "connected" : "NOT connected");
    lastHealthReport = now;
    lastBluetoothReports = bt;
    lastWristbandReports = wb;
  }

  // 5. Report dropped Bluetooth packets, at most every 10 seconds
  static unsigned long lastDropReport = 0;
  static uint32_t reportedDrops = 0;
  if (droppedPackets != reportedDrops && (now - lastDropReport >= 10000)) {
    lastDropReport = now;
    Serial.printf("[ANCHOR %s] %lu wristband packets dropped so far (table full or busy).\n",
                  anchorMac, (unsigned long)droppedPackets);
    reportedDrops = droppedPackets;
  }

  delay(10); // Yield for background Wi-Fi and FreeRTOS tasks
}
