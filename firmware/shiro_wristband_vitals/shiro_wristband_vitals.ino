/*
 * =========================================================================================
 *   SHIRO Wristband Tag - Physiological & Kinematic Telemetry Node (V5 - Protocol 2)
 *   Hardware: Seeed Studio XIAO ESP32-C6
 *   Sensors:  HW-605 (MAX30102 PPG) + MPU-6050 (6-DOF IMU) via I2C (SDA: D4, SCL: D5)
 *   Battery:  100k/100k Divider on BAT+ to D0
 *   Power:    Adaptive Throttling (3-min Passive Sleep Cycle + Active 1Hz Escalation)
 *   Safety:   On-Chip Triple-Phase Kinematic Fall State Machine (Chapter 4, Algorithm 3)
 *   Protocol: BLE broadcast, telemetry packet version 2 (docs/protocol.md) + GATT control
 *   Project:  MR-Patient Connect (SHIRO) - Final Year Project (RSWG7)
 *
 *   Files in this sketch folder:
 *     fall_detector.h  - fall state machine and its self-test
 *     shiro_packet.h   - telemetry packet (identical copy in shiro_anchor_node)
 *     vitals_filter.h  - accepted vitals range and beat smoothing
 *   The wristband and ALL anchors must run the same protocol version: flash them together.
 * =========================================================================================
 */

#include <Wire.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLEAdvertising.h>
#include "driver/usb_serial_jtag.h"
#include "esp_random.h"
#include "MAX30105.h"
#include "heartRate.h"
#include "fall_detector.h"
#include "shiro_packet.h"
#include "vitals_filter.h"

// Set to 1 for bench testing only: a firm shake (>= 1.8 g) then starts 1 Hz active
// mode without the dashboard. Must be 0 on a wristband worn by a patient.
#define SHIRO_DEBUG_SHAKE_WAKE 0

// Bench measurements: recorder for the raw pulse signal, USB serial only.
// Commands typed into the Serial Monitor (or sent by firmware/tools/record_ppg.bat),
// each followed by Enter:
//   rec [seconds]   record for 1 to 600 seconds (default 120)
//   stop            end the recording now
//   led <hex>       LED current for the next recording, 01 to FF (default 24)
// Nothing of this is sent by radio, and the normal operation is not changed
// while no recording runs.
#define SHIRO_PPG_RECORDER 1

// I2C Pin Configuration for Seeed Studio XIAO ESP32-C6
#define I2C_SDA D4
#define I2C_SCL D5
#define MPU_ADDR 0x68

// MPU-6050 registers and scaling
#define MPU_REG_ACCEL_CONFIG 0x1C
#define MPU_REG_ACCEL_XOUT_H 0x3B
#define MPU_REG_PWR_MGMT_1   0x6B
#define MPU_REG_WHO_AM_I     0x75
#define MPU_ACCEL_RANGE_16G  0x18       // AFS_SEL = 3
const float MPU_LSB_PER_G = 2048.0f;    // sensitivity at +/-16 g
// The default +/-2 g range clips each axis at 2 g, so a 2.5 g impact could not
// be measured at all. In the bench tests of 14 Nov 2026 the +/-8 g range still
// clipped: most recorded impacts sat on its ceiling values (8.0, 11.3, 13.9 g).
// +/-16 g is the widest range of the sensor; one step is still below 0.001 g.

// Battery Sensing Configuration (XIAO ESP32-C6: 100k/100k Divider on BAT+ to D0)
#define BATTERY_ADC_PIN     D0
const float VOLTAGE_DIVIDER_RATIO = 2.0f; // Halved by 100k:100k divider

// Sensor Objects
MAX30105 particleSensor;
bool maxReady = false;
const uint8_t PPG_LED_CURRENT = 0x24;   // red and infrared LED current, about 7 mA

// Raw pulse-signal recorder (see SHIRO_PPG_RECORDER above)
bool ppgRecording = false;
#if SHIRO_PPG_RECORDER
unsigned long ppgRecEndMs = 0;
uint32_t ppgSampleNo = 0;
uint8_t ppgLedLevel = PPG_LED_CURRENT;
char ppgCmd[24];
uint8_t ppgCmdLen = 0;
#endif

// -----------------------------------------------------------------------------
// Heart Rate (BPM) State Variables
// -----------------------------------------------------------------------------
const byte RATE_SIZE = 4;
byte rates[RATE_SIZE];
byte rateSpot = 0;
long lastBeat = 0;
unsigned long lastValidBeatMs = 0;   // 0 = no beat collected since the last reset
float beatsPerMinute = 0;
int beatAvg = 0;

// -----------------------------------------------------------------------------
// SpO2 Calculation State Variables
// -----------------------------------------------------------------------------
int spo2Avg = 0;
const byte SPO2_SIZE = 4;
byte spo2Buffer[SPO2_SIZE];
byte spo2Spot = 0;

uint32_t irMax = 0, irMin = 0xFFFFFF;
uint32_t redMax = 0, redMin = 0xFFFFFF;
int spo2SampleCount = 0;

long latestIR = 0;
long latestRed = 0;
int touchState = 0;
unsigned long lastValidContactTime = 0;

// -----------------------------------------------------------------------------
// Algorithm 3: On-Chip Triple-Phase Kinematic Fall State Machine (Chapter 4, Section 4.5.3)
// Implemented in fall_detector.h; thresholds are in defaultFallConfig() there.
// -----------------------------------------------------------------------------
FallDetector fallDetector;
bool isFallEmergency = false;   // mirrors fallDetector.emergency()

// -----------------------------------------------------------------------------
// Sensor health: a sensor that stops answering is reported, never papered over
// -----------------------------------------------------------------------------
bool imuFault = false;                              // accelerometer not delivering data
uint8_t imuFailStreak = 0;
uint8_t mpuWhoAmI = 0;
unsigned long lastImuRecoveryAttempt = 0;
const uint8_t IMU_FAULT_AFTER_FAILURES = 5;         // 5 failed reads in a row = 100 ms
const unsigned long IMU_RECOVERY_INTERVAL_MS = 2000;

// -----------------------------------------------------------------------------
// Adaptive Vitals Sampling & Power-Saving Engine (Chapter 4, Section 4.2.1)
// -----------------------------------------------------------------------------
enum VitalsSamplingMode {
  MODE_PASSIVE_SLEEP,
  MODE_PASSIVE_BURST,
  MODE_ACTIVE_STREAM
};

VitalsSamplingMode vitalsMode = MODE_PASSIVE_BURST; // Start with initial burst
bool maxSensorSleeping = false;
unsigned long lastVitalsBurstTime = 0;
unsigned long burstStartTime = 0;
unsigned long activeModeEndTime = 0;

const unsigned long PASSIVE_CYCLE_INTERVAL = 180000; // 3 Minutes (180s)
const unsigned long BURST_MEASURE_DURATION = 15000;  // 15 Seconds
const unsigned long ACTIVE_STREAM_TIMEOUT  = 60000;  // 60 Seconds when triggered

// Kinematic Vector & Motion Classifier
float currentG = 1.0f;
const char* currentMotion = "STATIONARY";
const int MOTION_WINDOW_SIZE = 10;
float gHistory[MOTION_WINDOW_SIZE];
int gHistorySpot = 0;
int gHistoryCount = 0;

const char* classifyWristbandMotion(float g) {
  gHistory[gHistorySpot++] = g;
  gHistorySpot %= MOTION_WINDOW_SIZE;
  if (gHistoryCount < MOTION_WINDOW_SIZE) gHistoryCount++;

  if (gHistoryCount < 5) return "STATIONARY";

  float sumDiffSq = 0;
  float minG = 999.0;
  float maxG = -999.0;
  for (int i = 0; i < gHistoryCount; i++) {
    float diff = gHistory[i] - 1.0f;
    sumDiffSq += diff * diff;
    if (gHistory[i] < minG) minG = gHistory[i];
    if (gHistory[i] > maxG) maxG = gHistory[i];
  }
  float variance = sumDiffSq / gHistoryCount;
  float p2p = maxG - minG;

  int zeroCrossings = 0;
  for (int i = 1; i < gHistoryCount; i++) {
    float prevDev = gHistory[i - 1] - 1.0f;
    float curDev = gHistory[i] - 1.0f;
    if ((prevDev > 0.04 && curDev < -0.04) || (prevDev < -0.04 && curDev > 0.04)) {
      zeroCrossings++;
    }
  }

  if (isFallEmergency) {
    return "FALL_EMERGENCY";
  }
  if (p2p >= 1.4 || maxG >= 2.2 || minG <= 0.3) {
    return "HAND_MOVEMENT";
  }
  if (zeroCrossings >= 3 && p2p >= 0.28 && variance >= 0.012) {
    return "WALKING";
  }
  if (p2p >= 0.16 || fabs(g - 1.0f) > 0.15 || variance >= 0.004) {
    return "HAND_MOVEMENT";
  }
  return "STATIONARY";
}

// -----------------------------------------------------------------------------
// Battery Sensing & Charging Logic (Zero-Solder Detection)
// -----------------------------------------------------------------------------
int currentBatteryPct = 100;
float currentVBat = 4.2f;
bool isCharging = false;
unsigned long lastBatteryCheckTime = 0;
const unsigned long BATTERY_CHECK_INTERVAL = 1000;

float vBatHistory[6] = {4.2, 4.2, 4.2, 4.2, 4.2, 4.2};
int vBatHistoryIndex = 0;

float readBatteryVoltage() {
  uint32_t rawMvSum = 0;
  const int SAMPLES = 8;
  for (int i = 0; i < SAMPLES; i++) {
    rawMvSum += analogReadMilliVolts(BATTERY_ADC_PIN);
    delay(2);
  }
  float vPin = (rawMvSum / (float)SAMPLES) / 1000.0f;
  float vBat = vPin * VOLTAGE_DIVIDER_RATIO;
  return vBat;
}

int calculateBatteryPercentage(float vBat) {
  if (vBat >= 4.18f) return 100;
  if (vBat <= 3.30f) return 0;

  if (vBat >= 4.00f) {
    return 85 + (int)((vBat - 4.00f) / (4.18f - 4.00f) * 15.0f);
  } else if (vBat >= 3.75f) {
    return 50 + (int)((vBat - 3.75f) / (4.00f - 3.75f) * 35.0f);
  } else if (vBat >= 3.60f) {
    return 20 + (int)((vBat - 3.60f) / (3.75f - 3.60f) * 30.0f);
  } else {
    return (int)((vBat - 3.30f) / (3.60f - 3.30f) * 20.0f);
  }
}

bool detectCharging(float vBat) {
  if (usb_serial_jtag_is_connected()) {
    return true;
  }
  if (vBat >= 4.18f) {
    return true;
  }
  float oldestVBat = vBatHistory[(vBatHistoryIndex + 1) % 6];
  if (vBat - oldestVBat >= 0.035f) {
    return true;
  }
  return false;
}

// -----------------------------------------------------------------------------
// BLE Dynamic Broadcast & GATT Control Receiver
// -----------------------------------------------------------------------------
#define SHIRO_SERVICE_UUID        "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define SHIRO_CONTROL_CHAR_UUID   "beb5483e-36e1-4688-b7f5-ea07361b26a8"

bool deviceConnected = false;

class MyServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* pServer) {
    deviceConnected = true;
    Serial.println("\n[BLE SERVER] Central Client Connected!");
  }
  void onDisconnect(BLEServer* pServer) {
    deviceConnected = false;
    Serial.println("[BLE SERVER] Central Client Disconnected. Resuming advertisement.");
    BLEDevice::startAdvertising();
  }
};

class ControlCallback : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* pCharacteristic) {
    String value = pCharacteristic->getValue();
    if (value.length() > 0) {
      Serial.printf("[BLE GATT CMD] Received '%s' -> Escalating to 1 Hz Active Mode!\n", value.c_str());
      activeModeEndTime = millis() + ACTIVE_STREAM_TIMEOUT;
    }
  }
};

unsigned long lastBleTransmitTime = 0;
const unsigned long BLE_TRANSMIT_INTERVAL = 200; // 5 Hz update rate

uint8_t currentMotionCode() {
  if (isFallEmergency || strcmp(currentMotion, "FALL_EMERGENCY") == 0) return shiro::MOTION_FALL_EMERGENCY;
  if (strcmp(currentMotion, "WALKING") == 0) return shiro::MOTION_WALKING;
  if (strcmp(currentMotion, "HAND_MOVEMENT") == 0) return shiro::MOTION_HAND_MOVEMENT;
  return shiro::MOTION_STATIONARY;
}

void updateBleAdvertisement() {
  if (deviceConnected) {
    // Crucial: Do NOT modify BLE advertisement while a GATT client connection is active
    return;
  }

  BLEAdvertising* pAdvertising = BLEDevice::getAdvertising();

  BLEAdvertisementData advData;
  advData.setFlags(0x06); // General Discoverable Mode, BR/EDR Not Supported

  // Telemetry packet version 2: layout in shiro_packet.h and docs/protocol.md
  shiro::Telemetry t;
  t.bpm = (uint8_t)beatAvg;                // 0 = no valid reading
  t.spo2 = (uint8_t)spo2Avg;               // 0 = no valid reading
  t.motion = currentMotionCode();
  t.battery = shiro::clampPercent(currentBatteryPct);
  t.charging = isCharging;
  t.contact = (touchState != 0);
  t.fall = isFallEmergency;
  t.active = (vitalsMode == MODE_ACTIVE_STREAM);
  t.imuFault = imuFault;
  t.ppgFault = !maxReady;
  t.g = imuFault ? 0.0f : currentG;
  t.fallSeq = fallDetector.eventCounter();
  t.impactG = fallDetector.peakImpactG();
  t.freefallG = fallDetector.minFreefallG();
  t.stillG = fallDetector.stillnessG();

  uint8_t mData[shiro::PACKET_V2_LENGTH];
  shiro::encodePacketV2(t, mData);

  advData.setManufacturerData(String((char*)mData, shiro::PACKET_V2_LENGTH));
  pAdvertising->setAdvertisementData(advData);
}

// -----------------------------------------------------------------------------
// MPU-6050 Helper Functions
// -----------------------------------------------------------------------------
bool mpuWrite(uint8_t reg, uint8_t value) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  Wire.write(value);
  return Wire.endTransmission(true) == 0;
}

bool mpuRead(uint8_t reg, uint8_t* buffer, uint8_t count) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) {
    return false;
  }
  if (Wire.requestFrom((uint8_t)MPU_ADDR, count, (uint8_t)true) != count) {
    return false;
  }
  for (uint8_t i = 0; i < count; i++) {
    buffer[i] = (uint8_t)Wire.read();
  }
  return true;
}

// Wakes the sensor, selects the +/-16 g range and reads the setting back.
// Returns false when the sensor does not answer or did not accept the range.
bool initMPU6050() {
  uint8_t who = 0;
  if (!mpuRead(MPU_REG_WHO_AM_I, &who, 1)) return false;
  mpuWhoAmI = who;

  if (!mpuWrite(MPU_REG_PWR_MGMT_1, 0x00)) return false;   // wake from sleep
  delay(30);
  if (!mpuWrite(MPU_REG_ACCEL_CONFIG, MPU_ACCEL_RANGE_16G)) return false;

  uint8_t accelConfig = 0;
  if (!mpuRead(MPU_REG_ACCEL_CONFIG, &accelConfig, 1)) return false;
  return (accelConfig & 0x18) == MPU_ACCEL_RANGE_16G;
}

// Reads the total acceleration in g. Returns false when the read failed; the
// caller must then treat the sample as missing (it is never replaced by 1.0 g).
bool readMPU6050TotalG(float& totalG) {
  uint8_t raw[6];
  if (!mpuRead(MPU_REG_ACCEL_XOUT_H, raw, 6)) {
    return false;
  }

  int16_t rawX = (int16_t)((raw[0] << 8) | raw[1]);
  int16_t rawY = (int16_t)((raw[2] << 8) | raw[3]);
  int16_t rawZ = (int16_t)((raw[4] << 8) | raw[5]);

  // All three axes exactly zero means the sensor has reset into sleep mode.
  // Real free-fall still shows sensor noise on at least one axis.
  if (rawX == 0 && rawY == 0 && rawZ == 0) {
    return false;
  }

  float ax = rawX / MPU_LSB_PER_G;
  float ay = rawY / MPU_LSB_PER_G;
  float az = rawZ / MPU_LSB_PER_G;
  totalG = sqrt(ax * ax + ay * ay + az * az);
  return true;
}

#if SHIRO_PPG_RECORDER
// -----------------------------------------------------------------------------
// Raw pulse-signal recorder (bench measurements over USB serial)
//
// Lines written while a recording runs:
//   P,<sample>,<infrared>,<red>,<g x 100>     every sample (100 per second)
//   B,<sample>,<interval ms>,<BPM reported>   every beat the firmware detected
//   T,<sample>,<millis>                       every 100 samples, to check the sample rate
// -----------------------------------------------------------------------------
void ppgSetLed(uint8_t level) {
  if (!maxReady) return;
  particleSensor.setPulseAmplitudeIR(level);
  particleSensor.setPulseAmplitudeRed(level);
  ppgLedLevel = level;
}

void ppgStop(const char* reason) {
  if (!ppgRecording) return;
  ppgRecording = false;
  Serial.printf("[PPG-REC] end samples=%lu reason=%s\n", (unsigned long)ppgSampleNo, reason);
  // A changed LED current applies to one recording only
  if (ppgLedLevel != PPG_LED_CURRENT) ppgSetLed(PPG_LED_CURRENT);
}

void ppgHandleCommand(const char* cmd) {
  if (strncmp(cmd, "rec", 3) == 0) {
    if (!maxReady) {
      Serial.println("[PPG-REC] error: the pulse sensor is not available");
      return;
    }
    long seconds = atol(cmd + 3);
    if (seconds <= 0) seconds = 120;
    if (seconds > 600) seconds = 600;
    unsigned long now = millis();
    ppgRecEndMs = now + (unsigned long)seconds * 1000UL;
    activeModeEndTime = ppgRecEndMs + 1000;   // keeps the pulse sensor awake for the recording
    ppgSampleNo = 0;
    ppgRecording = true;
    Serial.printf("[PPG-REC] start seconds=%ld led=0x%02X sample_hz=100\n", seconds, (unsigned)ppgLedLevel);
  } else if (strncmp(cmd, "stop", 4) == 0) {
    ppgStop("command");
  } else if (strncmp(cmd, "led", 3) == 0) {
    long level = strtol(cmd + 3, NULL, 16);
    if (level < 1 || level > 255) {
      Serial.println("[PPG-REC] error: led needs a hex value from 01 to FF");
      return;
    }
    ppgSetLed((uint8_t)level);
    Serial.printf("[PPG-REC] led=0x%02X\n", (unsigned)ppgLedLevel);
  } else {
    Serial.println("[PPG-REC] commands: rec [seconds] | stop | led <hex 01..FF>");
  }
}

void ppgPollSerial() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      if (ppgCmdLen > 0) {
        ppgCmd[ppgCmdLen] = '\0';
        ppgCmdLen = 0;
        ppgHandleCommand(ppgCmd);
      }
    } else if (ppgCmdLen < sizeof(ppgCmd) - 1) {
      ppgCmd[ppgCmdLen++] = c;
    }
  }
}
#endif  // SHIRO_PPG_RECORDER

// -----------------------------------------------------------------------------
// Arduino Setup
// -----------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(1500);

  Serial.println("\n==========================================================");
  Serial.println("  SHIRO Wristband Tag - Adaptive Telemetry (V5 - Protocol 2)");
  Serial.println("  Hardware: Seeed Studio XIAO ESP32-C6");
  Serial.println("==========================================================");

  // 1. Initialize Hardware I2C (100 kHz Standard Speed)
  Wire.begin(I2C_SDA, I2C_SCL);
  Wire.setClock(100000);

  // 2. Initialize MPU-6050 (+/-16 g) and verify that it answers
  imuFault = !initMPU6050();
  if (!imuFault) {
    Serial.printf("[OK] MPU-6050 ready: +/-16 g range, WHO_AM_I = 0x%02X.\n", mpuWhoAmI);
    if (mpuWhoAmI != 0x68 && mpuWhoAmI != 0x70 && mpuWhoAmI != 0x71 && mpuWhoAmI != 0x72 && mpuWhoAmI != 0x98) {
      Serial.println("[WARN] Unexpected WHO_AM_I value: check the readings of this sensor before trusting them.");
    }
  } else {
    Serial.println("[FAIL] MPU-6050 not responding or range not accepted.");
    Serial.println("       Fall detection is OFF. The fault is reported in every packet.");
  }

  // 3. Self-test of the fall state machine with built-in traces (no sensor involved)
  FallSelfTestResult selfTest = runFallSelfTest();
  Serial.printf("[SELF-TEST] Fall detector: %s (fall: %s, short dip: %s, movement: %s)\n",
                selfTest.passed() ? "PASS" : "FAIL",
                selfTest.fallDetected ? "detected" : "MISSED",
                selfTest.shortDipIgnored ? "ignored" : "FALSE ALARM",
                selfTest.movementIgnored ? "ignored" : "FALSE ALARM");

  // 4. Initialize HW-605 (MAX30102)
  if (particleSensor.begin(Wire, I2C_SPEED_STANDARD)) {
    // 400 samples per second averaged by 4 = 100 samples per second, red + infrared
    particleSensor.setup(PPG_LED_CURRENT, 4, 2, 400, 411, 4096);
    particleSensor.setPulseAmplitudeRed(PPG_LED_CURRENT);
    particleSensor.setPulseAmplitudeGreen(0);
    maxReady = true;
    Serial.println("[OK] HW-605 (MAX30102) Initialized.");
  } else {
    Serial.println("[FAIL] HW-605 not responding. Vitals are OFF. The fault is reported in every packet.");
  }

  Wire.begin(I2C_SDA, I2C_SCL);
  Wire.setClock(100000);

  // 5. Initialize Battery Sense ADC (Pin D0)
  pinMode(BATTERY_ADC_PIN, INPUT);
  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);
  currentVBat = readBatteryVoltage();
  currentBatteryPct = calculateBatteryPercentage(currentVBat);
  Serial.printf("[OK] Battery Monitoring Initialized: %.2fV (%d%%)\n", currentVBat, currentBatteryPct);

  // 6. Initialize BLE Device, GATT Server & Control Characteristic
  BLEDevice::init("SHIRO-WRISTBAND");
  BLEServer* pServer = BLEDevice::createServer();
  pServer->setCallbacks(new MyServerCallbacks());
  BLEService* pService = pServer->createService(SHIRO_SERVICE_UUID);
  BLECharacteristic* pChar = pService->createCharacteristic(
                               SHIRO_CONTROL_CHAR_UUID,
                               BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR
                             );
  pChar->setCallbacks(new ControlCallback());
  pService->start();

  // The fall counter starts at a random value, so a wristband that restarts
  // cannot repeat the counter of a fall it reported shortly before.
  fallDetector.seedCounter((uint8_t)(esp_random() & 0xFF));

  // 7. Start Continuous BLE Broadcast
  BLEAdvertising* pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->setMinInterval(100);
  pAdvertising->setMaxInterval(160);

  BLEAdvertisementData scanRespData;
  scanRespData.setName("SHIRO-WRISTBAND");
  scanRespData.setCompleteServices(BLEUUID(SHIRO_SERVICE_UUID));
  pAdvertising->setScanResponseData(scanRespData);

  updateBleAdvertisement();
  pAdvertising->start();

  burstStartTime = millis();
  lastVitalsBurstTime = millis();

  Serial.printf("[OK] Dual BLE Broadcast + GATT Server Active! MAC: %s\n", BLEDevice::getAddress().toString().c_str());
  Serial.printf("[OK] Telemetry packet version %u, %u bytes.\n", (unsigned)shiro::PACKET_VERSION, (unsigned)shiro::PACKET_V2_LENGTH);
  Serial.println(">>> Ready: 3-min passive cycle + 1Hz on-demand/fall escalation <<<\n");
}

// -----------------------------------------------------------------------------
// Arduino Main Loop
// -----------------------------------------------------------------------------
void loop() {
  unsigned long now = millis();

#if SHIRO_PPG_RECORDER
  ppgPollSerial();
  if (ppgRecording && (long)(now - ppgRecEndMs) >= 0) ppgStop("time");
#endif

  // 1. High-Frequency Kinematic Sampling (~50 Hz) for Algorithm 3 Fall Detection
  static unsigned long lastImuTime = 0;
  if (now - lastImuTime >= 20) {
    lastImuTime = now;

    float sampleG = 0.0f;
    bool sampleOk = false;
    if (!imuFault) {
      sampleOk = readMPU6050TotalG(sampleG);
    } else if (now - lastImuRecoveryAttempt >= IMU_RECOVERY_INTERVAL_MS) {
      // A failed sensor is retried every 2 seconds, not 50 times a second, so a
      // stuck I2C bus cannot slow down the pulse sensor and the broadcast.
      lastImuRecoveryAttempt = now;
      sampleOk = initMPU6050() && readMPU6050TotalG(sampleG);
    }

    if (sampleOk) {
      imuFailStreak = 0;
      if (imuFault) {
        imuFault = false;
        Serial.println("[IMU] Accelerometer is delivering data again. Fall detection is back ON.");
      }
      currentG = sampleG;

      if (fallDetector.update(sampleG, now)) {
        activeModeEndTime = now + ACTIVE_STREAM_TIMEOUT; // Automatically engage 1 Hz streaming on emergency
        Serial.printf("\n[ALERT] *** ON-CHIP KINEMATIC FALL CONFIRMED! #%u | free-fall min %.2fg | impact %.2fg | post-impact motion %.2fg ***\n",
                      (unsigned)fallDetector.eventCounter(), fallDetector.minFreefallG(),
                      fallDetector.peakImpactG(), fallDetector.stillnessG());
      }
    } else {
      // No sample: keep an existing alert running, but never feed a made-up value
      fallDetector.service(now);

      if (!imuFault) {
        if (imuFailStreak < 255) imuFailStreak++;
        if (imuFailStreak >= IMU_FAULT_AFTER_FAILURES) {
          imuFault = true;
          lastImuRecoveryAttempt = now;
          fallDetector.cancelPending();
          currentG = 0.0f;
          Serial.println("[IMU] FAULT: accelerometer stopped answering. Fall detection is OFF until it recovers.");
        }
      }
    }

    isFallEmergency = fallDetector.emergency();

    if (isFallEmergency) {
      currentMotion = "FALL_EMERGENCY";
    } else if (imuFault) {
      currentMotion = "STATIONARY"; // unknown; the fault flag tells receivers not to trust it
    } else if (sampleOk) {
      currentMotion = classifyWristbandMotion(currentG);
#if SHIRO_DEBUG_SHAKE_WAKE
      // Bench testing only: firm tap / shake triggers 1 Hz active mode
      static unsigned long lastTapWakeTime = 0;
      if (currentG >= 1.80f && (now - lastTapWakeTime > 3000)) {
        lastTapWakeTime = now;
        activeModeEndTime = now + ACTIVE_STREAM_TIMEOUT;
        Serial.println("[MOTION WAKE] Firm tap/shake detected -> Escalated to 1 Hz Active Mode!");
      }
#endif
    }
  }

  // 2. Power-Saving & Throttling Management (Section 4.2.1)
  // Decoupled from touchState: Active 1Hz mode only triggers on confirmed fall emergency or remote inspection
  bool shouldBeActive = isFallEmergency || (now < activeModeEndTime);

  if (shouldBeActive) {
    if (vitalsMode != MODE_ACTIVE_STREAM) {
      vitalsMode = MODE_ACTIVE_STREAM;
      if (maxSensorSleeping && maxReady) {
        particleSensor.wakeUp();
        maxSensorSleeping = false;
        Serial.println("[POWER] Escalated to 1 Hz Active Streaming (MAX30102 Awake)");
      }
    }
  } else {
    // Normal 3-minute passive cycle
    if (vitalsMode == MODE_ACTIVE_STREAM) {
      vitalsMode = MODE_PASSIVE_SLEEP;
      lastVitalsBurstTime = now;
      beatAvg = 0;
      spo2Avg = 0;
      touchState = 0;
      rateSpot = 0;
      spo2Spot = 0;
      for (byte i = 0; i < RATE_SIZE; i++) rates[i] = 0;
      for (byte j = 0; j < SPO2_SIZE; j++) spo2Buffer[j] = 0;
      if (!maxSensorSleeping && maxReady) {
        particleSensor.shutDown();
        maxSensorSleeping = true;
        Serial.println("[POWER] Active stream finished. MAX30102 entering low-power sleep. Vitals reset to 0.");
      }
    }

    if (vitalsMode == MODE_PASSIVE_SLEEP) {
      if (now - lastVitalsBurstTime >= PASSIVE_CYCLE_INTERVAL) {
        vitalsMode = MODE_PASSIVE_BURST;
        burstStartTime = now;
        if (maxSensorSleeping && maxReady) {
          particleSensor.wakeUp();
          maxSensorSleeping = false;
          Serial.println("[POWER] Waking MAX30102 for scheduled 15s vitals measurement.");
        }
      }
    } else if (vitalsMode == MODE_PASSIVE_BURST) {
      if (now - burstStartTime >= BURST_MEASURE_DURATION) {
        vitalsMode = MODE_PASSIVE_SLEEP;
        lastVitalsBurstTime = now;
        beatAvg = 0;
        spo2Avg = 0;
        touchState = 0;
        rateSpot = 0;
        spo2Spot = 0;
        for (byte i = 0; i < RATE_SIZE; i++) rates[i] = 0;
        for (byte j = 0; j < SPO2_SIZE; j++) spo2Buffer[j] = 0;
        if (!maxSensorSleeping && maxReady) {
          particleSensor.shutDown();
          maxSensorSleeping = true;
          Serial.println("[POWER] 15s vitals sample completed. MAX30102 sleeping for 3 minutes. Vitals reset to 0.");
        }
      }
    }
  }

  // 3. Process MAX30102 I2C Samples (Only when sensor is awake)
  if (maxReady && !maxSensorSleeping) {
    particleSensor.check();

    // A heart rate with no recent beat behind it is withdrawn, not kept on air
    if (lastValidBeatMs != 0 && isBeatStale(now, lastValidBeatMs)) {
      beatAvg = 0;
      rateSpot = 0;
      for (byte i = 0; i < RATE_SIZE; i++) rates[i] = 0;
      lastValidBeatMs = 0;
    }

    while (particleSensor.available()) {
      uint32_t irVal  = particleSensor.getFIFOIR();
      uint32_t redVal = particleSensor.getFIFORed();
      particleSensor.nextSample();

      latestIR  = irVal;
      latestRed = redVal;

#if SHIRO_PPG_RECORDER
      if (ppgRecording) {
        if (ppgSampleNo % 100 == 0) Serial.printf("T,%lu,%lu\n", (unsigned long)ppgSampleNo, (unsigned long)millis());
        Serial.printf("P,%lu,%lu,%lu,%d\n", (unsigned long)ppgSampleNo, (unsigned long)irVal,
                      (unsigned long)redVal, (int)(currentG * 100.0f + 0.5f));
        ppgSampleNo++;
      }
#endif

      if (irVal > 50000) {
        touchState = 1;
        lastValidContactTime = now;

        if (checkForBeat(irVal) == true) {
          long delta = millis() - lastBeat;
          lastBeat = millis();

          float bpm = 60.0f / (delta / 1000.0f);
          // Wide range on purpose (vitals_filter.h): dangerous rates must reach the server
          if (isValidBpm(bpm)) {
            rates[rateSpot++] = (byte)bpm;
            rateSpot %= RATE_SIZE;

            // Median of the last beats: one missed or doubled beat does not move it.
            // Nothing is reported before BPM_MIN_BEATS intervals have been measured.
            beatAvg = medianOfNonZero(rates, RATE_SIZE, BPM_MIN_BEATS);
            lastValidBeatMs = millis();
            if (lastValidBeatMs == 0) lastValidBeatMs = 1;
          }
#if SHIRO_PPG_RECORDER
          if (ppgRecording) Serial.printf("B,%lu,%ld,%d\n", (unsigned long)ppgSampleNo, delta, beatAvg);
#endif
        }

        if (irVal > irMax)   irMax = irVal;
        if (irVal < irMin)   irMin = irVal;
        if (redVal > redMax) redMax = redVal;
        if (redVal < redMin) redMin = redVal;

        spo2SampleCount++;
        if (spo2SampleCount >= 100) {
          float acIR  = (float)(irMax - irMin);
          float dcIR  = (float)irMin;
          float acRed = (float)(redMax - redMin);
          float dcRed = (float)redMin;

          if (dcIR > 0 && dcRed > 0 && acIR > 0) {
            float R = (acRed / dcRed) / (acIR / dcIR);
            // Uncalibrated linear approximation: SpO2 values are indicative only
            float calculatedSpo2 = 110.0f - (25.0f * R);

            if (isValidSpo2(calculatedSpo2)) {
              spo2Buffer[spo2Spot++] = (byte)calculatedSpo2;
              spo2Spot %= SPO2_SIZE;

              int spo2Sum = 0;
              byte spo2Count = 0;
              for (byte y = 0; y < SPO2_SIZE; y++) {
                if (spo2Buffer[y] > 0) {
                  spo2Sum += spo2Buffer[y];
                  spo2Count++;
                }
              }
              if (spo2Count > 0) spo2Avg = spo2Sum / spo2Count;
            }
          }

          irMax = 0; irMin = 0xFFFFFF;
          redMax = 0; redMin = 0xFFFFFF;
          spo2SampleCount = 0;
        }
      } else {
        // Debounce contact loss: only wipe vitals if contact lost continuously for > 3.5 seconds
        if (now - lastValidContactTime > 3500) {
          touchState = 0;
          beatAvg = 0;
          spo2Avg = 0;
          rateSpot = 0;
          spo2Spot = 0;
          irMax = 0; irMin = 0xFFFFFF;
          redMax = 0; redMin = 0xFFFFFF;
          spo2SampleCount = 0;
          for (byte i = 0; i < RATE_SIZE; i++) rates[i] = 0;
          for (byte j = 0; j < SPO2_SIZE; j++) spo2Buffer[j] = 0;
        }
      }
    }
  }

  // 4. Periodic Battery Check (Every 1 second)
  if (now - lastBatteryCheckTime >= BATTERY_CHECK_INTERVAL) {
    lastBatteryCheckTime = now;
    float newVBat = readBatteryVoltage();
    currentVBat = (currentVBat * 0.7f) + (newVBat * 0.3f);
    currentBatteryPct = calculateBatteryPercentage(currentVBat);

    vBatHistory[vBatHistoryIndex] = currentVBat;
    vBatHistoryIndex = (vBatHistoryIndex + 1) % 6;

    isCharging = detectCharging(currentVBat);
  }

  // 5. Update Dynamic BLE Broadcast (Every 200ms = 5 Hz)
  if (now - lastBleTransmitTime >= BLE_TRANSMIT_INTERVAL) {
    lastBleTransmitTime = now;
    updateBleAdvertisement();

    // The status line is left out while a raw recording runs (it would sit between the samples)
    if (!ppgRecording) {
      Serial.printf("[BROADCAST %s] BPM: %d | SpO2: %d%% | Bat: %d%%%s | G: %.2f | Motion: %s [%s]%s%s\n",
                    BLEDevice::getAddress().toString().c_str(),
                    beatAvg, spo2Avg, currentBatteryPct,
                    isCharging ? " (⚡ CHG)" : "", currentG, currentMotion,
                    vitalsMode == MODE_ACTIVE_STREAM ? "1Hz ACTIVE" : (vitalsMode == MODE_PASSIVE_BURST ? "3m BURST" : "3m SLEEP"),
                    imuFault ? " | IMU FAULT" : "", !maxReady ? " | PPG FAULT" : "");
    }
  }

  delay(5);
}
