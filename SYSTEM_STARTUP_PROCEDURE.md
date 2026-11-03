# SHIRO: Spatial Health Interface & Real-Time Observer
## Master System Startup Procedure & Hardware/Software Operations Guide

> **Document Version:** 1.0.0  
> **Last Updated:** October 2026  
> **Project:** Final Year Project (RSWG7) - MR-Patient Connect (SHIRO)  
> **Maintainer:** Tan Shou Xian  
> **Note:** This document must be updated whenever new modules, firmware revisions, or hardware components are introduced into the project.

---

## 1. System Architecture & Topology Overview

Before powering on any individual component, ensure you understand the end-to-end data pipeline:

```
[ Tier 1: Patient Wearable ]
  Seeed Studio XIAO ESP32-C6 + HW-605 (MAX30102 PPG) + MPU-6050 IMU
         │
         ├──(BLE 5.0 GATT Notifications @ 5 Hz)──► [ Tier 1.5: Gateway Node ]
         │                                          ESP32-S3-N16R8
         │                                                 │
         │                                                 ├──(Wi-Fi MQTT TCP:1883)──┐
         │                                                                            ▼
         └──(BLE Advertising Beacons @ 10 Hz)────► [ Tier 1.5: Stationary Anchors ]  [ Tier 2: Edge Server ]
                                                   3x ESP32-WROOM-32E (A, B, C)      Asus TUF Laptop
                                                           │                          - Aedes MQTT Broker (Port 1883)
                                                           └──(Wi-Fi MQTT TCP:1883)──►- HTTP/WebSocket Server (Port 3000)
                                                                                      - 1D Extended Kalman Filter (EKF)
                                                                                      - Web Diagnostic Dashboard
                                                                                              │
                                                                                              ├──(WebSocket JSON:3000)──► [ Tier 3: MR Client ]
                                                                                                                          Meta Quest 3 (Unity OpenXR)
```

---

## 2. Pre-Requisite Network & Environment Setup

### 2.1 Wi-Fi Network Requirements
* All wireless nodes (Gateway, Anchors, Laptop Edge Server, and Meta Quest 3) **must be connected to the exact same 2.4 GHz Local Area Network (LAN)**.
* **Network SSID:** `REDACTED_SSID`
* **Network Password:** `REDACTED`
* *Security Note:* Ensure Client Isolation / AP Isolation is **DISABLED** on your Wi-Fi router so devices can communicate directly over local IP sockets.

### 2.2 Finding the Laptop Edge Server IP Address
The ESP32 nodes must know the exact local IP address of your laptop to connect to the MQTT broker.
1. On your Windows laptop, open PowerShell or Command Prompt.
2. Run:
   ```powershell
   ipconfig
   ```
3. Look for **Wireless LAN adapter Wi-Fi** --> **IPv4 Address** (e.g., `192.168.1.229`).
4. If your router assigns a new IP address via DHCP, you must update the `mqtt_server` variable in the Gateway and Anchor firmware.

---

## 3. Tier 2: Starting the MySQL Database, Edge Server & Web Dashboard

Always start MySQL and the Edge Server **FIRST** so the database, MQTT broker, and REST APIs are listening before the hardware nodes attempt to connect.

### 3.1 Software Prerequisites
* **XAMPP** (Installed at `C:\xampp`) with **MySQL** and **Apache** modules.
* **Node.js** (v18.x, v20.x, or v24.x).
* Dependencies installed in `d:\RSW\FYP\Code\edge_server` (`aedes`, `ws`, `mysql2`).

### 3.2 Starting the MySQL Database (XAMPP)
1. Open the Windows Start Menu, search for **XAMPP Control Panel**, and launch it.
2. In the XAMPP Control Panel:
   * Click **Start** on **MySQL** (The indicator turns green on Port `3306`).
   * Click **Start** on **Apache** (Allows viewing the visual database manager at `http://localhost/phpmyadmin`).
3. *(First-time verification)*: In terminal, run `cd d:\RSW\FYP\Code\edge_server; node database/test_db.js` to ensure the `shiro_db` schema and initial seed data are populated.

### 3.3 Starting the Edge Server
1. Open PowerShell or Terminal on your laptop.
2. Navigate to the edge server directory:
   ```powershell
   cd d:\RSW\FYP\Code\edge_server
   ```
3. Start the server daemon:
   ```powershell
   npm start
   ```
   *(Alternatively, run `node server.js`)*
4. Expected Console Output:
   ```text
   [DATABASE] Connecting to MySQL Database...
   [DATABASE] Connected to MySQL server successfully.
   [DATABASE] Verified Ward Configuration schema and seed data in MySQL.

   ======================================================
     SHIRO Edge Server & MQTT Broker Running
   ======================================================
   [MQTT BROKER] Listening on 0.0.0.0:1883
   [WEB DASHBOARD] Accessible at:
     -> Localhost:  http://localhost:3000
     -> Network IP: http://192.168.100.21:3000
     -> MQTT IP for ESP32: "192.168.100.21" (Port: 1883)
   ======================================================
   ```
5. Open your web browser (Chrome / Edge) and navigate to:
   * **Web Admin Portal:** `http://localhost:3000`
   * **phpMyAdmin Visual Database Inspector:** `http://localhost/phpmyadmin` (Select `shiro_db`)
   The dashboard UI provides:
   * **Ward Configuration Tab:** Dynamic room dimensions, ensuite toilet cutouts, door reference, beds, and anchors connected directly to MySQL with instant 2D architectural canvas synchronization.
   * **System Health & Live Lab:** Rolling PPG waveform, RSSI Kalman Filter signal conditioning, and real-time MQTT packet inspection.

---

## 4. Tier 1: Embedded Hardware Setup & Arduino IDE Programming Guide

### 4.1 Arduino IDE Global Environment Configuration
1. Open **Arduino IDE** (v2.x recommended).
2. Open **File --> Preferences**.
3. In **Additional boards manager URLs**, ensure the official Espressif ESP32 package URL is present:
   ```text
   https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
   ```
4. Open **Library Manager** (`Ctrl + Shift + I`) and install:
   * **`SparkFun MAX3010x Sensor Library`** (by SparkFun)
   * **`PubSubClient`** (by Nick O'Leary)

---

### 4.2 Board 1: Wristband Tag (XIAO ESP32-C6)

* **Physical Hardware:** Seeed Studio XIAO ESP32-C6 Microcontroller
* **Sensors Attached:** HW-605 (MAX30102 PPG Optical Sensor) + MPU-6050 (6-DOF IMU)
* **Firmware Location:** `d:\RSW\FYP\Code\firmware\shiro_wristband_vitals\shiro_wristband_vitals.ino`

#### Hardware Wiring Diagram:
| Sensor Pin | XIAO ESP32-C6 Pin | Wire Color Recommendation | Function |
| :--- | :--- | :--- | :--- |
| **VCC / VIN** | **3.3V** | Red | 3.3V Regulated Power |
| **GND** | **GND** | Black | Ground |
| **SDA** | **D4** (GPIO 21) | Blue / Green | I2C Data Line |
| **SCL** | **D5** (GPIO 22) | Yellow / White | I2C Clock Line |

*Both sensors share the same I2C bus lines (SDA to D4, SCL to D5).*

#### Arduino IDE Settings:
1. Connect XIAO ESP32-C6 to laptop via USB-C cable.
2. Select **Tools --> Board --> esp32 --> "XIAO_ESP32C6"**.
3. Select **Tools --> Port -->** (Choose the COM port for the XIAO).
4. Select **Tools --> Upload Speed --> "921600"**.
5. Click **Upload** (`Ctrl + U`).

#### Verification in Serial Monitor (115200 baud):
```text
==========================================================
  SHIRO Wristband Tag: Biometric & Kinematic Telemetry (V2)
==========================================================
[OK] MPU-6050 Initialized.
[OK] HW-605 (MAX30102) Initialized.
[OK] BLE Advertising started ('SHIRO-WRISTBAND').
>>> Ready! Waiting for Gateway to connect... <<<

[IDLE MONITOR] -> {"bpm":0,"spo2":0,"ir":850,"red":910,"g":0.99,"touch":0}
```
*Note: You can now unplug the wristband from the laptop and power it from any portable 3.7V LiPo battery or USB power bank.*

---

### 4.3 Board 2: Edge Node Gateway (ESP32-S3-N16R8)

* **Physical Hardware:** ESP32-S3-N16R8 Dev Module
* **Role:** Transparent BLE-to-MQTT bridge. Subscribes to wristband BLE notifications and forwards packets to the laptop MQTT broker over Wi-Fi.
* **Firmware Location:** `d:\RSW\FYP\Code\firmware\shiro_gateway_node\shiro_gateway_node.ino`

#### Configuration Check in Code:
Open `shiro_gateway_node.ino` and verify:
```cpp
const char* ssid        = "REDACTED_SSID";
const char* password    = "REDACTED";
const char* mqtt_server = "192.168.1.229"; // Your laptop IP
const int   mqtt_port   = 1883;
```

#### Arduino IDE Settings:
1. Connect ESP32-S3 to laptop via USB-C cable (ensure you plug into the `USB` port, not COM-only if dual-port).
2. Select **Tools --> Board --> esp32 --> "ESP32S3 Dev Module"**.
3. Select **Tools --> Flash Size --> "16MB (128Mb)"**.
4. Select **Tools --> PSRAM --> "OPI PSRAM"**.
5. Select **Tools --> USB CDC On Boot --> "Enabled"**.
6. Select **Tools --> Port -->** (Choose the COM port for the ESP32-S3).
7. Click **Upload** (`Ctrl + U`).

#### Verification in Serial Monitor (115200 baud):
```text
Connecting to Wi-Fi: REDACTED_SSID .....
[OK] Wi-Fi Connected!
Gateway IP Address: 192.168.1.137
Starting BLE Scanner for 'SHIRO-WRISTBAND'...
.
[FOUND] SHIRO-WRISTBAND detected!
>>> [GATEWAY] Connected to Wristband via BLE! <<<
[OK] Subscribed to Wristband notifications!
[BLE IN] {"bpm":78,"spo2":98,"ir":125000,"red":112000,"g":0.99,"touch":1} -> [MQTT PUBLISHED OK]
```

---

### 4.4 Board 3, 4, 5: Stationary Anchor Nodes (ESP32-WROOM-32E)

* **Physical Hardware:** ESP32-WROOM-32E Development Boards (3 units for full 2D localization)
* **Role:** Continuous BLE RSSI scanners. Measures raw signal attenuation from the wristband and streams RSSI vectors to the Edge Server over Wi-Fi/MQTT.
* **Firmware Location:** `d:\RSW\FYP\Code\firmware\shiro_anchor_node\shiro_anchor_node.ino`

#### Setting Anchor Identity:
Open `shiro_anchor_node.ino` before uploading to each respective board:
* **For Anchor A:** Set line 21: `#define ANCHOR_ID "anchor-A"`
* **For Anchor B:** Set line 21: `#define ANCHOR_ID "anchor-B"`
* **For Anchor C:** Set line 21: `#define ANCHOR_ID "anchor-C"`

#### CRITICAL Arduino IDE Settings:
> [!IMPORTANT]
> Because the anchor firmware compiles both the full Bluetooth stack and the Wi-Fi/MQTT stack, the compiled binary is ~1.63 MB. The default ESP32 flash partition is only 1.3 MB, which will cause a fatal compiler error: `text section exceeds available space in board`. You **MUST** change the partition scheme as shown below:

1. Connect ESP32-WROOM-32E to laptop via USB cable.
2. Select **Tools --> Board --> esp32 --> "ESP32 Dev Module"**.
3. Select **Tools --> Partition Scheme --> "Huge APP (3MB No OTA/1MB SPIFFS)"**.
4. Select **Tools --> Upload Speed --> "921600"** (or 115200 if cable is long).
5. Select **Tools --> Port -->**  
   *Caution: Do NOT select COM3 through COM9 (these are Windows virtual Bluetooth links). Select the physical USB serial port (e.g., `COM10` or higher).*
6. Click **Upload** (`Ctrl + U`).  
   *(If the IDE displays `Connecting........_____.....`, press and hold the physical **BOOT** button on the ESP32 board for 1 second until the upload percentage starts).*

#### Verification in Serial Monitor (115200 baud):
```text
==========================================================
  SHIRO Anchor Node: anchor-A (ESP32-WROOM-32E)
==========================================================
Connecting to Wi-Fi: REDACTED_SSID ...
[OK] Wi-Fi Connected!
Anchor IP Address: 192.168.1.145
[anchor-A] Connecting to MQTT Broker on 192.168.1.229... [OK] Connected to MQTT Broker!
[OK] Anchor Node 'anchor-A' ready! Scanning for 'SHIRO-WRISTBAND'...

[anchor-A STREAM] -> {"anchor":"anchor-A","rssi":-61,"ts":14250} (Topic: shiro/ward-A1/anchor/anchor-A)
```

---

## 5. Anchor Power Supply Deployment Plan (Central 12V DC Bus)

For deploying anchors across a room without running multiple wall plugs:

### 5.1 Power Architecture:
* **Central Source:** 12V 2A DC Wall Adapter.
* **Bus Distribution:** 2-core thin wire (22/24 AWG) routed along room perimeter walls.
* **Local Regulation:** Mini-360 or LM2596 step-down buck converter at each anchor node, calibrated to **5.0V output**.
* **Board Connection:** Connect the buck converter's `5.0V` output to the **`5V` (or `V5`)** pin on the ESP32-WROOM-32E, and ground to **`GND`**.

### 5.2 Mandatory Calibration Rule Before Connecting Boards:
1. Turn on the 12V central power supply.
2. Use a digital multimeter to measure output voltage across `OUT+` and `OUT-` on each buck converter.
3. Turn the brass adjustment screw until the multimeter reads **exactly 5.0V**.
4. Only connect the ESP32 board **after** verifying the 5.0V reading to avoid overvoltage damage.

---

## 6. End-to-End Operational Checklist (Daily Startup Routine)

Follow this numbered sequence every time you demonstrate or test the system:

```
[Step 1: Network]
  Ensure laptop is connected to Wi-Fi: 'REDACTED_SSID'
  Confirm laptop IP: ipconfig (verify it matches firmware mqtt_server)

[Step 2: Server]
  Open PowerShell -> cd d:\RSW\FYP\Code\edge_server -> npm start
  Open browser -> http://localhost:3000

[Step 3: Wearable Wristband]
  Power on Seeed Studio XIAO ESP32-C6 (Power bank or USB).
  Place finger firmly on the HW-605 sensor.

[Step 4: Gateway Node]
  Power on ESP32-S3 Gateway.
  Observe the Web Dashboard: 'Packets Received' begins incrementing at 5 Hz (200 ms).
  Confirm Heart Rate and SpO2 readings change from 'Reading...' to live numbers.

[Step 5: Anchor Nodes]
  Power on Anchor A (and Anchors B, C).
  Observe the Web Dashboard: Anchor RSSI table populates with raw and EKF filtered dBm values.
  Move the wristband closer to / farther from Anchor A: verify distance curve responds live.

[Step 6: Spatial Mixed Reality (Future Increment)]
  Launch SHIRO Unity app on Meta Quest 3.
  Pinch to lock room origin spatial anchor at the entrance door frame.
  Verify 2D Ward Mini-Map and bedside holographic cards render in passthrough.
```

---

## 7. Troubleshooting & Recovery Matrix

| Symptom / Error | Root Cause | Immediate Resolution |
| :--- | :--- | :--- |
| `rc=-4` or `rc=-2` in Gateway / Anchor Serial Monitor | Board cannot reach the Laptop MQTT broker. | 1. Ensure laptop firewall allows port 1883 incoming.<br>2. Check laptop IP via `ipconfig` and ensure `mqtt_server` in `.ino` matches.<br>3. Verify `npm start` is actively running. |
| `Compilation error: text section exceeds available space in board` on ESP32 | ESP32 flash partition table is at default 1.3 MB. | In Arduino IDE: **Tools --> Partition Scheme --> "Huge APP (3MB No OTA/1MB SPIFFS)"**. |
| `A serial exception error occurred: Write timeout` during upload | Selected port is a Windows virtual Bluetooth link (COM3-COM9). | In Device Manager, check Ports (COM & LPT). Select the physical USB serial port (e.g., `COM10`, CH340, or CP210x). |
| Web dashboard shows `Interval: 2000 ms` instead of `200 ms` | BLE background scan is congesting the 2.4 GHz radio. | Ensure the Gateway is running `shiro_gateway_node.ino` (which stops scanning upon connection) and wristband is running V2 non-blocking FIFO code. |
| Heart rate reads 0 or stays on `Reading...` | Finger placement is too loose or sensor FIFO is saturated. | Rest finger gently but firmly over the optical lens of the HW-605. Ensure IR readings exceed 50,000 in Serial Monitor / Dashboard. |
