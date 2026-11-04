// =============================================================================
// SHIRO Central Ward Management System - Real-Time IPS Localization Service
// Robust 2D Weighted Multilateration, Median+Kalman Filtering & Offline Handling
// =============================================================================
const { getPool } = require('../database/db');
const { KalmanFilter1D, calculateDistance, getCalibration } = require('./kalman_filter');
const { broadcastToClients } = require('./websocket_service');
const deviceService = require('./device_service');

// Zero-latency in-memory lookup caches
let anchorToWardMap = new Map(); // Key: MAC or DeviceId -> { ward_id, anchor_id, device_id, x, y, z }
let wardDimensionsMap = new Map(); // Key: ward_id -> { length_x, width_y, height_z, room_title, max_diagonal }

// Active Tag Readings Buffer: wardId -> tagId -> anchorDeviceId -> { rawRssi, filteredRssi, distance, timestamp }
const tagReadings = new Map();

// 5-sample Sliding Window Median Filter Buffer per (anchorDeviceId, tagId)
const tagMedianBuffers = new Map();

// Dedicated Kalman Filter per (anchorDeviceId, tagId)
const tagKalmanFilters = new Map();

// Smoothed 2D Position Cache per tagId: { x, y, ward_id, tag_mac, status, confidence, last_seen, last_broadcast }
const tagSmoothedPositions = new Map();

// Maximum time (ms) before an anchor signal is deemed stale
const STALE_TIMEOUT_MS = 3500;
// Time (ms) without packets before a tag is marked OFFLINE (keeps last position on map)
const OFFLINE_TIMEOUT_MS = 5000;
// Minimum interval (ms) between WebSocket position broadcasts per tag (~6.7 Hz)
const MIN_BROADCAST_INTERVAL_MS = 140;

function getFilterKey(anchorDeviceId, tagId) {
  return `${anchorDeviceId}__${tagId}`;
}

/**
 * Computes median of a numeric array
 */
function getMedian(arr) {
  if (!arr || arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Filter raw RSSI through 5-sample Rolling Median followed by 1D Kalman Filter
 */
function filterRssi(anchorDeviceId, tagId, rawRssi) {
  const key = getFilterKey(anchorDeviceId, tagId);

  // 1. Sliding Window Median Filter (rejects sudden NLOS dropouts / multipath impulse spikes)
  if (!tagMedianBuffers.has(key)) tagMedianBuffers.set(key, []);
  const window = tagMedianBuffers.get(key);
  window.push(rawRssi);
  if (window.length > 5) window.shift();
  const medianRssi = getMedian(window);

  // 2. 1D Kalman Filter (smooths residual Gaussian noise)
  if (!tagKalmanFilters.has(key)) {
    // Q = 0.04 (process noise), R = 2.5 (measurement noise), initial estimate = medianRssi
    tagKalmanFilters.set(key, new KalmanFilter1D(2.5, 0.04, medianRssi));
  }
  const kf = tagKalmanFilters.get(key);
  return kf.update(medianRssi);
}

/**
 * Geometry-Aware Distance Calculation with Physical Room Capping
 */
function calculateBoundedDistance(filteredRssi, maxDiagonal = 5.5) {
  const cal = getCalibration(); // A: -58, n: 2.4
  // Standard Log-Distance Path Loss
  const exp = (cal.A - filteredRssi) / (10.0 * cal.n);
  const rawDist = Math.pow(10, exp);

  // PHYSICAL BOUNDING: In an enclosed room, Euclidean distance can NEVER exceed the room's diagonal!
  // NLOS/body shadowing causes RSSI drops (-80 dBm) that yield impossible distances (10m - 12m).
  // We cap at maxDiagonal so NLOS does not blow up the multilateration matrix.
  const safeCap = Math.max(1.0, maxDiagonal);
  const boundedDist = Math.min(rawDist, safeCap);
  return Math.round(boundedDist * 100) / 100;
}

/**
 * Reload anchor geometry and ward boundaries from MySQL
 */
async function reloadWardAnchorsCache() {
  try {
    const pool = getPool();
    const [rooms] = await pool.query('SELECT ward_id, room_title, length_x, width_y, height_z FROM ward_rooms');
    const newWardMap = new Map();
    for (const r of rooms) {
      const lx = parseFloat(r.length_x) || 6.40;
      const wy = parseFloat(r.width_y) || 4.80;
      const hz = parseFloat(r.height_z) || 2.60;
      const maxDiag = Math.sqrt(lx * lx + wy * wy);
      newWardMap.set(r.ward_id, {
        length_x: lx,
        width_y: wy,
        height_z: hz,
        room_title: r.room_title || 'Ward',
        max_diagonal: maxDiag
      });
    }
    wardDimensionsMap = newWardMap;

    const [anchors] = await pool.query(`
      SELECT 
        wa.anchor_id, wa.ward_id, wa.device_id, wa.mac_address, wa.x, wa.y, wa.z, wa.wall_location,
        d.mac_address AS dev_mac
      FROM ward_anchors wa
      LEFT JOIN devices d ON wa.device_id = d.device_id
      WHERE wa.device_id IS NOT NULL AND wa.device_id != ''
    `);

    const newAnchorMap = new Map();
    for (const a of anchors) {
      const data = {
        anchor_id: a.anchor_id,
        ward_id: a.ward_id,
        device_id: a.device_id,
        mac_address: (a.mac_address || a.dev_mac || '').toUpperCase(),
        x: parseFloat(a.x) || 0.0,
        y: parseFloat(a.y) || 0.0,
        z: parseFloat(a.z) || 1.80,
        wall_location: a.wall_location || ''
      };

      if (a.device_id) newAnchorMap.set(a.device_id.toLowerCase(), data);
      if (a.device_id) newAnchorMap.set(a.device_id.toUpperCase(), data);
      if (data.mac_address) newAnchorMap.set(data.mac_address, data);
      if (data.mac_address) newAnchorMap.set(data.mac_address.replace(/:/g, ''), data);
    }
    anchorToWardMap = newAnchorMap;

    console.log(`[IPS ENGINE] Cached ${anchors.length} assigned anchors across ${rooms.length} wards.`);
  } catch (err) {
    console.warn('[IPS ENGINE] Failed to reload ward anchors cache:', err.message);
  }
}

/**
 * 2D Weighted Multilateration (WLS):
 * Anchors with stronger signals (shorter distances) receive exponentially higher weights.
 * This prevents a single obstructed / NLOS anchor from skewing the true position.
 */
function solveWeightedTrilateration(anchorPoints) {
  if (!anchorPoints || anchorPoints.length < 3) return null;

  // Sort anchors so reference anchor (index 0) has the strongest signal (lowest distance)
  const sorted = [...anchorPoints].sort((a, b) => a.d - b.d);
  const ref = sorted[0];

  let ata11 = 0, ata12 = 0, ata21 = 0, ata22 = 0;
  let atb1 = 0, atb2 = 0;

  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i];
    const row1 = 2 * (a.x - ref.x);
    const row2 = 2 * (a.y - ref.y);
    const b = (a.x * a.x - ref.x * ref.x) + (a.y * a.y - ref.y * ref.y) + (ref.d * ref.d - a.d * a.d);

    // Inverse distance squared weight: W_i = 1 / (d_ref * d_i)^1.5
    const weight = 1.0 / Math.pow(Math.max(0.4, ref.d * a.d), 1.5);

    ata11 += row1 * row1 * weight;
    ata12 += row1 * row2 * weight;
    ata21 += row2 * row1 * weight;
    ata22 += row2 * row2 * weight;

    atb1 += row1 * b * weight;
    atb2 += row2 * b * weight;
  }

  const det = ata11 * ata22 - ata12 * ata21;
  if (Math.abs(det) < 1e-5) {
    return computeWeightedCentroid(sorted);
  }

  const x = (atb1 * ata22 - atb2 * ata12) / det;
  const y = (ata11 * atb2 - ata21 * atb1) / det;
  return { x, y };
}

/**
 * Bounded Non-Linear Geometric Refinement:
 * Starting from initial coordinates, takes a few gradient descent steps
 * to minimize true Euclidean distance error strictly within room bounds.
 */
function refinePositionWithinRoom(initialPos, anchorPoints, roomDim) {
  let curX = Math.max(0.15, Math.min(roomDim.length_x - 0.15, initialPos.x));
  let curY = Math.max(0.15, Math.min(roomDim.width_y - 0.15, initialPos.y));

  const alpha = 0.08; // Small step size for stability
  const iterations = 8;

  for (let iter = 0; iter < iterations; iter++) {
    let gradX = 0;
    let gradY = 0;

    for (const a of anchorPoints) {
      const dx = curX - a.x;
      const dy = curY - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > 0.05) {
        const err = dist - a.d;
        // Weight inversely by measured distance
        const w = 1.0 / Math.max(0.2, a.d * a.d);
        gradX += 2 * w * err * (dx / dist);
        gradY += 2 * w * err * (dy / dist);
      }
    }

    curX -= alpha * gradX;
    curY -= alpha * gradY;

    // Strict physical room bounding
    curX = Math.max(0.15, Math.min(roomDim.length_x - 0.15, curX));
    curY = Math.max(0.15, Math.min(roomDim.width_y - 0.15, curY));
  }

  return { x: curX, y: curY };
}

/**
 * Fallback: Distance-Weighted Centroid
 */
function computeWeightedCentroid(anchorPoints) {
  let sumWeight = 0;
  let wx = 0;
  let wy = 0;

  for (const a of anchorPoints) {
    const weight = 1.0 / Math.max(0.2, a.d * a.d);
    sumWeight += weight;
    wx += a.x * weight;
    wy += a.y * weight;
  }

  if (sumWeight <= 0) return { x: anchorPoints[0].x, y: anchorPoints[0].y };
  return { x: wx / sumWeight, y: wy / sumWeight };
}

/**
 * Record an incoming anchor RSSI packet and compute real-time tag position
 */
function recordAnchorReading({ anchorId, anchorMac, tagId, tagMac, rawRssi, timestamp }) {
  if (!tagId || isNaN(rawRssi) || rawRssi >= 0 || rawRssi < -110) return;

  const now = timestamp || Date.now();
  const cleanMac = tagMac ? tagMac.toUpperCase().trim() : null;
  const cleanAnchorMac = anchorMac ? anchorMac.toUpperCase().trim() : null;

  // 1. CANONICAL TAG RESOLUTION:
  // If tagMac belongs to an enrolled device (e.g. TAG-002), always use that canonical ID!
  let canonicalTagId = tagId;
  if (cleanMac) {
    const enrolled = deviceService.findEnrolledDeviceByMac(cleanMac);
    if (enrolled && enrolled.device_id) {
      canonicalTagId = enrolled.device_id;
    }
  }

  // 2. GHOST / RAW MAC PURGE:
  // If this device was previously buffered under its raw MAC address (e.g. "58:E6:C5:1B:80:4E"),
  // purge the raw MAC entry so it never appears as a phantom third tag!
  if (cleanMac && canonicalTagId !== cleanMac) {
    if (tagSmoothedPositions.has(cleanMac)) {
      tagSmoothedPositions.delete(cleanMac);
      broadcastToClients({
        type: 'IPS_TAG_PURGE',
        tag_id: cleanMac,
        canonical_id: canonicalTagId
      });
    }
  }

  // 3. Resolve anchor metadata from cache
  let anchorMeta = null;
  if (cleanAnchorMac && anchorToWardMap.has(cleanAnchorMac)) {
    anchorMeta = anchorToWardMap.get(cleanAnchorMac);
  } else if (anchorId && anchorToWardMap.has(anchorId.toLowerCase())) {
    anchorMeta = anchorToWardMap.get(anchorId.toLowerCase());
  } else if (cleanAnchorMac) {
    anchorMeta = anchorToWardMap.get(cleanAnchorMac.replace(/:/g, ''));
  }

  if (!anchorMeta || !anchorMeta.ward_id) return;

  const wardId = anchorMeta.ward_id;
  const devId = anchorMeta.device_id || anchorId;
  const wardDim = wardDimensionsMap.get(wardId) || { length_x: 6.40, width_y: 4.80, max_diagonal: 8.0 };

  // 4. Two-stage filtering: 5-sample Rolling Median -> 1D Kalman Filter
  const filteredRssi = filterRssi(devId, canonicalTagId, rawRssi);
  // 5. Geometry-Aware Distance Calculation with Diagonal Bounding
  const distance = calculateBoundedDistance(filteredRssi, wardDim.max_diagonal);

  // Store reading in buffer under canonicalTagId
  if (!tagReadings.has(wardId)) tagReadings.set(wardId, new Map());
  const wardTags = tagReadings.get(wardId);

  // Clean raw MAC key if present
  if (cleanMac && wardTags.has(cleanMac)) {
    wardTags.delete(cleanMac);
  }

  if (!wardTags.has(canonicalTagId)) wardTags.set(canonicalTagId, new Map());
  const anchorMap = wardTags.get(canonicalTagId);

  anchorMap.set(devId, {
    anchor_id: anchorMeta.anchor_id,
    device_id: devId,
    mac: cleanAnchorMac || anchorMeta.mac_address,
    x: anchorMeta.x,
    y: anchorMeta.y,
    z: anchorMeta.z,
    rawRssi,
    filteredRssi: Math.round(filteredRssi * 10) / 10,
    distance,
    timestamp: now
  });

  // Collect fresh anchor readings (< 3.5 seconds)
  const freshAnchors = [];
  for (const [aId, reading] of anchorMap.entries()) {
    if (now - reading.timestamp <= STALE_TIMEOUT_MS) {
      freshAnchors.push({
        anchor_id: reading.anchor_id,
        device_id: aId,
        x: reading.x,
        y: reading.y,
        d: reading.distance,
        rssi: reading.filteredRssi,
        raw_rssi: reading.rawRssi,
        last_seen_ms: now - reading.timestamp
      });
    }
  }

  if (freshAnchors.length === 0) return;

  // 6. Multilateration Solving
  let solved = null;
  let confidence = 'LOW';

  if (freshAnchors.length >= 3) {
    const rawWls = solveWeightedTrilateration(freshAnchors);
    if (rawWls) {
      // Non-linear bounded geometric refinement
      solved = refinePositionWithinRoom(rawWls, freshAnchors, wardDim);
      confidence = 'HIGH';
    }
  } else if (freshAnchors.length === 2) {
    solved = computeWeightedCentroid(freshAnchors);
    confidence = 'MEDIUM';
  } else {
    solved = { x: freshAnchors[0].x, y: freshAnchors[0].y };
    confidence = 'APPROXIMATE';
  }

  if (!solved || isNaN(solved.x) || isNaN(solved.y)) return;

  // 7. Adaptive Exponential Moving Average (EMA) Smoothing:
  // Small displacement: heavy smoothing (alpha = 0.18) to freeze RF jitter.
  // Large displacement (> 0.6m): higher alpha (0.42) for prompt walking responsiveness.
  let smoothX = solved.x;
  let smoothY = solved.y;

  const prevSmoothed = tagSmoothedPositions.get(canonicalTagId);
  if (prevSmoothed && prevSmoothed.ward_id === wardId) {
    const dx = solved.x - prevSmoothed.x;
    const dy = solved.y - prevSmoothed.y;
    const disp = Math.sqrt(dx * dx + dy * dy);
    const alpha = disp > 0.60 ? 0.42 : 0.18;

    smoothX = alpha * solved.x + (1 - alpha) * prevSmoothed.x;
    smoothY = alpha * solved.y + (1 - alpha) * prevSmoothed.y;
  }

  smoothX = Math.round(smoothX * 100) / 100;
  smoothY = Math.round(smoothY * 100) / 100;

  // Update position cache
  tagSmoothedPositions.set(canonicalTagId, {
    x: smoothX,
    y: smoothY,
    raw_x: Math.round(solved.x * 100) / 100,
    raw_y: Math.round(solved.y * 100) / 100,
    ward_id: wardId,
    tag_mac: cleanMac || '',
    status: 'ONLINE',
    confidence,
    last_seen: now,
    last_broadcast: prevSmoothed?.last_broadcast || 0
  });

  // 8. Rate-limited WebSocket broadcast (~6.7 Hz)
  const lastPub = prevSmoothed?.last_broadcast || 0;
  if (now - lastPub >= MIN_BROADCAST_INTERVAL_MS) {
    tagSmoothedPositions.get(canonicalTagId).last_broadcast = now;

    broadcastToClients({
      type: 'IPS_POSITION_UPDATE',
      ward_id: wardId,
      tag_id: canonicalTagId,
      tag_mac: cleanMac || '',
      x: smoothX,
      y: smoothY,
      raw_x: Math.round(solved.x * 100) / 100,
      raw_y: Math.round(solved.y * 100) / 100,
      status: 'ONLINE',
      confidence,
      anchors_used: freshAnchors.map(a => ({
        anchor_id: a.anchor_id,
        device_id: a.device_id,
        rssi: a.rssi,
        distance: a.d,
        last_seen_ms: a.last_seen_ms
      })),
      calibration: getCalibration(),
      timestamp: now
    });
  }
}

/**
 * Background Offline Watchdog:
 * Runs every 2 seconds. If a tag has not received any packet for > OFFLINE_TIMEOUT_MS,
 * marks its status as OFFLINE and broadcasts the last known position to the client!
 */
setInterval(() => {
  const now = Date.now();
  for (const [tagId, pos] of tagSmoothedPositions.entries()) {
    if (pos.status === 'ONLINE' && (now - pos.last_seen > OFFLINE_TIMEOUT_MS)) {
      pos.status = 'OFFLINE';
      pos.confidence = 'LAST_KNOWN';

      broadcastToClients({
        type: 'IPS_POSITION_UPDATE',
        ward_id: pos.ward_id,
        tag_id: tagId,
        tag_mac: pos.tag_mac,
        x: pos.x,
        y: pos.y,
        status: 'OFFLINE',
        confidence: 'LAST_KNOWN',
        anchors_used: [],
        timestamp: pos.last_seen
      });
    }
  }
}, 2000);

/**
 * Retrieve the latest known position for a specific tag
 */
function getTagPosition(tagId) {
  return tagSmoothedPositions.get(tagId) || null;
}

/**
 * Retrieve all currently localized tags inside a specific ward
 */
function getWardTagPositions(wardId) {
  const result = [];
  for (const [tagId, pos] of tagSmoothedPositions.entries()) {
    if (pos.ward_id === wardId) {
      result.push({ tag_id: tagId, ...pos });
    }
  }
  return result;
}

module.exports = {
  reloadWardAnchorsCache,
  recordAnchorReading,
  solveWeightedTrilateration,
  getTagPosition,
  getWardTagPositions
};
