// =============================================================================
// SHIRO Central Ward Management System - Real-Time IPS Localization Service
// 2D Kalman-Filtered Multilateration & Tag Tracking Engine
// =============================================================================
const { getPool } = require('../database/db');
const { KalmanFilter1D, calculateDistance, getCalibration } = require('./kalman_filter');
const { broadcastToClients } = require('./websocket_service');

// Caches for quick zero-latency lookup during high-speed MQTT packet streaming
let anchorToWardMap = new Map(); // Key: MAC or DeviceId -> { ward_id, anchor_id, device_id, x, y, z }
let wardDimensionsMap = new Map(); // Key: ward_id -> { length_x, width_y, height_z, room_title }

// Active Tag Readings Buffer: wardId -> tagId -> anchorDeviceId -> { rawRssi, filteredRssi, distance, timestamp }
const tagReadings = new Map();

// Dedicated Kalman Filter per (anchorDeviceId, tagId)
const tagKalmanFilters = new Map();

// Smoothed 2D Position Cache per tagId: { x, y, ward_id, last_published }
const tagSmoothedPositions = new Map();

// EMA smoothing factor: 0.35 gives responsive tracking while rejecting RF multipath noise
const EMA_ALPHA = 0.35;
// Maximum time (ms) an anchor packet is considered fresh
const STALE_TIMEOUT_MS = 3500;
// Minimum interval (ms) between WebSocket position broadcasts per tag (~6.7 Hz max)
const MIN_BROADCAST_INTERVAL_MS = 140;

function getFilterKey(anchorDeviceId, tagId) {
  return `${anchorDeviceId}__${tagId}`;
}

function getKalmanFilter(anchorDeviceId, tagId) {
  const key = getFilterKey(anchorDeviceId, tagId);
  if (!tagKalmanFilters.has(key)) {
    // Process noise Q = 0.05, Measurement noise R = 3.5, initial estimate -62.0
    tagKalmanFilters.set(key, new KalmanFilter1D(3.5, 0.05, -62.0));
  }
  return tagKalmanFilters.get(key);
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
      newWardMap.set(r.ward_id, {
        length_x: parseFloat(r.length_x) || 6.40,
        width_y: parseFloat(r.width_y) || 4.80,
        height_z: parseFloat(r.height_z) || 2.60,
        room_title: r.room_title || 'Ward'
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
 * Solve 2D Multilateration using Linear Least Squares:
 * A * p = b  ==>  p = (A^T * A)^-1 * A^T * b
 * @param {Array<{ x: number, y: number, d: number }>} anchorPoints 
 * @returns {{ x: number, y: number } | null}
 */
function solveTrilateration(anchorPoints) {
  if (!anchorPoints || anchorPoints.length < 3) return null;

  // Anchor 0 is the reference anchor
  const x1 = anchorPoints[0].x;
  const y1 = anchorPoints[0].y;
  const d1 = anchorPoints[0].d;

  if (anchorPoints.length === 3) {
    // Closed-form 2x2 analytical solution
    const x2 = anchorPoints[1].x;
    const y2 = anchorPoints[1].y;
    const d2 = anchorPoints[1].d;

    const x3 = anchorPoints[2].x;
    const y3 = anchorPoints[2].y;
    const d3 = anchorPoints[2].d;

    const A11 = 2 * (x2 - x1);
    const A12 = 2 * (y2 - y1);
    const b1  = (x2 * x2 - x1 * x1) + (y2 * y2 - y1 * y1) + (d1 * d1 - d2 * d2);

    const A21 = 2 * (x3 - x1);
    const A22 = 2 * (y3 - y1);
    const b2  = (x3 * x3 - x1 * x1) + (y3 * y3 - y1 * y1) + (d1 * d1 - d3 * d3);

    const det = A11 * A22 - A12 * A21;
    if (Math.abs(det) < 1e-5) {
      // Degenerate (collinear) configuration: fallback to distance-weighted centroid
      return computeWeightedCentroid(anchorPoints);
    }

    const x = (b1 * A22 - b2 * A12) / det;
    const y = (A11 * b2 - A21 * b1) / det;
    return { x, y };
  }

  // General Least Squares for N > 3 anchors
  let ata11 = 0, ata12 = 0, ata21 = 0, ata22 = 0;
  let atb1 = 0, atb2 = 0;

  for (let i = 1; i < anchorPoints.length; i++) {
    const xi = anchorPoints[i].x;
    const yi = anchorPoints[i].y;
    const di = anchorPoints[i].d;

    const row1 = 2 * (xi - x1);
    const row2 = 2 * (yi - y1);
    const bi   = (xi * xi - x1 * x1) + (yi * yi - y1 * y1) + (d1 * d1 - di * di);

    ata11 += row1 * row1;
    ata12 += row1 * row2;
    ata21 += row2 * row1;
    ata22 += row2 * row2;

    atb1 += row1 * bi;
    atb2 += row2 * bi;
  }

  const det = ata11 * ata22 - ata12 * ata21;
  if (Math.abs(det) < 1e-5) {
    return computeWeightedCentroid(anchorPoints);
  }

  const x = (atb1 * ata22 - atb2 * ata12) / det;
  const y = (ata11 * atb2 - ata21 * atb1) / det;
  return { x, y };
}

/**
 * Fallback: Distance-Weighted Centroid
 */
function computeWeightedCentroid(anchorPoints) {
  let sumWeight = 0;
  let wx = 0;
  let wy = 0;

  for (const a of anchorPoints) {
    const weight = 1.0 / Math.max(0.1, a.d * a.d);
    sumWeight += weight;
    wx += a.x * weight;
    wy += a.y * weight;
  }

  if (sumWeight <= 0) return { x: anchorPoints[0].x, y: anchorPoints[0].y };
  return { x: wx / sumWeight, y: wy / sumWeight };
}

/**
 * Record an incoming anchor RSSI packet and compute real-time tag position
 * @param {Object} param0 
 */
function recordAnchorReading({ anchorId, anchorMac, tagId, tagMac, rawRssi, timestamp }) {
  if (!tagId || isNaN(rawRssi) || rawRssi >= 0 || rawRssi < -110) return;

  const now = timestamp || Date.now();
  const cleanMac = anchorMac ? anchorMac.toUpperCase() : null;

  // Resolve anchor metadata from cache
  let anchorMeta = null;
  if (cleanMac && anchorToWardMap.has(cleanMac)) {
    anchorMeta = anchorToWardMap.get(cleanMac);
  } else if (anchorId && anchorToWardMap.has(anchorId.toLowerCase())) {
    anchorMeta = anchorToWardMap.get(anchorId.toLowerCase());
  } else if (cleanMac) {
    anchorMeta = anchorToWardMap.get(cleanMac.replace(/:/g, ''));
  }

  // If anchor is not assigned to any ward, we cannot localize in room space
  if (!anchorMeta || !anchorMeta.ward_id) {
    return;
  }

  const wardId = anchorMeta.ward_id;
  const devId = anchorMeta.device_id || anchorId;

  // Apply Kalman filter on RSSI
  const kf = getKalmanFilter(devId, tagId);
  const filteredRssi = kf.update(rawRssi);
  const distance = calculateDistance(filteredRssi);

  // Store reading in buffer
  if (!tagReadings.has(wardId)) tagReadings.set(wardId, new Map());
  const wardTags = tagReadings.get(wardId);

  if (!wardTags.has(tagId)) wardTags.set(tagId, new Map());
  const anchorMap = wardTags.get(tagId);

  anchorMap.set(devId, {
    anchor_id: anchorMeta.anchor_id,
    device_id: devId,
    mac: cleanMac || anchorMeta.mac_address,
    x: anchorMeta.x,
    y: anchorMeta.y,
    z: anchorMeta.z,
    rawRssi,
    filteredRssi: Math.round(filteredRssi * 10) / 10,
    distance,
    timestamp: now
  });

  // Collect all fresh anchor readings for this tag in this ward
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

  // Solve 2D position
  let solved = null;
  let confidence = 'LOW';

  if (freshAnchors.length >= 3) {
    solved = solveTrilateration(freshAnchors);
    confidence = 'HIGH';
  } else if (freshAnchors.length === 2) {
    solved = computeWeightedCentroid(freshAnchors);
    confidence = 'MEDIUM';
  } else {
    // 1 anchor: place at anchor with distance offset or anchor point
    solved = { x: freshAnchors[0].x, y: freshAnchors[0].y };
    confidence = 'APPROXIMATE';
  }

  if (!solved || isNaN(solved.x) || isNaN(solved.y)) return;

  // Bound coordinates within ward room perimeter
  const wardDim = wardDimensionsMap.get(wardId) || { length_x: 6.40, width_y: 4.80 };
  const minPadding = 0.10;
  const clampedX = Math.max(minPadding, Math.min(wardDim.length_x - minPadding, solved.x));
  const clampedY = Math.max(minPadding, Math.min(wardDim.width_y - minPadding, solved.y));

  // Apply Exponential Moving Average (EMA) to smooth movement across frames
  let smoothX = clampedX;
  let smoothY = clampedY;

  const prevSmoothed = tagSmoothedPositions.get(tagId);
  if (prevSmoothed && prevSmoothed.ward_id === wardId) {
    smoothX = EMA_ALPHA * clampedX + (1 - EMA_ALPHA) * prevSmoothed.x;
    smoothY = EMA_ALPHA * clampedY + (1 - EMA_ALPHA) * prevSmoothed.y;
  }

  smoothX = Math.round(smoothX * 100) / 100;
  smoothY = Math.round(smoothY * 100) / 100;

  // Update smoothed position cache
  tagSmoothedPositions.set(tagId, {
    x: smoothX,
    y: smoothY,
    raw_x: Math.round(clampedX * 100) / 100,
    raw_y: Math.round(clampedY * 100) / 100,
    ward_id: wardId,
    confidence,
    last_published: now
  });

  // Check rate limiter before broadcasting
  const lastPub = prevSmoothed?.last_broadcast || 0;
  if (now - lastPub >= MIN_BROADCAST_INTERVAL_MS) {
    if (tagSmoothedPositions.has(tagId)) {
      tagSmoothedPositions.get(tagId).last_broadcast = now;
    }

    broadcastToClients({
      type: 'IPS_POSITION_UPDATE',
      ward_id: wardId,
      tag_id: tagId,
      tag_mac: tagMac || '',
      x: smoothX,
      y: smoothY,
      raw_x: Math.round(clampedX * 100) / 100,
      raw_y: Math.round(clampedY * 100) / 100,
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
  const now = Date.now();
  for (const [tagId, pos] of tagSmoothedPositions.entries()) {
    if (pos.ward_id === wardId && (now - (pos.last_published || 0) < 15000)) {
      result.push({ tag_id: tagId, ...pos });
    }
  }
  return result;
}

module.exports = {
  reloadWardAnchorsCache,
  recordAnchorReading,
  solveTrilateration,
  getTagPosition,
  getWardTagPositions
};
