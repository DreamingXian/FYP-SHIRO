# SHIRO: Spatial Health Interface & Real-Time Observer
## Master System Startup Procedure & Hardware/Software Operations Guide

> **Document Version:** 2.0.0  
> **Last Updated:** November 2026  
> **Project:** Final Year Project (RSWG7) - MR-Patient Connect (SHIRO)  
> **Maintainer:** Tan Shou Xian  
> **Repository:** https://github.com/DreamingXian/FYP-SHIRO.git  

---

## 1. System Architecture & Topology Overview

SHIRO is an end-to-end edge-computed clinical IoT telemetry and Mixed Reality platform. All data flows across three integrated tiers:

```
[ Tier 1: Patient Wearable ]
  Seeed Studio XIAO ESP32-C6 + HW-605 (MAX30102 PPG) + MPU-6050 (6-DOF IMU)
         │
         ├──(BLE 5.0 GATT Notifications @ 5 Hz)──► [ Tier 1.5: Gateway Node ]
         │                                          ESP32-S3-N16R8 (USB CDC)
         │                                                 │
         │                                                 ├──(Wi-Fi MQTT TCP:1883)──┐
         │                                                                            ▼
         └──(BLE Advertising Beacons @ 10 Hz)────► [ Tier 1.5: Stationary Anchors ]  [ Tier 2: Edge Server ]
                                                   3x ESP32-WROOM-32E (A, B, C)      Host PC / Laptop
                                                           │                          - Aedes MQTT Broker (:1883)
                                                           └──(Wi-Fi MQTT TCP:1883)──►- HTTP REST Server (:3000)
                                                                                      - WebSocket Server (:3000)
                                                                                      - 1D Extended Kalman Filter (EKF)
                                                                                      - Multi-Anchor Trilateration Engine
                                                                                      - MySQL Database (XAMPP :3306)
                                                                                      - InfluxDB Time-Series Engine
                                                                                      - Web Management Dashboard
                                                                                              │
                                                                                              ├──(WebSocket JSON:3000)──► [ Tier 3: MR Client ]
                                                                                                                          Meta Quest 3 (Unity 6 OpenXR)
                                                                                                                          - Passthrough Digital Twin
                                                                                                                          - Patient In-Situ Hologram
                                                                                                                          - Bed Headboard / Bedside Dock
                                                                                                                          - 2-Point Spatial Alignment
                                                                                                                          - Wrist Radar Hand Slate HUD
```

---

## 2. Pre-Requisite Network & Environment Setup

### 2.1 Wi-Fi Network Requirements
* All wireless nodes (Gateway, Anchors, Laptop Edge Server, and Meta Quest 3) **must be connected to the exact same 2.4 GHz Local Area Network (LAN)** or laptop Wi-Fi hotspot.
* **Network SSID:** `REDACTED_SSID`
* **Network Password:** `REDACTED`
* *Security Note:* Ensure Client Isolation / AP Isolation is **DISABLED** on your Wi-Fi router so devices can communicate directly over local IP sockets.

### 2.2 Finding the Laptop Edge Server IP Address
The ESP32 nodes and Meta Quest 3 must know the exact local IP address of your laptop to connect to the MQTT broker and WebSocket server.
1. On your Windows laptop, open PowerShell or Command Prompt.
2. Run:
   ```powershell
   ipconfig
   ```
3. Look for **Wireless LAN adapter Wi-Fi** --> **IPv4 Address** (e.g., `192.168.1.229`).
4. If your router assigns a new IP address via DHCP, you must update:
   - `mqtt_server` in `firmware/shiro_gateway_node/shiro_gateway_node.ino`
   - `mqtt_server` in `firmware/shiro_anchor_node/shiro_anchor_node.ino`
   - `serverIp` in Unity Inspector (`ShiroMRManager`) or via the Quest 3 Hand Slate Connection menu.

---

## 3. Tier 2: Starting the Database, Edge Server & Web Dashboard

Always start MySQL and the Edge Server **FIRST** so the database, MQTT broker, and REST APIs are listening before the hardware nodes or Quest 3 attempt to connect.

### 3.1 Software Prerequisites
* **XAMPP** (Installed at `C:\xampp`) with **MySQL** and **Apache** modules.
* **Node.js** (v18.x, v20.x, or v24.x).
* Dependencies installed in `edge_server/` (`aedes`, `ws`, `mysql2`, `express`, `cors`).

### 3.2 Starting the MySQL Database (XAMPP)
1. Open the Windows Start Menu, search for **XAMPP Control Panel**, and launch it.
2. In the XAMPP Control Panel:
   * Click **Start** on **MySQL** (Indicator turns green on Port `3306`).
   * Click **Start** on **Apache** (Allows viewing the visual database manager at `http://localhost/phpmyadmin`).
3. *(First-time verification)*: In terminal, run:
   ```powershell
   cd d:\RSW\FYP\Code\edge_server
   node database/test_db.js
   ```
   Ensures the `shiro_db` schema, ward definitions, benchmark patients, and hardware device registries are verified.

### 3.3 Starting the Edge Server
1. Open PowerShell or Terminal on your laptop:
   ```powershell
   cd d:\RSW\FYP\Code\edge_server
   npm start
   ```
   *(Alternatively: `node server.js`)*
2. Expected Console Output:
   ```text
   ======================================================
     SHIRO Edge Server & Clinical IoT Gateway (Booting...)
   ======================================================
   [DATABASE] Connected to MySQL server successfully.
   [DATABASE] Verified Ward Configuration schema and seed data in MySQL.
   [DATABASE] Verified Inpatient Registry schema and benchmark patients in MySQL.
   [DATABASE] Verified Hardware Device Registry schema and benchmark fleet in MySQL.
   [DATABASE] Verified Emergency Incident Audit Log schema in MySQL.
   [IPS ENGINE] Cached assigned anchors across wards.
   [MQTT BROKER] Listening on 0.0.0.0:1883
   ======================================================
     SHIRO Clinical Dashboard & Gateway Ready
   ======================================================
   [HTTP DASHBOARD] Accessible at:
     -> Localhost:  http://localhost:3000
     -> Network IP: http://192.168.1.229:3000
   [MQTT BROKER]  tcp://192.168.1.229:1883 (ESP32 Gateway)
   [WEBSOCKET]    ws://192.168.1.229:3000 (Web & Quest 3 HMD)
   ======================================================
   ```

3. Open your web browser (Chrome / Edge) and navigate to `http://localhost:3000`:
   * **Ward Configuration Editor:** Architectural room dimensioning, obstacle cutouts, rotatable beds ($0^\circ, 90^\circ, 180^\circ, 270^\circ$), and 3D ray-cast anchor suggestion.
   * **Live Ward Map:** 2D real-time bird's-eye canvas with 45cm scaled human dot, motion trajectory, bed docking detection, and 1-click landmark empirical calibration ($A$ and $n$ parameter tuning).
   * **Device Provisioning Radar:** Zero-configuration spectrum discovery for Seeed Studio XIAO and ESP32 nodes with 1-click enrollment.
   * **Patient Admissions Directory:** Electronic health record (EHR) profiles, fall risk scores, bed allocation, and wristband tag binding.
   * **Live Telemetry & Diagnostics Lab:** Rolling 5 Hz PPG absorption waveform, heart rate, SpO2 %, and dual-channel RSSI Kalman filter comparison.

---

## 4. Tier 1: Embedded Hardware Setup & Arduino IDE Programming Guide

### 4.1 Arduino IDE Global Environment Configuration
1. Open **Arduino IDE** (v2.x recommended).
2. Go to **File --> Preferences**.
3. In **Additional boards manager URLs**, ensure the official Espressif ESP32 package URL is present:
   ```text
   https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
   ```
4. Open **Library Manager** (`Ctrl + Shift + I`) and install:
   * **`SparkFun MAX3010x Sensor Library`** (by SparkFun)
   * **`PubSubClient`** (by Nick O'Leary)

---

### 4.2 Board 1: Wristband Tag (Seeed Studio XIAO ESP32-C6)

* **Physical Hardware:** Seeed Studio XIAO ESP32-C6 Microcontroller
* **Sensors Attached:** HW-605 (MAX30102 PPG Optical Sensor) + MPU-6050 (6-DOF IMU)
* **Firmware Location:** `firmware/shiro_wristband_vitals/shiro_wristband_vitals.ino`

#### Hardware Wiring Diagram:
| Sensor Pin | XIAO ESP32-C6 Pin | Function |
| :--- | :--- | :--- |
| **VCC / VIN** | **3.3V** | 3.3V Regulated Power |
| **GND** | **GND** | Ground |
| **SDA** | **D4** (GPIO 21) | I2C Data Line |
| **SCL** | **D5** (GPIO 22) | I2C Clock Line |

*Both sensors share the same hardware I2C bus lines.*

#### Arduino IDE Settings:
1. Connect XIAO ESP32-C6 via USB-C cable.
2. Select **Tools --> Board --> esp32 --> "XIAO_ESP32C6"**.
3. Select **Tools --> Port** (COM port for XIAO).
4. Select **Tools --> Upload Speed --> "921600"**.
5. Click **Upload** (`Ctrl + U`).

---

### 4.3 Board 2: Edge Node Gateway (ESP32-S3-N16R8)

* **Physical Hardware:** ESP32-S3-N16R8 Dev Module
* **Role:** Transparent BLE-to-MQTT bridge. Subscribes to wristband BLE GATT notifications at 5 Hz and forwards packets to the laptop MQTT broker over Wi-Fi.
* **Firmware Location:** `firmware/shiro_gateway_node/shiro_gateway_node.ino`

#### Configuration Check:
Open `shiro_gateway_node.ino` and verify:
```cpp
const char* ssid        = "REDACTED_SSID";
const char* password    = "REDACTED";
const char* mqtt_server = "192.168.1.229"; // Your laptop IP
const int   mqtt_port   = 1883;
```

#### Arduino IDE Settings:
1. Connect ESP32-S3 via USB-C (ensure you connect to the `USB` port).
2. Select **Tools --> Board --> esp32 --> "ESP32S3 Dev Module"**.
3. Select **Tools --> Flash Size --> "16MB (128Mb)"**.
4. Select **Tools --> PSRAM --> "OPI PSRAM"**.
5. Select **Tools --> USB CDC On Boot --> "Enabled"**.
6. Select **Tools --> Port** (COM port for ESP32-S3).
7. Click **Upload** (`Ctrl + U`).

---

### 4.4 Boards 3, 4, 5: Stationary Anchor Nodes (ESP32-WROOM-32E)

* **Physical Hardware:** ESP32-WROOM-32E Development Boards (3+ units for 2D trilateration)
* **Role:** Continuous BLE RSSI scanners. Measures raw signal attenuation from the wristband and streams RSSI vectors to the Edge Server over Wi-Fi/MQTT.
* **Firmware Location:** `firmware/shiro_anchor_node/shiro_anchor_node.ino`

#### Setting Anchor Identity:
Open `shiro_anchor_node.ino` before uploading to each respective board:
* **Anchor A:** `#define ANCHOR_ID "anchor-A"`
* **Anchor B:** `#define ANCHOR_ID "anchor-B"`
* **Anchor C:** `#define ANCHOR_ID "anchor-C"`

#### Mandatory Partition Scheme Setting:
> [!IMPORTANT]
> The anchor firmware compiles both Bluetooth and Wi-Fi/MQTT stacks (~1.63 MB binary). The default partition (1.3 MB) will trigger a compiler error. You **MUST** change the partition scheme:

1. Select **Tools --> Board --> esp32 --> "ESP32 Dev Module"**.
2. Select **Tools --> Partition Scheme --> "Huge APP (3MB No OTA/1MB SPIFFS)"**.
3. Select **Tools --> Upload Speed --> "921600"**.
4. Select **Tools --> Port** (physical USB serial port, e.g., `COM10+`).
5. Click **Upload** (`Ctrl + U`). *(If `Connecting........_____`, press and hold the physical **BOOT** button for 1 second).*

---

## 5. Tier 3: Meta Quest 3 Mixed Reality (MR) Spatial Client

The Quest 3 client delivers the spatial hospital digital twin, in-situ floating vitals HUD, and room calibration tools directly overlaid in color Passthrough.

### 5.1 Project Location & Dependencies
* **Project Folder:** `quest3_client/` (or `D:\RSW\FYP\VR\Shiro_Quest3_MR`)
* **Engine Version:** Unity 6 (`6000.3.28f1`) Universal Render Pipeline (URP)
* **Key Packages:** Meta XR Core SDK, Meta XR Building Blocks, `NativeWebSocket`, Unity New Input System.

### 5.2 Opening & Configuring the Project
1. Open **Unity Hub** and click **Add** -> Select `quest3_client/` (or `D:\RSW\FYP\VR\Shiro_Quest3_MR`).
2. Open the project with Unity `6000.3.28f1`.
3. In the Project window, open `Assets/Scenes/MainMRScene.unity`.
4. Inspect the `[SHIRO_MR_ROOT]` GameObject in the Hierarchy:
   * **Server IP:** Set to your laptop IP (e.g., `192.168.1.229`).
   * **Server Port:** `3000`.
   * **Target Ward ID:** `WARD-005` (or your active ward code).
   * **Auto Connect on Start:** Enabled.

### 5.3 Running the Client (Two Methods)

#### Method A: Instant Play via Meta Quest Link / Air Link (Fastest for Testing)
1. Power on Meta Quest 3 and connect to your PC via USB-C cable or 5 GHz Wi-Fi (Air Link).
2. Open the **Meta Quest Link** desktop app on your PC.
3. Put on the Quest 3, open Quick Settings, and launch **Quest Link**.
4. Once inside the PC VR environment, look at your monitor and click **`▶ Play`** in the Unity Editor.
5. Put the headset back on: You are now in color Passthrough with the live SHIRO MR system running!

#### Method B: Wireless Standalone Deployment (Untethered APK)
1. In Unity, go to **File --> Build Settings**.
2. Select **Platform: Android** -> **Run Device: Meta Quest 3**.
3. Click **Build and Run** to install `Shiro_MR.apk` wirelessly.

---

### 5.4 Spatial Room Calibration Procedure

To align the digital twin ward with your physical room:

```
[ Step 1: Launch Tool ]
  Turn your left palm up to open the Hand Slate HUD.
  Click [🎯 Room Calibration] to enter Calibration Mode.
  The laser pointer activates with hardware depth sensor raycasting.

[ Step 2: Door Frame Calibration (Recommended) ]
  Point the laser reticle at the Bottom-Left corner of your physical door frame.
  Pinch index finger & thumb (or pull index trigger) -> Point 1 locks at the physical floor.
  Point the laser reticle at the Bottom-Right corner of the door frame.
  Pinch to lock Point 2.
  Result: The 3D room boundaries, walls, and beds instantly snap into alignment!

[ Step 3: Bed 2-Point Alignment (Alternative) ]
  Select "Bed Two Points" mode on the Hand Slate.
  Point at the Headboard center -> Point at the Footboard center.
  Result: Ward snaps directly using the physical bed as the spatial baseline.

[ Step 4: Physical Floor Height Snapping ]
  Calibration depth raycasting automatically queries Meta.XR.EnvironmentRaycastManager.
  Points lock to true measured physical floor Y (immune to virtual geometry occlusion).
```

---

### 5.5 In-Situ Patient Hologram & Bed Docking Controls

When the patient wearing the wristband is detected by the IPS engine:
1. **In-Transit Walking Mode:**
   - A $0.65\text{m}$ emerald green/cyan uncertainty footprint ring appears on the physical floor.
   - A glassmorphic vitals HUD panel floats $+1.35\text{m}$ at eye level, smoothly billboarding to face the doctor as they move around the room.
   - Displays live Heart Rate (pulsating ECG rhythm), Blood Oxygen %, Fall Risk score, and IMU motion state.
2. **Bed-Docked Mode:**
   - When the patient enters their assigned bed area, the panel automatically transitions to **Bed-Docked** state.
   - Locks statically to the bed headwall or bedside cart with zero jitter.
   - Aligns outward along the bed's rotation ($0^\circ, 90^\circ, 180^\circ, 270^\circ$) facing into the room toward the foot of the bed (non-mirrored, readable text).
3. **Manual [✥ Move] Handle & [🔓 Unfix] Controls:**
   - Top-left corner of the vitals panel features a **`[✥ Move]`** handle.
   - Aim the laser pointer at the handle, pinch and hold to drag the panel vertically and horizontally.
   - Extend or pull back your left hand to adjust distance (closer or farther).
   - Release pinch: The panel locks permanently at your chosen location (`📌 PANEL LOCKED`).
   - Click the adjacent **`[🔓 Unfix]`** button to release manual lock and resume automatic IPS/Bed following.

---

### 5.6 Wrist Hand Slate HUD

Look at your left palm/wrist to summon the 4-tab clinical slate:
* **Tab 1: IPS Ward Radar & Mini-Map:** Top-down architectural floorplan showing room boundaries, beds, anchors, doctor position (green compass blip), and patient position (cyan dot).
* **Tab 2: Room Calibration:** Switch between Door Frame, Bed 2-Point, and Wall Anchor alignment modes.
* **Tab 3: Hardware Fleet:** Real-time health, RSSI, and battery status of all assigned nodes.
* **Tab 4: Settings & Connection:** Reconnect to Edge Server, switch network IP presets (Wi-Fi `.1.229`, Hotspot `.137.1`, or Localhost).

---

## 6. End-to-End Daily Startup Routine

Follow this numbered checklist for demonstrations, laboratory testing, and clinical trials:

```
[Step 1: Network Check]
  Ensure host laptop is on Wi-Fi 'REDACTED_SSID' (or Hotspot).
  Run 'ipconfig' and note your IPv4 address (e.g. 192.168.1.229).

[Step 2: Start MySQL & Edge Server]
  Open XAMPP -> Start MySQL (Port 3306).
  Open Terminal -> cd d:\RSW\FYP\Code\edge_server -> npm start
  Verify console outputs: [HTTP DASHBOARD], [MQTT BROKER], [WEBSOCKET] Ready.

[Step 3: Power On Hardware Nodes]
  Power Seeed Studio XIAO ESP32-C6 (Wristband) -> Place finger on sensor.
  Power ESP32-S3 (Gateway) -> Confirm Web Dashboard begins receiving packets at 5 Hz.
  Power ESP32-WROOM-32E (Anchors A, B, C) -> Confirm RSSI populates on Live Map.

[Step 4: Launch Meta Quest 3 MR Client]
  Put on Meta Quest 3 -> Start Quest Link.
  In Unity, hit Play on 'MainMRScene'.
  Observe WebSocket connected message in VR.

[Step 5: Calibrate Room]
  Turn left palm up -> Click [🎯 Room Calibration].
  Aim laser pointer at door frame corners -> Lock Point 1 & Point 2.
  Verify virtual hospital beds overlay the real physical furniture perfectly.
```

---

## 7. Troubleshooting & Recovery Matrix

| Symptom / Error | Root Cause | Immediate Resolution |
| :--- | :--- | :--- |
| `rc=-4` or `rc=-2` in Gateway / Anchor Serial Monitor | Board cannot reach Laptop MQTT broker. | 1. Check laptop IP via `ipconfig` and ensure `mqtt_server` in `.ino` matches.<br>2. Ensure Windows Firewall allows incoming TCP port `1883`.<br>3. Verify `npm start` is running. |
| ESP32 compiler error: `text section exceeds available space in board` | Default 1.3 MB partition table selected. | In Arduino IDE: **Tools --> Partition Scheme --> "Huge APP (3MB No OTA/1MB SPIFFS)"**. |
| Quest 3 shows `WebSocket Connection Error` on startup | Server IP mismatch or Edge Server offline. | 1. Look at left palm -> Click Hand Slate connection tab.<br>2. Click Wi-Fi preset or retype correct laptop IP.<br>3. Ensure Quest 3 is on the same Wi-Fi LAN. |
| Quest 3 disconnects repeatedly with rapid reconnect loop | WebSocket ping/pong timeout or port contention. | Fixed in v2.0: Single persistent connection per headset serial (`QUEST3-001`) with heartbeats. Ensure only one Unity instance is playing. |
| Virtual room overlay appears underground or tilted | Calibration point snapped to virtual floor mesh instead of physical floor. | Fixed in v2.0: Depth raycasting now queries `EnvironmentRaycastManager` to detect true physical floor height before transforming coordinates. |
| Bed vitals panel is mirrored / backwards | Canvas local rotation flipped $180^\circ$ relative to bed anchor. | Fixed in v2.0: `GetBedHeadboardRotation` now matches `wardOrigin.rotation * Quaternion.Euler(0, bed.rotation_deg, 0)`. The Canvas front face ($ local -Z$) points outward down the mattress into the room. |
| Laser pointer blocked by 3D room overlay | Raycast hit testing virtual wall/bed colliders before physical space. | Virtual room geometry colliders are bypassed during calibration mode; raycast queries physical depth sensor mesh directly. |
| Heart rate reads 0 or stays on `Reading...` | Finger placement too loose or sensor FIFO saturated. | Rest finger gently but firmly over the optical lens of the HW-605. Ensure IR readings exceed 50,000 in Serial Monitor / Dashboard. |
