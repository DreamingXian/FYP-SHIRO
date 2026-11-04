# SHIRO: Spatial Health Interface & Real-Time Observer

> **MR-Patient Connect (SHIRO)** — Final Year Project (RSWG7)  
> An edge-computed, privacy-preserving IoT vitals telemetry and indoor positioning system with an interactive web operations dashboard.

---

## 1. Project Overview

**SHIRO** is a healthcare IoT monitoring platform designed for hospital inpatient environments. The system continuously streams physiological signals (photoplethysmography pulse, blood oxygen, and motion kinematics) from wearable patient wristbands, and tracks relative indoor positioning across stationary wall anchors using Bluetooth Low Energy (BLE) RSSI and Extended Kalman Filter (EKF) signal conditioning.

A centralized Edge Server aggregates sensor telemetry through an embedded MQTT broker, stores clinical and architectural data in a MySQL database, and serves a modular Single Page Application (SPA) web dashboard for real-time monitoring, hardware fleet provisioning, and ward configuration.

```
┌────────────────────────────────────────────────────────────────────────┐
│                        SHIRO SYSTEM ARCHITECTURE                       │
└────────────────────────────────────────────────────────────────────────┘

 [ Patient Wristband ]
   Seeed Studio XIAO ESP32-C6 + MAX30102 PPG + MPU-6050 IMU
     │
     ├──(BLE 5.0 GATT Notifications @ 5 Hz)──► [ Edge Node Gateway ]
     │                                          ESP32-S3-N16R8
     │                                                │
     │                                                ├──(Wi-Fi MQTT TCP:1883)──┐
     │                                                                          ▼
     └──(BLE Advertising Beacons @ 10 Hz)───► [ Stationary Wall Anchors ]     [ Central Edge Server ]
                                                ESP32-WROOM-32E (A, B, ...)     Host PC / Laptop
                                                      │                         - Embedded Aedes MQTT Broker (:1883)
                                                      └──(Wi-Fi MQTT TCP:1883)─►- HTTP & WebSocket Server (:3000)
                                                                                - Extended Kalman Filter (EKF)
                                                                                - MySQL Database (XAMPP :3306)
                                                                                - Web Management Dashboard
```

---

## 2. Hardware & Software Stack

### Hardware Components
| Role | Microcontroller / Board | Sensors / Modules | Description |
| :--- | :--- | :--- | :--- |
| **Patient Wristband Tag** | Seeed Studio XIAO ESP32-C6 | HW-605 (MAX30102 PPG) + MPU-6050 (6-DOF IMU) | Wearable node measuring heart rate, SpO2, and kinematic G-force vectors. Streams BLE GATT notifications. |
| **Ward Edge Node Gateway** | ESP32-S3 (N16R8 Dev Module) | On-board Wi-Fi + BLE 5.0 | Connects to the wristband via BLE and immediately bridges telemetry packets to MQTT over Wi-Fi. |
| **Stationary Wall Anchors** | ESP32-WROOM-32E | On-board Wi-Fi + BLE Scanner | Wall-mounted beacons scanning wristband radio attenuation (RSSI) for indoor distance tracking. |
| **Edge Server Host** | Local PC / Laptop | 2.4 GHz Wi-Fi / Ethernet | Hosts the MQTT broker, REST API, WebSocket server, and MySQL database. |

### Software & Technologies
* **Edge Server Runtime:** Node.js (v18+), Express.js
* **MQTT Broker:** Aedes (integrated MQTT broker listening on port `1883`)
* **Real-Time WebSockets:** `ws` package (bi-directional event streaming on port `3000`)
* **Database:** MySQL 8.0+ (managed via XAMPP) with connection pooling (`mysql2`)
* **Frontend Web Dashboard:** Modern Vanilla JavaScript (MVC Client Architecture), CSS3 variables, HTML5 Canvas
* **Signal Conditioning:** 1D Extended Kalman Filter (`kalman_filter.js`) for RF multipath jitter suppression
* **Embedded Firmware:** Arduino C++ / ESP32 Core with `PubSubClient`, `BLEDevice`, and `SparkFun MAX3010x`

---

## 3. What Has Been Completed So Far

* **Universal Firmware Architecture:**
  * All boards run universal sketches without hardcoded IDs. Device identifiers (`TAG-001`, `anchor-001`, `EDGE-001`) are dynamically assigned by the Edge Server during enrollment.
  * Low-latency BLE connection parameter locking (15–30 ms connection intervals) preventing radio stalls.
  * Disabled Wi-Fi modem sleep (`WiFi.setSleep(false)`) and enabled TCP Nagle bypass (`espClient.setNoDelay(true)`) for zero-jitter packet delivery.
* **Live Telemetry & Diagnostics Lab:**
  * Real-time scrolling Photoplethysmography (PPG) absorption waveform at 5 Hz.
  * Live Heart Rate (BPM), Blood Oxygen (SpO2), and kinematic G-Force impact/fall detection.
  * Dual-channel RSSI Kalman filter comparison canvas (Raw Jitter vs. EKF Smoothed State).
  * Real-time MQTT packet inspector logging raw payloads and topics.
* **Zero-Configuration Hardware Discovery Radar:**
  * Automatic RF spectrum scanner detecting broadcasting unprovisioned nodes.
  * One-click hardware enrollment with dynamic sequential ID generation (`anchor-001`, `TAG-001`, etc.).
  * Multi-dimensional fleet filtering toolbar (Online/Offline + Available/In-Use/Unavailable) with live counters.
* **Interactive Ward Configuration Canvas:**
  * 2D architectural ward editor with interactive room dimensioning, door positioning, and ensuite bathroom cutouts.
  * Visual drag-and-drop placement of clinical beds and stationary anchors with MySQL persistence.
* **Patient Inpatient Directory:**
  * Admission management, medical profile tracking, bed allocation, and wearable wristband binding.

---

## 4. Hardware Wiring & Pinout

### Wristband Node (Seeed Studio XIAO ESP32-C6)
Both the HW-605 (MAX30102) and MPU-6050 share the hardware I2C bus:

| Sensor Pin | XIAO ESP32-C6 Pin | Function |
| :--- | :--- | :--- |
| **VCC / VIN** | **3.3V** | Power |
| **GND** | **GND** | Ground |
| **SDA** | **D4** (GPIO 21) | I2C Data |
| **SCL** | **D5** (GPIO 22) | I2C Clock |

---

## 5. Environment Setup & Configuration

### Prerequisites
1. **Node.js** (v18.x or newer): [https://nodejs.org/](https://nodejs.org/)
2. **XAMPP** (with Apache and MySQL): [https://www.apachefriends.org/](https://www.apachefriends.org/)
3. **Arduino IDE** (v2.x): [https://www.arduino.cc/en/software](https://www.arduino.cc/en/software)
   * In **File > Preferences > Additional boards manager URLs**, add:  
     `https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json`
   * In **Library Manager**, install:
     * `PubSubClient` (by Nick O'Leary)
     * `SparkFun MAX3010x Sensor Library` (by SparkFun)

### Wi-Fi & Network Configuration
All physical devices and the host laptop must connect to the **same 2.4 GHz Wi-Fi LAN**.

1. Check your host laptop's local IPv4 address:
   ```powershell
   ipconfig
   ```
   *(e.g., `192.168.1.229`)*

2. Open the firmware files in `firmware/` and update `ssid`, `password`, and `mqtt_server`:
   * [firmware/shiro_gateway_node/shiro_gateway_node.ino](file:///d:/RSW/FYP/Code/firmware/shiro_gateway_node/shiro_gateway_node.ino)
   * [firmware/shiro_anchor_node/shiro_anchor_node.ino](file:///d:/RSW/FYP/Code/firmware/shiro_anchor_node/shiro_anchor_node.ino)

---

## 6. How to Build & Run

### Step 1: Initialize Database (XAMPP MySQL)
1. Open **XAMPP Control Panel** and start **MySQL** and **Apache**.
2. Open your browser and navigate to `http://localhost/phpmyadmin`.
3. Create a database named `shiro_db` (utf8mb4_general_ci).
4. Run the schema migrations in `edge_server/database/` or verify connection with:
   ```powershell
   cd d:\RSW\FYP\Code\edge_server
   node database/test_db.js
   ```

### Step 2: Start the Edge Server
1. In the `edge_server` directory, install Node.js dependencies (first time only):
   ```powershell
   npm install
   ```
2. Launch the Edge Server and MQTT broker:
   ```powershell
   node server.js
   ```
3. The server will output:
   ```text
   [MQTT BROKER] Listening on 0.0.0.0:1883
   [WEB DASHBOARD] Accessible at http://localhost:3000
   ```

### Step 3: Flash Embedded Firmware
Using Arduino IDE:
1. **Wristband:** Select `XIAO_ESP32C6`, COM port, and upload `firmware/shiro_wristband_vitals/shiro_wristband_vitals.ino`.
2. **Edge Node Gateway:** Select `ESP32S3 Dev Module`, COM port, Flash Size `16MB`, PSRAM `OPI PSRAM`, and upload `firmware/shiro_gateway_node/shiro_gateway_node.ino`.
3. **Stationary Anchors:** Select `ESP32 Dev Module`, Partition Scheme **Huge APP (3MB No OTA / 1MB SPIFFS)**, and upload `firmware/shiro_anchor_node/shiro_anchor_node.ino`.

### Step 4: Access Dashboard & Observe Live Streams
1. Open `http://localhost:3000` in Google Chrome or Microsoft Edge.
2. Go to **Device Provisioning & Fleet Radar**:
   * Watch the Discovery Radar detect broadcasting nodes automatically.
   * Click **➕ Enroll Device** to add them to the fleet.
3. Switch to **System Health & Live Lab**:
   * Touch the HW-605 sensor on the wristband: observe real-time PPG pulse waveform, Heart Rate (BPM), and SpO2.
   * Move the wristband relative to anchors: observe filtered RSSI and estimated distances.

---

## 7. Project Structure

```
Code/
├── .gitignore                      # Git exclusion rules
├── README.md                       # Main project documentation
├── SYSTEM_STARTUP_PROCEDURE.md     # Detailed step-by-step physical startup procedure
├── firmware/                       # Embedded Arduino C++ sketches
│   ├── shiro_wristband_vitals/     # XIAO ESP32-C6 PPG + IMU wearable firmware
│   ├── shiro_gateway_node/         # ESP32-S3 BLE-to-MQTT bridge firmware
│   └── shiro_anchor_node/          # ESP32 BLE RSSI trilateration scanner firmware
└── edge_server/                    # Central Node.js edge server & web portal
    ├── server.js                   # Server entrypoint (HTTP, WebSocket, MQTT)
    ├── package.json                # Server dependencies & scripts
    ├── config/                     # Application and calibration configs
    ├── database/                   # MySQL schemas, migrations, and connection pool
    ├── controllers/                # Backend API route controllers
    ├── services/                   # MQTT broker, WebSocket, EKF, and fleet services
    ├── routes/                     # Express REST route handlers
    └── public/                     # Single Page Application frontend (HTML/CSS/JS)
        ├── index.html              # Main dashboard application shell
        ├── css/                    # Modular stylesheet components & theme
        ├── js/                     # MVC client controllers & visual canvas engines
        └── views/                  # Dynamic HTML module templates
```

---

## 8. Upcoming Milestones

* [ ] Meta Quest 3 Mixed Reality spatial interface client (Unity OpenXR).
* [ ] Multi-anchor 2D trilateration positioning solver.
* [ ] Spatial heatmaps and automated geofenced clinical alarms.

