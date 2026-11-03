/*
 * =========================================================================================
 *   SHIRO Anchor Node - BLE RSSI Distance Tracking Beacon
 *   Hardware: ESP32-WROOM-32E (or generic ESP32)
 *   Function: Continuously scans for SHIRO-WRISTBAND BLE beacons, records raw RSSI,
 *             and streams real-time radio telemetry to Edge Server over Wi-Fi/MQTT.
 *   Note:     UNIVERSAL FIRMWARE - Flash the EXACT same code to all anchor boards!
 *             Each board is identified dynamically by its factory MAC address.
 *             Device Identifiers (anchor-001, anchor-002, etc.) are auto-assigned by 
 *             the Central Edge System during enrollment.
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
const char* mqtt_server = "192.168.1.229";      // Your Asus TUF Laptop IP
const int   mqtt_port   = 1883;

// Shared MQTT Topic for all anchors
const char* mqtt_topic  = "shiro/ward-A1/anchor/telemetry";

// Target Wristband BLE Service UUID
static BLEUUID serviceUUID("4fafc201-1fb5-459e-8fcc-c5c9c331914b");

// Network & BLE Objects
WiFiClient espClient;
PubSubClient mqttClient(espClient);
BLEScan* pBLEScan = nullptr;

// Real-time tracking variables
volatile int latestRSSI = 0;
volatile bool newRssiAvailable = false;
String latestTagMac = "";
unsigned long lastPublishTime = 0;
unsigned long lastPacketHeard = 0;
const unsigned long PUBLISH_INTERVAL = 150; // Publish ~6-7 times per second (every 150 ms)

// -----------------------------------------------------------------------------
// BLE Advertised Device Callback (Triggers whenever an RF packet is heard)
// -----------------------------------------------------------------------------
class MyAdvertisedDeviceCallbacks : public BLEAdvertisedDeviceCallbacks {
  void onResult(BLEAdvertisedDevice advertisedDevice) {
    bool isWristband = false;

    // Match by Device Name
    if (advertisedDevice.haveName() && advertisedDevice.getName() == "SHIRO-WRISTBAND") {
      isWristband = true;
    }
    // Match by Service UUID
    else if (advertisedDevice.haveServiceUUID() && advertisedDevice.isAdvertisingService(serviceUUID)) {
      isWristband = true;
    }

    if (isWristband) {
      latestRSSI = advertisedDevice.getRSSI();
      latestTagMac = advertisedDevice.getAddress().toString();
      newRssiAvailable = true;
    }
  }
};

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
  Serial.println("  SHIRO Stationary Wall Anchor (ESP32-WROOM-32E)");
  Serial.println("  Universal Firmware - Identity Managed by Edge Server");
  Serial.println("==========================================================");

  // 1. Connect to Wi-Fi
  setupWifi();

  // 2. Configure MQTT Client
  mqttClient.setServer(mqtt_server, mqtt_port);

  // 3. Initialize BLE Continuous Scanner
  Serial.println("Initializing High-Speed BLE Radio Scanner...");
  BLEDevice::init("SHIRO-ANCHOR");
  pBLEScan = BLEDevice::getScan();
  pBLEScan->setAdvertisedDeviceCallbacks(new MyAdvertisedDeviceCallbacks(), true); // allow duplicates for continuous tracking!
  pBLEScan->setActiveScan(true);  // Active scan requests scan response for stronger detection
  pBLEScan->setInterval(100);     // Scan interval: 100ms
  pBLEScan->setWindow(99);        // Scan window: 99ms (near 100% duty cycle)

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

  // 2. Publish RSSI updates to Edge Server at ~6.7 Hz (every 150 ms)
  unsigned long now = millis();
  if (now - lastPublishTime >= PUBLISH_INTERVAL) {
    lastPublishTime = now;

    if (newRssiAvailable && mqttClient.connected()) {
      newRssiAvailable = false;
      lastPacketHeard = now;

      char payload[180];
      snprintf(payload, sizeof(payload),
               "{\"anchor_mac\":\"%s\",\"tag_mac\":\"%s\",\"rssi\":%d,\"ts\":%lu}",
               WiFi.macAddress().c_str(), latestTagMac.c_str(), latestRSSI, now);

      mqttClient.publish(mqtt_topic, payload);
      Serial.printf("[ANCHOR %s STREAM] -> %s\n", WiFi.macAddress().c_str(), payload);
    } 
    // If no wristband heard in the last 2 seconds, send a Standby Heartbeat
    // Keeps Anchor node visible on Edge Server Radar even when wristband is turned off
    else if (now - lastPacketHeard >= 2000 && mqttClient.connected()) {
      lastPacketHeard = now;

      char payload[130];
      snprintf(payload, sizeof(payload),
               "{\"anchor_mac\":\"%s\",\"status\":\"STANDBY\",\"rssi\":0,\"ts\":%lu}",
               WiFi.macAddress().c_str(), now);

      mqttClient.publish(mqtt_topic, payload);
      Serial.printf("[ANCHOR %s STANDBY] -> %s\n", WiFi.macAddress().c_str(), payload);
    }
  }

  delay(10); // Yield for background Wi-Fi and FreeRTOS tasks
}
