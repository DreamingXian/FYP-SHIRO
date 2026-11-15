# SHIRO Security Model and Known Limits

This document states what the system protects against, how, and what it does not protect against. It covers the edge server, the anchors and the local network. Clinician login is not yet part of the system (planned as Stage B).

## 1. Assumptions

- SHIRO runs on one closed Wi-Fi network (WPA2) used by the edge server PC, the anchors and the headset. Nothing is exposed to the internet.
- The edge server PC is trusted: whoever can log in to it can read every database and configuration file.
- Anyone else on the same Wi-Fi network is not trusted.

## 2. What is protected, and how

| Threat | Protection | Where |
| :--- | :--- | :--- |
| A device on the network sends false telemetry or false falls over MQTT | The broker accepts only the anchor login and an anchor client ID. Without them the connection is refused | `edge_server/services/mqtt_access.js` |
| A logged-in client sends to a topic it should not use (for example a 1 Hz command) or reads other anchors' messages | Anchors may publish only to the telemetry and discovery topics and subscribe only under `shiro/control/`. A forbidden publish closes the connection; a forbidden subscription is refused | `mqtt_access.js` |
| One anchor reports under another anchor's address | `anchor_mac` must be the MAC address in the sender's client ID | `services/mqtt_service.js` |
| Password guessing on the broker | 10 failed logins from one address within a minute lock that address out for 60 seconds. Passwords are compared in constant time and never logged | `mqtt_access.js` |
| Malformed or oversized MQTT, HTTP or WebSocket input | Every input is checked for type, format, range and size before use. See Phase 4 in the remediation record | `utils/validate.js`, `utils/http.js`, `services/telemetry/anchor_message.js` |
| Script injected through patient names or other text (stored XSS) | The dashboard writes every server value as text. No values in inline event handlers | `public/js/html_safety.js` |
| Files written outside the upload folder, or uploads that are not images | The server checks the image signature, builds the file name itself and checks the final path | `services/patient_service.js` |
| Query injection into InfluxDB | Fixed list of time ranges; IDs and tag values validated and escaped | `services/time_series_service.js` |
| Another website controls the dashboard API or WebSocket from the user's browser | Cross-site requests and WebSocket connections are refused; no CORS | `routes/index.js`, `services/websocket_service.js` |
| The databases are read or changed from another device | MySQL and InfluxDB listen on `127.0.0.1` only. Windows Firewall allows only ports 3000 (dashboard) and 1883 (MQTT), and only on private networks | `my.ini`, `edge_server/tools/start_influxdb.bat`, firewall rules (`SYSTEM_STARTUP_PROCEDURE.md`, section 3.2) |
| A fault in the server exposes data through its own account | The server uses the `shiro_app` MySQL account: data access and schema changes in `shiro_db` only, no right to drop tables or reach other databases | `SYSTEM_STARTUP_PROCEDURE.md`, section 3.2 |
| Secrets in the repository | Passwords, tokens and Wi-Fi settings live only in the git-ignored `edge_server/.env` and `firmware/shiro_anchor_node/secrets.h`. The history was cleaned of earlier secrets | `.gitignore` |

## 3. Known limits

These are accepted for a prototype on a closed network. Each is a candidate for future work.

1. **No encryption on the local network (no TLS).** MQTT, HTTP and WebSocket traffic is plain text on the Wi-Fi. WPA2 keeps outsiders out, but a device that has joined the Wi-Fi can read patient data in transit and capture the anchor login when an anchor connects. *Future work:* MQTT over TLS (port 8883) and HTTPS with a local certificate authority.
2. **BLE advertisements are not authenticated.** The wristband broadcasts its vitals and fall flag openly. A nearby device can copy a wristband's address and broadcast false vitals or a false fall, and anyone nearby can read the values. *Future work:* a message authentication code (for example a truncated HMAC with a per-wristband key and a counter) in the packet. The 31-byte advertisement still has 11 bytes free.
3. **One shared anchor login.** All anchors use the same MQTT username and password. If one board is stolen, the login can be read from its flash memory (flash encryption is not enabled) and every anchor must be reflashed with a new password. Separate logins per anchor would limit the damage to one board but would need a different `secrets.h` for each board.
4. **No clinician login yet.** Anyone on the Wi-Fi who opens `http://<server>:3000` can use the dashboard, including admitting and discharging patients. Planned as Stage B.
5. **MySQL `root` has no password.** It can be used only on the edge server PC itself, because MySQL listens on `127.0.0.1` only and phpMyAdmin answers local requests only. A program or person on that PC can still use it. Setting a root password is described in `SYSTEM_STARTUP_PROCEDURE.md`, section 3.2.
6. **The 1 Hz command reaches every anchor.** All anchors subscribe to `shiro/control/mode` and the command names the one that must act. The command contains only device addresses, no patient data.
7. **The lockout works per network address.** A device on the Wi-Fi that guesses passwords locks out only its own address. It cannot lock out the anchors, which have their own addresses.

## 4. Changing a secret

| Secret | Where it is used | How to change it |
| :--- | :--- | :--- |
| MQTT anchor password | `.env` (`MQTT_ANCHOR_PASSWORD`) and `secrets.h` (`SHIRO_MQTT_PASSWORD`) | Generate a new one (section 3.2 of the startup guide), put it in both files, restart the server, reflash every anchor |
| MySQL `shiro_app` password | `.env` (`DB_PASSWORD`) and the MySQL account | `ALTER USER 'shiro_app'@'127.0.0.1' IDENTIFIED BY '<new password>';` in phpMyAdmin, then update `.env` and restart the server |
| InfluxDB token | `.env` (`INFLUX_TOKEN`) | InfluxDB web page, Load Data, API Tokens: create a new token, delete the old one, update `.env` |
