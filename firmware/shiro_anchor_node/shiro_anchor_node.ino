/*
 * =========================================================================================
 *   SHIRO Anchor Node - Combined RSSI Localization & Vitals Gateway (V4 - Protocol 2)
 *   Hardware: ESP32-WROOM-32E (or generic ESP32)
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

const char* ssid        = SHIRO_WIFI_SSID;
const char* password    = SHIRO_WIFI_PASSWORD;
const char* mqtt_server = SHIRO_MQTT_SERVER;
const int   mqtt_port   = SHIRO_MQTT_PORT;

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
void mqttCallback(char* topic, byte* payload, unsigned int length) {
  char msg[256];
  if (length >= sizeof(msg)) length = sizeof(msg) - 1;
  memcpy(msg, payload, length);
  msg[length] = '\0';

  if (strstr(msg, "SET_ACTIVE") != nullptr) {
    char targetMac[24] = {0};
    char* macPtr = strstr(msg, "target_mac\":\"");
    if (macPtr) {
      macPtr += strlen("target_mac\":\"");
      int i = 0;
      while (*macPtr && *macPtr != '\"' && i < 20) {
        targetMac[i++] = *macPtr++;
      }
      targetMac[i] = '\0';
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
        Serial.printf("\n[ANCHOR] Nearest to tag %s (RSSI: %d). Queued 1 Hz Active Mode Escalation!\n", targetMac, heardRssi);
      }
    }
  }
}

// -----------------------------------------------------------------------------
// BLE GATT Client Command Dispatcher (Relays Edge Server Commands to Tags)
// -----------------------------------------------------------------------------
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
void setupWifi() {
  delay(10);
  Serial.printf("\nConnecting to Wi-Fi: %s ", ssid);
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);

  while (WiFi.status() != WL_CONNECTED) {
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
// MQTT Reconnection Helper
// -----------------------------------------------------------------------------
void reconnectMQTT() {
  while (!mqttClient.connected()) {
    Serial.printf("[ANCHOR %s] Connecting to MQTT Broker on %s... ", anchorMac, mqtt_server);
    String macClean = WiFi.macAddress();
    macClean.replace(":", "");
    char clientId[50];
    snprintf(clientId, sizeof(clientId), "SHIRO_Anchor_%s", macClean.c_str());

    if (mqttClient.connect(clientId)) {
      Serial.println("[OK] Connected to MQTT Broker!");
      mqttClient.subscribe("shiro/control/mode");
    } else {
      Serial.printf("[FAILED] rc=%d. Retrying in 2 seconds...\n", mqttClient.state());
      delay(2000);
      break;
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
  Serial.println("  SHIRO Wall Anchor - Dual RSSI & Telemetry Gateway (V4)");
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
  if (!mqttClient.setBufferSize(MQTT_BUFFER_SIZE)) {
    Serial.println("[WARN] Could not allocate the MQTT buffer: large messages will be dropped.");
  }
  mqttClient.setCallback(mqttCallback);

  // 3. Initialize BLE Radio Scanner
  Serial.println("Initializing BLE Radio Scanner...");
  BLEDevice::init("SHIRO-ANCHOR");
  pBLEScan = BLEDevice::getScan();
  pBLEScan->setAdvertisedDeviceCallbacks(new MyAdvertisedDeviceCallbacks(), true);
  pBLEScan->setActiveScan(true);  // Request scan response
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
  // 1. Maintain MQTT connection
  if (!mqttClient.connected()) {
    reconnectMQTT();
  }
  mqttClient.loop();

  // 2. Execute pending BLE write command outside of MQTT callback
  if (pendingCmd) {
    pendingCmd = false;
    executeActiveModeCommand(pendingTargetMac);
  }

  // 3. Publish Combined Telemetry updates to Edge Server at ~6.7 Hz
  unsigned long now = millis();
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

  // 4. Report dropped Bluetooth packets, at most every 10 seconds
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
