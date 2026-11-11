/*
 * =========================================================================================
 *   SHIRO Wristband Tag - Physiological & Kinematic Telemetry Node (V4 - Phase 2 & 3)
 *   Hardware: Seeed Studio XIAO ESP32-C6
 *   Sensors:  HW-605 (MAX30102 PPG) + MPU-6050 (6-DOF IMU) via I2C (SDA: D4, SCL: D5)
 *   Battery:  100k/100k Divider on BAT+ to D0
 *   Power:    Adaptive Throttling (3-min Passive Sleep Cycle + Active 1Hz Escalation)
 *   Safety:   On-Chip Triple-Phase Kinematic Fall State Machine (Chapter 4, Algorithm 3)
 *   Protocol: Dual-Mode BLE 5.0 Broadcast (Continuous Manufacturer Telemetry + GATT Control)
 *   Project:  MR-Patient Connect (SHIRO) - Final Year Project (RSWG7)
 * =========================================================================================
 */

#include <Wire.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLEAdvertising.h>
#include "driver/usb_serial_jtag.h"
#include "MAX30105.h"
#include "heartRate.h"

// I2C Pin Configuration for Seeed Studio XIAO ESP32-C6
#define I2C_SDA D4
#define I2C_SCL D5
#define MPU_ADDR 0x68

// Battery Sensing Configuration (XIAO ESP32-C6: 100k/100k Divider on BAT+ to D0)
#define BATTERY_ADC_PIN     D0
const float VOLTAGE_DIVIDER_RATIO = 2.0f; // Halved by 100k:100k divider

// Sensor Objects
MAX30105 particleSensor;
bool maxReady = false;

// -----------------------------------------------------------------------------
// Heart Rate (BPM) State Variables
// -----------------------------------------------------------------------------
const byte RATE_SIZE = 4;
byte rates[RATE_SIZE];
byte rateSpot = 0;
long lastBeat = 0;
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
// -----------------------------------------------------------------------------
enum FallState {
  STATE_MONITORING,
  STATE_FREEFALL_DETECTED,
  STATE_IMPACT_DETECTED,
  STATE_FALL_CONFIRMED
};

FallState fallState = STATE_MONITORING;
unsigned long freeFallTimestamp = 0;
unsigned long impactTimestamp = 0;
unsigned long fallAlertEndTime = 0;
const float TH_FREEFALL = 0.50f;
const float TH_IMPACT = 2.50f;
const float TH_STILLNESS = 0.20f;
const unsigned long T_IMPACT_MAX_MS = 500;
const unsigned long T_STILL_DURATION_MS = 2000;
const unsigned long FALL_ALERT_HOLD_MS = 45000; // Hold emergency state for 45 seconds

float stillnessAccumulator = 0.0f;
int stillnessSampleCount = 0;
bool isFallEmergency = false;

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

void updateFallDetection(float smv, unsigned long now) {
  // If emergency alert is currently holding active
  if (isFallEmergency) {
    if (now >= fallAlertEndTime) {
      isFallEmergency = false;
      fallState = STATE_MONITORING;
    }
    return;
  }

  switch (fallState) {
    case STATE_MONITORING:
      if (smv < TH_FREEFALL) {
        freeFallTimestamp = now;
        fallState = STATE_FREEFALL_DETECTED;
      }
      break;

    case STATE_FREEFALL_DETECTED:
      if (now - freeFallTimestamp > T_IMPACT_MAX_MS) {
        fallState = STATE_MONITORING; // Timeout: no impact
      } else if (smv > TH_IMPACT) {
        impactTimestamp = now;
        stillnessAccumulator = 0.0f;
        stillnessSampleCount = 0;
        fallState = STATE_IMPACT_DETECTED;
      }
      break;

    case STATE_IMPACT_DETECTED:
      stillnessAccumulator += fabs(smv - 1.0f);
      stillnessSampleCount++;

      if (now - impactTimestamp >= T_STILL_DURATION_MS) {
        float meanMotion = (stillnessSampleCount > 0) ? (stillnessAccumulator / stillnessSampleCount) : 0.0f;
        if (meanMotion < TH_STILLNESS) {
          // Verified: Free-fall + Impact + Post-impact Incapacitation
          isFallEmergency = true;
          fallAlertEndTime = now + FALL_ALERT_HOLD_MS;
          activeModeEndTime = now + ACTIVE_STREAM_TIMEOUT; // Automatically engage 1 Hz streaming on emergency
          fallState = STATE_FALL_CONFIRMED;
          Serial.printf("\n[ALERT] *** ON-CHIP KINEMATIC FALL CONFIRMED! (SMV: %.2fg) ***\n", smv);
        } else {
          fallState = STATE_MONITORING; // False alarm: movement detected
        }
      }
      break;

    case STATE_FALL_CONFIRMED:
      if (now >= fallAlertEndTime) {
        isFallEmergency = false;
        fallState = STATE_MONITORING;
      }
      break;
  }
}

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

void updateBleAdvertisement() {
  if (deviceConnected) {
    // Crucial: Do NOT modify BLE advertisement while a GATT client connection is active
    return;
  }

  BLEAdvertising* pAdvertising = BLEDevice::getAdvertising();

  BLEAdvertisementData advData;
  advData.setFlags(0x06); // General Discoverable Mode, BR/EDR Not Supported

  // Map motion to 1-byte enum:
  // 0: STATIONARY, 1: HAND_MOVEMENT, 2: WALKING, 3: FALL_EMERGENCY
  uint8_t mCode = 0;
  if (isFallEmergency || strcmp(currentMotion, "FALL_EMERGENCY") == 0) mCode = 3;
  else if (strcmp(currentMotion, "WALKING") == 0) mCode = 2;
  else if (strcmp(currentMotion, "HAND_MOVEMENT") == 0) mCode = 1;
  else mCode = 0;

  // flags:
  // bit0: charging
  // bit1: touch contact
  // bit2: isFallEmergency
  // bit3: isActiveStreaming (1: 1Hz active mode, 0: 3-min passive cycle)
  uint8_t flags = (isCharging ? 0x01 : 0x00) |
                  (touchState ? 0x02 : 0x00) |
                  (isFallEmergency ? 0x04 : 0x00) |
                  ((vitalsMode == MODE_ACTIVE_STREAM) ? 0x08 : 0x00);

  int16_t gScaled = (int16_t)(currentG * 100.0f);

  uint8_t mData[9];
  mData[0] = 0x53; // 'S'
  mData[1] = 0x48; // 'H'
  mData[2] = (uint8_t)beatAvg;
  mData[3] = (uint8_t)spo2Avg;
  mData[4] = mCode;
  mData[5] = (uint8_t)currentBatteryPct;
  mData[6] = flags;
  mData[7] = (uint8_t)((gScaled >> 8) & 0xFF);
  mData[8] = (uint8_t)(gScaled & 0xFF);

  advData.setManufacturerData(String((char*)mData, 9));
  pAdvertising->setAdvertisementData(advData);
}

// -----------------------------------------------------------------------------
// MPU-6050 Helper Functions
// -----------------------------------------------------------------------------
void wakeMPU6050() {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x6B); // Power Management 1 register
  Wire.write(0x00); // Wake from sleep
  Wire.endTransmission(true);
}

float readMPU6050TotalG() {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x3B); // ACCEL_XOUT_H register
  if (Wire.endTransmission(false) != 0) {
    return 1.0f;
  }

  if (Wire.requestFrom((uint8_t)MPU_ADDR, (uint8_t)6, (uint8_t)true) == 6) {
    int16_t rawX = (Wire.read() << 8) | Wire.read();
    int16_t rawY = (Wire.read() << 8) | Wire.read();
    int16_t rawZ = (Wire.read() << 8) | Wire.read();

    float ax = rawX / 16384.0f;
    float ay = rawY / 16384.0f;
    float az = rawZ / 16384.0f;
    return sqrt(ax * ax + ay * ay + az * az);
  }
  return 1.0f;
}

// -----------------------------------------------------------------------------
// Arduino Setup
// -----------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(1500);

  Serial.println("\n==========================================================");
  Serial.println("  SHIRO Wristband Tag - Adaptive Telemetry (V4 - Phase 2&3)");
  Serial.println("  Hardware: Seeed Studio XIAO ESP32-C6");
  Serial.println("==========================================================");

  // 1. Initialize Hardware I2C (100 kHz Standard Speed)
  Wire.begin(I2C_SDA, I2C_SCL);
  Wire.setClock(100000);

  // 2. Initialize MPU-6050
  wakeMPU6050();
  Serial.println("[OK] MPU-6050 Initialized.");

  // 3. Initialize HW-605 (MAX30102)
  if (particleSensor.begin(Wire, I2C_SPEED_STANDARD)) {
    particleSensor.setup(0x24, 4, 2, 400, 411, 4096);
    particleSensor.setPulseAmplitudeRed(0x24);
    particleSensor.setPulseAmplitudeGreen(0);
    maxReady = true;
    Serial.println("[OK] HW-605 (MAX30102) Initialized.");
  } else {
    Serial.println("[FAIL] HW-605 not responding.");
  }

  Wire.begin(I2C_SDA, I2C_SCL);
  Wire.setClock(100000);

  // 4. Initialize Battery Sense ADC (Pin D0)
  pinMode(BATTERY_ADC_PIN, INPUT);
  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);
  currentVBat = readBatteryVoltage();
  currentBatteryPct = calculateBatteryPercentage(currentVBat);
  Serial.printf("[OK] Battery Monitoring Initialized: %.2fV (%d%%)\n", currentVBat, currentBatteryPct);

  // 5. Initialize BLE Device, GATT Server & Control Characteristic
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

  // 6. Start Continuous BLE Broadcast
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
  Serial.println(">>> Ready: 3-min passive cycle + 1Hz on-demand/fall escalation <<<\n");
}

// -----------------------------------------------------------------------------
// Arduino Main Loop
// -----------------------------------------------------------------------------
void loop() {
  unsigned long now = millis();

  // 1. High-Frequency Kinematic Sampling (~50 Hz) for Algorithm 3 Fall Detection
  static unsigned long lastImuTime = 0;
  static unsigned long lastTapWakeTime = 0;
  if (now - lastImuTime >= 20) {
    lastImuTime = now;
    currentG = readMPU6050TotalG();
    updateFallDetection(currentG, now);
    if (!isFallEmergency) {
      currentMotion = classifyWristbandMotion(currentG);
      // Intentional tap / firm shake wake-up: triggers 1 Hz active mode for testing
      if (currentG >= 1.80f && (now - lastTapWakeTime > 3000)) {
        lastTapWakeTime = now;
        activeModeEndTime = now + ACTIVE_STREAM_TIMEOUT;
        Serial.println("[MOTION WAKE] Firm tap/shake detected -> Escalated to 1 Hz Active Mode!");
      }
    } else {
      currentMotion = "FALL_EMERGENCY";
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

    while (particleSensor.available()) {
      uint32_t irVal  = particleSensor.getFIFOIR();
      uint32_t redVal = particleSensor.getFIFORed();
      particleSensor.nextSample();

      latestIR  = irVal;
      latestRed = redVal;

      if (irVal > 50000) {
        touchState = 1;
        lastValidContactTime = now;

        if (checkForBeat(irVal) == true) {
          long delta = millis() - lastBeat;
          lastBeat = millis();

          float bpm = 60.0f / (delta / 1000.0f);
          if (bpm >= 50.0f && bpm <= 180.0f) {
            rates[rateSpot++] = (byte)bpm;
            rateSpot %= RATE_SIZE;

            int beatSum = 0;
            byte validCount = 0;
            for (byte x = 0; x < RATE_SIZE; x++) {
              if (rates[x] > 0) {
                beatSum += rates[x];
                validCount++;
              }
            }
            if (validCount > 0) beatAvg = beatSum / validCount;
          }
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
            float calculatedSpo2 = 110.0f - (25.0f * R);

            if (calculatedSpo2 >= 85.0f && calculatedSpo2 <= 100.0f) {
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

    Serial.printf("[BROADCAST %s] BPM: %d | SpO2: %d%% | Bat: %d%%%s | G: %.2f | Motion: %s [%s]\n",
                  BLEDevice::getAddress().toString().c_str(),
                  beatAvg, spo2Avg, currentBatteryPct,
                  isCharging ? " (⚡ CHG)" : "", currentG, currentMotion,
                  vitalsMode == MODE_ACTIVE_STREAM ? "1Hz ACTIVE" : (vitalsMode == MODE_PASSIVE_BURST ? "3m BURST" : "3m SLEEP"));
  }

  delay(5);
}
