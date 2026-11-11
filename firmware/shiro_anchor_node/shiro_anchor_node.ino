/*
 * =========================================================================================
 *   SHIRO Anchor Node - Combined RSSI Localization & Vitals Gateway (V3 - Path 2)
 *   Hardware: ESP32-WROOM-32E (or generic ESP32)
 *   Function: Continuously scans for SHIRO-WRISTBAND BLE broadcasts, records raw RSSI
 *             for IPS multilateration, unpacks physiological/kinematic telemetry,
 *             and streams unified telemetry packets to the Edge Server over Wi-Fi/MQTT.
 *   Note:     UNIVERSAL FIRMWARE - Flash the EXACT same code to all anchor boards!
 *             Device Identifiers are auto-assigned by the Central Edge Server.
 *   Project:  MR-Patient Connect (SHIRO) - Final Year Project (RSWG7)
 * =========================================================================================
 */

#include <WiFi.h>
#include <PubSubClient.h>
#include <BLEDevice.h>
#include <BLEUtils.h>
#include <BLEScan.h>
#include <BLEAdvertisedDevice.h>

// =============================================================================
// 1. Wi-Fi & MQTT Server Configuration
// =============================================================================
const char* ssid        = "REDACTED_SSID";  // Your 2.4GHz Wi-Fi SSID
const char* password    = "REDACTED";          // Your Wi-Fi Password
const char* mqtt_server = "192.168.100.21";      // Your Asus TUF Laptop IP
const int   mqtt_port   = 1883;

// Shared MQTT Topic for all anchors
const char* mqtt_topic  = "shiro/ward-A1/anchor/telemetry";

// Target Wristband BLE Service UUID
static BLEUUID serviceUUID("4fafc201-1fb5-459e-8fcc-c5c9c331914b");
static BLEUUID controlCharUUID("beb5483e-36e1-4688-b7f5-ea07361b26a8");

// Network & BLE Objects
WiFiClient espClient;
PubSubClient mqttClient(espClient);
BLEScan* pBLEScan = nullptr;

// Real-time tracking table for multiple concurrent wristband tags
struct HeardTag {
  String mac;
  int rssi;
  unsigned long timestamp;
  bool pending;
  // Embedded Physiological & Kinematic Vitals
  int bpm;
  int spo2;
  int battery;
  bool isCharging;
  int touch;
  bool active;
  float g;
  String motion;
};

const int MAX_TRACKED_TAGS = 8;
HeardTag trackedTags[MAX_TRACKED_TAGS];
int trackedTagCount = 0;

volatile bool pendingCmd = false;
char pendingTargetMac[24] = {0};

unsigned long lastPublishTime = 0;
unsigned long lastPacketHeard = 0;
const unsigned long PUBLISH_INTERVAL = 150; // Publish ~6-7 times per second (every 150 ms)

// -----------------------------------------------------------------------------
// BLE Advertised Device Callback (Triggers whenever an RF packet is heard)
// -----------------------------------------------------------------------------
class MyAdvertisedDeviceCallbacks : public BLEAdvertisedDeviceCallbacks {
  void onResult(BLEAdvertisedDevice advertisedDevice) {
    bool isWristband = false;

    // Match by Device Name, Service UUID, or Manufacturer Header
    if (advertisedDevice.haveName() && advertisedDevice.getName() == "SHIRO-WRISTBAND") {
      isWristband = true;
    } else if (advertisedDevice.haveServiceUUID() && advertisedDevice.isAdvertisingService(serviceUUID)) {
      isWristband = true;
    } else if (advertisedDevice.haveManufacturerData()) {
      String mfg = advertisedDevice.getManufacturerData();
      if (mfg.length() >= 9 && (uint8_t)mfg[0] == 0x53 && (uint8_t)mfg[1] == 0x48) {
        isWristband = true;
      }
    }

    if (isWristband) {
      String tagMac = advertisedDevice.getAddress().toString();
      int rssi = advertisedDevice.getRSSI();
      unsigned long now = millis();

      int bpm = 0;
      int spo2 = 0;
      int battery = 100;
      bool isCharging = false;
      int touch = 0;
      bool isActiveStreaming = false;
      float g = 1.0f;
      String motion = "STATIONARY";

      // Unpack 9-byte binary telemetry from Manufacturer Data
      if (advertisedDevice.haveManufacturerData()) {
        String mfg = advertisedDevice.getManufacturerData();
        if (mfg.length() >= 9 && (uint8_t)mfg[0] == 0x53 && (uint8_t)mfg[1] == 0x48) {
          bpm = (uint8_t)mfg[2];
          spo2 = (uint8_t)mfg[3];

          uint8_t mCode = (uint8_t)mfg[4];
          if (mCode == 1) motion = "HAND_MOVEMENT";
          else if (mCode == 2) motion = "WALKING";
          else if (mCode == 3) motion = "FALL_EMERGENCY";
          else motion = "STATIONARY";

          battery = (uint8_t)mfg[5];
          uint8_t flags = (uint8_t)mfg[6];
          isCharging = (flags & 0x01) != 0;
          touch = (flags & 0x02) != 0 ? 1 : 0;
          bool isEmergencyFall = (flags & 0x04) != 0;
          isActiveStreaming = (flags & 0x08) != 0;
          if (isEmergencyFall) motion = "FALL_EMERGENCY";

          int16_t gScaled = ((int16_t)(int8_t)mfg[7] << 8) | (uint8_t)mfg[8];
          g = gScaled / 100.0f;
        }
      }

      // Find or allocate tag entry in tracking table
      int foundIdx = -1;
      for (int i = 0; i < trackedTagCount; i++) {
        if (trackedTags[i].mac.equalsIgnoreCase(tagMac)) {
          foundIdx = i;
          break;
        }
      }

      int targetIdx = foundIdx >= 0 ? foundIdx : (trackedTagCount < MAX_TRACKED_TAGS ? trackedTagCount++ : -1);
      if (targetIdx >= 0) {
        trackedTags[targetIdx].mac = tagMac;
        trackedTags[targetIdx].rssi = rssi;
        trackedTags[targetIdx].timestamp = now;
        trackedTags[targetIdx].pending = true;
        trackedTags[targetIdx].bpm = bpm;
        trackedTags[targetIdx].spo2 = spo2;
        trackedTags[targetIdx].battery = battery;
        trackedTags[targetIdx].isCharging = isCharging;
        trackedTags[targetIdx].touch = touch;
        trackedTags[targetIdx].active = isActiveStreaming;
        trackedTags[targetIdx].g = g;
        trackedTags[targetIdx].motion = motion;
      }
    }
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
      for (int i = 0; i < trackedTagCount; i++) {
        if (trackedTags[i].mac.equalsIgnoreCase(targetMac) && (millis() - trackedTags[i].timestamp < 3500) && trackedTags[i].rssi >= -82) {
          strncpy(pendingTargetMac, targetMac, sizeof(pendingTargetMac) - 1);
          pendingCmd = true;
          Serial.printf("\n[ANCHOR] Nearest to tag %s (RSSI: %d). Queued 1 Hz Active Mode Escalation!\n", targetMac, trackedTags[i].rssi);
          break;
        }
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
    Serial.printf("[ANCHOR %s] Connecting to MQTT Broker on %s... ", WiFi.macAddress().c_str(), mqtt_server);
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
// Arduino Setup
// -----------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(1500);

  Serial.println("\n==========================================================");
  Serial.println("  SHIRO Wall Anchor - Dual RSSI & Telemetry Gateway (V3)");
  Serial.println("  Universal Firmware - Identity Managed by Edge Server");
  Serial.println("==========================================================");

  // 1. Connect to Wi-Fi
  setupWifi();

  // 2. Configure MQTT Client
  mqttClient.setServer(mqtt_server, mqtt_port);
  mqttClient.setBufferSize(384);
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

    bool anyPublished = false;
    if (mqttClient.connected()) {
      for (int i = 0; i < trackedTagCount; i++) {
        if (trackedTags[i].pending) {
          trackedTags[i].pending = false;
          anyPublished = true;
          lastPacketHeard = now;

          char payload[280];
          snprintf(payload, sizeof(payload),
                   "{\"anchor_mac\":\"%s\",\"tag_mac\":\"%s\",\"rssi\":%d,\"bpm\":%d,\"spo2\":%d,\"battery\":%d,\"charging\":%s,\"motion\":\"%s\",\"g\":%.2f,\"touch\":%d,\"active\":%s,\"ts\":%lu}",
                   WiFi.macAddress().c_str(), trackedTags[i].mac.c_str(), trackedTags[i].rssi,
                   trackedTags[i].bpm, trackedTags[i].spo2, trackedTags[i].battery,
                   trackedTags[i].isCharging ? "true" : "false",
                   trackedTags[i].motion.c_str(), trackedTags[i].g, trackedTags[i].touch,
                   trackedTags[i].active ? "true" : "false", now);

          mqttClient.publish(mqtt_topic, payload);
          Serial.printf("[ANCHOR %s STREAM] -> %s\n", WiFi.macAddress().c_str(), payload);
        }
      }

      // Standby Heartbeat when no wristbands are heard
      if (!anyPublished && (now - lastPacketHeard >= 2000)) {
        lastPacketHeard = now;

        char payload[130];
        snprintf(payload, sizeof(payload),
                 "{\"anchor_mac\":\"%s\",\"status\":\"STANDBY\",\"rssi\":0,\"ts\":%lu}",
                 WiFi.macAddress().c_str(), now);

        mqttClient.publish(mqtt_topic, payload);
        Serial.printf("[ANCHOR %s STANDBY] -> %s\n", WiFi.macAddress().c_str(), payload);
      }
    }
  }

  delay(10); // Yield for background Wi-Fi and FreeRTOS tasks
}
