/*
 * =========================================================================================
 *   SHIRO Edge Node - BLE-to-MQTT Bridge Gateway
 *   Hardware: ESP32-S3 (ESP32-S3-N16R8 Dev Module)
 *   Function: Connects to 'SHIRO-WRISTBAND' over BLE 5.0, subscribes to notifications,
 *             and forwards physiological/motion packets immediately to MQTT over Wi-Fi.
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
// 1. Wi-Fi & MQTT Configuration
// =============================================================================
const char* ssid        = "REDACTED_SSID";  // 2.4GHz Wi-Fi SSID
const char* password    = "REDACTED";          // Wi-Fi Password
const char* mqtt_server = "192.168.1.229";      // Asus TUF Laptop IP
const int   mqtt_port   = 1883;
const char* mqtt_topic  = "shiro/ward-A1/wristband/telemetry";
const char* gateway_status_topic = "shiro/ward-A1/gateway/status";
unsigned long lastGatewayHeartbeat = 0;

// =============================================================================
// 2. BLE Configuration (Matching Wristband)
// =============================================================================
static BLEUUID serviceUUID("4fafc201-1fb5-459e-8fcc-c5c9c331914b");
static BLEUUID charUUID("beb5483e-36e1-4688-b7f5-ea07361b26a8");

static boolean doConnect = false;
static boolean connected = false;
static boolean isScanning = false;
static BLERemoteCharacteristic* pRemoteCharacteristic = nullptr;
static BLEAdvertisedDevice* myDevice = nullptr;

WiFiClient espClient;
PubSubClient mqttClient(espClient);

unsigned long lastMqttRetry = 0;

// -----------------------------------------------------------------------------
// BLE Notification Buffer & Thread-Safe Cross-Core Handoff
// (Eliminates synchronous TCP/MQTT publish locks inside BLE task that caused 2000ms latency)
// -----------------------------------------------------------------------------
static char blePayloadBuffer[256];
static volatile bool newBlePacketAvailable = false;

static void notifyCallback(
  BLERemoteCharacteristic* pBLERemoteCharacteristic,
  uint8_t* pData,
  size_t length,
  bool isNotify) {

  if (length > 0 && length < sizeof(blePayloadBuffer)) {
    memcpy(blePayloadBuffer, pData, length);
    blePayloadBuffer[length] = '\0';
    newBlePacketAvailable = true; // Hand off to loopTask for thread-safe MQTT publish
  }
}

// -----------------------------------------------------------------------------
// BLE Client Callbacks
// -----------------------------------------------------------------------------
class MyClientCallback : public BLEClientCallbacks {
  void onConnect(BLEClient* pclient) {
    connected = true;
    Serial.println("\n>>> [GATEWAY] Connected to Wristband via BLE! <<<");

    // CRITICAL: Force ultra-fast connection interval (12-24 * 1.25ms = 15ms - 30ms)
    // Prevents ESP32 BLE stack from negotiating to 1000ms - 2000ms battery-saver intervals!
    pclient->updateConnParams(12, 24, 0, 400);
  }

  void onDisconnect(BLEClient* pclient) {
    connected = false;
    isScanning = false;
    Serial.println("\n>>> [GATEWAY] Disconnected from Wristband! <<<");
  }
};

// -----------------------------------------------------------------------------
// BLE Scan Ended Callback
// -----------------------------------------------------------------------------
void scanEndedCB(BLEScanResults results) {
  isScanning = false;
  BLEDevice::getScan()->clearResults();
}

// -----------------------------------------------------------------------------
// Connect to the Wristband's BLE GATT Server
// -----------------------------------------------------------------------------
bool connectToServer() {
  Serial.print("Connecting to: ");
  Serial.println(myDevice->getAddress().toString().c_str());

  BLEClient* pClient = BLEDevice::createClient();
  pClient->setClientCallbacks(new MyClientCallback());

  // Connect to the remote BLE Server
  if (!pClient->connect(myDevice)) {
    Serial.println("Failed to connect to Wristband.");
    return false;
  }

  // Force connection interval (min 15ms, max 30ms, 0 latency, 4s supervision timeout)
  pClient->updateConnParams(12, 24, 0, 400);

  // Obtain reference to the service
  BLERemoteService* pRemoteService = pClient->getService(serviceUUID);
  if (pRemoteService == nullptr) {
    Serial.println("Failed to find SHIRO service UUID.");
    pClient->disconnect();
    return false;
  }

  // Obtain reference to the characteristic
  pRemoteCharacteristic = pRemoteService->getCharacteristic(charUUID);
  if (pRemoteCharacteristic == nullptr) {
    Serial.println("Failed to find SHIRO characteristic UUID.");
    pClient->disconnect();
    return false;
  }

  // Register for Notifications
  if (pRemoteCharacteristic->canNotify()) {
    pRemoteCharacteristic->registerForNotify(notifyCallback);
    Serial.println("[OK] Subscribed to Wristband notifications!");
  }

  connected = true;

  // CRITICAL: Stop BLE scanning when connected so 2.4GHz radio can dedicate
  // 100% bandwidth to BLE GATT connection and Wi-Fi MQTT transmission!
  BLEDevice::getScan()->stop();
  BLEDevice::getScan()->clearResults();
  isScanning = false;

  return true;
}

// -----------------------------------------------------------------------------
// BLE Advertised Device Callbacks (Search for SHIRO-WRISTBAND)
// -----------------------------------------------------------------------------
class MyAdvertisedDeviceCallbacks: public BLEAdvertisedDeviceCallbacks {
  void onResult(BLEAdvertisedDevice advertisedDevice) {
    Serial.print(".");
    if (advertisedDevice.haveServiceUUID() && advertisedDevice.isAdvertisingService(serviceUUID)) {
      Serial.println("\n[FOUND] SHIRO-WRISTBAND detected!");
      BLEDevice::getScan()->stop();
      isScanning = false;
      if (myDevice != nullptr) {
        delete myDevice;
      }
      myDevice = new BLEAdvertisedDevice(advertisedDevice);
      doConnect = true;
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
  WiFi.setSleep(false);        // CRITICAL: Disable modem sleep to prevent Wi-Fi jitter & dropped MQTT packets!
  espClient.setNoDelay(true);  // CRITICAL: Disable TCP Nagle algorithm for real-time packet dispatch!
  Serial.println("\n[OK] Wi-Fi Connected!");
  Serial.print("Gateway IP Address: ");
  Serial.println(WiFi.localIP());
}

// -----------------------------------------------------------------------------
// Non-Blocking MQTT Reconnect Helper
// -----------------------------------------------------------------------------
void handleMQTT() {
  if (mqttClient.connected()) {
    mqttClient.loop();
    return;
  }

  unsigned long now = millis();
  if (now - lastMqttRetry > 3000) {
    lastMqttRetry = now;
    Serial.print("Connecting to MQTT Broker on Laptop... ");
    String macClean = WiFi.macAddress();
    macClean.replace(":", "");
    char clientId[50];
    snprintf(clientId, sizeof(clientId), "SHIRO_Gateway_%s", macClean.c_str());
    if (mqttClient.connect(clientId)) {
      Serial.println("[OK] Connected to MQTT Broker!");
    } else {
      Serial.printf("[FAILED] rc=%d. Retrying in 3s...\n", mqttClient.state());
    }
  }
}

// -----------------------------------------------------------------------------
// Arduino Setup
// -----------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(1500);

  Serial.println("\n=============================================");
  Serial.println("  SHIRO Edge Node (ESP32-S3 Gateway V2)");
  Serial.println("=============================================");

  setupWifi();
  mqttClient.setServer(mqtt_server, mqtt_port);
  mqttClient.setBufferSize(512);
  mqttClient.setKeepAlive(15);

  // Initialize BLE Stack as Scanner
  Serial.println("Starting BLE Scanner for 'SHIRO-WRISTBAND'...");
  BLEDevice::init("SHIRO-GATEWAY");
  BLEScan* pBLEScan = BLEDevice::getScan();
  pBLEScan->setAdvertisedDeviceCallbacks(new MyAdvertisedDeviceCallbacks());
  pBLEScan->setInterval(160); // 100ms interval for rapid discovery
  pBLEScan->setWindow(120);   // 75ms window
  pBLEScan->setActiveScan(true);
  pBLEScan->start(5, scanEndedCB, false);
  isScanning = true;
}

// -----------------------------------------------------------------------------
// Arduino Main Loop
// -----------------------------------------------------------------------------
void loop() {
  // 1. Maintain Non-blocking MQTT Connection
  handleMQTT();

  // 2. Immediately forward any incoming BLE telemetry packet from Wristband
  // (Executed on Core 1 thread for 100% thread safety and zero BLE radio stalls)
  if (newBlePacketAvailable && mqttClient.connected()) {
    newBlePacketAvailable = false;
    mqttClient.publish(mqtt_topic, blePayloadBuffer);
    Serial.printf("[BLE -> MQTT] %s\n", blePayloadBuffer);
  }

  unsigned long now = millis();

  // 3. Transmit Standalone Gateway Heartbeat every 1.5s
  // Keeps Gateway visibly ONLINE on Edge Server even when wristband is turned off
  if (now - lastGatewayHeartbeat >= 1500) {
    lastGatewayHeartbeat = now;
    if (mqttClient.connected()) {
      char hbPayload[130];
      snprintf(hbPayload, sizeof(hbPayload),
               "{\"mac\":\"%s\",\"status\":\"ONLINE\",\"tag_connected\":%s}",
               WiFi.macAddress().c_str(), connected ? "true" : "false");
      mqttClient.publish(gateway_status_topic, hbPayload);
    }
  }

  // 4. Handle BLE Connection logic
  if (doConnect == true) {
    if (connectToServer()) {
      Serial.println("[GATEWAY] Ready! Streaming data to MQTT in real-time...");
    } else {
      Serial.println("[GATEWAY] Failed to connect. Will retry scan.");
      isScanning = false;
    }
    doConnect = false;
  }

  // 5. Continuously Re-scan if disconnected and not already scanning
  if (!connected && !isScanning) {
    Serial.println("\n[GATEWAY] Scanning for Wristband beacon...");
    BLEDevice::getScan()->start(5, scanEndedCB, false);
    isScanning = true;
  }

  delay(5); // 5ms loop yield
}
