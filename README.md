# SHIRO: Spatial Health Interface & Real-Time Observer

> **MR-Patient Connect (SHIRO)** — Final Year Project (RSWG7)  
> An edge-computed, privacy-preserving clinical IoT telemetry, indoor positioning (IPS), and Mixed Reality (MR) spatial digital twin platform for inpatient healthcare.  
> **Maintainer:** Tan Shou Xian  
> **Repository:** https://github.com/DreamingXian/FYP-SHIRO.git  

---

## 1. Project Overview

**SHIRO** is a hospital-grade healthcare IoT and Spatial Mixed Reality monitoring ecosystem. The system continuously streams physiological signals (photoplethysmography heart rate, blood oxygen saturation, and 6-DOF motion kinematics) from wearable patient wristbands, and tracks real-time 2D/3D indoor positioning across stationary wall anchors using Bluetooth Low Energy (BLE) RSSI, 1D Extended Kalman Filtering (EKF), and non-linear multi-anchor trilateration.

A centralized Edge Server aggregates telemetry through an embedded MQTT broker, stores architectural and clinical records in a MySQL database, streams high-frequency biometrics to InfluxDB, and powers an interactive Single Page Application (SPA) web dashboard.

Wearing a **Meta Quest 3** Mixed Reality headset, clinicians enter a color Passthrough digital twin of the ward. Patient vital signs float at eye level beside the patient, dock seamlessly to hospital bed headboards with zero jitter, and an interactive 2D ward radar HUD appears upon glancing at the wrist.

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                SHIRO SYSTEM ARCHITECTURE                               │
└────────────────────────────────────────────────────────────────────────────────────────┘

 [ Tier 1: Patient Wristband ]
   Seeed Studio XIAO ESP32-C6 + MAX30102 PPG + MPU-6050 (6-DOF IMU)
     │
     ├──(BLE 5.0 GATT Notifications @ 5 Hz)──► [ Tier 1.5: Edge Node Gateway ]
     │                                          ESP32-S3-N16R8 (USB CDC)
     │                                                │
     │                                                ├──(Wi-Fi MQTT TCP:1883)──┐
     │                                                                          ▼
     └──(BLE Advertising Beacons @ 10 Hz)────► [ Tier 1.5: Stationary Anchors ] [ Tier 2: Central Edge Server ]
                                                3x ESP32-WROOM-32E (A, B, C)    Host PC / Laptop
                                                      │                         - Embedded Aedes MQTT Broker (:1883)
                                                      └──(Wi-Fi MQTT TCP:1883)─►- HTTP REST Server (:3000)
                                                                                - WebSocket Server (:3000)
                                                                                - 1D Extended Kalman Filter (EKF)
                                                                                - Multi-Anchor Trilateration Engine
                                                                                - MySQL Database (XAMPP :3306)
                                                                                - InfluxDB Time-Series Engine
                                                                                - Web Operations Dashboard
                                                                                        │
                                                                                        ├──(WebSocket JSON:3000)──► [ Tier 3: MR Client ]
                                                                                                                    Meta Quest 3 (Unity 6 OpenXR)
                                                                                                                    - Color Passthrough Digital Twin
                                                                                                                    - In-Situ Patient Hologram
                                                                                                                    - Bed Docking (Headboard/Bedside)
                                                                                                                    - 2-Point Spatial Alignment
                                                                                                                    - Wrist Radar Hand Slate HUD
```

---

## 2. Hardware & Software Stack

### Hardware Fleet
| Role | Microcontroller / Board | Sensors / Modules | Description |
| :--- | :--- | :--- | :--- |
| **Patient Wristband Tag** | Seeed Studio XIAO ESP32-C6 | HW-605 (MAX30102 PPG) + MPU-6050 (6-DOF IMU) | Wearable node measuring heart rate, SpO2 %, and kinematic G-force vectors. Streams BLE GATT notifications at 5 Hz. |
| **Ward Edge Gateway** | ESP32-S3 (N16R8 Dev Module) | On-board Wi-Fi + BLE 5.0 | Subscribes to wristband BLE notifications and immediately bridges packets to MQTT over Wi-Fi. |
| **Stationary Wall Anchors** | ESP32-WROOM-32E | On-board Wi-Fi + BLE Scanner | Wall-mounted nodes scanning wristband RSSI attenuation for 2D indoor positioning. |
| **Central Edge Server** | Local PC / Laptop | 2.4 GHz Wi-Fi / Ethernet | Hosts MQTT broker, REST API, WebSocket server, trilateration solver, and MySQL database. |
| **Mixed Reality Headset** | Meta Quest 3 | Color Passthrough + Depth Sensor | Spatial client rendering 3D ward digital twins, in-situ patient vitals HUDs, and wrist radar slates. |

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
* **Universal Firmware Architecture:** Device enrollment without hardcoded credentials; dynamically provisioned IDs (`TAG-001`, `anchor-A`, `EDGE-001`).
* **Low-Latency BLE GATT:** 15–30 ms connection intervals preventing radio congestion; Wi-Fi modem sleep disabled (`WiFi.setSleep(false)`) and TCP Nagle bypass (`espClient.setNoDelay(true)`) for zero-jitter packet delivery.
* **Biometric & Kinematic Pipeline:** Non-blocking FIFO reading of MAX30102 PPG optical sensors (BPM and SpO2) and MPU-6050 accelerometer G-force vectors.

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
* **Clinical Emergency Audit Logging:** Dedicated MySQL emergency log schema, alert service, and InfluxDB time-series integration for clinical incidents.

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
Both the HW-605 (MAX30102) and MPU-6050 share the hardware I2C bus:

| Sensor Pin | XIAO ESP32-C6 Pin | Function |
| :--- | :--- | :--- |
| **VCC / VIN** | **3.3V** | Power |
| **GND** | **GND** | Ground |
| **SDA** | **D4** (GPIO 21) | I2C Data |
| **SCL** | **D5** (GPIO 22) | I2C Clock |

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
   * XIAO ESP32-C6 (Wristband) -> Wear on finger/wrist.
   * ESP32-S3 (Gateway) -> Connects via BLE and forwards to MQTT.
   * ESP32-WROOM-32E (Anchors A, B, C) -> Scans RSSI and publishes to MQTT.
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
│   ├── shiro_gateway_node/         # ESP32-S3 BLE-to-MQTT bridge firmware
│   └── shiro_anchor_node/          # ESP32 BLE RSSI scanner firmware
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
