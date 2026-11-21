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
   * **Ward Configuration Editor:** Room dimensions, obstacle cut-outs, rotatable beds ($0^\circ, 90^\circ, 180^\circ, 270^\circ$), the LiDAR room sensor, and **📐 Plan Anchors & LiDAR**: where to mount each anchor and the LiDAR, which way each faces, and a printable installation sheet (Section 4.5).
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
4. Open **Boards Manager** (`Ctrl + Shift + B`), search for `esp32` and install **esp32 by Espressif Systems**. Tested version: **3.3.13**. Use the same version for every board: the Bluetooth stack and the board menus change between versions.
5. Open **Library Manager** (`Ctrl + Shift + I`) and install:
   * **`SparkFun MAX3010x Sensor Library`** (by SparkFun)
   * **`PubSubClient`** (by Nick O'Leary)

   Bluetooth (BLE), Wi-Fi and I2C come with the ESP32 package. Do not install another BLE library: it would be used instead of the package's own.

#### Opening a sketch
* Open the `.ino` file in its repository folder, for example `firmware/shiro_wristband_vitals/shiro_wristband_vitals.ino`. The `.h` files in the same folder open as tabs and are compiled with it.
* If you keep a copy in another folder (for example under `Documents\Arduino`):
  * The folder must have the same name as its `.ino` file.
  * It must hold **every** `.h` file of the repository folder, plus your own `secrets.h` for the anchors and the LiDAR node.
  * Copy **all** of them again after every firmware update. A copy with one old `.h` file either fails to compile or runs old code.
* The first lines on the Serial Monitor show the version that is running (for example `V5.3` on the wristband).

#### The Tools settings belong to the board type, not to the sketch
Arduino IDE keeps the **Tools** settings you last chose for each board type, whichever sketch is open.
* A setting meant for one board is easily left on another. For example, **USB CDC On Boot: Disabled** is right for the ESP32-S3 but wrong for the XIAO ESP32-C6.
* **Before every upload, read the whole Tools menu against the table below.**

#### Board settings at a glance (esp32 package 3.3.13)
Leave every item that is not listed at the value its menu starts with:
* CPU Frequency: the top "(WiFi)" value;
* Flash Mode: QIO;
* Core Debug Level: None;
* Erase All Flash Before Sketch Upload: Disabled;
* JTAG Adapter: Disabled;
* Zigbee Mode: Disabled.

| Tools menu item | Wristband: XIAO ESP32-C6 | Anchor: ESP32-WROOM-32E | Anchor: ESP32-S3 N16R8 | Anchor: XIAO ESP32-C3 | LiDAR node: ESP32-S3 N16R8 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Board | **XIAO_ESP32C6** | **ESP32 Dev Module** | **ESP32S3 Dev Module** | **XIAO_ESP32C3** (or ESP32C3 Dev Module) | **ESP32S3 Dev Module** |
| USB CDC On Boot | **Enabled** | not in the menu | **Disabled** | **Enabled** (also on ESP32C3 Dev Module, where the menu starts at Disabled) | **Disabled** |
| USB Mode | not in the menu | not in the menu | Hardware CDC and JTAG | not in the menu | Hardware CDC and JTAG |
| Upload Mode | not in the menu | not in the menu | UART0 / Hardware CDC | not in the menu | UART0 / Hardware CDC |
| Flash Size | 4MB | 4MB | **16MB** | 4MB | **16MB** |
| PSRAM | not in the menu | Disabled | **Disabled** | not in the menu | **Disabled** |
| Partition Scheme | Default 4MB with spiffs (Huge APP works too) | **Huge APP** | **Huge APP** | **Huge APP** | **Huge APP** |
| Upload Speed | 921600 | 921600 | 921600 | 921600 | 921600 (115200 if the upload stops with an error) |
| Port | USB Serial Device | the board's USB-to-serial chip (CP210x or CH340) | the USB-C socket marked **COM** | USB Serial Device | the USB-C socket marked **COM** |
| Sketch | `shiro_wristband_vitals` | `shiro_anchor_node` | `shiro_anchor_node` | `shiro_anchor_node` | `shiro_lidar_node` |

"Huge APP" is **Huge APP (3MB No OTA/1MB SPIFFS)**. The anchor and LiDAR sketches do not fit in the default partition. The wristband sketch uses about 60 % of it.

#### Where the Serial Monitor output goes
Every board prints its log on `Serial` at **115200** baud. Which USB socket that output reaches depends on the board and on **USB CDC On Boot**:

| Board | What is behind its USB socket | USB CDC On Boot | If it is set wrong |
| :--- | :--- | :--- | :--- |
| XIAO ESP32-C6, XIAO ESP32-C3 | the chip's own USB | **Enabled** | With Disabled, `Serial` goes to pins D6/D7 instead. Uploading still works and the board runs normally (the wristband still shows on the dashboard), but the Serial Monitor stays **empty**. |
| ESP32-S3 N16R8, socket **COM** | a USB-to-serial chip | **Disabled** | With Enabled, `Serial` goes to the other socket (marked **USB**) and the COM socket stays empty. |
| ESP32-WROOM-32E | a USB-to-serial chip | (no such setting) | — |

Uploading works with either setting: the chip's built-in loader receives the upload, not the sketch.

#### Using the Serial Monitor
* **Tools → Serial Monitor** (`Ctrl + Shift + M`), set to **115200 baud**. Any line ending works.
* Only one program can use a COM port at a time. Close the Serial Monitor before running `firmware/tools/record_ppg.bat`, and close PuTTY or a second Arduino IDE window before uploading.
* The start-up lines are printed once, 1.5 s after the board starts. To see them again, keep the Serial Monitor open and press the board's reset button: **R** on the XIAO boards, **EN** or **RST** on the others. A XIAO's port disappears for a moment at the reset; the Serial Monitor connects again by itself.
* **Finding the port:** unplug the board, open **Tools → Port**, and plug it in again; the entry that appears is the board.
  * In Windows Device Manager → **Ports (COM & LPT)**, the XIAO boards show as **USB Serial Device (COMx)**.
  * Boards with a USB-to-serial chip show under the chip's name (Silicon Labs CP210x, USB-SERIAL CH340, CH343).
* A charge-only USB cable powers the board but gives no port: use a data cable.

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
1. Connect the XIAO ESP32-C6 to the PC with a USB-C **data** cable.
2. Open `firmware/shiro_wristband_vitals/shiro_wristband_vitals.ino` (or your copy; see "Opening a sketch" in 4.1).
3. In the **Tools** menu, set:

   | Tools menu item | Setting |
   | :--- | :--- |
   | Board | esp32 → **XIAO_ESP32C6** |
   | **USB CDC On Boot** | **Enabled**. Needed for the Serial Monitor. With Disabled, the upload works and the wristband runs, but nothing is printed to the PC. |
   | CPU Frequency | 160MHz (WiFi) |
   | Flash Frequency | 80MHz |
   | Flash Mode | QIO |
   | Flash Size | 4MB (32Mb) |
   | Partition Scheme | Default 4MB with spiffs (1.2MB APP/1.5MB SPIFFS). Huge APP works too. |
   | Upload Speed | 921600 |
   | Core Debug Level | None |
   | Erase All Flash Before Sketch Upload | Disabled |
   | JTAG Adapter | Disabled |
   | Zigbee Mode | Disabled |
   | Port | the XIAO's port (**USB Serial Device (COMx)** in Device Manager) |

4. Click **Upload** (`Ctrl + U`). When the upload finishes, the wristband restarts by itself with the new firmware.
5. Open the Serial Monitor (`Ctrl + Shift + M`) at **115200** baud and press **R** on the XIAO to see the start-up lines.

**If the upload stops** with `Failed to connect` or `No serial data received`:
1. Close every other program that uses the port.
2. Hold the **B** (boot) button, plug the USB cable in, release **B**, and upload again.
3. After this kind of upload, press **R** once so the new firmware starts.

#### What the Serial Monitor shows at power-on (115200 baud):
```
==========================================================
  SHIRO Wristband Tag - Adaptive Telemetry (V5.3 - Protocol 2)
  Hardware: Seeed Studio XIAO ESP32-C6
==========================================================
[OK] MPU-6050 ready: +/-16 g range, WHO_AM_I = 0x68.
[SELF-TEST] Fall detector: PASS (fall: detected, soft fall: detected, short dip: ignored, movement: ignored, arm drop while standing: ignored)
[OK] HW-605 (MAX30102) Initialized.
[OK] Battery Monitoring Initialized: ...V (...%)
[OK] Dual BLE Broadcast + GATT Server Active! MAC: ...
[OK] Telemetry packet version 2, 15 bytes.
>>> Ready: 3-min passive cycle + 1Hz on-demand/fall escalation <<<
```
After that, a status line comes **5 times a second**, the same values the wristband broadcasts:
```
[BROADCAST ...] BPM: 0 | SpO2: 0% | Bat: 85% | G: 1.01 | Motion: STATIONARY [3m SLEEP]
```
* `[3m SLEEP]`: the pulse sensor is resting.
* `[3m BURST]`: it is in a scheduled measurement.
* `[1Hz ACTIVE]`: live mode, started from the dashboard or by a fall.

A fall shows as `[ALERT] *** ON-CHIP KINEMATIC FALL CONFIRMED! ...` with the measured free-fall, impact and stillness values.

**Fall-check lines (V5.2).** Every movement that looks like a drop gives one `[FALL CHECK]` line, whether it raised an alarm or not. The line says how the check ended:

| Line starts with | Meaning |
| :--- | :--- |
| `[FALL CHECK] FALL` | Free-fall, impact and stillness: a fall. The `[ALERT]` line comes with it. |
| `[FALL CHECK] no alarm: MOVING after the impact` | Free-fall and impact were there, but the wrist moved more than the limit afterwards: 0.20 g, or 0.08 g after an impact below 4 g. |
| `[FALL CHECK] no alarm: NO IMPACT` | The free-fall was long enough, but no impact above 2.50 g came within 0.5 s. |
| `[FALL CHECK] no alarm: FREE-FALL TOO SHORT` | An impact came, or the wrist dipped below 0.50 g for 60 ms or more, but it was below 0.50 g for less than 150 ms (0 ms: it never got below 0.50 g). |

Each line also gives:
* the measured values;
* `largest sample gap`: the longest time between two accelerometer readings during the check (normally 20 ms);
* the vitals mode at that moment (`1Hz ACTIVE`, `3m BURST` or `3m SLEEP`).

After a fall, `[FALL] Alert hold over: watching for falls again.` shows when the 45 s hold has ended and the next fall can be detected.

A `[FAIL]` line for a sensor means that sensor is reported as faulty in every packet and shown as **SENSOR FAULT** on the dashboard. The wristband keeps running with the sensors that work.

**If the Serial Monitor stays empty** while the dashboard shows the wristband, check in this order:
1. **USB CDC On Boot** is **Enabled** (Tools menu). If not, set it and upload again. This is the usual cause.
2. **Tools → Port** is the wristband's port, not an anchor's.
3. No other program has the port open (`record_ppg.bat`, PuTTY, another IDE window).
4. Press **R**: the start-up lines come 1.5 s later.

> [!NOTE]
> The "firm shake starts 1 Hz active mode" shortcut is now a bench-test option. It is off by default; set `SHIRO_DEBUG_SHAKE_WAKE` to `1` at the top of the sketch to use it. Start active mode from the dashboard instead.

---

### 4.3 Board 2: Dual-Role Stationary Wall Anchors (ESP32-WROOM-32E, ESP32-S3 or XIAO ESP32-C3)

* **Physical Hardware:** ESP32-WROOM-32E Development Boards (3+ units for 2D trilateration). ESP32-S3 and Seeed XIAO ESP32-C3 boards run the same firmware unchanged (see "Other anchor boards" below).
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
4. Check **Flash Size "4MB (32Mb)"** and **PSRAM "Disabled"**; leave the other items at their first value (table in 4.1).
5. Select **Tools --> Upload Speed --> "921600"**.
6. Select **Tools --> Port** (the board's USB-to-serial chip, CP210x or CH340, e.g., `COM10+`).
7. Click **Upload** (`Ctrl + U`). *(If `Connecting........_____`, press and hold the physical **BOOT** button for 1 second).*
8. Open the Serial Monitor at **115200** baud and press **EN**. The anchor prints:
   * its version (`V4.1`);
   * `[OK] Wi-Fi Connected!` and its MAC address;
   * `[OK] Connected to MQTT Broker!`;
   * a health line every 30 s.

#### Other anchor boards (Phase 10)
There were not enough ESP32-WROOM-32E boards for six anchors, so ESP32-S3 and XIAO ESP32-C3 boards are used as well. The firmware is the same; only the Arduino IDE settings differ. All three compile with the Huge APP partition (checked 20 Nov 2026: S3 36 %, C3 40 % of 3 MB; the C3's default partition would be 97 % full). The full Tools settings of each board are in the table in 4.1.

| Board | Tools → Board | Partition Scheme | USB CDC On Boot | Notes |
| :--- | :--- | :--- | :--- | :--- |
| ESP32-WROOM-32E | ESP32 Dev Module | Huge APP | not in the menu | As above |
| ESP32-S3 (N16R8) | ESP32S3 Dev Module | Huge APP | **Disabled** | Flash Size 16MB, PSRAM Disabled, USB Mode Hardware CDC and JTAG, Upload Mode UART0 / Hardware CDC. Upload and Serial Monitor through the USB-C socket marked **COM**. |
| Seeed XIAO ESP32-C3 | XIAO_ESP32C3, or ESP32C3 Dev Module | Huge APP | **Enabled** (on ESP32C3 Dev Module the menu starts at Disabled: change it) | The board has no antenna of its own: clip the FPC antenna onto its connector **before** powering it. No code change. If upload fails, hold **B** (boot) while plugging in USB, then press **R** after the upload. |

Mounting, for every anchor the same way: board upright against the wall (1–2 cm off it, for example on a foam pad), components facing into the room, antenna end pointing **up**, nothing within 5 cm of the antenna (cables, step-down module, metal). On a XIAO C3, stick the FPC antenna upright above the board. Boards with different antennas read a wristband a few dB stronger or weaker; each anchor's own calibration value (🎯 Calibrate Anchors) takes care of that.

**S3 and C3 need anchor firmware V4.1 or later** (21 Nov 2026). The Arduino-ESP32 core 3.3 uses a different Bluetooth stack on them (NimBLE) than on the WROOM-32E (Bluedroid). With V4, a XIAO C3 restarted about every 25 s (`abort() was called at PC … on core 0`) and passed on about half as many readings as a WROOM: the Bluetooth library kept every device it heard in memory until the memory ran out, and waited for each wristband's scan response. V4.1 scans passively on these boards and keeps no such list. The WROOM-32E runs the same code as before and does not need flashing again.

What V4.1 prints at start and every 30 s:
```
Bluetooth: NimBLE, passive scan.            (WROOM-32E: Bluedroid, active scan.)
[ANCHOR AC:27:6E:... HEALTH] 30 s: 180 wristband advertisements (6.0/s), 950 Bluetooth reports in all. Free memory 112000 bytes (lowest 98000). Wi-Fi -55 dBm, MQTT connected.
```
* **Free memory** must stay about the same from one line to the next. If it keeps falling, something still leaks: report it.
* **Wristband advertisements per second** should be close to a WROOM's next to it (the wristband sends 6–10 a second). Compare the two boards on the same spot.

---

### 4.4 Board 3: LiDAR Room Sensor Node (ESP32-S3 + RPLIDAR C1, Phase 10)

The LiDAR measures distances all around itself in one flat slice, about 10 turns per second. The node sends every turn to the edge server, which finds the people in it and links them to wristbands. No camera and no image: distances only.

* **Hardware:** ESP32-S3 board (tested: ESP32-S3 N16R8) and a SLAMTEC RPLIDAR C1 (model C1M1-R2).
* **Firmware:** `firmware/shiro_lidar_node/shiro_lidar_node.ino`
* **Settings:** copy `firmware/shiro_anchor_node/secrets.h` into `firmware/shiro_lidar_node/` (the same Wi-Fi and MQTT values; the node uses the anchors' MQTT login).

#### Wiring
Unplug the C1's cable from its green USB board (pull the plug, not the wires). The green board is only for connecting the C1 to a PC; keep it for troubleshooting. Plug a strip of five standard 2.54 mm **male pin headers** into the plug: their square pins grip the plug's contacts firmly, while loose round jumper pins add resistance. Solder or screw the wires to the header pins. Connect with everything switched off:

| C1 wire | Connects to |
| :--- | :--- |
| Red (VCC, 5 V) | LM2596S 5 V module **OUT+** |
| Black (GND) | LM2596S **OUT−** and a **GND** pin of the S3 (the grounds must be joined) |
| Yellow (TX, C1 → S3) | S3 **GPIO18** |
| Green (RX, S3 → C1) | S3 **GPIO17** |

The C1's signals are 3.3 V and connect directly. It needs 4.8–5.2 V, up to **800 mA while starting**, and 230–260 mA while scanning (Slamtec datasheet C1M1-R2, rev 1.0). Never power it from the S3's 3V3 pin.

**The supply wires decide whether it works.** At 800 mA, every ohm in the red or black wire costs 0.8 V. Use wires of at least 0.3 mm² (22 AWG), as short as possible (under 30 cm), screwed straight into the module's OUT+ and OUT− terminals: no breadboard and no chain of jumper wires. Give the S3's GND its own wire to OUT−. Then measure red to black **at the C1's plug while the motor turns**: Slamtec specifies at least 4.8 V and above 5 V in normal operation, and the C1 switches its laser off when the supply is low. On 20 Nov 2026, with jumper wires, the module gave 5.08 V but only 4.18 V reached the C1 while it was spinning, and the C1 sent no scan data.

#### Powering the S3
* **While testing (option B):** the S3 runs from its USB-C port marked **COM**: the PC when you want the Serial Monitor, otherwise a phone charger. Its 5V pin stays unconnected.
* **Final installation (option A):** the same LM2596S module also feeds the S3's **5V** pin, so one supply runs both. **Never plug a USB cable into the S3 while its 5V pin is connected to the module**: unplug that wire first.

#### Flashing
1. Plug the S3's **COM** USB-C port into the PC.
2. Arduino IDE, Tools menu (the full list is in the table in 4.1):

   | Tools menu item | Setting |
   | :--- | :--- |
   | Board | **ESP32S3 Dev Module** |
   | USB CDC On Boot | **Disabled** (the log goes to the COM socket) |
   | USB Mode | Hardware CDC and JTAG |
   | Upload Mode | UART0 / Hardware CDC |
   | Flash Size | **16MB (128Mb)** |
   | PSRAM | **Disabled** |
   | Partition Scheme | **Huge APP (3MB No OTA/1MB SPIFFS)** |
   | Upload Speed | 921600; 115200 if the upload stops with an error |
   | Port | the COM port that appeared when you plugged in the **COM** socket |

3. Upload `shiro_lidar_node.ino`, then open the Serial Monitor at **115200** baud and press **RST**.

#### Test, stage 1: on the PC (option B)
With the LM2596S module powered and the S3 on USB, the Serial Monitor shows:
```
[LIDAR] Found: model 0x41, firmware 1.02, hardware 18.
[LIDAR] Health: OK (code 0).
[LIDAR] Scan started. Waiting for the motor to reach its speed (up to 10 s).
[LIDAR] Scanning: first complete turn ... s after the scan command (... points). ...
[OK] Wi-Fi Connected!
[LIDAR NODE ..] SCANNING | 10.0 turns/s | 500 points/turn (... with a distance) | data ... bytes/s, 5000 samples/s | health OK | restarts 0 | sent ..., failed 0 | Wi-Fi -55 dBm | MQTT connected
```
* `No answer from the RPLIDAR C1`: check red/black on the module, yellow → GPIO18, green → GPIO17 (swapped yellow and green is the most common mistake) and the shared ground.
* `No scan data at all ... after the scan command` (and `data 0 bytes/s`): the motor never reached its speed or the C1 switched its laser off. Almost always the supply at the C1's plug: see the wiring note above.
* `... bytes arrived ... but none was a valid sample`: a garbled signal. Check the yellow wire, the shared ground, and keep the signal wires away from the supply wires.
* `Health: ERROR`, a speed well below 10 turns/s, or `restarts` counting up: the supply is too low at the C1's plug. With a multimeter, red to black there should read 4.8 V or more while it spins, normally above 5 V.
* `rc=2: client ID refused`: the edge server is older than Phase 10.
* Dashboard → **Devices**: the node appears in the discovery radar as **🌀 LiDAR** with turns per second and LiDAR health. Enroll it (it becomes `lidar-001`).

#### Test, stage 2: on its own (option A)
1. Unplug the USB cable.
2. Connect the LM2596S **OUT+** to the S3's **5V** pin as well.
3. On the Devices page the `lidar-001` row should come back within about 30 s and stay at about 10 turns/s with health OK for several minutes.

Slamtec advises 2 minutes of warm-up before measuring. Keep the C1 below 40 °C (not in direct sun).

#### Mounting
* The laser slice is about 3 cm above the C1's base. Mount it **level** with the base at about **0.92 m**, so the slice is at about 0.95 m: above beds, chair seats and tables, at the torso of a person standing or sitting.
* Use a small shelf or bracket, a tripod with a small board, or furniture of the right height. The 4 screw holes underneath take **M2.5 screws at most 4 mm deep**; longer screws damage it. Do not screw a tripod's 1/4-inch screw into it.
* Keep the S3 and the module **below** the C1's base, so nothing blocks the laser window. Keep glass and mirrors out of the slice where possible.
* WARD-005 (mounted 21 Nov 2026): against the east wall, centre 1.31 m from the north-east corner and 0.18 m out from the wall, just past the foot of the bed, ▲ on top pointing west (270°, into the room), cable towards the wall. With the partitions now drawn in the south-west corner, this is the planner's spot (4.5): it sees 99.3 % of the floor a person can stand on. The earlier south-wall spot (0.98 m from the south-west corner) now sees only 90.7 %, because the partitions hide the west side. The spot is 0.4 m from the path from the bed's foot to the door, so fix the stand so it cannot be knocked.
* The position that counts is the **centre** of the C1 (the middle of its round top), not its edge. A few centimetres or 1–2° off the plan is fine: 🎯 Align to walls (4.6) finds the real position and heading from the scan.
* Tested on 21 Nov 2026 (firmware 1.0.1): on USB and on its own (S3's 5V pin on the module, no laptop), 10.0 turns/s, about 510 points per turn, 5,093 samples/s, no restarts. 4.62 V at the C1's plug while it spins, still below the 4.8 V minimum: rewire with the pin headers and thicker wires when mounting it for good.

### 4.5 Planning where the anchors and the LiDAR go (Phase 10)

Ward editor → open the ward → Panel 3 → **📐 Plan Anchors & LiDAR**. The server plans for the layout in the editor, saved or not. Nothing is stored until you press **Apply to Ward** and then **Save Changes**.

**Anchors per ward:** 3 to 12. Three is the least that gives a position, and 12 is the most the planner plans. A new ward starts with 6, placed for the default room. Panel 3 does not add a 13th or remove the 3rd, and the server does not store a ward with fewer than 3. The ward templates also have 6 anchors each, where the planner puts them.

**Mounting:** flat on the wall on a 1–2 cm foam pad, **no tilt**. Board upright, antenna end up, components facing into the room, every board the same way. The only angle to set is the facing the planner gives (straight out from the wall). Why no tilt:
* The modules' small antennas have no narrow beam to aim. Their strength changes by a few dB with direction, while the baseline measured 10–22 dB from the body alone.
* From 2.30 m to a wrist at 0.85 m, the patient is 20–55° below the board in WARD-005 (55° at 1 m away, 36° at 2 m, 22° at 3.6 m). That spans the whole lower half of an upright board's coverage, so no single tilt fits.
* Calibration (🎯 Calibrate Anchors) measures each board where it hangs, so a constant difference in antenna gain is absorbed. A flat mount is easy to repeat exactly on six boards and does not sag.
* What matters more: 15 cm below the ceiling, 1–2 cm off the wall, and nothing within 5 cm of the antenna.

**Settings**
* **Anchors:** how many (3–12). The default is 6, or more if the ward already has more.
* **Height:** Auto is 2.40 m, or 15 cm below a lower ceiling (WARD-005: 2.30 m). Never above 3.0 m.
* **Keep … where they are:** plans only the new anchors around the ones already mounted. It is ticked when the ward has anchors bound to boards.
* **Place the LiDAR.**

**What it shows**
* A floor plan coloured by the expected error, with **Suggested** and **Current** views. Anchors are shown blue (keep), amber (move) and green (new), with an arrow the way the board faces. The LiDAR is a purple square with its ▲ direction. Crosses mark floor the LiDAR cannot see; dashed lines are walking routes from a bed to the door.
* Current against suggested: expected error (average and 95 % of the floor), floor with a clear line to 3 or more anchors, and floor the LiDAR sees. "No anchors" is the error when only the room is known.
* One line per device: the wall, the distance from a named corner, the height, and the direction the board faces in words and degrees (0° north, 90° east).
* **🖨️ Print installation sheet:** the plan, the list with a box to tick per device, and mounting notes. Allow pop-ups for the dashboard.

**How it decides**
* **Anchor spots:** every 10 cm along the walls and along the outer faces of tall partitions, pillars and bathrooms. Not within 30 cm of a corner, not within 20 cm of the door, and not behind furniture that reaches the mounting height.
* **Scoring a set of anchors:** the expected position error at wrist height (0.85 m) over a 20 cm floor grid. It uses the lowest error any method can reach from Bluetooth signal strength: the Cramér–Rao bound (Patwari et al., IEEE Trans. Signal Processing, 2003), with a signal spread of 6 dB and a path-loss exponent of 3.2, and the room itself as prior knowledge.
  * An anchor whose line to a point is blocked by tall furniture adds nothing at that point.
  * Door and bed areas count twice.
* **Search:** anchors are added one at a time where they lower the error most, then moved one at a time until no move helps. Anchors stay at least 0.8 m apart.
* **LiDAR spots:** 0.18 m out from the walls, not on furniture and not in the door area. The spot that sees the most floor in the 0.95 m slice wins.
  * Furniture taller than the slice blocks it, and so do tables, because things put on them reach the slice.
  * A spot within 0.5 m of a walking route loses 5 points: it would be knocked over.
* **What the numbers mean:** the expected error is a lower limit, for comparing layouts. Real readings are worse. In WARD-005 the same three anchors were expected at 0.96 m and measured 1.29 m (`docs/test_records/ips-accuracy-10.md`).

**After the plan**
1. **Apply to Ward:** the spots fill Panels 3 and 3b.
2. Print the installation sheet and mount the devices as listed.
3. Bind each new board in Panel 3 and the LiDAR node in Panel 3b, then **Save Changes**.
4. Live Map → **🎯 Calibrate Anchors** (new and moved anchors need it).
5. The LiDAR: learn the empty room and align it to the walls (4.6).

**WARD-005, 21 Nov 2026** (6 anchors, A, B and C kept):

| Device | Where |
| :--- | :--- |
| Anchor D | South wall, 0.80 m from the south-west corner, board centre 2.30 m high |
| Anchor E | North wall, 0.90 m from the north-west corner, 2.30 m high |
| Anchor F | East wall, 1.49 m from the north-east corner, 2.30 m high |
| LiDAR | East wall, 1.31 m from the north-east corner, centre 0.18 m out from the wall, base 0.92 m high, ▲ west (270°) |

Expected error drops from 0.96 m to 0.81 m, and the floor with a clear line to 3 or more anchors goes from 96 % to 100 %.

**Why A, B and C stay where they are:**
* Replanning all six would reach 0.80 m instead of 0.81 m, while moving A, B and C by 0.2–0.7 m each.
* The three are already close to the best spots for three anchors (0.96 m against 0.92 m).
* They stay exactly as in the baseline measurement, so before and after differ only by what was added (anchors D–F and the LiDAR), not by moved boards.
* All six anchors are calibrated again after D–F are mounted. The baseline showed A's and B's calibration made their distances hit the room-size limit.
* A, B and C stay at 2.40 m as measured in the baseline; the 2.30 m rule applies to the new boards.

### 4.6 Setting up the LiDAR in its ward: live scan, empty room, alignment (Phase 10)

Ward editor → the ward → Panel 3b. Under each LiDAR with a node assigned are three tools. The node must be on and scanning (Devices page: about 10 turns/s).

**👁 Live scan** draws the LiDAR's newest turn on the floor plan, three times a second, at the x, y and heading in the panel.
* Grey dots: the room as the LiDAR sees it. They should lie on the drawn walls and on the sides of obstacles taller than the slice (0.95 m). Walls that are doubled, bent or turned mean the x, y or heading in the panel is off.
* Orange dots (once the empty room is learned): something new in the room, normally a person. Walk about and watch your dot follow you.
* Things not drawn in the layout show as grey dots in open floor (a chair, a bin, bed rails above 0.95 m). That is fine.

**🧹 Learn empty room** (admin; save the ward first)
1. Put the furniture where it normally stays and the door as it normally is.
2. Press 🧹 Learn empty room → **▶ Start**, and leave the room within **15 s**. One beep: recording starts.
3. Stay out of the LiDAR's view for **20 s**, until two beeps. The panel then shows "Empty room learned … (about 200 turns, surface in …% of directions)".
4. A warning that directions "changed while learning" means someone or something moved in view: learn again.
* The empty room belongs to the LiDAR where it stands: learn it again after moving the LiDAR or the furniture. Changing x, y or heading in the panel does not spoil it.
* If the LiDAR is knocked or turned later, the panel shows "⚠️ … read farther than the empty room: the LiDAR may have been moved or turned" (a person never causes this). Put it back, align it and learn the empty room again.

**🎯 Align to walls**
1. Press 🎯 Align to walls (after learning the empty room: it uses that; without it, the last 3 s of turns).
2. The fit appears in green on the plan, and the panel shows the new x, y and heading with the change from the panel's values, the share of returns within 5 cm of a drawn wall before and after, and a quality (GOOD, FAIR, POOR).
3. If the green dots lie on the walls: **✅ Use this position**, then **Save Changes**.
* It searches within 0.30 m and 10° of the panel's values. A warning that "the scan fits much better with the ▲ pointing about …" means the heading in the panel is far off: set roughly that heading and align again.
* A low share on the walls usually means the room size or obstacles in the layout differ from the real room: measure them again.

**WARD-005:** learn the empty room and align once, before the "6 anchors" position-test session, so that the LiDAR turns recorded with each run (9.2) come with a correct position and empty room.

### 4.7 Patient positions from the LiDAR (Phase 10, step 5b)

Once a LiDAR is placed, aligned and has its empty room, the server finds the people it sees and links each to a wristband nearby (by position; `docs/protocol.md`, section 5). Nothing has to be switched on.

On the **Live Map**:
* **📡 before the patient's name**, violet dot: the position comes from the LiDAR (about ±0.1 m). The text under the map says "📡 seen by the LiDAR" and how far the Bluetooth estimate is from it; the faint teal circle is that estimate.
* **🛏**: the patient was last seen at the bed and the LiDAR no longer sees them, normally because they lay down (a lying person is below the scan slice). The position stays there until they get up, or until Bluetooth clearly shows they left. Getting up, they are first seen at the bed, on whichever side they get out, and the violet dot goes with them within about 1 s.
* **⏸**: the LiDAR lost the patient away from a bed (someone in front of them, or they went down). The last position is held for 10 s, then Bluetooth.
* **Grey dot, "person (no wristband)"**: someone the LiDAR sees who is not linked to a wristband: a visitor, staff, or a patient whose Bluetooth position is still more than 2 m away.
* No symbol (teal dot, 🔒 when still): Bluetooth only.

How linking behaves:
* A patient who walks in is linked within about 1–2 s, when they are the only person near their wristband's Bluetooth position (within 2 m) or clearly the nearest one.
* While the LiDAR follows them, the link stays, even when Bluetooth is far off.
* Several people close together near one wristband: no link until one is clearly nearer. They show as grey dots, and the patient's dot stays on Bluetooth.
* While a patient lies in bed (🛏), a person counts as that patient getting up only if the LiDAR first saw them **at that bed** (within 0.6 m of it), after the patient lay down. A nurse or visitor who walks up to the bed was first seen where they came into view, usually the door, and stays a grey dot. So does someone who was already in the room, and someone getting out of another bed.
* Known limit: someone the LiDAR first sees right at the bed while the patient lies there is taken for the patient getting up. This happens, for example, when they step out from behind another person standing at the bed.

Door alerts (geofence; only for a wristband bound to a patient, only in a ward with a LiDAR):
* **🚪 AT THE DOOR:** the LiDAR has seen the patient in the door zone (the doorway, reaching 1 m into the room) for 10 s. One per visit to the door; after 3 s back in the room, the next visit can raise its own.
* **🚪 LEFT THE WARD:** the LiDAR lost the patient in the door zone and did not see them again, about 11.5 s after it last saw them. After that, the patient's dot is Bluetooth again, and only a person who comes in through the door is taken for them.
* Both come as an alert with the alarm tone on the dashboard and the headset, and are acknowledged like a fall. No door alert while a headset sees the patient elsewhere in the room.
* The server log shows each one: `[ROOM PEOPLE] The patient of TAG-… has been at the door …` or `… left WARD-… through the door …`, and `… came back into …` when the patient returns.
* The headset shows the kind (AT THE DOOR / LEFT THE WARD) from the next APK build; an older APK shows LEFT THE WARD for both.

Things that stop the LiDAR positions (the map falls back to Bluetooth): the empty room being learned, the "may have been moved" warning (4.6), the node not sending turns. Things that put grey dots where nobody is: furniture moved since the empty room was learned (learn it again).

**Replaying recorded runs:** `node tools/replay_lidar_runs.js <session-id>` (in `edge_server`) runs the LiDAR turns recorded with a position-test session through the same code and prints the errors at the marked spots, next to what the maps showed then. `--csv <file>` writes every reading.

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

### 5.3 Phase 10 additions
* **LiDAR node:** one more LM2596S 5 V module on the 12 V bus feeds the RPLIDAR C1 (and, in the final installation, the S3's 5V pin). The fixed 5 V version of the LM2596S (no adjusting screw) holds 4.8–5.2 V, inside the C1's range. Keep its wires to the C1 short (under 30 cm, at least 0.3 mm², screwed into the module; see 4.4). The C1 adds up to about 0.65 A on the 12 V side while it starts and about 0.2 A while it runs, which a 12 V 2 A adapter covers together with three anchors.
* **Anchors without a step-down module:** a WROOM or ESP32-S3 board runs from a phone charger (5 V, 1 A or more) through its USB port, and a XIAO ESP32-C3 through its USB-C port. Use a cable 2–3 m long to reach the mounting height. A power bank is fine for a quick test only: many switch off at such a low current, and they need daily recharging.

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
| Live Map: the patient stays on Bluetooth (no 📡) and a grey "person (no wristband)" dot is where they stand | The wristband's Bluetooth position is more than 2 m from them, or another person is about as near. | Wait a few seconds; it links when they are the only person within 2 m or clearly the nearest. Check the anchors (🎯 Calibrate Anchors) if Bluetooth is far off everywhere. |
| Live Map: grey dots where nobody is, always at the same place | Something was put in the room after the empty room was learned (a chair, a bag, a stand). | Remove it, or learn the empty room again with the room as it will stay (4.6). |
| Live Map: 📡 positions stop while the LiDAR is scanning | The LiDAR is flagged as probably moved, or its empty room is being learned. | See the warning in Panel 3b (4.6): put the LiDAR back, align it, learn the empty room again. |
| Live Lab simulation button answers "Simulation is disabled" | `ENABLE_SIMULATION=false` in `edge_server/.env`. | Set it to `true` and restart the server. Simulated incidents are always marked as simulated. |
| ESP32 compiler error: `text section exceeds available space in board` | Default 1.3 MB partition table selected. | In Arduino IDE: **Tools --> Partition Scheme --> "Huge APP (3MB No OTA/1MB SPIFFS)"**. |
| Upload works and the board runs (the wristband shows on the dashboard), but the Serial Monitor stays empty | On a XIAO ESP32-C6 or C3: **USB CDC On Boot** is Disabled, so the log goes to pins D6/D7 instead of the USB socket. On an ESP32-S3: the cable is in the wrong socket for the setting. | XIAO: **Tools → USB CDC On Boot → Enabled**, upload again. S3: use the **COM** socket with USB CDC On Boot Disabled. Also check **Tools → Port** and that no other program holds the port (4.1, "Where the Serial Monitor output goes"). |
| Serial Monitor shows only unreadable characters | The baud rate is not 115200 (boards with a USB-to-serial chip: WROOM-32E, S3 on its COM socket). | Set **115200 baud** in the Serial Monitor. |
| Upload: `Failed to connect`, `No serial data received`, or the port is busy | Another program holds the port, the cable is charge-only, or the board is not in its loader. | Close the other Serial Monitor, `record_ppg.bat` or PuTTY. Use a data cable. Hold **BOOT** (**B** on a XIAO) while plugging in or while `Connecting...` shows, then upload; afterwards press reset. Try Upload Speed 115200. |
| An old firmware still runs after uploading (the banner shows the old version) | The upload came from a copy of the sketch with old files, or from another folder than the one edited. | Open the `.ino` in the repository folder, or copy **all** `.h` files of the repository folder into your copy again (4.1, "Opening a sketch"). |
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
| LiDAR node: `No answer from the RPLIDAR C1` on the Serial Monitor | Wiring or power of the C1. | Red/black on the 5 V module, yellow → GPIO18, green → GPIO17 (often swapped), the C1's black wire and the S3's GND joined. See 4.4. |
| LiDAR node: `No scan data at all`, `Health: ERROR`, well below 10 turns/s, or restarts counting up | The C1's supply is too low at its plug; it sends no data until its motor is at speed and switches its laser off to protect itself. | Short wires of at least 0.3 mm² screwed straight into the LM2596S, pin headers in the C1's plug, no breadboard; 4.8 V or more at the C1's plug while it spins (normally above 5 V). See 4.4. |
| Ward editor, LiDAR: "Empty room not learned: Only N turns arrived" | The node stopped sending turns while learning (power, Wi-Fi). | Check the Devices page (about 10 turns/s), then learn again. Nothing was saved. |
| Ward editor, LiDAR: "⚠️ … read farther than the empty room" | The LiDAR was knocked, turned or moved since the empty room was learned (or large furniture was taken out). | Put it back where the panel says; 🎯 Align to walls, Save Changes, 🧹 Learn empty room again. |
| Ward editor, LiDAR: the live scan's walls do not line up with the drawn walls | x, y or heading in Panel 3b differ from where the LiDAR stands, or the room size in the layout is wrong. | 🎯 Align to walls; if it warns about the heading, set the heading the warning gives and align again. |
| Anchor (XIAO C3 or ESP32-S3) restarts every half minute with `abort() was called at PC … on core 0`, loses MQTT, passes on few readings | Anchor firmware V4 on a NimBLE board: the Bluetooth library ran out of memory. | Flash anchor firmware V4.1 or later (4.3, "Other anchor boards"); then 🎯 Calibrate Anchors again. |
| LiDAR node not on the Devices page | No Wi-Fi or MQTT. | The Serial Monitor tells which: Wi-Fi name and password, or `rc=4/5` (MQTT login: copy the anchors' `secrets.h`), or `rc=2` (edge server older than Phase 10). |

---

## 9. Measuring Positioning Accuracy (Position Test, Phase 10)

The position test measures how far the position shown on the maps is from where the wristband really is. The results are saved on the edge server (`edge_server/data/position_tests/`, one file per session) and can be downloaded as CSV for the thesis. A session is one measurement round, for example "Baseline 3 anchors" before a change and "LiDAR + 6 anchors" after it. Measure the same spots in both.

### 9.1 Preparing the room
1. Mark the spots on the floor with tape. Measure each from the south-west corner: **x** from the west wall, **y** from the south wall (the same origin as the ward editor).
2. For WARD-005 (2.29 × 3.39 m):

   | Spot | x, y (m) | Posture |
   | :--- | :--- | :--- |
   | P1 | 0.7, 0.4 | Standing |
   | P2 | 0.7, 1.0 | Standing |
   | P3 | 0.7, 1.6 | Standing |
   | P4 | 0.6, 2.35 | Standing |
   | P5 | 1.2, 2.35 | Standing |
   | P6 | 1.9, 2.35 | Standing |
   | P7 | 1.9, 3.0 (door entry) | Standing |
   | Bed edge | 1.35, 1.0 | Sitting |
   | Bed | 1.74, 1.0 | Lying |
   | Table | 0.8, 2.45 | Sitting |

3. The anchors must be calibrated (🎯 Calibrate Anchors) and the wristband switched on and visible on the Live Map.

### 9.2 Running the test
1. Dashboard → **Wards** → the ward → **Live Map** → **📏 Position test**.
2. **Session:** ➕ New session, with a name such as `Baseline 3 anchors`. Later runs: choose the session in the list.
3. **Wristband:** the wristband you wear.
4. **Spot:** type the name (`P1`) and x, y, or press **📍 Pick on map** and click the spot. Spots used before in the session appear as buttons below.
5. **Facing:** the direction your body faces (N = towards the north wall). **Posture:** standing, sitting or lying.
6. **▶ Start run.** Walk to the spot within the countdown (10 s). One beep: recording starts. Stand still with your arm relaxed at your side for the recording time (20 s). Two beeps: done.
7. The run appears in the table with its mean error, 95 % error and the share of readings in the correct zone. After a run facing N, E or S, the next facing is chosen for you, so the four runs of a spot need only ▶ Start run.
8. A run spoiled by a mistake: 🗑 removes it. A run in progress: **✕ Cancel this run** (nothing is kept).
9. At the end: **⬇ Summary CSV** (one row per run, then ALL, STANDING and SITTING+LYING) and **⬇ All readings CSV** (every reading: the position shown and its source, the Bluetooth-only position, the raw solver position before smoothing, the zone, the motion state and every anchor's RSSI).
10. **LiDAR:** when the ward has a LiDAR (Panel 3b), its turns are recorded with every run, from the start of the countdown to the end, with where it stands, its empty room and the wristband's positions. A 🌀 after the spot shows a run with LiDAR turns; the summary CSV has a column "LiDAR turns recorded" (about 10 per second). The files are in `edge_server/data/position_tests/` (`<session>-run<n>.lidar.json.gz`), for working out the LiDAR's accuracy against the marked spots. Removing a run removes its file.

Each reading counts as available when the wristband had a position in this ward that was at most 3.5 s old. The error is the straight-line distance from the marked spot. The zones are the beds (0.3 m around them), the door (1 m into the room) and the rest of the room.
