# SHIRO: Spatial Health Interface & Real-Time Observer
## Master System Startup Procedure & Hardware/Software Operations Guide

> **Document Version:** 2.2.0  
> **Last Updated:** 16 November 2026  
> **Project:** Final Year Project (RSWG7) - MR-Patient Connect (SHIRO)  
> **Maintainer:** Tan Shou Xian  
> **Repository:** https://github.com/DreamingXian/FYP-SHIRO.git  

---

## 1. System Architecture & Topology Overview

SHIRO uses a dual-role anchor architecture with **no separate gateway hardware**. The stationary wall anchors measure the BLE signal strength (RSSI) of each wristband broadcast for positioning, and decode the telemetry the wristband places in that broadcast (heart rate, SpO2, battery, motion state, fall events, sensor faults):

```
[ Tier 1: Patient Wearable ]
  Seeed Studio XIAO ESP32-C6 + HW-605 (MAX30102 PPG) + MPU-6050 (6-DOF IMU) + Battery Divider
         │
         └──(BLE advertising, every 62.5–100 ms)
             │  [Telemetry packet v2: vitals, motion, fall, battery, sensor faults]
             ▼
[ Tier 1.5: Dual-Role Stationary Wall Anchors (Anchor & Gateway) ]
  3x ESP32-WROOM-32E (one firmware for all, identity assigned by the edge server)
         │  - Measures RSSI for multilateration
         │  - Decodes the wristband's telemetry packet
         │
         └──(Wi-Fi, MQTT TCP:1883, anchor login)──► [ Tier 2: Central Edge Server ]
                                      Host PC / Laptop (Node.js)
                                      - Embedded Aedes MQTT Broker (:1883)
                                      - HTTP REST API Server (:3000)
                                      - WebSocket Real-Time Event Server (:3000)
                                      - 1D Kalman Filter on RSSI per anchor
                                      - Weighted Least-Squares Multilateration
                                      - MariaDB / MySQL Relational Database (XAMPP :3306)
                                      - InfluxDB Time-Series Store (:8086, optional)
                                      - Web Operations Dashboard
                                              │
                                              └──(WebSocket JSON:3000)──► [ Tier 3: MR Client ]
                                                                          Meta Quest 3 (Unity 6, Meta XR)
                                                                          - Color Passthrough Digital Twin
                                                                          - In-Situ Walking Patient Hologram
                                                                          - Bed Docking (Headboard/Bedside)
                                                                          - 2-Point Door Frame Calibration
                                                                          - Hand Slate HUD
```

---

## 2. Pre-Requisite Network & Environment Setup

### 2.1 Wi-Fi Network Requirements
* All wireless nodes (Anchors, Laptop Edge Server, and Meta Quest 3) **must be connected to the exact same 2.4 GHz Local Area Network (LAN)** or laptop Wi-Fi hotspot.
* **Network SSID and password:** your own 2.4 GHz network or hotspot. These are never written in this repository; the anchors read them from `firmware/shiro_anchor_node/secrets.h` (see Section 4.3).
* *Security Note:* Ensure Client Isolation / AP Isolation is **DISABLED** on your Wi-Fi router so devices can communicate directly over local IP sockets.

### 2.2 Finding the Laptop Edge Server IP Address
The ESP32 anchor nodes and Meta Quest 3 must know the exact local IP address of your laptop to connect to the MQTT broker and WebSocket server.
1. On your Windows laptop, open PowerShell or Command Prompt.
2. Run:
   ```powershell
   ipconfig
   ```
3. Look for **Wireless LAN adapter Wi-Fi** --> **IPv4 Address** (e.g., `192.168.1.229`).
4. If your router assigns a new IP address via DHCP, you must update:
   - `SHIRO_MQTT_SERVER` in `firmware/shiro_anchor_node/secrets.h` (then re-flash the anchors)
   - `serverIp` in Unity Inspector (`ShiroMRManager`) or via the Quest 3 Hand Slate Connection menu.

---

## 3. Tier 2: Starting the Database, Edge Server & Web Dashboard

Always start MySQL and the Edge Server **FIRST** so the database, MQTT broker, and REST APIs are listening before the hardware nodes or Quest 3 attempt to connect.

### 3.1 Software Prerequisites
* **XAMPP** (Installed at `C:\xampp`) with **MySQL** and **Apache** modules. XAMPP's "MySQL" is MariaDB 10.4, which is MySQL-compatible.
* **Node.js** v20.12 or newer (v24.x recommended).
* Dependencies installed in `edge_server/` with `npm install` (`aedes`, `ws`, `mysql2`).
* **Server configuration file** `edge_server/.env` (first-time setup only):
  1. Copy `edge_server/.env.example` to `edge_server/.env`.
  2. Set `INFLUX_TOKEN` to an API token from the InfluxDB UI (`http://localhost:8086` --> Load Data --> API Tokens). Leave it empty to run without time-series logging.
  3. Set the MQTT anchor login and the MySQL account as described in Section 3.2.

  `.env` is git-ignored. Never commit it or paste its contents anywhere.

### 3.2 First-Time Security Setup

Do this once per edge server PC. Background and limits: `docs/security.md`.

**a) Generate two passwords.** Run this in PowerShell twice, once for the MQTT anchor login and once for the MySQL account. Each run prints a new random 32-character password with letters and digits only:
```powershell
$b = New-Object byte[] 24; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b).Replace('+','x').Replace('/','y')
```
Keep them only in the files named below. Do not paste them into chats, documents or commit messages.

**b) MQTT anchor login.** In `edge_server/.env`:
```ini
MQTT_ANCHOR_USER=shiro-anchor
MQTT_ANCHOR_PASSWORD=<first password>
```
Put the same two values in `firmware/shiro_anchor_node/secrets.h` (`SHIRO_MQTT_USER`, `SHIRO_MQTT_PASSWORD`, see Section 4.3) and reflash every anchor. Without these settings the server does not start.

**c) MySQL account for the server.** Start MySQL and Apache in XAMPP, open `http://localhost/phpmyadmin`, click the **SQL** tab, paste the following with your second password in place of `<second password>`, and click **Go**:
```sql
CREATE USER 'shiro_app'@'127.0.0.1' IDENTIFIED BY '<second password>';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES ON `shiro_db`.* TO 'shiro_app'@'127.0.0.1';
GRANT ALL PRIVILEGES ON `shiro_test`.* TO 'shiro_app'@'127.0.0.1';
```
The server may read and change data and create missing tables in `shiro_db`, but not drop tables or reach other databases. The integration tests drop and recreate `shiro_test`, so that database gets full rights. Then in `edge_server/.env`:
```ini
DB_USER=shiro_app
DB_PASSWORD=<second password>
```

**d) MySQL on this PC only.** Open `C:\xampp\mysql\bin\my.ini` in a text editor. In the `[mysqld]` section, change
```ini
# bind-address="127.0.0.1"
```
to
```ini
bind-address="127.0.0.1"
```
Save, then **Stop** and **Start** MySQL in XAMPP. phpMyAdmin keeps working, because it connects through `127.0.0.1`.

**e) InfluxDB on this PC only.** Always start InfluxDB with `edge_server\tools\start_influxdb.bat` (double-click it, or run `.\start_influxdb.bat` in that folder) instead of `influxd.exe` directly. It starts InfluxDB with `--http-bind-address 127.0.0.1:8086`.

**f) Windows Firewall.** Open **PowerShell as administrator** (Start menu, type PowerShell, right-click, Run as administrator) and run:
```powershell
# 1. Back up the current rules (restore with: netsh advfirewall import "$env:USERPROFILE\Documents\firewall_before_shiro.wfw")
netsh advfirewall export "$env:USERPROFILE\Documents\firewall_before_shiro.wfw"

# 2. Node.js: only TCP 3000 (dashboard) and 1883 (MQTT), only on private networks.
#    -EdgeTraversalPolicy Block is required: the rule Windows created at the first start of
#    Node.js is "defer to user", which cannot be combined with a port limit.
Get-NetFirewallRule -DisplayName 'Node.js JavaScript Runtime' | Where-Object { ($_ | Get-NetFirewallPortFilter).Protocol -eq 'TCP' } | Set-NetFirewallRule -EdgeTraversalPolicy Block -Profile Private -Protocol TCP -LocalPort 3000,1883
Get-NetFirewallRule -DisplayName 'Node.js JavaScript Runtime' | Where-Object { ($_ | Get-NetFirewallPortFilter).Protocol -eq 'UDP' } | Disable-NetFirewallRule

# 3. MySQL, InfluxDB and Apache need no access from other devices
Get-NetFirewallRule -DisplayName 'mysqld','influxd','Apache HTTP Server' -ErrorAction SilentlyContinue | Disable-NetFirewallRule

# 4. Show the result
Get-NetFirewallRule -DisplayName 'Node.js JavaScript Runtime','mysqld','influxd','Apache HTTP Server' -ErrorAction SilentlyContinue | Select-Object DisplayName, Enabled, Profile, @{n='Ports';e={($_ | Get-NetFirewallPortFilter).LocalPort}}
```
The Wi-Fi connection of the edge server PC must be a **private** network: Settings --> Network & internet --> Wi-Fi --> your network --> Network profile type --> Private. On a public network (for example a café), the anchors and the headset cannot connect, which is intended.

**g) Optional: a password for MySQL `root`.** After step d, `root` without a password can be used only on this PC. To close that too, set a password and switch phpMyAdmin to a login page:
1. In phpMyAdmin, SQL tab: `ALTER USER 'root'@'localhost' IDENTIFIED BY '<third password>';` (also for `'root'@'127.0.0.1'` and `'root'@'::1'` if they exist: User accounts tab).
2. In `C:\xampp\phpMyAdmin\config.inc.php`, change `$cfg['Servers'][$i]['auth_type'] = 'config';` to `'cookie'` and `$cfg['Servers'][$i]['AllowNoPassword'] = true;` to `false`.
3. phpMyAdmin now asks for a username and password; use `root` and the third password. The XAMPP Control Panel's MySQL **Stop** button may then need the password too (or stop MySQL with the Windows Services panel).

### 3.3 Starting the MySQL Database (XAMPP)
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

### 3.4 Starting InfluxDB

Double-click `edge_server\tools\start_influxdb.bat` and keep its window open. InfluxDB then accepts connections from this PC only (Section 3.2 e).

### 3.5 Starting the Edge Server
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
   2026-11-16 09:00:00.120 INFO  [DATABASE] Connecting to MySQL Database...
   2026-11-16 09:00:00.150 INFO  [DATABASE] Connected to MySQL server successfully.
   2026-11-16 09:00:00.180 INFO  [DATABASE] Schema verified in "shiro_db".
   2026-11-16 09:00:00.210 INFO  [IPS ENGINE] Cached 3 assigned anchors across 2 wards.
   2026-11-16 09:00:00.230 INFO  [MQTT BROKER] Listening on 0.0.0.0:1883 (anchor login required)

   ======================================================
     SHIRO Clinical Dashboard & Gateway Ready
   ======================================================
   [HTTP DASHBOARD] Accessible at:
     -> Localhost:  http://localhost:3000
     -> Wi-Fi: http://192.168.1.229:3000
   [MQTT BROKER]  tcp://192.168.1.229:1883 (ESP32 Anchors)
   [WEBSOCKET]    ws://192.168.1.229:3000 (Web & Quest 3 HMD)
   ======================================================
   ```
   The time stamps, counts and addresses are examples; the dashboard lists one line per network adapter of the PC. Then one `[MQTT CLIENT CONNECTED] ID: SHIRO_Anchor_…` line appears for each anchor that connects.

   Notes on database start-up:
   * Missing tables are created automatically. Existing data is never modified by a restart.
   * Sample wards and patients are loaded only into a completely empty database. To load them by hand, run `npm run db:seed`.
   * If MySQL is not running, the server stops with `[FATAL STARTUP ERROR] Could not connect to MySQL ...` and exit code 1. Start MySQL in XAMPP and run `npm start` again.
   * If the MQTT anchor login is missing from `.env`, the server stops with `[FATAL STARTUP ERROR] MQTT_ANCHOR_USER and MQTT_ANCHOR_PASSWORD must be set ...` (Section 3.2 b).
   * Log lines carry a time stamp and a level (`INFO`, `WARN`, `ERROR`). `LOG_LEVEL` in `.env` chooses how much is shown.

   **Stopping the server:** press **Ctrl+C** once in its terminal. It disconnects the anchors and dashboards, writes the device status and InfluxDB points still in memory, closes the database and ends with `[SHUTDOWN] Done.` Closing the terminal window instead skips these steps; at most the last 5 seconds of "last seen" and battery values are then lost.

3. Open your web browser (Chrome / Edge) and navigate to `http://localhost:3000`. Sign in (Section 3.6). The dashboard offers:
   * **Ward Configuration Editor:** Room dimensions, obstacle cut-outs, rotatable beds ($0^\circ, 90^\circ, 180^\circ, 270^\circ$), and anchor placement suggestions with line-of-sight checks.
   * **Live Ward Map:** 2D real-time bird's-eye canvas with a scaled patient marker, movement trail, bed docking detection, and landmark calibration of each anchor ($A$ and $n$ parameters).
   * **Device Provisioning Radar:** Lists nearby anchors, wristbands and headsets that are not yet enrolled, with one-click enrollment.
   * **Patient Admissions Directory:** Patient profiles, fall risk scores, bed allocation, wristband binding and discharge.
   * **Live Telemetry & Diagnostics Lab:** Live heart rate, SpO2 (indicative), motion and sensor contact from the wristband, raw versus Kalman-filtered RSSI per anchor, and an MQTT telemetry inspector. The raw pulse waveform is not shown: the wristband sends only computed results.
   * **System Health:** live server state (uptime, memory, response delay, database queries per second) and the status of every enrolled anchor and headset, refreshed every 5 s.
   * **Admin** (admins only): clinician accounts, headset pairing and the audit log.

### 3.6 Clinician Accounts and Sign-in

The dashboard and every API address need a signed-in clinician. Two roles exist:

| Role | Can do |
| :--- | :--- |
| `CLINICIAN` | Patients (admit, edit, discharge, beds, photos), wristband bindings, alarms (acknowledge), live mode, everything that is read only |
| `ADMIN` | Everything a clinician can, plus accounts, device enrollment and deletion, ward editing, anchor calibration, headset pairing and the audit log |

**First start (once):**
1. On the **server PC itself**, open `http://localhost:3000`. While no account exists, the sign-in page shows **Create the first admin account**. This form works only on the server PC.
2. Enter your full name, a username (lowercase, for example `admin`) and a password of at least 10 characters. You are then signed in as admin.
3. Open the **ADMIN** tab and create an account for each clinician (role `CLINICIAN`). Give each person their initial password in person.

**Every day:** sign in with your username and password. A session lasts 12 hours; **Log out** (top right) ends it. After 5 wrong passwords an account is locked for 5 minutes.

**Audit log:** ADMIN tab → Audit Log. Every change (admission, discharge, binding, acknowledgement, device, ward, calibration), every sign-in and failed sign-in, and every account and pairing change is listed with who did it, when and from which address. Filter by actor (`CLN-002`, `QUEST3-…`), action (`PATIENT_ADMIT`) or target (`P-001`).

**Forgotten admin password:** on the server PC, in `edge_server`, run `node tools/reset_password.js <username>` and type the new password twice (it is not shown). Every session of that account ends.

---

## 4. Tier 1: Embedded Hardware Setup & Firmware Programming Guide

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
* **Sensors Attached:** HW-605 (MAX30102 PPG Optical Sensor) + MPU-6050 (6-DOF IMU) + 100k/100k battery divider on `D0`
* **Firmware Location:** `firmware/shiro_wristband_vitals/shiro_wristband_vitals.ino` (the `.h` files in the same folder open as tabs and are compiled with it)
* **Telemetry packet:** version 2, defined in `docs/protocol.md`

> [!IMPORTANT]
> The wristband and **all** anchors must run the same packet version. After a protocol change, flash the wristband and every anchor in one session. An anchor that hears a wristband with another version still tracks its position but forwards no vitals or fall alerts, and the edge server prints a `[PROTOCOL]` warning.

#### Hardware Wiring Diagram:
| Sensor Pin / Signal | XIAO ESP32-C6 Pin | Function |
| :--- | :--- | :--- |
| **VCC / VIN** | **3.3V** | 3.3V Regulated Power |
| **GND** | **GND** | Ground |
| **SDA** | **D4** (GPIO 22) | I2C Data Line |
| **SCL** | **D5** (GPIO 23) | I2C Clock Line |
| **BAT+ (via 100k/100k divider)** | **D0** (GPIO 0) | Analog Battery Voltage Monitor |

*Both sensors share the same hardware I2C bus lines.*

#### Arduino IDE Settings:
1. Connect XIAO ESP32-C6 via USB-C cable.
2. Select **Tools --> Board --> esp32 --> "XIAO_ESP32C6"**.
3. Select **Tools --> Port** (COM port for XIAO).
4. Select **Tools --> Upload Speed --> "921600"**.
5. Click **Upload** (`Ctrl + U`).

#### What the Serial Monitor shows at power-on (115200 baud):
```
[OK] MPU-6050 ready: +/-16 g range, WHO_AM_I = 0x68.
[SELF-TEST] Fall detector: PASS (fall: detected, short dip: ignored, movement: ignored)
[OK] HW-605 (MAX30102) Initialized.
[OK] Telemetry packet version 2, 15 bytes.
```
A `[FAIL]` line for a sensor means that sensor is reported as faulty in every packet and shown as **SENSOR FAULT** on the dashboard; the wristband keeps running with the sensors that work.

> [!NOTE]
> The "firm shake starts 1 Hz active mode" shortcut is now a bench-test option. It is off by default; set `SHIRO_DEBUG_SHAKE_WAKE` to `1` at the top of the sketch to use it. Start active mode from the dashboard instead.

---

### 4.3 Board 2: Dual-Role Stationary Wall Anchors (ESP32-WROOM-32E)

* **Physical Hardware:** ESP32-WROOM-32E Development Boards (3+ units for 2D trilateration)
* **Dual Role:** Continuously scans BLE advertising beacons from wristbands, measures raw RSSI for IPS multilateration, unpacks embedded vitals (BPM, SpO2, battery, motion, fall alerts), and streams unified JSON packets to MQTT over Wi-Fi.
* **Firmware Location:** `firmware/shiro_anchor_node/shiro_anchor_node.ino`

#### Universal Firmware Notice:
> [!NOTE]
> `shiro_anchor_node.ino` uses **Universal Firmware Architecture**. You flash the exact same compiled sketch to ALL anchor boards! Do NOT hardcode IDs. The Central Edge Server automatically identifies and provisions each anchor by its hardware MAC address during discovery radar enrollment.

#### Configuration (first-time setup, and whenever the network or laptop IP changes):
Wi-Fi and MQTT settings are kept out of the sketch, in a git-ignored file:
1. In `firmware/shiro_anchor_node/`, copy `secrets.example.h` to `secrets.h`.
2. Open `secrets.h` (it appears as a tab in Arduino IDE) and fill in your values:
   ```cpp
   #define SHIRO_WIFI_SSID     "YOUR_WIFI_SSID"
   #define SHIRO_WIFI_PASSWORD "YOUR_WIFI_PASSWORD"
   #define SHIRO_MQTT_SERVER   "192.168.1.100"   // Your laptop IPv4 address
   #define SHIRO_MQTT_PORT     1883
   #define SHIRO_MQTT_USER     "shiro-anchor"    // = MQTT_ANCHOR_USER in edge_server/.env
   #define SHIRO_MQTT_PASSWORD "..."             // = MQTT_ANCHOR_PASSWORD in edge_server/.env
   ```
3. Re-flash every anchor after changing this file.

If `secrets.h` is missing, or lacks `SHIRO_MQTT_USER` or `SHIRO_MQTT_PASSWORD`, the sketch stops compiling with a message saying what to add.

#### Mandatory Partition Scheme Setting:
> [!IMPORTANT]
> The anchor firmware compiles both Bluetooth and Wi-Fi/MQTT stacks (~1.63 MB binary). The default partition (1.3 MB) will trigger a compiler error. You **MUST** change the partition scheme:

1. Connect ESP32-WROOM-32E via USB cable.
2. Select **Tools --> Board --> esp32 --> "ESP32 Dev Module"**.
3. Select **Tools --> Partition Scheme --> "Huge APP (3MB No OTA/1MB SPIFFS)"**.
4. Select **Tools --> Upload Speed --> "921600"**.
5. Select **Tools --> Port** (physical USB serial port, e.g., `COM10+`).
6. Click **Upload** (`Ctrl + U`). *(If `Connecting........_____`, press and hold the physical **BOOT** button for 1 second).*

---

## 5. Anchor Power Supply Deployment Plan (Central 12V DC Bus)

For deploying anchors across a room without running multiple individual wall plugs:

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

## 6. Tier 3: Meta Quest 3 Mixed Reality (MR) Spatial Client

The Quest 3 client delivers the spatial hospital digital twin, in-situ floating vitals HUD, and room calibration tools directly overlaid in color Passthrough.

### 6.1 Project Location & Dependencies
* **Project Folder:** `quest3_client/` in this repository. Always open this folder, so that what you test is what is in git. Older copies elsewhere on the PC are out of date.
* **Engine Version:** Unity 6 (`6000.3.28f1`) Universal Render Pipeline (URP)
* **Key Packages:** Meta XR Core SDK, Meta XR Building Blocks, `NativeWebSocket`, Unity New Input System.

### 6.2 Opening & Configuring the Project
1. Open **Unity Hub** --> **Projects** --> **Add** --> **Add project from disk** --> select `d:\RSW\FYP\Code\quest3_client`.
2. Open the project with Unity `6000.3.28f1`. The first opening imports all assets and takes a few minutes.
3. First time only: **File --> Build Profiles --> Android --> Switch Platform**. The Unity title bar then ends in "Android".
4. In the Project window, open `Assets/Scenes/SampleScene.unity`.
5. Inspect the `SHIRO_MR_SYSTEM` GameObject in the Hierarchy:
   * **Server IP:** the starting value only. On the headset it is set on the hand slate: **System → 🌐 Server address** (the dashboard shows the address: **ADMIN → Headset Pairing**), or **💻 Quest Link (127.0.0.1)** when the edge server runs on the same PC as Unity. The choice is remembered.
   * **Server Port:** `3000`.
   * **Target Ward ID:** leave empty. The ward is chosen on the hand slate (Section 6.6) and remembered on the headset; no ward is assumed.
   * **Auto Connect on Start:** Enabled.
6. **Pair the headset (once per headset).** Press Play. The hand slate's **System** tab shows `Edge Server: 🔑 NOT PAIRED`.
   1. On the dashboard (signed in as admin): **ADMIN** tab → **Headset Pairing** → **Create pairing code**. A 6-digit code appears, valid for 5 minutes and usable once.
   2. On the headset: System tab → **🔑 Pair headset (code)** → type the code on the number pad → **✓ Pair**.
   3. The headset is enrolled automatically (as `QUEST3-…`, shown in the Unity Console as `[SHIRO NET] This headset is QUEST3-…`) and connects. It stays paired until an admin presses **Revoke** on the ADMIN tab.
   4. On the ADMIN tab, choose the clinician who uses the headset in its **Used by** column. What the headset does (for example acknowledging an alert) is recorded as `QUEST3-… (name, CLN-…)`; without an assignment it is recorded as `QUEST3-… (no clinician assigned)`. The hand slate header shows the assignment. Pairing again clears it.
   The Unity editor on a PC and the app installed on the Quest have different IDs, so each is paired once.

### 6.3 Running the Client (Two Methods)

#### Method A: Instant Play via Meta Quest Link / Air Link (Fastest for Testing)
1. Power on Meta Quest 3 and connect to your PC via USB-C cable or 5 GHz Wi-Fi (Air Link).
2. Open the **Meta Quest Link** desktop app on your PC. First time only: **Settings → Developer → Spatial Data over Meta Quest Link** on. Without it the headset gets no depth data over Link, and person linking (Section 6.5) cannot see anyone.
3. Put on the Quest 3, open Quick Settings, and launch **Quest Link**.
4. Once inside the PC VR environment, look at your monitor and click **`▶ Play`** in the Unity Editor.
5. Put the headset back on: You are now in color Passthrough with the live SHIRO MR system running!

#### Method B: Standalone App on the Headset (APK, no cable while in use)

The app **SHIRO MR** (`com.shiro.mrpatientconnect`, version 1.1.0) runs on the headset itself. The headset then reaches the edge server over the ward Wi-Fi, so it must be on the same network as the laptop. Building is done with the USB-C cable; afterwards the cable is not needed.

**One-time preparation of the headset (developer mode):**
1. In the **Meta Horizon** app on your phone: **Devices → Meta Quest 3 → Headset settings → Developer mode** on. (The Meta account must belong to a developer organisation; create one free at developers.meta.com if asked.)
2. Restart the headset, connect it to the laptop with the USB-C cable, put it on and choose **Allow** (tick *Always allow from this computer*) for **USB debugging**.

**Building and installing (each time the headset code changes):**
1. Close any running Play session. In Unity: menu **SHIRO → Check APK build settings**. The Console must show `[SHIRO APK] Ready to build`. If it lists problems, run **SHIRO → Apply APK build settings**, then **File → Save Project**.
2. **Meta → Tools → Project Setup Tool**: press **Fix All** for the Android tab (recommended items too), until no required item is left.
3. **File → Build Profiles → Android**: under **Run Device** choose the Quest 3 (press **Refresh** if it is not listed). Press **Build And Run** and save the file as `quest3_client\Builds\SHIRO_MR.apk` (create the `Builds` folder in the dialog; APK files are git-ignored). The first build takes 10 to 20 minutes, later builds a few minutes. The app starts on the headset by itself.

**First start of the app on the headset (once per headset):**
1. The headset asks to allow **spatial data**: choose **Allow**. Without it depth sensing (person detection and linking, Section 6.5) stays off; the System tab then shows `🛡 Spatial data: ⚠ not allowed`. To allow it later: Quest Settings → Privacy & safety → App permissions → Spatial data → SHIRO MR on, then restart the app.
2. Find the laptop's address on the dashboard: **ADMIN → Headset Pairing** shows *Server address for the headset* (for example `192.168.100.21`, Wi-Fi).
3. On the hand slate: **System → 🌐 Server address** → type the address → **✓ Connect**. It is remembered.
4. Pair the app as in Section 6.2, step 6. The app has its own headset ID (`QUEST3-…`), different from the Unity editor's, so it is paired once even if the editor already is.
5. Choose the ward and calibrate each ward once (Section 6.4). Spatial anchors saved by the app stay on the headset, so the app finds each calibrated ward again after a restart.

**Starting it later:** Library → filter **Unknown sources** → **SHIRO MR**. Building again replaces the app and keeps its pairing, address and calibration; uninstalling it removes them.

**Walking the whole clinic:** the app hides the headset's boundary while it shows passthrough (Meta's Boundary API), so it keeps working beyond the boundary area set up on the headset; no room needs to be scanned for this. It needs **Boundary Visibility Support** in the Meta XR settings (set by **SHIRO → Apply APK build settings**) and works in the APK only. In the log, `[SHIRO MR] Boundary hidden` confirms it. Passthrough is what keeps the clinician safe here: the hand slate, patient cards and the solid ward objects cover what is behind them, so stop walking while reading them.

**Quitting the app:** hand slate → **System → ✖ Quit app → ✖ Quit now** (it asks first, because alerts stop on this headset while the app is closed). The Meta menu always works too: turn your right palm towards you, pinch thumb and index finger and hold until the menu opens (or press the Meta button on the right controller), then choose **Quit**. With the cable connected: `adb shell am force-stop com.shiro.mrpatientconnect`.

**Logs while testing (cable connected):** `adb logcat -s Unity` (adb is in Unity's Android folder: `C:\Program Files\Unity\Hub\Editor\6000.3.28f1\Editor\Data\PlaybackEngines\AndroidPlayer\SDK\platform-tools\adb.exe`).

**Why the app can reach the edge server:** Meta's default Android network security file blocks plain HTTP. The project uses its own file, `Assets/Oculus/ShiroNetworkSecurityConfig.xml`, which allows HTTP to the edge server on the ward network (it has no TLS yet). Every request still needs the headset's pairing token.

---

### 6.4 Spatial Room Calibration Procedure

To align the digital twin ward with your physical room:

```
[ Step 1: Choose the Ward ]
  Turn your left palm up to open the Hand Slate HUD.
  Open the [🚪 Ward Setup] tab and pick the ward under "SWITCH HOSPITAL WARD"
  (the list is loaded from the edge server). The choice is remembered.

[ Step 2: Door Frame Calibration ]
  On the same tab, click [🚪 Start Door Frame Calibration (L->R)].
  Point the laser reticle at the Bottom-Left corner of your physical door frame.
  Pinch index finger & thumb (or pull index trigger) -> Point 1 locks at the physical floor.
  Point the laser reticle at the Bottom-Right corner of the door frame.
  Pinch to lock Point 2.
  Result: The 3D room boundaries, walls, and beds snap into alignment.

[ Step 3: Keep the Alignment ]
  Click [💾 Save Persistent Spatial Anchor]. The headset stores the anchor and
  sends its ID to the edge server. If saving fails, the slate says so and
  nothing is sent.
  [⚡ 1-Click Re-Sync Alignment] restores it later; [🗑️ Purge Anchor & Reset
  Alignment] starts again.

[ Physical Floor Height ]
  Calibration points are placed with Meta.XR.EnvironmentRaycastManager on the
  measured physical floor, not on virtual geometry.
```

The alignment tool also has bed two-point and wall-anchor two-point methods (`WardAlignmentTool.cs`); they have no button on the hand slate and are not part of the normal procedure.

**Several wards and headsets.** A spatial anchor exists only on the headset that saved it, so each headset calibrates each ward once; the server keeps one anchor per headset and ward. With **🧭 Auto ward** on (Ward Setup tab), the headset keeps the anchors of the wards it has calibrated loaded. When it has been inside another calibrated ward for 2 s, that ward becomes active and is aligned from its anchor, with no new calibration. **🔍 Find My Current Ward / Room** on the IPS Location tab checks at once. So far this has been tested in one room only: walking between two calibrated rooms needs the standalone APK.

---

### 6.5 In-Situ Patient Hologram & Bed Docking Controls

When the patient wearing the wristband is detected by the IPS engine:
1. **In-Transit Walking Mode:**
   - A $0.65\text{m}$ emerald green/cyan uncertainty footprint ring appears on the physical floor.
   - A glassmorphic vitals HUD panel floats $+1.35\text{m}$ at eye level, smoothly billboarding to face the doctor as they move around the room.
   - Displays live heart rate (a heart icon pulsing at the measured rate), SpO2 marked `~` as indicative, wristband battery, and motion state. A value the wristband cannot measure at the moment is shown as `--`, never as the last or a default value.
2. **Bed-Docked Mode:**
   - When the patient enters their assigned bed area, the panel automatically transitions to **Bed-Docked** state.
   - Locks statically to the bed headwall or bedside cart with zero jitter.
   - Aligns outward along the bed's rotation ($0^\circ, 90^\circ, 180^\circ, 270^\circ$) facing into the room toward the foot of the bed (non-mirrored, readable text).
3. **Manual [✥ Move] Handle and Panel Buttons:**
   - Top-left corner of the vitals panel features a **`[✥ Move]`** handle.
   - Aim the laser pointer at the handle, pinch and hold to drag the panel vertically and horizontally.
   - Extend or pull back your left hand to adjust distance (closer or farther).
   - Release pinch: the panel stays at your chosen location.
   - **`[🎯 Re-Attach]`** starts aiming:
     - Aim at a detected person: an amber column marks them and the pointer says **"🔗 LINK TO THIS PERSON"**. A pinch links the panel to that person until they are lost from view, even when the Bluetooth position disagrees ("🔗 FOLLOWING CHOSEN PERSON").
     - Aim where nobody is detected: the pointer says **"📍 NOBODY SEEN HERE"**, and a pinch pins the panel to that spot.
     - **`[✖ Cancel Aim]`** ends the aiming.
   - **`[🔄 Auto]`** (shown while a person you chose or a spot you pinned is in use) goes back to automatic following.
   - The **headboard/bedside** button switches the bed mount.
4. **Person Linking (System tab → 🔗 Linking, on by default):**
   - Five times per second the headset measures distances with its depth sensor (no camera image) and finds person-sized objects. One that has moved at least 0.4 m is a person candidate.
   - A panel away from its bed follows the person candidate within **0.5 m of the wristband's Bluetooth position** ("🔗 FOLLOWING PERSON"), with the patient's name above their head. The link holds while the Bluetooth position stays within 1.5 m, and ends when it is farther for 5 s or the person leaves the view.
   - The status line at the bottom of the panel says why, for example "linked: person 1.62 m, 0.3 m from the wristband". When two people fit equally it says "❓ UNCLEAR: CHOOSE PERSON": use Re-Attach.
   - While linked, the dashboard's live map and the headset's Live Map show the patient where the headset sees them (violet dot, 👁), with the Bluetooth estimate as a faint dot.
   - **🔬 Depth view** (System tab) shows what the headset sees. Each object has a vertical line and a label: grey = not a person, yellow = still, green = person candidate, 🔗 = linked patient.

---

### 6.6 Wrist Hand Slate HUD

Look at your left palm/wrist to summon the 5-tab slate:
* **🚪 Ward Setup:** ward information and the ward choice ("SWITCH HOSPITAL WARD"), door frame calibration, save / re-sync / purge of the spatial anchor, perspective, the 3D digital twin overlay on/off, and **🧭 Auto ward** (Section 6.4).
* **📍 IPS Location:** "Find My Current Ward / Room" and continuous refresh (4 Hz). Shows only data of the loaded ward: its beds and anchors, and the anchor signal marked as estimated. Without a ward it says "NO WARD CONFIGURED".
* **🛏️ Patient Vitals:** re-attach the patient hologram to gaze/aim and switch its mount between headboard and bedside.
* **⚙️ System:** reconnect, **🌐 Server address** (typed on a keypad; the dashboard shows it under ADMIN → Headset Pairing) or **💻 Quest Link** (`127.0.0.1`), the headset ID, the active ward and the connection state, pairing, **🛡 Spatial data** (the permission for depth sensing, app on the headset only) and **✖ Quit app** (asks first; over Quest Link it ends Play mode). Person linking: **🔗 Linking** (on by default), **🔬 Depth view**, **🚶 Move rule** (off only to test with height alone) and **🧪 Fake band** (a test panel whose Bluetooth position wanders 2 m in front of you, shown as a cyan disc; never sent to the server).
* **🗺️ Live Map:** top view of the ward with each patient (BLE position, or violet 👁 where a headset sees them), this headset and alerting patients in red. Tapping a patient opens their card and requests 1 Hz vitals for 60 s.

---

## 7. End-to-End Daily Startup Routine

Follow this numbered checklist for demonstrations, laboratory testing, and clinical trials:

```
[Step 1: Network Check]
  Ensure host laptop is on the same Wi-Fi network (or hotspot) as the anchors.
  Run 'ipconfig' and note your IPv4 address (e.g. 192.168.1.229).

[Step 2: Start MySQL, InfluxDB & Edge Server]
  Open XAMPP -> Start MySQL (Port 3306).
  Double-click edge_server\tools\start_influxdb.bat (keep the window open).
  Open Terminal -> cd d:\RSW\FYP\Code\edge_server -> npm start
  Verify console outputs: [HTTP DASHBOARD], [MQTT BROKER], [WEBSOCKET] Ready.

[Step 3: Power On Wristband Tag]
  Power Seeed Studio XIAO ESP32-C6 (Power bank or USB).
  Wear it with the sensor on the outer side of the wrist, strap snug
  (or rest a fingertip on the sensor for a bench test).

[Step 4: Power On Stationary Wall Anchors]
  Power on the anchors.
  The server prints one [MQTT CLIENT CONNECTED] line per anchor; the System Health
  tab shows them ONLINE.
  Live Map shows the wristband's position and vitals; Live Lab shows raw and
  filtered RSSI per anchor.

[Step 5: Launch Meta Quest 3 MR Client]
  Put on Meta Quest 3 -> Start Quest Link.
  In Unity (project quest3_client), press Play on 'SampleScene'.
  The hand slate's System tab shows the headset ID, the connection and
  "🔗 Linking: ON".

[Step 6: Calibrate Room]
  Turn left palm up -> [🚪 Ward Setup] -> check the ward -> [🚪 Start Door Frame Calibration (L->R)].
  Aim laser pointer at door frame corners -> Lock Point 1 & Point 2.
  Check that the virtual beds overlay the real furniture.

[Stopping]
  Ctrl+C once in the server terminal (Section 3.5), then stop InfluxDB and MySQL.
```

---

## 8. Troubleshooting & Recovery Matrix

| Symptom / Error | Root Cause | Immediate Resolution |
| :--- | :--- | :--- |
| `rc=-4` or `rc=-2` in Anchor Serial Monitor | Board cannot reach Laptop MQTT broker. | 1. Check laptop IP via `ipconfig` and ensure `SHIRO_MQTT_SERVER` in `secrets.h` matches.<br>2. Check that the laptop's Wi-Fi is a **private** network and the firewall rule allows TCP `1883` (Section 3.2 f). Windows stores this per network name: a laptop that moves to another network (or the other band of the same router, e.g. `…_5G`) may be on a **public** network again. Check with `Get-NetConnectionProfile`; fix with `Set-NetConnectionProfile -Name '<network>' -NetworkCategory Private` (administrator).<br>3. Verify `npm start` is running. |
| `rc=4: login refused` (or `rc=5`) in Anchor Serial Monitor; server prints `[MQTT SECURITY] Refused SHIRO_Anchor_…` | The anchor's MQTT login does not match `edge_server/.env`, or its address is locked out for 60 s after 10 failed logins. | Make `SHIRO_MQTT_USER` / `SHIRO_MQTT_PASSWORD` in `secrets.h` equal to `MQTT_ANCHOR_USER` / `MQTT_ANCHOR_PASSWORD` in `.env`, reflash, and wait one minute. |
| `[FATAL STARTUP ERROR] MQTT_ANCHOR_USER and MQTT_ANCHOR_PASSWORD must be set` | The MQTT anchor login is missing from `edge_server/.env`, or the password is shorter than 16 characters. | Section 3.2 a and b. |
| `Access denied for user 'shiro_app'` on `npm start` | Wrong `DB_PASSWORD`, or the account was not created. | Section 3.2 c. Check the password in `.env`; in phpMyAdmin, User accounts must list `shiro_app` with host `127.0.0.1`. |
| `Access denied for user 'shiro_app'@'127.0.0.1' to database 'shiro_db'` (the login works, the database is refused), often right after MySQL was restarted | MySQL's grant table `mysql.db` is damaged, so the GRANTs of section 3.2 c were lost when MySQL reloaded them. | In phpMyAdmin's SQL tab: `CHECK TABLE mysql.db, mysql.proxies_priv;`. If either is not `OK`, run `REPAIR TABLE mysql.db, mysql.proxies_priv;`, then run the two `GRANT` lines of section 3.2 c again and `FLUSH PRIVILEGES;`. `SHOW GRANTS FOR 'shiro_app'@'127.0.0.1';` must list `shiro_db` and `shiro_test`. |
| Headset app (APK) shows beds, door frames or calibration markers in magenta, while their labels look normal; over Quest Link they look right | An object made by code has a material whose shader the APK left out. Unity packs a shader only when something in the build uses it; inside the editor every shader is available. | Objects made by code take their material from `ShiroMaterials` (templates in `Assets/Resources/ShiroMR`). Run **SHIRO → Check APK build settings**, then build again. |
| Headset app (APK) stops at the edge of the boundary area (boundary wall, app paused or hidden) | The app may not hide the boundary: Boundary Visibility Support is off, so the app lacks the permission `com.oculus.permission.BOUNDARY_VISIBILITY`. | Run **SHIRO → Check APK build settings** (then **Apply** if it lists the problem) and build again. `adb logcat -s Unity` must show `[SHIRO MR] Boundary hidden`. |
| Live map toast: "1 Hz vitals stream not started: No anchor has heard wristband …" | No anchor has received the wristband for 3.5 s. | Check that the wristband is on and near an online anchor, then select the patient again. |
| Edge server prints `[PROTOCOL] Wristband … sends a packet version this system does not support` | Wristband and anchors run different firmware versions. | Flash the wristband and all anchors from the same commit. |
| Live map shows **SENSOR FAULT** | The wristband reports that its accelerometer or pulse sensor does not answer. | Check the sensor wiring (SDA `D4`, SCL `D5`, 3.3 V, GND) and restart the wristband. The Serial Monitor names the failed sensor. |
| Live map shows **NO SIGNAL** | No packet from the wristband for 5 seconds. | Check that the wristband is powered and in range of at least one online anchor. |
| Live Lab simulation button answers "Simulation is disabled" | `ENABLE_SIMULATION=false` in `edge_server/.env`. | Set it to `true` and restart the server. Simulated incidents are always marked as simulated. |
| ESP32 compiler error: `text section exceeds available space in board` | Default 1.3 MB partition table selected. | In Arduino IDE: **Tools --> Partition Scheme --> "Huge APP (3MB No OTA/1MB SPIFFS)"**. |
| Quest 3 shows `WebSocket Connection Error` on startup | Server IP mismatch or Edge Server offline. | 1. Look at left palm -> Click Hand Slate connection tab.<br>2. Click Wi-Fi preset or retype correct laptop IP.<br>3. Ensure Quest 3 is on the same Wi-Fi LAN. |
| Quest 3 disconnects repeatedly with rapid reconnect loop | WebSocket ping/pong timeout or port contention. | One persistent connection per headset, with heartbeats. Ensure only one Unity instance is playing. |
| Hand slate shows `Edge Server: 🔑 NOT PAIRED` | The headset has no pairing, or its pairing was revoked, or the database was recreated. | Section 6.2 step 6: create a code on the ADMIN tab and enter it on the System tab. |
| Hand slate says "Pairing refused: The pairing code is wrong or has expired" | The code was mistyped, older than 5 minutes or already used. | Create a new code. After 5 wrong codes the headset's address is locked for 5 minutes. |
| The dashboard always returns to the sign-in page | The session ended: 12 hours passed, you logged out elsewhere, or an admin deactivated the account or reset its password. | Sign in again; ask an admin if the account is deactivated. |
| "Too many failed sign-ins for this account" | 5 wrong passwords in a row. | Wait 5 minutes. A forgotten password is reset by an admin (ADMIN tab), or for the last admin with `node tools/reset_password.js <username>` on the server PC. |
| "Your account does not have permission for this" | The action needs an admin (accounts, devices, wards, calibration). | Ask an admin, or sign in with an admin account. |
| Depth view status says "Depth NOT SUPPORTED here"; no panel is ever linked | Over Quest Link, the depth sensor's data is not passed to the PC. | Meta Quest Link app → **Settings → Developer → Spatial Data over Meta Quest Link** on, then restart Quest Link and Play. |
| Panel stays on "📶 BLUETOOTH POSITION": "nobody within 0.5 m of the wristband" | The Bluetooth estimate is more than 0.5 m from the person (positioning accuracy, F-2), or the person has not moved since the headset came on (still, yellow in the depth view). | **🎯 Re-Attach**, aim at the patient and pinch. **🔄 Auto** returns to automatic linking. |
| Panel follows the wrong person | Two people near the wristband's Bluetooth position. | Re-Attach and choose the right person; the choice holds until that person leaves the view. |
| Hand slate shows "Ward: not configured" or "NO WARD CONFIGURED" | No ward has been chosen on this headset yet; no ward is assumed. | **Ward Setup** tab on the hand slate: choose the ward under "SWITCH HOSPITAL WARD". The choice is remembered. |
| Server console shows the same warning only now and then | Repeated warnings are limited to one per 10 to 30 s. | Set `LOG_LEVEL=debug` in `edge_server/.env` for full detail, including error stacks. |
| Virtual room overlay appears underground or tilted | Calibration point snapped to virtual floor mesh instead of physical floor. | Fixed in v2.0: Depth raycasting now queries `EnvironmentRaycastManager` to detect true physical floor height before transforming coordinates. |
| Bed vitals panel is mirrored / backwards | Canvas local rotation flipped $180^\circ$ relative to bed anchor. | Fixed in v2.0: `GetBedHeadboardRotation` now matches `wardOrigin.rotation * Quaternion.Euler(0, bed.rotation_deg, 0)`. The Canvas front face (local $-Z$) points outward down the mattress into the room. |
| Laser pointer blocked by 3D room overlay | Raycast hit testing virtual wall/bed colliders before physical space. | Virtual room geometry colliders are bypassed during calibration mode; raycast queries physical depth sensor mesh directly. |
| `[FATAL STARTUP ERROR] Could not connect to MySQL` on `npm start` | MySQL service is not running, or the settings in `edge_server/.env` are wrong. | 1. Start MySQL in XAMPP Control Panel.<br>2. Check `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` in `.env`.<br>3. Run `npm start` again. |
| Heart rate shows `--` or stays on `Reading...` | The wristband reports no heart rate while the pulse signal is not clear (movement, loose strap, wrong spot); it never sends a guessed value. | Keep the arm still for about 10 s with the strap snug and the sensor on the outer side of the wrist, at the usual spot (or rest a fingertip on the sensor). The wristband's Serial Monitor shows each broadcast (`[BROADCAST …] BPM: …`). Background: `docs/test_records/heart-rate-measurement.md`. |
