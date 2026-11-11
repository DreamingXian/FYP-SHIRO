/*
 * =========================================================================================
 *   [DEPRECATED / ARCHIVED] SHIRO Standalone Gateway Node
 *   Note: In Path 2 (Unified Architecture), standalone Gateway hardware is no longer needed!
 *         All Wall Anchors ('shiro_anchor_node.ino') now directly receive both RSSI location
 *         data and physiological vitals (BPM, SpO2, Battery, Motion) via BLE Broadcast.
 *   Keep this file only for historical reference / standalone testing.
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
// 2. Multi-Wristband BLE Configuration
// =============================================================================
static BLEUUID serviceUUID("4fafc201-1fb5-459e-8fcc-c5c9c331914b");
static BLEUUID charUUID("beb5483e-36e1-4688-b7f5-ea07361b26a8");

const int MAX_WRISTBANDS = 4;

struct WristbandConnection {
  BLEClient* client = nullptr;
  BLERemoteCharacteristic* remoteChar = nullptr;
  String mac = "";
  bool connected = false;
};

WristbandConnection wristbands[MAX_WRISTBANDS];

static boolean isScanning = false;
static boolean doConnect = false;
static int pendingSlot = -1;
static BLEAdvertisedDevice* pendingDevice = nullptr;
static unsigned long lastScanAttempt = 0;

WiFiClient espClient;
PubSubClient mqttClient(espClient);
unsigned long lastMqttRetry = 0;

// -----------------------------------------------------------------------------
// Thread-Safe Multi-Packet FIFO Queue (Prevents packet collision across wristbands)
// -----------------------------------------------------------------------------
const int PAYLOAD_QUEUE_SIZE = 12;
static char payloadQueue[PAYLOAD_QUEUE_SIZE][384];
static int queueHead = 0;
static int queueTail = 0;
static portMUX_TYPE queueMux = portMUX_INITIALIZER_UNLOCKED;

void enqueuePacket(uint8_t* pData, size_t length) {
  if (length == 0 || length >= 384) return;
  portENTER_CRITICAL(&queueMux);
  int nextHead = (queueHead + 1) % PAYLOAD_QUEUE_SIZE;
  if (nextHead != queueTail) { // queue not full
    memcpy(payloadQueue[queueHead], pData, length);
    payloadQueue[queueHead][length] = '\0';
    queueHead = nextHead;
  }
  portEXIT_CRITICAL(&queueMux);
}

bool dequeuePacket(char* outBuffer, size_t maxLen) {
  portENTER_CRITICAL(&queueMux);
  if (queueHead == queueTail) {
    portEXIT_CRITICAL(&queueMux);
    return false;
  }
  strncpy(outBuffer, payloadQueue[queueTail], maxLen - 1);
  outBuffer[maxLen - 1] = '\0';
  queueTail = (queueTail + 1) % PAYLOAD_QUEUE_SIZE;
  portEXIT_CRITICAL(&queueMux);
  return true;
}

// -----------------------------------------------------------------------------
// BLE Notification Callback
// -----------------------------------------------------------------------------
static void notifyCallback(
  BLERemoteCharacteristic* pBLERemoteCharacteristic,
  uint8_t* pData,
  size_t length,
  bool isNotify) {
  enqueuePacket(pData, length);
}

// -----------------------------------------------------------------------------
// Helper: Count Active Connected Wristbands
// -----------------------------------------------------------------------------
int getConnectedCount() {
  int count = 0;
  for (int i = 0; i < MAX_WRISTBANDS; i++) {
    if (wristbands[i].connected) count++;
  }
  return count;
}

// -----------------------------------------------------------------------------
// BLE Client Callbacks for Each Slot
// -----------------------------------------------------------------------------
class WristbandClientCallbacks : public BLEClientCallbacks {
  int slotIndex;
public:
  WristbandClientCallbacks(int slot) : slotIndex(slot) {}

  void onConnect(BLEClient* pclient) {
    wristbands[slotIndex].connected = true;
    Serial.printf("\n>>> [GATEWAY] Wristband [Slot %d] Connected! Total active: %d <<<\n",
                  slotIndex, getConnectedCount());
    // Balanced connection interval (24-48 * 1.25ms = 30ms - 60ms)
    pclient->updateConnParams(24, 48, 0, 400);
  }

  void onDisconnect(BLEClient* pclient) {
    Serial.printf("\n>>> [GATEWAY] Wristband [Slot %d] (%s) Disconnected! <<<\n",
                  slotIndex, wristbands[slotIndex].mac.c_str());
    wristbands[slotIndex].connected = false;
    wristbands[slotIndex].mac = "";
    wristbands[slotIndex].remoteChar = nullptr;
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
// Connect to a Specific Wristband Slot
// -----------------------------------------------------------------------------
bool connectWristbandToSlot(int slot, BLEAdvertisedDevice* device) {
  if (slot < 0 || slot >= MAX_WRISTBANDS || device == nullptr) return false;

  String targetMac = device->getAddress().toString();
  Serial.printf("[GATEWAY] Connecting Slot %d to Wristband: %s...\n", slot, targetMac.c_str());

  if (wristbands[slot].client == nullptr) {
    wristbands[slot].client = BLEDevice::createClient();
    wristbands[slot].client->setClientCallbacks(new WristbandClientCallbacks(slot));
  }

  // Connect to the remote BLE server
  if (!wristbands[slot].client->connect(device)) {
    Serial.printf("[GATEWAY] Failed to connect to %s on Slot %d.\n", targetMac.c_str(), slot);
    return false;
  }

  // Request MTU 256 for complete JSON telemetry payloads
  wristbands[slot].client->setMTU(256);

  // Set balanced connection timing (30ms - 60ms interval)
  wristbands[slot].client->updateConnParams(24, 48, 0, 400);

  // Discover Service
  BLERemoteService* pRemoteService = wristbands[slot].client->getService(serviceUUID);
  if (pRemoteService == nullptr) {
    Serial.println("[GATEWAY] Failed to find SHIRO service UUID.");
    wristbands[slot].client->disconnect();
    return false;
  }

  // Discover Characteristic
  wristbands[slot].remoteChar = pRemoteService->getCharacteristic(charUUID);
  if (wristbands[slot].remoteChar == nullptr) {
    Serial.println("[GATEWAY] Failed to find SHIRO characteristic UUID.");
    wristbands[slot].client->disconnect();
    return false;
  }

  // Register for notifications
  if (wristbands[slot].remoteChar->canNotify()) {
    wristbands[slot].remoteChar->registerForNotify(notifyCallback);
    Serial.printf("[OK] Subscribed to Slot %d (%s) notifications!\n", slot, targetMac.c_str());
  }

  wristbands[slot].mac = targetMac;
  wristbands[slot].connected = true;
  return true;
}

// -----------------------------------------------------------------------------
// BLE Advertised Device Callbacks (Discovery)
// -----------------------------------------------------------------------------
class MyAdvertisedDeviceCallbacks: public BLEAdvertisedDeviceCallbacks {
  void onResult(BLEAdvertisedDevice advertisedDevice) {
    bool isWristband = false;

    // Match by Device Name or Service UUID
    if (advertisedDevice.haveName() && advertisedDevice.getName() == "SHIRO-WRISTBAND") {
      isWristband = true;
    } else if (advertisedDevice.haveServiceUUID() && advertisedDevice.isAdvertisingService(serviceUUID)) {
      isWristband = true;
    }

    if (isWristband && !doConnect) {
      String foundMac = advertisedDevice.getAddress().toString();

      // Check if already connected
      for (int i = 0; i < MAX_WRISTBANDS; i++) {
        if (wristbands[i].connected && wristbands[i].mac.equalsIgnoreCase(foundMac)) {
          return; // Already actively connected
        }
      }

      // Find an available slot
      for (int i = 0; i < MAX_WRISTBANDS; i++) {
        if (!wristbands[i].connected) {
          Serial.printf("\n[FOUND NEW WRISTBAND] %s -> Allocating Slot %d\n", foundMac.c_str(), i);
          if (pendingDevice != nullptr) delete pendingDevice;
          pendingDevice = new BLEAdvertisedDevice(advertisedDevice);
          pendingSlot = i;
          doConnect = true;
          BLEDevice::getScan()->stop();
          isScanning = false;
          return;
        }
      }
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

  Serial.println("\n==========================================================");
  Serial.println("  SHIRO Edge Node - Multi-Wristband BLE Gateway (V3)");
  Serial.println("  Supports up to 4 concurrent wristbands simultaneously");
  Serial.println("==========================================================");

  setupWifi();
  mqttClient.setServer(mqtt_server, mqtt_port);
  mqttClient.setBufferSize(512);
  mqttClient.setKeepAlive(15);

  // Initialize BLE Stack
  Serial.println("Starting BLE Multi-Scanner for 'SHIRO-WRISTBAND'...");
  BLEDevice::init("SHIRO-GATEWAY");
  BLEScan* pBLEScan = BLEDevice::getScan();
  pBLEScan->setAdvertisedDeviceCallbacks(new MyAdvertisedDeviceCallbacks());
  pBLEScan->setInterval(160); // 100ms interval
  pBLEScan->setWindow(100);   // ~62ms window (balanced duty cycle)
  pBLEScan->setActiveScan(true);
  pBLEScan->start(4, scanEndedCB, false);
  isScanning = true;
}

// -----------------------------------------------------------------------------
// Arduino Main Loop
// -----------------------------------------------------------------------------
void loop() {
  // 1. Maintain Non-blocking MQTT Connection
  handleMQTT();

  // 2. Dequeue and forward all buffered telemetry packets to MQTT
  char packet[384];
  while (dequeuePacket(packet, sizeof(packet))) {
    if (mqttClient.connected()) {
      mqttClient.publish(mqtt_topic, packet);
      Serial.printf("[BLE -> MQTT] %s\n", packet);
    }
  }

  unsigned long now = millis();

  // 3. Transmit Standalone Gateway Heartbeat every 1.5s
  if (now - lastGatewayHeartbeat >= 1500) {
    lastGatewayHeartbeat = now;
    if (mqttClient.connected()) {
      int activeCount = getConnectedCount();
      char hbPayload[160];
      snprintf(hbPayload, sizeof(hbPayload),
               "{\"mac\":\"%s\",\"status\":\"ONLINE\",\"active_wristbands\":%d,\"capacity\":%d}",
               WiFi.macAddress().c_str(), activeCount, MAX_WRISTBANDS);
      mqttClient.publish(gateway_status_topic, hbPayload);
    }
  }

  // 4. Handle Pending BLE Connection
  if (doConnect && pendingDevice != nullptr && pendingSlot >= 0) {
    if (connectWristbandToSlot(pendingSlot, pendingDevice)) {
      Serial.printf("[GATEWAY] Slot %d successfully active! Total wristbands: %d\n",
                    pendingSlot, getConnectedCount());
    } else {
      Serial.printf("[GATEWAY] Slot %d connection failed. Will retry scan.\n", pendingSlot);
    }
    delete pendingDevice;
    pendingDevice = nullptr;
    pendingSlot = -1;
    doConnect = false;
    isScanning = false;
  }

  // 5. Periodic Background Scanner for discovering additional wristbands
  // If we have free slots and aren't already scanning or connecting:
  if (!doConnect && !isScanning && getConnectedCount() < MAX_WRISTBANDS) {
    if (now - lastScanAttempt >= 3000) {
      lastScanAttempt = now;
      Serial.printf("\n[GATEWAY] Background scanning for additional wristbands (%d/%d slots in use)...\n",
                    getConnectedCount(), MAX_WRISTBANDS);
      BLEDevice::getScan()->start(4, scanEndedCB, false);
      isScanning = true;
    }
  }

  delay(5); // 5ms loop yield for FreeRTOS and Wi-Fi tasks
}
