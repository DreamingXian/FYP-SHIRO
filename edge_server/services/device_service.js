// =============================================================================
// SHIRO Hospital Edge Server - Device Fleet Registry Service
// Manages Hardware Devices (Wristbands, Anchors, Edge Nodes, Headsets) & Discovery
// =============================================================================

const { getPool } = require('../database/db');
const { broadcastToClients } = require('./websocket_service');

// In-memory buffer for unprovisioned devices heard over MQTT / BLE in the last 10 minutes
const discoveredDevices = new Map();

// In-memory lookup cache for enrolled devices keyed by physical MAC address
const enrolledDevicesByMac = new Map();

/**
 * Synchronizes the in-memory enrolled device cache from MySQL.
 */
async function syncEnrolledDevicesCache() {
  try {
    const pool = getPool();
    const [rows] = await pool.query('SELECT device_id, mac_address, device_type, status, availability_status FROM devices');
    enrolledDevicesByMac.clear();
    for (const r of rows) {
      if (r.mac_address) {
        const clean = r.mac_address.toUpperCase().trim();
        enrolledDevicesByMac.set(clean, r);
        enrolledDevicesByMac.set(clean.replace(/[:-]/g, ''), r);
      }
      if (r.device_id) {
        enrolledDevicesByMac.set(r.device_id.toUpperCase().trim(), r);
      }
    }
  } catch (_) {}
}

/**
 * Returns an enrolled device record by physical MAC address, or null if unprovisioned.
 */
function findEnrolledDeviceByMac(mac) {
  if (!mac) return null;
  const clean = mac.toUpperCase().trim();
  return enrolledDevicesByMac.get(clean) || enrolledDevicesByMac.get(clean.replace(/[:-]/g, '')) || null;
}

/**
 * Records or refreshes a detected unprovisioned device in the discovery radar.
 */
function recordDiscoveredDevice(data) {
  if (!data || !data.mac) return;
  const mac = data.mac.toUpperCase().trim();

  const existing = discoveredDevices.get(mac) || {};
  const now = Date.now();
  const lastBroadcast = existing._last_broadcast || 0;

  // Preserve existing RSSI if incoming packet didn't supply one (e.g. Gateway physiological telemetry)
  const effectiveRssi = data.rssi !== undefined 
    ? data.rssi 
    : (existing.rssi !== undefined ? existing.rssi : null);

  const record = {
    mac: mac,
    suggested_id: data.suggested_id || existing.suggested_id || null,
    device_type: data.device_type || existing.device_type || 'WRISTBAND',
    hardware_model: data.hardware_model || existing.hardware_model || 'XIAO ESP32-C6',
    rssi: effectiveRssi,
    detected_by_anchor: data.detected_by_anchor || existing.detected_by_anchor || null,
    battery_level: data.battery_level !== undefined ? data.battery_level : (existing.battery_level || null),
    ip_address: data.ip_address || existing.ip_address || null,
    status_text: data.status_text || existing.status_text || null,
    first_detected: existing.first_detected || new Date().toLocaleTimeString(),
    last_detected: new Date().toISOString(),
    _last_broadcast: lastBroadcast
  };

  discoveredDevices.set(mac, record);

  // Throttle WebSocket discovery broadcasts to at most once per 1200ms per node
  // This prevents UI jitter, DOM thrashing, and unclickable buttons when nodes stream at 7 Hz
  if (now - lastBroadcast >= 1200) {
    record._last_broadcast = now;
    broadcastToClients({
      type: 'DISCOVERY_RADAR',
      device: {
        mac: record.mac,
        suggested_id: record.suggested_id,
        device_type: record.device_type,
        hardware_model: record.hardware_model,
        rssi: record.rssi,
        detected_by_anchor: record.detected_by_anchor,
        battery_level: record.battery_level,
        ip_address: record.ip_address,
        status_text: record.status_text,
        first_detected: record.first_detected,
        last_detected: record.last_detected
      }
    });
  }
}

/**
 * Clears an enrolled device from the unprovisioned discovery radar.
 */
function removeDiscoveredDevice(mac) {
  if (!mac) return;
  discoveredDevices.delete(mac.toUpperCase().trim());
}

/**
 * Returns all currently detected unprovisioned devices not yet in MySQL.
 */
async function getUnprovisionedDevices() {
  const pool = getPool();
  const [rows] = await pool.query('SELECT mac_address FROM devices');
  const enrolledMacs = new Set(rows.map(r => r.mac_address.toUpperCase()));

  const now = Date.now();
  const result = [];

  for (const [mac, dev] of discoveredDevices.entries()) {
    // Drop records older than 12 seconds (node powered off / disconnected)
    const ageMs = now - new Date(dev.last_detected).getTime();
    if (ageMs > 12000) {
      discoveredDevices.delete(mac);
      continue;
    }

    if (!enrolledMacs.has(mac)) {
      result.push(dev);
    }
  }

  // Only return REAL live broadcasting devices (no benchmark / dummy fallbacks)
  return result;
}

/**
 * Lists all registered devices in the fleet, optionally filtered by type.
 */
async function listDevices(typeFilter = 'ALL', statusFilter = 'ALL') {
  const pool = getPool();
  let query = `
    SELECT 
      d.device_id,
      d.mac_address,
      d.device_type,
      d.hardware_model,
      d.firmware_version,
      d.ip_address,
      d.assigned_ward_id,
      d.battery_level,
      d.status,
      d.availability_status,
      d.last_seen,
      d.created_at,
      w.room_title AS ward_title,
      p.patient_id AS bound_patient_id,
      p.full_name AS bound_patient_name
    FROM devices d
    LEFT JOIN ward_rooms w ON d.assigned_ward_id = w.ward_id
    LEFT JOIN patients p ON (p.status = 'ADMITTED' AND (p.assigned_bed_id = d.device_id OR p.patient_id = d.device_id))
    WHERE 1=1
  `;
  const params = [];

  if (typeFilter && typeFilter !== 'ALL') {
    query += ` AND d.device_type = ?`;
    params.push(typeFilter);
  }

  if (statusFilter && statusFilter !== 'ALL') {
    query += ` AND d.status = ?`;
    params.push(statusFilter);
  }

  query += ` ORDER BY d.device_type ASC, d.device_id ASC`;

  const [rows] = await pool.query(query, params);
  return rows;
}

/**
 * Enrolls a new device into the MySQL registry.
 */
async function enrollDevice(data) {
  if (!data.device_id || !data.mac_address || !data.device_type) {
    throw new Error('Device ID, MAC address, and Device Type are required.');
  }

  const pool = getPool();
  const cleanMac = data.mac_address.toUpperCase().trim();
  const cleanId = data.device_id.trim();

  // Check duplicate MAC
  const [existing] = await pool.query('SELECT device_id FROM devices WHERE mac_address = ? LIMIT 1', [cleanMac]);
  if (existing.length > 0) {
    throw new Error(`Device with MAC "${cleanMac}" already enrolled as "${existing[0].device_id}".`);
  }

  // Check duplicate ID
  let assignedId = cleanId;
  if (!assignedId) {
    assignedId = await getNextDeviceId(data.device_type);
  }

  const [existingId] = await pool.query('SELECT device_id FROM devices WHERE device_id = ? LIMIT 1', [assignedId]);
  if (existingId.length > 0) {
    throw new Error(`Device ID "${assignedId}" is already in use.`);
  }

  const insertSql = `
    INSERT INTO devices (
      device_id,
      mac_address,
      device_type,
      hardware_model,
      firmware_version,
      ip_address,
      assigned_ward_id,
      battery_level,
      status,
      availability_status
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
  `;

  await pool.query(insertSql, [
    assignedId,
    cleanMac,
    data.device_type,
    data.hardware_model || 'ESP32',
    data.firmware_version || 'v1.0.0',
    data.ip_address || null,
    data.battery_level !== undefined ? data.battery_level : null,
    data.status || 'ONLINE',
    data.availability_status || 'AVAILABLE'
  ]);

  removeDiscoveredDevice(cleanMac);
  enrolledDevicesByMac.set(cleanMac, {
    device_id: assignedId,
    mac_address: cleanMac,
    device_type: data.device_type,
    status: data.status || 'ONLINE',
    availability_status: data.availability_status || 'AVAILABLE'
  });

  return {
    success: true,
    device_id: assignedId,
    message: `Device ${assignedId} [${cleanMac}] enrolled successfully.`
  };
}

/**
 * Updates an existing device's details (availability status, maintenance notes).
 */
async function updateDevice(deviceId, updateData) {
  const pool = getPool();

  const [existing] = await pool.query('SELECT * FROM devices WHERE device_id = ? LIMIT 1', [deviceId]);
  if (existing.length === 0) {
    throw new Error(`Device "${deviceId}" not found.`);
  }
  const current = existing[0];

  const updateSql = `
    UPDATE devices SET
      hardware_model = ?,
      firmware_version = ?,
      availability_status = ?
    WHERE device_id = ?
  `;

  await pool.query(updateSql, [
    updateData.hardware_model || current.hardware_model,
    updateData.firmware_version || current.firmware_version,
    updateData.availability_status || current.availability_status || 'AVAILABLE',
    deviceId
  ]);

  return {
    success: true,
    message: `Device ${deviceId} updated successfully.`
  };
}

/**
 * Deletes a device from the registry and immediately purges it from IPS live maps.
 */
async function deleteDevice(deviceId) {
  const pool = getPool();
  const [existing] = await pool.query('SELECT mac_address FROM devices WHERE device_id = ? LIMIT 1', [deviceId]);
  const mac = existing.length > 0 ? existing[0].mac_address : null;

  const [result] = await pool.query('DELETE FROM devices WHERE device_id = ?', [deviceId]);
  if (result.affectedRows === 0) {
    throw new Error(`Device "${deviceId}" not found.`);
  }
  await syncEnrolledDevicesCache();

  // Automatically purge deleted device from real-time IPS localization memory
  try {
    const ipsService = require('./ips_service');
    ipsService.purgeTag(deviceId, mac);
  } catch (_) {}

  return {
    success: true,
    message: `Device "${deviceId}" permanently removed from fleet.`
  };
}

/**
 * Generates next sequential device ID suggestion based on type.
 * When devices are unprovisioned, every device of that category receives the same
 * next available ID (e.g. anchor-001). Once enrolled, it increments to anchor-002, etc.
 */
async function getNextDeviceId(deviceType) {
  const pool = getPool();
  let prefix = 'DEV-';
  let padLen = 3;

  if (deviceType === 'ANCHOR') {
    prefix = 'anchor-';
    padLen = 3;
  } else if (deviceType === 'WRISTBAND') {
    prefix = 'TAG-';
    padLen = 3;
  } else if (deviceType === 'EDGE_NODE') {
    prefix = 'EDGE-';
    padLen = 3;
  } else if (deviceType === 'HEADSET') {
    prefix = 'QUEST3-';
    padLen = 3;
  }

  const [rows] = await pool.query('SELECT device_id FROM devices WHERE device_type = ?', [deviceType]);

  let maxNum = 0;
  for (const r of rows) {
    const id = r.device_id || '';
    // Match trailing digits e.g. anchor-001 -> 1, TAG-002 -> 2
    const match = id.match(/(\d+)$/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > maxNum) maxNum = num;
    } else {
      // Fallback for legacy letters like anchor-A -> 1, anchor-B -> 2
      const letterMatch = id.match(/-([A-Za-z])$/);
      if (letterMatch) {
        const letterVal = letterMatch[1].toUpperCase().charCodeAt(0) - 64;
        if (letterVal > maxNum) maxNum = letterVal;
      }
    }
  }

  const nextNum = maxNum + 1;
  return `${prefix}${String(nextNum).padStart(padLen, '0')}`;
}

/**
 * Automatically updates device status to ONLINE in MySQL and notifies frontend,
 * or adds unprovisioned devices to the discovery radar.
 */
async function recordActiveDeviceTraffic(deviceIdOrAlias, deviceType, metadata = {}) {
  const pool = getPool();
  try {
    // 1. Search if device exists in MySQL by physical MAC address (definitive hardware identity)
    let rows = [];
    const searchMac = metadata.mac ? metadata.mac.toUpperCase().trim() : null;

    if (searchMac) {
      [rows] = await pool.query(
        'SELECT device_id, mac_address, device_type, status, availability_status FROM devices WHERE UPPER(mac_address) = ? LIMIT 1',
        [searchMac]
      );
    } else {
      [rows] = await pool.query(
        'SELECT device_id, mac_address, device_type, status, availability_status FROM devices WHERE device_id = ? LIMIT 1',
        [deviceIdOrAlias]
      );
    }

    if (rows.length > 0) {
      const dev = rows[0];
      if (dev.mac_address) {
        enrolledDevicesByMac.set(dev.mac_address.toUpperCase().trim(), dev);
      }
      let updateSql = `UPDATE devices SET status = 'ONLINE', last_seen = NOW()`;
      const params = [];

      if (metadata.ip) {
        updateSql += `, ip_address = ?`;
        params.push(metadata.ip);
      }
      if (metadata.battery_level !== undefined && metadata.battery_level !== null) {
        updateSql += `, battery_level = ?`;
        params.push(metadata.battery_level);
      }

      updateSql += ` WHERE device_id = ?`;
      params.push(dev.device_id);

      await pool.query(updateSql, params);

      // Broadcast heartbeat over WebSocket to web dashboard
      broadcastToClients({
        type: 'DEVICE_HEARTBEAT',
        device_id: dev.device_id,
        device_type: dev.device_type,
        status: 'ONLINE',
        availability_status: dev.availability_status || 'AVAILABLE',
        last_seen: new Date().toLocaleTimeString(),
        battery_level: metadata.battery_level,
        rssi: metadata.rssi
      });
    } else {
      // 2. Unprovisioned device detected! Add to discovery radar
      let targetMac = metadata.mac ? metadata.mac.toUpperCase().trim() : null;
      let existingRecord = targetMac ? discoveredDevices.get(targetMac) : null;

      let suggestedId = existingRecord?.suggested_id;
      const isMacPattern = deviceIdOrAlias && /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/.test(deviceIdOrAlias);
      if (!suggestedId) {
        const [isTaken] = await pool.query('SELECT device_id FROM devices WHERE device_id = ? LIMIT 1', [deviceIdOrAlias]);
        if (!isTaken.length && deviceIdOrAlias && !deviceIdOrAlias.startsWith('DEV-') && !deviceIdOrAlias.startsWith('TAG-C6-01') && !isMacPattern) {
          suggestedId = deviceIdOrAlias;
        } else {
          suggestedId = await getNextDeviceId(deviceType);
        }
      }

      // Extract clean physical MAC if available
      let derivedMac = targetMac;
      if (!derivedMac) {
        const hex12 = (deviceIdOrAlias || '').match(/([0-9A-Fa-f]{12})$/);
        if (hex12) {
          derivedMac = hex12[1].match(/.{1,2}/g).join(':').toUpperCase();
        } else {
          derivedMac = (deviceType === 'ANCHOR' 
            ? `ANCHOR-${suggestedId.toUpperCase().replace(/^ANCHOR-/, '')}`
            : `DEV-${suggestedId.toUpperCase()}`);
        }
      }

      // Purge any temporary ANCHOR- or DEV- placeholder keys
      for (const [k] of discoveredDevices.entries()) {
        if (k.startsWith('ANCHOR-') || k.startsWith('DEV-')) {
          discoveredDevices.delete(k);
        }
      }

      // Calculate realistic RSSI
      let effectiveRssi = undefined;
      if (deviceType === 'EDGE_NODE') {
        effectiveRssi = null; // Wi-Fi / LAN, no BLE RSSI
      } else if (metadata.rssi !== undefined) {
        effectiveRssi = metadata.rssi;
      }

      recordDiscoveredDevice({
        mac: derivedMac,
        suggested_id: suggestedId,
        device_type: deviceType,
        hardware_model: metadata.model || (deviceType === 'ANCHOR' ? 'ESP32-WROOM-32E' : deviceType === 'EDGE_NODE' ? 'ESP32-S3-N16R8' : 'Seeed Studio XIAO ESP32-C6'),
        rssi: effectiveRssi,
        detected_by_anchor: metadata.detected_by_anchor || null,
        battery_level: metadata.battery_level,
        ip_address: metadata.ip || null,
        status_text: metadata.status_text || null
      });
    }
  } catch (err) {
    console.error('[DEVICE SERVICE] recordActiveDeviceTraffic error:', err.message);
  }
}

/**
 * Handles explicit or timed-out disconnection of a hardware node.
 */
async function handleDeviceDisconnect(deviceIdOrAlias) {
  const pool = getPool();
  try {
    // 1. If enrolled in MySQL, flip status to OFFLINE
    const [rows] = await pool.query(
      'SELECT device_id, device_type FROM devices WHERE device_id = ? LIMIT 1',
      [deviceIdOrAlias]
    );

    if (rows.length > 0) {
      await pool.query('UPDATE devices SET status = "OFFLINE" WHERE device_id = ?', [deviceIdOrAlias]);
      broadcastToClients({
        type: 'DEVICE_HEARTBEAT',
        device_id: deviceIdOrAlias,
        device_type: rows[0].device_type,
        status: 'OFFLINE'
      });
    }

    // 2. If unprovisioned in radar, drop immediately
    let changed = false;
    for (const [mac, dev] of discoveredDevices.entries()) {
      if (dev.suggested_id === deviceIdOrAlias || dev.mac.includes(deviceIdOrAlias)) {
        discoveredDevices.delete(mac);
        changed = true;
      }
    }
    if (changed) {
      broadcastToClients({
        type: 'DISCOVERY_RADAR_SYNC',
        unprovisioned: Array.from(discoveredDevices.values())
      });
    }
  } catch (err) {
    console.warn(`[DEVICE SERVICE] Could not handle disconnect for ${deviceIdOrAlias}:`, err.message);
  }
}

/**
 * Updates an existing device status (e.g. OFFLINE on disconnect).
 */
async function updateDeviceStatus(deviceId, status) {
  return handleDeviceDisconnect(deviceId);
}

// =============================================================================
// Live Freshness Watchdog (Runs every 2 seconds)
// Immediately detects power loss / unplugging of hardware
// =============================================================================
setInterval(async () => {
  const now = Date.now();
  const pool = getPool();

  // 1. Drop stale unprovisioned radar items if no packet in 12 seconds
  let radarChanged = false;
  for (const [mac, dev] of discoveredDevices.entries()) {
    const ageMs = now - new Date(dev.last_detected).getTime();
    if (ageMs > 12000) {
      discoveredDevices.delete(mac);
      radarChanged = true;
    }
  }
  if (radarChanged) {
    broadcastToClients({
      type: 'DISCOVERY_RADAR_SYNC',
      unprovisioned: Array.from(discoveredDevices.values())
    });
  }

  // 2. Mark enrolled devices OFFLINE if no packet in 12 seconds (absorbs normal Wi-Fi jitter)
  try {
    const [stale] = await pool.query(
      `SELECT device_id, device_type FROM devices WHERE status = 'ONLINE' AND last_seen < (NOW() - INTERVAL 12 SECOND)`
    );
    for (const d of stale) {
      await pool.query(`UPDATE devices SET status = 'OFFLINE' WHERE device_id = ?`, [d.device_id]);
      broadcastToClients({
        type: 'DEVICE_HEARTBEAT',
        device_id: d.device_id,
        device_type: d.device_type,
        status: 'OFFLINE'
      });
    }
  } catch (_) {}
}, 2000);

setTimeout(syncEnrolledDevicesCache, 1000);

module.exports = {
  recordDiscoveredDevice,
  removeDiscoveredDevice,
  getUnprovisionedDevices,
  listDevices,
  enrollDevice,
  updateDevice,
  deleteDevice,
  getNextDeviceId,
  recordActiveDeviceTraffic,
  updateDeviceStatus,
  handleDeviceDisconnect,
  findEnrolledDeviceByMac,
  syncEnrolledDevicesCache
};

