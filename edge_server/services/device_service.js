// =============================================================================
// SHIRO Hospital Edge Server - Device Fleet Registry Service
// Manages Hardware Devices (Wristbands, Anchors, Edge Nodes, Headsets) & Discovery
// =============================================================================

const logger = require('../utils/logger');
const { getPool } = require('../database/db');
const { broadcastToClients } = require('./websocket_service');

// In-memory buffer for unprovisioned devices heard over MQTT / BLE in the last 10 minutes
const discoveredDevices = new Map();

// In-memory lookup cache for enrolled devices, keyed by MAC address (with and
// without separators) and by device ID. It is the only lookup on the telemetry
// path: no database query per MQTT message.
const enrolledDevicesByMac = new Map();

function cacheEnrolledDevice(r) {
  if (r.mac_address) {
    const clean = r.mac_address.toUpperCase().trim();
    enrolledDevicesByMac.set(clean, r);
    enrolledDevicesByMac.set(clean.replace(/[:-]/g, ''), r);
  }
  if (r.device_id) {
    enrolledDevicesByMac.set(r.device_id.toUpperCase().trim(), r);
  }
}

/**
 * Synchronizes the in-memory enrolled device cache from MySQL.
 * Throws when the database cannot be read, so start-up fails visibly.
 */
async function syncEnrolledDevicesCache() {
  const pool = getPool();
  const [rows] = await pool.query('SELECT device_id, mac_address, device_type, status, availability_status FROM devices');
  enrolledDevicesByMac.clear();
  for (const r of rows) cacheEnrolledDevice(r);
}

// -----------------------------------------------------------------------------
// Presence writes. Every MQTT message used to read and update the devices table
// (about 80 queries per second with 3 anchors). Now:
//  - a status change (ONLINE, CHARGING, OFFLINE) is written at once;
//  - last seen, IP address and battery are kept here and written together every
//    PRESENCE_FLUSH_MS. The OFFLINE timeout (OFFLINE_AFTER_MS) is longer than
//    that, so a device that keeps sending is never marked offline.
// -----------------------------------------------------------------------------
const PRESENCE_FLUSH_MS = 5000;
const OFFLINE_AFTER_MS = 12000;
const pendingPresence = new Map(); // device_id -> { lastSeenMs, ip, battery }
const lastSeenMs = new Map();      // device_id -> time of the last message, in memory
let presenceTimer = null;
let presenceFlush = null;          // the flush in progress, if any

const queryCounter = { statusWrites: 0, presenceWrites: 0, presenceFlushes: 0 };

function addPresence(deviceId, now, ip, battery) {
  const entry = pendingPresence.get(deviceId) || { lastSeenMs: 0, ip: null, battery: null };
  entry.lastSeenMs = Math.max(entry.lastSeenMs, now);
  if (ip) entry.ip = ip;
  if (battery !== undefined && battery !== null) entry.battery = battery;
  pendingPresence.set(deviceId, entry);
}

/**
 * Writes the presence data collected since the last flush: one UPDATE per
 * device that sent something. On a database error the data is kept for the
 * next flush (newer values win).
 */
function flushPresence() {
  if (presenceFlush) return presenceFlush;
  if (pendingPresence.size === 0) return Promise.resolve(0);

  const batch = new Map(pendingPresence);
  pendingPresence.clear();
  presenceFlush = (async () => {
    const pool = getPool();
    let written = 0;
    for (const [deviceId, entry] of batch) {
      try {
        await pool.query(
          `UPDATE devices SET last_seen = FROM_UNIXTIME(?),
             ip_address = COALESCE(?, ip_address),
             battery_level = COALESCE(?, battery_level)
           WHERE device_id = ?`,
          [entry.lastSeenMs / 1000, entry.ip, entry.battery, deviceId]
        );
        written++;
        queryCounter.presenceWrites++;
      } catch (err) {
        // Keep it for the next flush unless newer data has arrived meanwhile
        const newer = pendingPresence.get(deviceId);
        if (!newer) pendingPresence.set(deviceId, entry);
        if (logger.every('presence-flush-error', 30000)) {
          logger.error(`[DEVICE SERVICE] Could not write device presence (${err.code || err.message}). Kept in memory and retried every ${PRESENCE_FLUSH_MS / 1000} s.`);
        }
      }
    }
    queryCounter.presenceFlushes++;
    return written;
  })().finally(() => { presenceFlush = null; });
  return presenceFlush;
}

function startPresenceWriter(intervalMs = PRESENCE_FLUSH_MS) {
  if (presenceTimer) return presenceTimer;
  presenceTimer = setInterval(() => { flushPresence(); }, intervalMs);
  return presenceTimer;
}

/** Shutdown: stops the timer and writes what is still waiting. */
async function stopPresenceWriter() {
  if (presenceTimer) {
    clearInterval(presenceTimer);
    presenceTimer = null;
  }
  if (presenceFlush) await presenceFlush;
  return flushPresence();
}

function getPresenceStats() {
  return { ...queryCounter, pending: pendingPresence.size };
}

/** Writes a status change at once. The cache holds the status last written. */
async function writeStatusChange(dev, status, now, ip, battery) {
  const previous = dev.status;
  dev.status = status; // set first, so the next messages do not write the same change again
  pendingPresence.delete(dev.device_id);
  try {
    await getPool().query(
      `UPDATE devices SET status = ?, last_seen = FROM_UNIXTIME(?),
         ip_address = COALESCE(?, ip_address),
         battery_level = COALESCE(?, battery_level)
       WHERE device_id = ?`,
      [status, now / 1000, ip || null, battery === undefined ? null : battery, dev.device_id]
    );
    queryCounter.statusWrites++;
    if (previous !== status) logger.info(`[DEVICE] ${dev.device_id} ${previous || 'UNKNOWN'} -> ${status}`);
  } catch (err) {
    dev.status = previous; // not written: the next message tries again
    if (logger.every('status-write-error', 30000)) {
      logger.error(`[DEVICE SERVICE] Could not write the status of ${dev.device_id} (${err.code || err.message}).`);
    }
  }
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
    is_charging: data.is_charging !== undefined ? data.is_charging : (existing.is_charging || false),
    ip_address: data.ip_address || existing.ip_address || null,
    status_text: data.status_text || (data.is_charging ? 'CHARGING' : (existing.status_text || null)),
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
        is_charging: record.is_charging,
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
      p.full_name AS bound_patient_name,
      (SELECT CONCAT(wa.ward_id, ' · ', wa.anchor_id) FROM ward_anchors wa WHERE wa.device_id = d.device_id LIMIT 1) AS anchor_slot,
      (SELECT CONCAT(rs.ward_id, ' · ', rs.sensor_id) FROM ward_room_sensors rs WHERE rs.device_id = d.device_id LIMIT 1) AS sensor_slot
    FROM devices d
    LEFT JOIN ward_rooms w ON d.assigned_ward_id = w.ward_id
    -- The patient wearing the wristband now (at most one ACTIVE binding per wristband)
    LEFT JOIN patient_bindings pb ON pb.device_id = d.device_id AND pb.status = 'ACTIVE'
    LEFT JOIN patients p ON p.patient_id = pb.patient_id
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
  cacheEnrolledDevice({
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
 * A wristband's binding history is kept: an active binding is ended first (UNBOUND,
 * with the time and who deleted it), then the rows keep the copied MAC address and
 * their device_id becomes NULL (foreign key ON DELETE SET NULL).
 * deletedBy: the signed-in clinician (actor label), or null when unknown.
 */
async function deleteDevice(deviceId, deletedBy = null) {
  const pool = getPool();
  const conn = await pool.getConnection();
  let mac = null;
  try {
    await conn.beginTransaction();
    const [existing] = await conn.query('SELECT mac_address FROM devices WHERE device_id = ? LIMIT 1 FOR UPDATE', [deviceId]);
    if (existing.length === 0) {
      throw new Error(`Device "${deviceId}" not found.`);
    }
    mac = existing[0].mac_address;
    await conn.query(
      `UPDATE patient_bindings SET status = 'UNBOUND', unbound_at = NOW(), unbound_by = ?
       WHERE device_id = ? AND status = 'ACTIVE'`,
      [deletedBy || null, deviceId]
    );
    await conn.query('DELETE FROM devices WHERE device_id = ?', [deviceId]);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  await syncEnrolledDevicesCache();
  try {
    await require('./binding_cache').refresh();
  } catch (err) {
    logger.warn('[DEVICE SERVICE] Binding cache refresh failed:', err.message);
  }

  pendingPresence.delete(deviceId);
  lastSeenMs.delete(deviceId);

  // Automatically purge deleted device from real-time IPS localization memory
  try {
    const ipsService = require('./ips_service');
    ipsService.purgeTag(deviceId, mac);
  } catch (err) {
    logger.warn(`[DEVICE SERVICE] ${deviceId} was deleted, but could not be removed from the live map:`, err);
  }

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
  } else if (deviceType === 'HEADSET') {
    prefix = 'QUEST3-';
    padLen = 3;
  } else if (deviceType === 'ROOM_SENSOR') {
    prefix = 'lidar-';
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
    // 1. Enrolled device? Looked up in the cache, by MAC address (the hardware
    //    identity) or else by device ID. No database query per message.
    const dev = metadata.mac ? findEnrolledDeviceByMac(metadata.mac) : findEnrolledDeviceByMac(deviceIdOrAlias);

    if (dev) {
      const now = Date.now();
      const effectiveStatus = metadata.status || 'ONLINE';
      lastSeenMs.set(dev.device_id, now);
      if (effectiveStatus !== dev.status) {
        await writeStatusChange(dev, effectiveStatus, now, metadata.ip, metadata.battery_level);
      } else {
        addPresence(dev.device_id, now, metadata.ip, metadata.battery_level);
      }

      // Broadcast heartbeat over WebSocket to web dashboard
      broadcastToClients({
        type: 'DEVICE_HEARTBEAT',
        device_id: dev.device_id,
        device_type: dev.device_type,
        status: effectiveStatus,
        last_seen: new Date().toLocaleTimeString(),
        battery_level: metadata.battery_level,
        is_charging: metadata.is_charging || (effectiveStatus === 'CHARGING'),
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
      if (metadata.rssi !== undefined) {
        effectiveRssi = metadata.rssi;
      }

      recordDiscoveredDevice({
        mac: derivedMac,
        suggested_id: suggestedId,
        device_type: deviceType,
        hardware_model: metadata.model || (deviceType === 'ANCHOR' ? 'ESP32-WROOM-32E' : 'Seeed Studio XIAO ESP32-C6'),
        rssi: effectiveRssi,
        detected_by_anchor: metadata.detected_by_anchor || null,
        battery_level: metadata.battery_level,
        is_charging: metadata.is_charging || false,
        ip_address: metadata.ip || null,
        status_text: metadata.status || metadata.status_text || null
      });
    }
  } catch (err) {
    logger.error('[DEVICE SERVICE] recordActiveDeviceTraffic error:', err.message);
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
      const cached = findEnrolledDeviceByMac(deviceIdOrAlias);
      if (cached) cached.status = 'OFFLINE';
      pendingPresence.delete(deviceIdOrAlias);
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
    logger.warn(`[DEVICE SERVICE] Could not handle disconnect for ${deviceIdOrAlias}:`, err.message);
  }
}

/**
 * Updates an existing device status (e.g. OFFLINE on disconnect).
 */
async function updateDeviceStatus(deviceId, _status) {
  return handleDeviceDisconnect(deviceId);
}

// =============================================================================
// Live Freshness Watchdog (Runs every 2 seconds)
// Immediately detects power loss / unplugging of hardware
// =============================================================================
let freshnessTimer = null;

async function runFreshnessCheck() {
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

  // 2. Mark enrolled devices OFFLINE if no packet in 12 seconds (absorbs normal Wi-Fi jitter).
  //    The database holds last_seen up to PRESENCE_FLUSH_MS late, so a device heard
  //    more recently according to memory is left alone.
  try {
    const [stale] = await pool.query(
      `SELECT device_id, device_type FROM devices WHERE status IN ('ONLINE', 'CHARGING') AND last_seen < (NOW() - INTERVAL ? SECOND)`,
      [OFFLINE_AFTER_MS / 1000]
    );
    for (const d of stale) {
      if (now - (lastSeenMs.get(d.device_id) || 0) <= OFFLINE_AFTER_MS) continue;
      await pool.query(`UPDATE devices SET status = 'OFFLINE' WHERE device_id = ? AND status IN ('ONLINE', 'CHARGING')`, [d.device_id]);
      const cached = findEnrolledDeviceByMac(d.device_id);
      if (cached) cached.status = 'OFFLINE';
      pendingPresence.delete(d.device_id);
      logger.info(`[DEVICE] ${d.device_id} OFFLINE (nothing received for ${OFFLINE_AFTER_MS / 1000} s)`);
      broadcastToClients({
        type: 'DEVICE_HEARTBEAT',
        device_id: d.device_id,
        device_type: d.device_type,
        status: 'OFFLINE'
      });
    }
  } catch (err) {
    if (logger.every('freshness-check-error', 30000)) {
      logger.error(`[DEVICE SERVICE] Offline check failed (${err.code || err.message}). Device status may be out of date until the database answers.`);
    }
  }
}

/**
 * Starts the 2-second freshness watchdog. Called once from server.js at start-up,
 * so that loading this module has no side effects.
 */
function startFreshnessWatchdog(intervalMs = 2000) {
  if (freshnessTimer) return freshnessTimer;
  freshnessTimer = setInterval(runFreshnessCheck, intervalMs);
  return freshnessTimer;
}

function stopFreshnessWatchdog() {
  if (freshnessTimer) {
    clearInterval(freshnessTimer);
    freshnessTimer = null;
  }
}

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
  syncEnrolledDevicesCache,
  startFreshnessWatchdog,
  stopFreshnessWatchdog,
  startPresenceWriter,
  stopPresenceWriter,
  flushPresence,
  getPresenceStats,
  PRESENCE_FLUSH_MS,
  OFFLINE_AFTER_MS
};

