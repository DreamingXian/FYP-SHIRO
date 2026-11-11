# SHIRO: Spatial Health Interface & Real-Time Observer

> **MR-Patient Connect (SHIRO)** — Final Year Project (RSWG7)  
> An edge-computed, privacy-preserving clinical IoT telemetry, indoor positioning (IPS), and Mixed Reality (MR) spatial digital twin platform for inpatient healthcare.  
> **Maintainer:** Tan Shou Xian  
> **Repository:** https://github.com/DreamingXian/FYP-SHIRO.git  

---

## 1. Project Overview

**SHIRO** is a hospital-grade healthcare IoT and Spatial Mixed Reality monitoring ecosystem. The system continuously streams physiological signals (photoplethysmography heart rate, blood oxygen saturation, battery level, and 6-DOF motion kinematics) from wearable patient wristbands, and tracks real-time 2D/3D indoor positioning across stationary wall anchors using Bluetooth Low Energy (BLE) RSSI, 1D Extended Kalman Filtering (EKF), and non-linear multi-anchor trilateration.

### Streamlined Dual-Role Anchor Architecture
In SHIRO's unified architecture, **standalone gateway hardware is eliminated**. The stationary wall anchors serve a dual role:
1. **Multilateration Anchors**: Measuring raw BLE RSSI signal attenuation from wristband broadcasts.
2. **Wireless Vitals Gateways**: Receiving and unpacking the wristband's embedded physiological/kinematic telemetry payload (BPM, SpO2, battery voltage, IMU motion state, and on-chip fall detection events).

Unified packets are published directly over Wi-Fi to the central Edge Server's embedded MQTT broker, where the Indoor Positioning (IPS) engine computes the patient's coordinates and synchronizes clinical state across the web dashboard and Meta Quest 3.

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                SHIRO SYSTEM ARCHITECTURE                               │
└────────────────────────────────────────────────────────────────────────────────────────┘

 [ Tier 1: Patient Wristband ]
   Seeed Studio XIAO ESP32-C6 + MAX30102 PPG + MPU-6050 (6-DOF IMU) + Battery Divider
     │
     └──(BLE 5.0 High-Rate Advertising Beacons @ 5–10 Hz)
         │  [Contains: RSSI Beacons + Embedded Biometric & Kinematic Payload]
         ▼
 [ Tier 1.5: Dual-Role Stationary Wall Anchors (Hybrid Anchor & Gateway) ]
   3x ESP32-WROOM-32E (Universal Firmware - Auto-Provisioned via Edge Server)
     │  - Measures raw RSSI attenuation for 2D/3D multilateration
     │  - Unpacks BPM, SpO2 %, Battery %, G-force, Motion state, and Fall alerts
     │
     └──(Wi-Fi MQTT TCP:1883)──► [ Tier 2: Central Edge Server ]
                                  Host PC / Laptop
                                  - Embedded Aedes MQTT Broker (:1883)
                                  - HTTP REST API Server (:3000)
                                  - WebSocket Real-Time Event Server (:3000)
                                  - 1D Extended Kalman Filter (EKF) Signal Conditioning
                                  - Multi-Anchor Non-Linear Trilateration Engine
                                  - 4-Anchor Quadruplet Combinatorial Solver
                                  - MySQL Relational Database (XAMPP :3306)
                                  - InfluxDB Time-Series Telemetry Engine
                                  - Web Operations Management Dashboard
                                          │
                                          └──(WebSocket JSON:3000)──► [ Tier 3: MR Client ]
                                                                      Meta Quest 3 (Unity 6 OpenXR)
                                                                      - Color Passthrough Digital Twin
                                                                      - In-Situ Walking Patient Hologram
                                                                      - Bed Docking (Headboard/Bedside)
                                                                      - 2-Point Door/Bed Spatial Calibration
                                                                      - Wrist Radar Hand Slate HUD
```

---

## 2. Hardware & Software Stack

### Hardware Fleet
| Role | Microcontroller / Board | Sensors / Modules | Description |
| :--- | :--- | :--- | :--- |
| **Patient Wristband Tag** | Seeed Studio XIAO ESP32-C6 | HW-605 (MAX30102 PPG) + MPU-6050 (6-DOF IMU) + 100k/100k Battery Divider | Wearable node measuring heart rate, SpO2 %, battery %, and 3-phase kinematic fall detection. Broadcasts BLE 5.0 advertising beacons at 5–10 Hz. |
| **Stationary Wall Anchors (Dual-Role Hybrid)** | ESP32-WROOM-32E | On-board Wi-Fi + BLE Scanner | Wall-mounted nodes performing dual duties: measures BLE RSSI signal attenuation and unpacks telemetry payloads, streaming unified packets to MQTT over Wi-Fi. |
| **Central Edge Server** | Local PC / Laptop | 2.4 GHz Wi-Fi / Ethernet | Hosts embedded MQTT broker, REST API, WebSocket server, trilateration solver, MySQL, and InfluxDB. |
| **Mixed Reality Headset** | Meta Quest 3 | Color Passthrough + Depth Sensor | Spatial client rendering 3D ward digital twins, in-situ patient vitals HUDs, and wrist radar slates. |

*(Note: Standalone ESP32-S3 gateway hardware has been retired; its bridging duties are performed directly by the ESP32 wall anchors).*

### Software & Frameworks
* **MR Client Engine:** Unity 6 (`6000.3.28f1`) Universal Render Pipeline (URP), Meta XR Core SDK, OpenXR
* **Edge Server Runtime:** Node.js (v18+), Express.js
* **MQTT Broker:** Aedes (integrated MQTT broker listening on port `1883`)
* **Real-Time Streaming:** `ws` package (bi-directional event streaming on port `3000`)
* **Relational Database:** MySQL 8.0+ (managed via XAMPP) with connection pooling (`mysql2`)
* **Time-Series Database:** InfluxDB 2.x for raw PPG absorption waveforms and motion telemetry
* **Frontend Web Dashboard:** Modern Vanilla JavaScript (MVC Client Architecture), CSS3 variables, HTML5 Canvas
* **Signal Conditioning & IPS:** 1D Extended Kalman Filter (`kalman_filter.js`), Non-linear Least Squares Trilateration, 4-Anchor Combinatorial Solver, 3-State Kinematic IMU Filter
* **Embedded Firmware:** Arduino C++ / ESP32 Core with `PubSubClient`, `BLEDevice`, and `SparkFun MAX3010x`

---

## 3. Completed Modules & Implemented Features

### Tier 1: Embedded IoT & Wearable Biometrics
* **Universal Anchor Firmware (`shiro_anchor_node.ino`):** Identical firmware flashed to all anchor boards without hardcoded IDs. Device identifiers (`anchor-A`, `anchor-B`, `anchor-C`) and calibration parameters are dynamically mapped and provisioned by the Central Edge Server during enrollment.
* **Dual-Role Anchor Pipeline:** Anchors continuously capture BLE manufacturer packets from wristbands, record raw RSSI for IPS multilateration, decode physiological vitals (BPM, SpO2, battery, touch), and publish unified JSON telemetry over Wi-Fi/MQTT (`shiro/ward-A1/anchor/telemetry`).
* **Connectionless Broadcast Telemetry:** Eliminated point-to-point BLE GATT connection bottlenecks. The wristband broadcasts high-rate advertising beacons heard by all anchors in radio range simultaneously.
* **On-Chip Triple-Phase Fall Detection:** Wristband runs an embedded kinematic fall state machine (Freefall $\rightarrow$ Impact $\rightarrow$ Stillness check) on the MPU-6050 before transmitting an immediate `EMERGENCY_FALL` alert.
* **Battery Sensing & Adaptive Power:** 100k/100k voltage divider on pin `D0` with battery percentage calculation and non-blocking optical sensor FIFO sampling.

### Tier 2: Edge Server, IPS Engine & Web Dashboard
* **Advanced Indoor Positioning (IPS) Engine:**
  * 1D Extended Kalman Filter (EKF) on raw RSSI to suppress multipath RF jitter.
  * Multi-anchor least squares trilateration and dedicated 4-anchor quadruplet combinatorial solver.
  * Slant range compensation and floor-height projection.
  * Velocity-gated movement capping (~1.4 m/s) preventing non-physical teleports.
  * 3-state IMU kinematic filter (`STATIONARY`, `MOVING`, `SETTLING`) fusing accelerometer motion with RF tracking.
  * 1-click landmark empirical anchor calibration ($A$ and $n$ parameter tuning with live side-by-side reference map preview and reset-to-defaults).
  * Auto-suggest anchor placement engine with 3D Line-Of-Sight (LOS) raycasting, vertical clearance shadow modeling, and obstacle wall mounting.
* **Interactive Web Management Portal:**
  * **Ward Configuration Editor:** Architectural room dimensioning, ensuite cutouts, rotatable beds ($0^\circ, 90^\circ, 180^\circ, 270^\circ$), and anchor management with MySQL persistence.
  * **2D Live Ward Map:** Scaled 45cm human dot, live motion trajectories, bed docking status, and interactive tag unbinding.
  * **Device Provisioning Radar:** Automatic RF spectrum scanner detecting unprovisioned nodes with 1-click enrollment.
  * **Patient Inpatient Directory:** Full admission lifecycle, fall risk scoring, medical history, bed allocation, and wristband tag binding.
  * **Live Lab & Diagnostics:** Real-time 5 Hz PPG absorption waveform, dual-channel RSSI Kalman filter comparison, and raw MQTT packet inspector.
* **Clinical Emergency Audit Logging:** Dedicated MySQL emergency log schema (`init_emergency_logs.sql`), alert service, and InfluxDB time-series integration for clinical incidents.

### Tier 3: Meta Quest 3 Mixed Reality Spatial Client (`quest3_client/`)
* **Color Passthrough Digital Twin:** Real-time 3D ward generation (`WardVisualizer.cs`) matching real-world architectural dimensions, walls, doors, obstacles, and hospital beds.
* **Dual-Mode Patient In-Situ Hologram (`PatientHologram.cs`):**
  * **In-Transit Walking Mode:** 0.65m luminous floor occupancy ring, floating eye-level vitals panel smoothly billboarding to face the doctor as they move.
  * **Bed-Docked Mode:** Automatically detects when a patient enters their bed area; docks to bed headwall or bedside cart with zero jitter; aligns statically along the bed's rotation facing outward into the room without mirroring.
  * **Interactive Vitals HUD:** Real-time Heart Rate (pulsating ECG rhythm), Blood Oxygen %, Fall Risk score, IMU motion state badge, and dock mode toggle button.
  * **Manual Repositioning Handle:** Top-left `[✥ Move]` handle allows pinching and dragging the panel vertically/horizontally, hand extension distance adjustment, and `[🔓 Unfix]` release button.
* **Spatial Room Alignment Tool (`WardAlignmentTool.cs`, `WardSpatialManager.cs`):**
  * 2-point door frame calibration with physical floor height depth detection via Meta XR Environment Raycast.
  * 2-point bed calibration (`AlignWardByBedTwoPoints`).
  * 2-point wall anchor calibration (`AlignWardByWallAnchors`).
  * Persistent calibration storage via local PlayerPrefs and MySQL synchronization.
* **Wrist/Palm Hand Slate HUD (`ShiroHandSlate.cs`, `ShiroHandVisualizer.cs`):**
  * Hand tracking with contour outline and fingertip direct touch interaction.
  * **Tab 1: IPS Ward Radar & Mini-Map:** Top-down architectural floorplan rendering room boundaries, beds, anchors, doctor position (compass blip), and patient position (cyan dot).
  * **Tab 2: Room Calibration:** Quick toggle for calibration modes.
  * **Tab 3: Hardware Fleet:** Real-time RSSI, battery, and node health.
  * **Tab 4: Settings & Connection:** Reconnect, IP preset switcher (Wi-Fi, Hotspot, Localhost).

---

## 4. Hardware Wiring & Pinout

### Wristband Node (Seeed Studio XIAO ESP32-C6)
The HW-605 (MAX30102) and MPU-6050 share the hardware I2C bus, with battery sensing on analog pin `D0`:

| Sensor Pin / Signal | XIAO ESP32-C6 Pin | Function |
| :--- | :--- | :--- |
| **VCC / VIN** | **3.3V** | Regulated Sensor Power |
| **GND** | **GND** | Ground |
| **SDA** | **D4** (GPIO 21) | I2C Data Line |
| **SCL** | **D5** (GPIO 22) | I2C Clock Line |
| **BAT+ (via 100k/100k divider)** | **D0** (GPIO 0) | Analog Battery Voltage Monitor |

---

## 5. Quick Startup Procedure

Detailed step-by-step instructions are documented in [SYSTEM_STARTUP_PROCEDURE.md](file:///d:/RSW/FYP/Code/SYSTEM_STARTUP_PROCEDURE.md).

1. **Start MySQL Database:** Open XAMPP Control Panel and start MySQL on port `3306`.
2. **Launch Edge Server:**
   ```powershell
   cd d:\RSW\FYP\Code\edge_server
   npm start
   ```
3. **Power On Hardware Nodes:**
   * **Wristband:** Power Seeed Studio XIAO ESP32-C6 -> Place finger on optical sensor.
   * **Anchors (A, B, C):** Power ESP32-WROOM-32E nodes -> They automatically scan wristband broadcasts and publish unified vitals/RSSI to MQTT.
4. **Launch Meta Quest 3 Client:**
   * Open `quest3_client/` in Unity 6.
   * Connect Quest 3 via Quest Link / Air Link and click Play on `MainMRScene.unity`.
   * Look at left palm -> Click `[🎯 Room Calibration]` -> Aim laser at door frame corners -> Ward snaps into physical alignment!

---

## 6. Project Structure

```
Code/
├── .gitignore                      # Git exclusion rules (Node, Unity, firmware)
├── README.md                       # Master project overview & feature guide
├── SYSTEM_STARTUP_PROCEDURE.md     # Step-by-step operations & troubleshooting guide
├── firmware/                       # Embedded Arduino C++ firmware
│   ├── shiro_wristband_vitals/     # XIAO ESP32-C6 PPG + IMU wearable firmware
│   ├── shiro_anchor_node/          # ESP32 dual-role hybrid anchor & vitals gateway
│   └── shiro_gateway_node/         # [Archived / Deprecated standalone gateway sketch]
├── edge_server/                    # Central Node.js edge server & web portal
│   ├── server.js                   # Server entrypoint (HTTP, WebSocket, MQTT)
│   ├── package.json                # Server dependencies & scripts
│   ├── config/                     # Application, network, and calibration configs
│   ├── database/                   # MySQL schemas, migrations, and connection pool
│   ├── controllers/                # Express controllers (Wards, Patients, Devices)
│   ├── services/                   # MQTT, WebSocket, IPS EKF, and Alert services
│   ├── routes/                     # Express REST API routes
│   └── public/                     # Single Page Application frontend (HTML/CSS/JS)
│       ├── index.html              # Main dashboard application shell
│       ├── css/                    # Modular stylesheet components & theme
│       ├── js/                     # MVC client controllers & canvas rendering
│       └── views/                  # Dynamic HTML module templates
└── quest3_client/                  # Unity 6 Meta Quest 3 Mixed Reality Client
    ├── Assets/
    │   ├── Scenes/                 # MainMRScene.unity
    │   ├── Scripts/ShiroMR/        # C# Spatial MR architecture
    │   │   ├── ShiroMRManager.cs       # Master MR orchestrator & lifecycle
    │   │   ├── ShiroNetworkManager.cs  # WebSocket & REST network client
    │   │   ├── WardVisualizer.cs       # 3D digital twin room generator
    │   │   ├── WardSpatialManager.cs   # Coordinate math, bed docking, alignment
    │   │   ├── WardAlignmentTool.cs    # 2-point door & bed calibration laser tool
    │   │   ├── PatientHologram.cs      # Dual-mode in-situ vitals hologram & HUD
    │   │   ├── ShiroHandSlate.cs       # 4-tab wrist radar & controls HUD
    │   │   ├── ShiroHandVisualizer.cs  # Hand outline contour tracking
    │   │   ├── ShiroVRPointer.cs       # Depth raycast laser pointer
    │   │   └── ShiroDataModels.cs      # Telemetry & JSON data contracts
    │   ├── Plugins/                # NativeWebSocket networking library
    │   ├── Resources/              # Runtime UI fonts & default assets
    │   ├── Settings/               # URP rendering pipelines & volume profiles
    │   └── XR/                     # OpenXR & Meta XR runtime configurations
    ├── Packages/                   # Package manifest & lockfiles
    └── ProjectSettings/            # InputSystem, TagManager, QualitySettings
```

---

## 7. Upcoming Milestones & Roadmap

* [ ] **Phase C (MR Emergency Fall Alert & Path Guidance):** High-priority flashing red FOV alert banner with audible chime; 3D emergency strobe beacon over bed; luminous breadcrumb floor path leading clinician to fallen patient.
* [ ] **Phase D (Untethered Standalone Android APK):** Standalone ARM64 Android build pushed directly to Quest 3 for untethered wireless hospital mobility.
* [ ] **Phase E (Empirical Evaluation & Thesis Viva Preparation):**
  * Quantitative localization accuracy benchmarking across 10 physical grid points in `WARD-005`.
  * End-to-end telemetry and tracking latency profiling (target: $< 250\text{ ms}$).
  * Frame rate (90 FPS) and thermal stability verification on Meta Quest 3.
  * Thesis documentation, portfolio updates, and viva examination live demonstration walkthrough video/script.
