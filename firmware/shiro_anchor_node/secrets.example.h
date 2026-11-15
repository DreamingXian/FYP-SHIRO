// =============================================================================
// SHIRO Anchor Node - site settings
// Copy this file to secrets.h (same folder) and fill in your own values.
// secrets.h is git-ignored and must never be committed.
// =============================================================================
#pragma once

#define SHIRO_WIFI_SSID     "YOUR_WIFI_SSID"   // 2.4 GHz network name
#define SHIRO_WIFI_PASSWORD "YOUR_WIFI_PASSWORD"   // Wi-Fi password
#define SHIRO_MQTT_SERVER   "192.168.1.100"   // IPv4 address of the edge server PC
#define SHIRO_MQTT_PORT     1883

// MQTT login: exactly the values of MQTT_ANCHOR_USER and MQTT_ANCHOR_PASSWORD
// in edge_server/.env. All anchors use the same login.
#define SHIRO_MQTT_USER     "YOUR_MQTT_ANCHOR_USER"
#define SHIRO_MQTT_PASSWORD "YOUR_MQTT_ANCHOR_PASSWORD"
