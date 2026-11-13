// =============================================================================
// SHIRO Central Ward Management System - Real-Time IPS Localization Service
// Robust 2D Weighted Multilateration, Median+Kalman Filtering & Offline Handling
// =============================================================================
const { getPool } = require('../database/db');
const { KalmanFilter1D, calculateDistance, getCalibration, setAnchorCalibration, clearAnchorCalibration } = require('./kalman_filter');
const { broadcastToClients } = require('./websocket_service');
const deviceService = require('./device_service');
const calibrationService = require('./calibration_service');
const timeSeriesService = require('./time_series_service');
const bindingCache = require('./binding_cache');
const { getMedian, solveWeightedTrilateration, refinePositionWithinRoom, computeWeightedCentroid } = require('./ips/geometry');

// Zero-latency in-memory lookup caches
let anchorToWardMap = new Map(); // Key: MAC or DeviceId -> { ward_id, anchor_id, device_id, x, y, z }
let wardDimensionsMap = new Map(); // Key: ward_id -> { length_x, width_y, height_z, room_title, max_diagonal }

// Active Tag Readings Buffer: wardId -> tagId -> anchorDeviceId -> { rawRssi, filteredRssi, distance, timestamp }
const tagReadings = new Map();

// 5-sample Sliding Window Median Filter Buffer per (anchorDeviceId, tagId)
const tagMedianBuffers = new Map();

// Dedicated Kalman Filter per (anchorDeviceId, tagId)
const tagKalmanFilters = new Map();

// Smoothed 2D Position Cache per tagId: { x, y, ward_id, tag_mac, status, confidence, motion_state, last_seen, last_broadcast }
const tagSmoothedPositions = new Map();

// Kinematic Motion Tracking State per tagId:
// { state: 'STATIONARY' | 'HAND_MOVEMENT' | 'WALKING' | 'SETTLING', lastG: 1.0, gSamples: [], lastMotionTime: 0, settlingStartTime: 0, settlingBuffer: [], lockedPosition: null, rfStillCount: 0 }
const tagKinematics = new Map();

// Innovation Velocity Gating Buffer per (anchorDeviceId, tagId): { dist, timestamp }
const tagPrevDistances = new Map();

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
 * Retrieve or initialize kinematic tracking state for a wristband tag
 */
function getKinematicState(tagId) {
  if (!tagKinematics.has(tagId)) {
    tagKinematics.set(tagId, {
      state: 'STATIONARY',
      lastG: 1.0,
      gSamples: [],
      lastMotionTime: 0,
      settlingStartTime: 0,
      settlingBuffer: [],
      lockedPosition: null,
      rfStillCount: 0
    });
  }
  return tagKinematics.get(tagId);
}

/**
 * Process incoming physical IMU telemetry (total acceleration in Gs)
 * Implements 4-State Machine: STATIONARY <-> HAND_MOVEMENT <-> WALKING -> SETTLING -> STATIONARY
 * Uses Cadence, Peak-to-Peak & Dynamic Variance to reliably distinguish gestures from walking!
 */
function recordKinematics(tagId, gValue, timestamp = Date.now(), explicitState = null) {
  if (isNaN(gValue)) return;
  const ks = getKinematicState(tagId);
  ks.lastG = gValue;
  ks.gSamples.push({ g: gValue, t: timestamp });
  if (ks.gSamples.length > 20) ks.gSamples.shift(); // ~4 seconds of 5Hz data

  if (explicitState) {
    if (explicitState === 'WALKING') {
      ks.state = 'WALKING';
      ks.lastMotionTime = timestamp;
      ks.settlingBuffer = [];
      return;
    } else if (explicitState === 'HAND_MOVEMENT') {
      ks.state = 'HAND_MOVEMENT';
      ks.lastMotionTime = timestamp;
      return;
    } else if (explicitState === 'STATIONARY') {
      if (ks.state === 'WALKING') {
        ks.state = 'SETTLING';
        ks.settlingStartTime = timestamp;
        ks.settlingBuffer = [];
      } else if (ks.state !== 'SETTLING') {
        ks.state = 'STATIONARY';
      }
      return;
    }
  }

  if (ks.gSamples.length < 4) return;

  // 1. Calculate dynamic acceleration variance around 1.0g
  let sumSqDiff = 0;
  let minG = 999.0;
  let maxG = -999.0;
  for (const s of ks.gSamples) {
    const diff = s.g - 1.0;
    sumSqDiff += diff * diff;
    if (s.g < minG) minG = s.g;
    if (s.g > maxG) maxG = s.g;
  }
  const variance = sumSqDiff / ks.gSamples.length;
  const p2p = maxG - minG;

  // 2. Count zero-crossings (oscillations crossing 1.0g baseline) to detect walking rhythm
  let zeroCrossings = 0;
  for (let i = 1; i < ks.gSamples.length; i++) {
    const prevDev = ks.gSamples[i - 1].g - 1.0;
    const curDev = ks.gSamples[i].g - 1.0;
    if ((prevDev > 0.04 && curDev < -0.04) || (prevDev < -0.04 && curDev > 0.04)) {
      zeroCrossings++;
    }
  }

  // 3. Multi-tier Biomechanical Classification
  // WALKING: Sustained periodic oscillation (p2p >= 0.30g, variance >= 0.009, zeroCrossings >= 2)
  const isWalking = (p2p >= 0.30 && variance >= 0.009 && zeroCrossings >= 2);
  // HAND MOVEMENT: Isolated movement, typing, gestural twitch (p2p >= 0.16g or |g - 1.0| > 0.15g, without steady cadence)
  const isHandMovement = !isWalking && (p2p >= 0.16 || Math.abs(gValue - 1.0) > 0.15 || variance >= 0.004);
  // STILL: Calm resting arm (variance < 0.004 and p2p < 0.16g)
  const isCalm = !isWalking && !isHandMovement;

  if (isWalking) {
    ks.lastMotionTime = timestamp;
    ks.state = 'WALKING';
    ks.settlingBuffer = [];
  } else if (isHandMovement) {
    ks.lastMotionTime = timestamp;
    if (ks.state !== 'WALKING') {
      ks.state = 'HAND_MOVEMENT';
    }
  } else if (isCalm) {
    if (ks.state === 'WALKING') {
      // Patient just stopped walking: enter 1.8-second Settling Convergence window
      ks.state = 'SETTLING';
      ks.settlingStartTime = timestamp;
      ks.settlingBuffer = [];
    } else if (ks.state === 'SETTLING') {
      // Check if 1.8-second settling window has elapsed
      if (timestamp - ks.settlingStartTime >= 1800) {
        // Settling window complete: lock onto the clean median of collected coordinates
        if (ks.settlingBuffer.length > 0) {
          const medX = getMedian(ks.settlingBuffer.map(p => p.x));
          const medY = getMedian(ks.settlingBuffer.map(p => p.y));
          ks.lockedPosition = {
            x: Math.round(medX * 100) / 100,
            y: Math.round(medY * 100) / 100
          };
        }
        ks.state = 'STATIONARY';
      }
    } else if (ks.state === 'HAND_MOVEMENT') {
      // Hand movement stopped: return to locked position
      if (timestamp - ks.lastMotionTime >= 1000) {
        ks.state = 'STATIONARY';
      }
    }
  }
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
 * Geometry-Aware Distance Calculation with Physical Room Capping & Innovation Velocity Gating
 * Eliminates impossible distance jumps (e.g. 0.5m -> 3.5m) caused by temporary multipath dips
 */
function calculateBoundedDistance(anchorDeviceId, tagId, filteredRssi, maxReach = 5.5, anchorId = null, now = Date.now()) {
  const cal = getCalibration(anchorId || anchorDeviceId);
  // Standard Log-Distance Path Loss
  const exp = (cal.A - filteredRssi) / (10.0 * cal.n);
  const rawDist = Math.pow(10, exp);

  // PHYSICAL BOUNDING: In an enclosed room, Euclidean distance can NEVER exceed the anchor's reach!
  const safeCap = Math.max(1.0, maxReach);
  let boundedDist = Math.min(rawDist, safeCap);

  // INNOVATION VELOCITY GATE:
  // Patient indoor speed in a hospital ward cannot exceed vmax = 1.3 m/s.
  // In a short time dt (~0.15s - 0.3s), distance to an anchor cannot jump more than (vmax * dt + Gaussian margin).
  const key = getFilterKey(anchorDeviceId, tagId);
  const prev = tagPrevDistances.get(key);
  if (prev && prev.dist !== undefined) {
    const dt = Math.max(0.08, (now - prev.timestamp) / 1000.0);
    const maxAllowedDelta = 1.30 * dt + 0.35; // 1.30 m/s max velocity + 0.35m RF tolerance
    const delta = boundedDist - prev.dist;
    if (Math.abs(delta) > maxAllowedDelta) {
      boundedDist = prev.dist + Math.sign(delta) * maxAllowedDelta;
    }
  }
  tagPrevDistances.set(key, { dist: boundedDist, timestamp: now });

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
        wa.calibrated_a, wa.calibrated_n,
        d.mac_address AS dev_mac
      FROM ward_anchors wa
      LEFT JOIN devices d ON wa.device_id = d.device_id
      WHERE wa.device_id IS NOT NULL AND wa.device_id != ''
    `);

    const newAnchorMap = new Map();
    for (const a of anchors) {
      const room = newWardMap.get(a.ward_id) || { length_x: 6.40, width_y: 4.80 };
      const ax = parseFloat(a.x) || 0.0;
      const ay = parseFloat(a.y) || 0.0;
      const corners = [
        { x: 0, y: 0 },
        { x: room.length_x, y: 0 },
        { x: room.length_x, y: room.width_y },
        { x: 0, y: room.width_y }
      ];
      let maxReach = 0;
      for (const c of corners) {
        const d = Math.sqrt(Math.pow(c.x - ax, 2) + Math.pow(c.y - ay, 2));
        if (d > maxReach) maxReach = d;
      }

      // Register or clear calibrated parameters
      if (a.calibrated_a !== null && a.calibrated_a !== undefined) {
        const calA = parseFloat(a.calibrated_a);
        const calN = a.calibrated_n !== null && a.calibrated_n !== undefined ? parseFloat(a.calibrated_n) : 3.2;
        setAnchorCalibration(a.anchor_id, calA, calN);
        if (a.device_id) setAnchorCalibration(a.device_id, calA, calN);
      } else {
        clearAnchorCalibration(a.anchor_id);
        if (a.device_id) clearAnchorCalibration(a.device_id);
      }

      const data = {
        anchor_id: a.anchor_id,
        ward_id: a.ward_id,
        device_id: a.device_id,
        mac_address: (a.mac_address || a.dev_mac || '').toUpperCase(),
        x: ax,
        y: ay,
        z: parseFloat(a.z) || 1.80,
        wall_location: a.wall_location || '',
        max_reach: Math.round((maxReach + 0.15) * 100) / 100 // Anchor-specific corner reach + small 0.15m margin
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

  // 3b. Feed raw sample to active calibration session if one is currently collecting
  calibrationService.recordSample(anchorMeta.anchor_id, devId, canonicalTagId, rawRssi);

  // 4. Two-stage filtering: 5-sample Rolling Median -> 1D Kalman Filter
  const filteredRssi = filterRssi(devId, canonicalTagId, rawRssi);
  // 5. Geometry-Aware Distance Calculation with Anchor-Specific Maximum Reach Bounding & Innovation Velocity Gating
  const maxReachLimit = anchorMeta.max_reach || wardDim.max_diagonal || 5.5;
  const distance = calculateBoundedDistance(devId, canonicalTagId, filteredRssi, maxReachLimit, anchorMeta.anchor_id, now);

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
  // Project 3D slant range to 2D floor plane using anchor Z and nominal patient wristband height (0.85m)
  const NOMINAL_WRISTBAND_Z = 0.85;
  const freshAnchors = [];
  for (const [aId, reading] of anchorMap.entries()) {
    if (now - reading.timestamp <= STALE_TIMEOUT_MS) {
      const anchorZ = reading.z !== undefined && reading.z !== null ? reading.z : (wardDim.height_z || 2.80);
      const deltaZ = Math.max(0, anchorZ - NOMINAL_WRISTBAND_Z);
      let d2D;
      if (reading.distance > deltaZ) {
        d2D = Math.sqrt(reading.distance * reading.distance - deltaZ * deltaZ);
      } else {
        // Smooth soft projection when tag is near or below the anchor's vertical cone
        // Never hard-collapse to 0.15m!
        const ratio = Math.max(0.1, reading.distance / Math.max(0.5, deltaZ));
        d2D = Math.max(0.20, reading.distance * ratio * 0.55);
      }

      freshAnchors.push({
        anchor_id: reading.anchor_id,
        device_id: aId,
        x: reading.x,
        y: reading.y,
        z: anchorZ,
        d: Math.round(d2D * 100) / 100,
        d_slant_3d: reading.distance,
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

  // 7. Kinematic Motion State & Velocity Clamping
  const ks = getKinematicState(canonicalTagId);
  const isImuActive = (ks.gSamples.length > 0 && (now - (ks.gSamples[ks.gSamples.length - 1]?.t || 0) < 8000));

  let smoothX = solved.x;
  let smoothY = solved.y;
  let motionStateText = 'STATIONARY';

  const prevSmoothed = tagSmoothedPositions.get(canonicalTagId);

  if (isImuActive) {
    if (ks.state === 'WALKING') {
      motionStateText = 'WALKING';
    } else if (ks.state === 'HAND_MOVEMENT') {
      motionStateText = 'HAND_MOVEMENT';
    } else if (ks.state === 'SETTLING') {
      motionStateText = 'SETTLING';
    } else {
      motionStateText = 'STATIONARY';
    }
  } else {
    // RF KINEMATIC DEADBAND (When tag is not streaming IMU, e.g. secondary tag)
    // Prevents non-IMU tags from constantly drifting due to RF noise!
    if (prevSmoothed && prevSmoothed.ward_id === wardId) {
      const dx = solved.x - prevSmoothed.x;
      const dy = solved.y - prevSmoothed.y;
      const disp = Math.sqrt(dx * dx + dy * dy);
      if (disp < 0.40) {
        // Tag is within RF multipath deadband
        ks.rfStillCount = (ks.rfStillCount || 0) + 1;
        if (ks.rfStillCount >= 4) {
          motionStateText = 'STATIONARY';
          if (!ks.lockedPosition) {
            ks.lockedPosition = { x: prevSmoothed.x, y: prevSmoothed.y };
          }
        } else {
          motionStateText = 'SETTLING';
        }
      } else {
        // Genuine physical displacement detected
        ks.rfStillCount = 0;
        ks.lockedPosition = null;
        motionStateText = 'WALKING';
      }
    } else {
      motionStateText = 'STATIONARY';
    }
  }

  // 8. DISPLACEMENT VELOCITY LIMITING (Physics-constrained Puck Dynamics)
  if (motionStateText === 'STATIONARY') {
    // 100% Locked position: Zero drift!
    if (ks.lockedPosition) {
      smoothX = ks.lockedPosition.x;
      smoothY = ks.lockedPosition.y;

      // Exception guard: If all anchors consistently report a huge shift (> 1.2m)
      // for multiple frames, soft-relax toward the new position
      const driftDist = Math.sqrt(Math.pow(solved.x - smoothX, 2) + Math.pow(solved.y - smoothY, 2));
      if (driftDist > 1.2) {
        smoothX += (solved.x - smoothX) * 0.05;
        smoothY += (solved.y - smoothY) * 0.05;
        ks.lockedPosition = { x: smoothX, y: smoothY };
      }
    } else {
      ks.lockedPosition = { x: smoothX, y: smoothY };
    }
  } else if (motionStateText === 'HAND_MOVEMENT') {
    // Hand movement while sitting/resting: allow small jitter radius (<= 0.22m) from locked center
    if (ks.lockedPosition) {
      const dx = solved.x - ks.lockedPosition.x;
      const dy = solved.y - ks.lockedPosition.y;
      const distFromLock = Math.sqrt(dx * dx + dy * dy);
      if (distFromLock > 0.22) {
        smoothX = ks.lockedPosition.x + (dx / distFromLock) * 0.22;
        smoothY = ks.lockedPosition.y + (dy / distFromLock) * 0.22;
      } else {
        smoothX = solved.x;
        smoothY = solved.y;
      }
    }
  } else if (motionStateText === 'SETTLING') {
    // Settling window: accumulate coordinates and converge on window median
    ks.settlingBuffer.push({ x: solved.x, y: solved.y });
    if (ks.settlingBuffer.length > 30) ks.settlingBuffer.shift();
    smoothX = getMedian(ks.settlingBuffer.map(p => p.x));
    smoothY = getMedian(ks.settlingBuffer.map(p => p.y));
    ks.lockedPosition = { x: smoothX, y: smoothY };
  } else { // WALKING
    if (prevSmoothed && prevSmoothed.ward_id === wardId) {
      const dt = Math.max(0.08, (now - (prevSmoothed.last_seen || (now - 150))) / 1000.0);
      const maxStep = 1.30 * dt; // 1.30 m/s max indoor walking speed
      const dx = solved.x - prevSmoothed.x;
      const dy = solved.y - prevSmoothed.y;
      const disp = Math.sqrt(dx * dx + dy * dy);
      if (disp > maxStep) {
        smoothX = prevSmoothed.x + (dx / disp) * maxStep;
        smoothY = prevSmoothed.y + (dy / disp) * maxStep;
      } else {
        smoothX = 0.45 * solved.x + 0.55 * prevSmoothed.x;
        smoothY = 0.45 * solved.y + 0.55 * prevSmoothed.y;
      }
    }
    ks.lockedPosition = { x: smoothX, y: smoothY };
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
    motion_state: motionStateText,
    confidence: (ks.state === 'LOCKED' && isImuActive) ? 'STATIONARY_LOCKED' : confidence,
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
      motion_state: motionStateText,
      confidence: (motionStateText === 'STATIONARY') ? 'STATIONARY_LOCKED' : confidence,
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

    // Log spatial trajectory to InfluxDB (Table 4.10)
    timeSeriesService.logTrajectory({
      patientId: bindingCache.getPatientIdForDevice(canonicalTagId) || 'UNASSIGNED',
      wristbandMac: cleanMac || '',
      posX: smoothX,
      posY: smoothY,
      confidence: (motionStateText === 'STATIONARY') ? 0.99 : 0.88,
      zone: wardId || 'WARD-001'
    });
  }
}

/**
 * Background Offline Watchdog:
 * Runs every 2 seconds. If a tag has not received any packet for > OFFLINE_TIMEOUT_MS,
 * marks its status as OFFLINE and broadcasts the last known position to the client!
 */
let offlineTimer = null;

function runOfflineCheck() {
  const now = Date.now();
  for (const [tagId, pos] of tagSmoothedPositions.entries()) {
    if ((pos.status === 'ONLINE' || pos.status === 'CHARGING') && (now - pos.last_seen > OFFLINE_TIMEOUT_MS)) {
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
}

/**
 * Starts the 2-second offline watchdog. Called once from server.js at start-up,
 * so that loading this module has no side effects.
 */
function startOfflineWatchdog(intervalMs = 2000) {
  if (offlineTimer) return offlineTimer;
  offlineTimer = setInterval(runOfflineCheck, intervalMs);
  return offlineTimer;
}

function stopOfflineWatchdog() {
  if (offlineTimer) {
    clearInterval(offlineTimer);
    offlineTimer = null;
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
  for (const [tagId, pos] of tagSmoothedPositions.entries()) {
    if (pos.ward_id === wardId) {
      result.push({ tag_id: tagId, ...pos });
    }
  }
  return result;
}

/**
 * Purge a wristband tag completely from all IPS buffers, kinematic states, and live maps.
 * Called automatically on device deletion, or manually by user clicking "Remove from Ward Map".
 */
function purgeTag(tagId, mac = null) {
  if (!tagId && !mac) return;
  const keysToPurge = new Set();
  if (tagId) keysToPurge.add(tagId);
  if (mac) {
    keysToPurge.add(mac.toUpperCase().trim());
    keysToPurge.add(mac.toUpperCase().replace(/[:-]/g, ''));
  }

  for (const k of keysToPurge) {
    tagSmoothedPositions.delete(k);
    tagKinematics.delete(k);

    for (const wardMap of tagReadings.values()) {
      wardMap.delete(k);
    }
    for (const fk of tagMedianBuffers.keys()) {
      if (fk.endsWith(`__${k}`)) tagMedianBuffers.delete(fk);
    }
    for (const fk of tagKalmanFilters.keys()) {
      if (fk.endsWith(`__${k}`)) tagKalmanFilters.delete(fk);
    }
    for (const fk of tagPrevDistances.keys()) {
      if (fk.endsWith(`__${k}`)) tagPrevDistances.delete(fk);
    }
  }

  broadcastToClients({
    type: 'IPS_TAG_PURGE',
    tag_id: tagId,
    mac: mac || ''
  });
  console.log(`[IPS ENGINE] Purged tag ${tagId} from all localization caches.`);
}

module.exports = {
  reloadWardAnchorsCache,
  recordAnchorReading,
  recordKinematics,
  solveWeightedTrilateration,
  getTagPosition,
  getWardTagPositions,
  purgeTag,
  startOfflineWatchdog,
  stopOfflineWatchdog
};
