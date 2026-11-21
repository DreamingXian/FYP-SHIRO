// =============================================================================
// SHIRO LiDAR Node - site settings
// The same values as the anchors: copy firmware/shiro_anchor_node/secrets.h
// into this folder, or copy this file to secrets.h and fill in your values.
// secrets.h is git-ignored and must never be committed.
// =============================================================================
#pragma once

#define SHIRO_WIFI_SSID     "YOUR_WIFI_SSID"   // 2.4 GHz network name
#define SHIRO_WIFI_PASSWORD "YOUR_WIFI_PASSWORD"   // Wi-Fi password
#define SHIRO_MQTT_SERVER   "192.168.1.100"   // IPv4 address of the edge server PC
#define SHIRO_MQTT_PORT     1883

// MQTT login: exactly the values of MQTT_ANCHOR_USER and MQTT_ANCHOR_PASSWORD
// in edge_server/.env. The LiDAR node uses the anchors' login.
#define SHIRO_MQTT_USER     "YOUR_MQTT_ANCHOR_USER"
#define SHIRO_MQTT_PASSWORD "YOUR_MQTT_ANCHOR_PASSWORD"
