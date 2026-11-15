# SHIRO Security Model and Known Limits

This document states what the system protects against, how, and what it does not protect against. It covers the edge server, the anchors, the headset, the dashboard and the local network.

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
| Anyone on the Wi-Fi uses the dashboard or the API | Every API address and the WebSocket need a signed-in clinician (session cookie) or a paired headset (token). Only sign-in and headset pairing are open | `services/auth/permissions.js`, `routes/index.js` |
| A clinician does what only an admin should (accounts, devices, wards, anchor calibration) | Two roles, `ADMIN` and `CLINICIAN`, checked on the server for every request and WebSocket command; a headset may only read wards, patients and alerts, acknowledge alerts and save its spatial anchor | `services/auth/permissions.js` |
| Stolen or guessed passwords | Passwords are stored as salted scrypt hashes, never logged or returned; at least 10 characters; 5 wrong attempts lock the account for 5 minutes; the same answer for an unknown username and a wrong password | `services/auth/passwords.js`, `services/auth/auth_service.js` |
| A stolen session | The session token is random (256 bits), kept in an `HttpOnly`, `SameSite=Strict` cookie that page scripts cannot read; only its SHA-256 hash is stored; it ends after 12 hours, at sign-out, on deactivation and on a password reset | `services/auth/auth_service.js`, `services/auth/request_auth.js` |
| Someone claims the first admin account | The first admin can only be created from the server PC itself (`localhost`), and only while no account exists | `routes/auth_routes.js` |
| An unknown headset connects, or a headset pretends to be another | A headset is paired once with a 6-digit code an admin creates (valid 5 minutes, single use; 5 wrong codes lock that address for 5 minutes) and then uses its own token; it may only report its own device ID; revoking the pairing disconnects it at once | `services/auth/auth_service.js`, `routes/headset_routes.js`, `services/websocket_service.js` |
| Nobody knows who changed a record | Every change through the API, every sign-in (also failed ones), account change and headset pairing is written to `audit_log` with the clinician or headset, the time and the address. Only identifiers are copied, never passwords or free text | `services/audit_service.js` |
| Patient photos read without sign-in | `/uploads/` is served only to a signed-in clinician or a paired headset | `routes/index.js` |

## 3. Known limits

These are accepted for a prototype on a closed network. Each is a candidate for future work.

1. **No encryption on the local network (no TLS).** MQTT, HTTP and WebSocket traffic is plain text on the Wi-Fi. WPA2 keeps outsiders out, but a device that has joined the Wi-Fi can read patient data in transit and capture the anchor login when an anchor connects, a clinician's password when they sign in, a session cookie or a headset token. *Future work:* MQTT over TLS (port 8883) and HTTPS with a local certificate authority; the session cookie would then also get the `Secure` flag.
2. **BLE advertisements are not authenticated.** The wristband broadcasts its vitals and fall flag openly. A nearby device can copy a wristband's address and broadcast false vitals or a false fall, and anyone nearby can read the values. *Future work:* a message authentication code (for example a truncated HMAC with a per-wristband key and a counter) in the packet. The 31-byte advertisement still has 11 bytes free.
3. **One shared anchor login.** All anchors use the same MQTT username and password. If one board is stolen, the login can be read from its flash memory (flash encryption is not enabled) and every anchor must be reflashed with a new password. Separate logins per anchor would limit the damage to one board but would need a different `secrets.h` for each board.
4. **Minimal sign-in.** Two roles only, no password expiry, no two-factor sign-in, no single sign-on with a hospital directory. The headset is trusted as a device: whoever wears a paired headset acts as that headset (recorded as "QUEST3-… (paired by …)"), not as a named clinician. The headset token is stored in the headset's app preferences without extra encryption. *Future work:* clinician sign-in on the headset, hospital directory sign-in.
5. **MySQL `root` has no password.** It can be used only on the edge server PC itself, because MySQL listens on `127.0.0.1` only and phpMyAdmin answers local requests only. A program or person on that PC can still use it. Setting a root password is described in `SYSTEM_STARTUP_PROCEDURE.md`, section 3.2.
6. **The 1 Hz command reaches every anchor.** All anchors subscribe to `shiro/control/mode` and the command names the one that must act. The command contains only device addresses, no patient data.
7. **The lockout works per network address.** A device on the Wi-Fi that guesses passwords locks out only its own address. It cannot lock out the anchors, which have their own addresses.

## 4. Changing a secret

| Secret | Where it is used | How to change it |
| :--- | :--- | :--- |
| MQTT anchor password | `.env` (`MQTT_ANCHOR_PASSWORD`) and `secrets.h` (`SHIRO_MQTT_PASSWORD`) | Generate a new one (section 3.2 of the startup guide), put it in both files, restart the server, reflash every anchor |
| MySQL `shiro_app` password | `.env` (`DB_PASSWORD`) and the MySQL account | `ALTER USER 'shiro_app'@'127.0.0.1' IDENTIFIED BY '<new password>';` in phpMyAdmin, then update `.env` and restart the server |
| InfluxDB token | `.env` (`INFLUX_TOKEN`) | InfluxDB web page, Load Data, API Tokens: create a new token, delete the old one, update `.env` |
| A clinician's password | `clinicians` table (hash only) | Dashboard, ADMIN tab, Reset password. The account is signed out everywhere |
| A headset's token | The headset's app preferences; hash in `headset_pairings` | Dashboard, ADMIN tab, Revoke; then pair the headset again with a new code |
