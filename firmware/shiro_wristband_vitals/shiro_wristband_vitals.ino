/*
 * =========================================================================================
 *   SHIRO Wristband Tag - Physiological & Kinematic Telemetry Node (V2 - Non-Blocking FIFO)
 *   Hardware: Seeed Studio XIAO ESP32-C6
 *   Sensors:  HW-605 (MAX30102 PPG) + MPU-6050 (6-DOF IMU) via I2C (SDA: D4, SCL: D5)
 *   Protocol: BLE 5.0 GATT Server (Notify Characteristic)
 *   Project:  MR-Patient Connect (SHIRO) - Final Year Project (RSWG7)
 * =========================================================================================
 */

#include <Wire.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include "MAX30105.h"
#include "heartRate.h"

// I2C Pin Configuration for Seeed Studio XIAO ESP32-C6
#define I2C_SDA D4
#define I2C_SCL D5
#define MPU_ADDR 0x68

// BLE UUIDs (Standard SHIRO Telemetry Profile)
#define SERVICE_UUID        "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define CHARACTERISTIC_UUID "beb5483e-36e1-4688-b7f5-ea07361b26a8"

// Sensor Objects
MAX30105 particleSensor;
bool maxReady = false;

// BLE Objects
BLEServer* pServer = nullptr;
BLECharacteristic* pCharacteristic = nullptr;
bool deviceConnected = false;
bool oldDeviceConnected = false;

// -----------------------------------------------------------------------------
// Heart Rate (BPM) State Variables
// -----------------------------------------------------------------------------
const byte RATE_SIZE = 4; // Rolling average window size
byte rates[RATE_SIZE];
byte rateSpot = 0;
long lastBeat = 0;
float beatsPerMinute = 0;
int beatAvg = 0;

// -----------------------------------------------------------------------------
// SpO2 Calculation State Variables (Ratio-of-Ratios Approximation)
// -----------------------------------------------------------------------------
int spo2Avg = 0;
const byte SPO2_SIZE = 4;
byte spo2Buffer[SPO2_SIZE];
byte spo2Spot = 0;

// Min/Max tracking for AC/DC optical calculation
uint32_t irMax = 0, irMin = 0xFFFFFF;
uint32_t redMax = 0, redMin = 0xFFFFFF;
int spo2SampleCount = 0;

// Latest raw sensor samples
long latestIR = 0;
long latestRed = 0;
int touchState = 0;

// Kinematic Vector
float currentG = 1.0;

// BLE transmission timing
unsigned long lastBleTransmitTime = 0;
const unsigned long BLE_TRANSMIT_INTERVAL = 200; // 5 Hz update rate (every 200 ms)

// -----------------------------------------------------------------------------
// BLE Server Callbacks
// -----------------------------------------------------------------------------
class MyServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* pServer) {
    deviceConnected = true;
    Serial.println("\n>>> [BLE] Gateway CONNECTED! <<<");
    // Restart advertising so Anchor nodes can continuously monitor RSSI distance!
    delay(50);
    pServer->startAdvertising();
  }

  void onDisconnect(BLEServer* pServer) {
    deviceConnected = false;
    Serial.println("\n>>> [BLE] Gateway DISCONNECTED! <<<");
  }
};

// -----------------------------------------------------------------------------
// MPU-6050 Helper Functions
// -----------------------------------------------------------------------------
void wakeMPU6050() {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x6B);
  Wire.write(0x00);
  Wire.endTransmission(true);
}

float readMPU6050TotalG() {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x3B);
  if (Wire.endTransmission(false) != 0) return 1.0;

  if (Wire.requestFrom((uint8_t)MPU_ADDR, (uint8_t)6, (uint8_t)true) == 6) {
    int16_t rawX = (Wire.read() << 8) | Wire.read();
    int16_t rawY = (Wire.read() << 8) | Wire.read();
    int16_t rawZ = (Wire.read() << 8) | Wire.read();

    float ax = rawX / 16384.0;
    float ay = rawY / 16384.0;
    float az = rawZ / 16384.0;
    return sqrt(ax * ax + ay * ay + az * az);
  }
  return 1.0;
}

// -----------------------------------------------------------------------------
// Arduino Setup
// -----------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(1500);

  Serial.println("\n==========================================================");
  Serial.println("  SHIRO Wristband Tag: Biometric & Kinematic Telemetry (V2)");
  Serial.println("==========================================================");

  // 1. Initialize Hardware I2C (100 kHz Standard Speed)
  Wire.begin(I2C_SDA, I2C_SCL);
  Wire.setClock(100000);

  // 2. Initialize MPU-6050
  wakeMPU6050();
  Serial.println("[OK] MPU-6050 Initialized.");

  // 3. Initialize HW-605 (MAX30102)
  if (particleSensor.begin(Wire, I2C_SPEED_STANDARD)) {
    // Standard clinical pulse oximetry setup:
    // powerLevel: 0x24 (~7.2mA), sampleAverage: 4, ledMode: 2 (Red + IR),
    // sampleRate: 400 (effective 100 Hz), pulseWidth: 411, adcRange: 4096
    particleSensor.setup(0x24, 4, 2, 400, 411, 4096);
    particleSensor.setPulseAmplitudeRed(0x24);
    particleSensor.setPulseAmplitudeGreen(0);
    maxReady = true;
    Serial.println("[OK] HW-605 (MAX30102) Initialized.");
  } else {
    Serial.println("[FAIL] HW-605 not responding.");
  }

  // Re-affirm I2C pins for ESP32-C6
  Wire.begin(I2C_SDA, I2C_SCL);
  Wire.setClock(100000);

  // 4. Initialize BLE Stack
  BLEDevice::init("SHIRO-WRISTBAND");
  BLEDevice::setMTU(128); // Ensure adequate buffer for JSON payload

  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new MyServerCallbacks());

  BLEService* pService = pServer->createService(SERVICE_UUID);
  pCharacteristic = pService->createCharacteristic(
                      CHARACTERISTIC_UUID,
                      BLECharacteristic::PROPERTY_READ |
                      BLECharacteristic::PROPERTY_NOTIFY
                    );
  pCharacteristic->addDescriptor(new BLE2902());
  pService->start();

  BLEAdvertising* pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->setScanResponse(true);
  pAdvertising->setMinPreferred(0x06); // 7.5 ms minimum connection interval
  pAdvertising->setMaxPreferred(0x12); // 22.5 ms maximum connection interval
  BLEDevice::startAdvertising();

  Serial.println("[OK] BLE Advertising started ('SHIRO-WRISTBAND').");
  Serial.println(">>> Ready! Waiting for Gateway to connect... <<<\n");
}

// -----------------------------------------------------------------------------
// Arduino Main Loop
// -----------------------------------------------------------------------------
void loop() {
  if (maxReady) {
    // 1. Non-Blocking I2C FIFO Polling
    particleSensor.check();

    while (particleSensor.available()) {
      uint32_t irVal  = particleSensor.getFIFOIR();
      uint32_t redVal = particleSensor.getFIFORed();
      particleSensor.nextSample(); // Advance to next sample in FIFO

      latestIR  = irVal;
      latestRed = redVal;

      // Contact threshold: IR > 50,000 indicates finger contact
      if (irVal > 50000) {
        touchState = 1;

        // 2. Pulse Peak Detection via heartRate.h
        if (checkForBeat(irVal) == true) {
          long delta = millis() - lastBeat;
          lastBeat = millis();

          float bpm = 60.0 / (delta / 1000.0);
          if (bpm >= 50.0 && bpm <= 180.0) {
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

        // 3. SpO2 AC/DC Tracking
        if (irVal > irMax)   irMax = irVal;
        if (irVal < irMin)   irMin = irVal;
        if (redVal > redMax) redMax = redVal;
        if (redVal < redMin) redMin = redVal;

        spo2SampleCount++;
        // Compute SpO2 every ~100 samples (~1.0 second of clean signal)
        if (spo2SampleCount >= 100) {
          float acIR  = (float)(irMax - irMin);
          float dcIR  = (float)irMin;
          float acRed = (float)(redMax - redMin);
          float dcRed = (float)redMin;

          if (dcIR > 0 && dcRed > 0 && acIR > 0) {
            float R = (acRed / dcRed) / (acIR / dcIR);
            // Maxim standard empirical curve: SpO2 = 110 - 25 * R
            float calculatedSpo2 = 110.0 - (25.0 * R);

            if (calculatedSpo2 >= 85.0 && calculatedSpo2 <= 100.0) {
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

          // Reset optical min/max window
          irMax = 0; irMin = 0xFFFFFF;
          redMax = 0; redMin = 0xFFFFFF;
          spo2SampleCount = 0;
        }
      } else {
        // Finger removed: reset vital tracking state
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

  // 4. Downsampled BLE Telemetry Transmission (Every 200ms = 5 Hz)
  unsigned long now = millis();
  if (now - lastBleTransmitTime >= BLE_TRANSMIT_INTERVAL) {
    lastBleTransmitTime = now;
    currentG = readMPU6050TotalG();

    char payload[160];
    snprintf(payload, sizeof(payload),
             "{\"tag_mac\":\"%s\",\"bpm\":%d,\"spo2\":%d,\"ir\":%ld,\"red\":%ld,\"g\":%.2f,\"touch\":%d}",
             BLEDevice::getAddress().toString().c_str(), beatAvg, spo2Avg, latestIR, latestRed, currentG, touchState);

    if (deviceConnected) {
      pCharacteristic->setValue(payload);
      pCharacteristic->notify();
      Serial.printf("[BLE STREAM] -> %s\n", payload);
    } else {
      Serial.printf("[IDLE MONITOR] -> %s\n", payload);
    }
  }

  // Handle BLE reconnection management
  if (!deviceConnected && oldDeviceConnected) {
    delay(500);
    pServer->startAdvertising();
    Serial.println(">>> Restarted BLE Advertising... <<<");
    oldDeviceConnected = deviceConnected;
  }
  if (deviceConnected && !oldDeviceConnected) {
    oldDeviceConnected = deviceConnected;
  }

  // 5ms yield allows FreeRTOS and BLE radio tasks to process cleanly
  delay(5);
}
