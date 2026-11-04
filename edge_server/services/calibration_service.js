// =============================================================================
// SHIRO Hospital Edge Server - Empirical Anchor Calibration Service
// =============================================================================
const { getPool } = require('../database/db');
const { getCalibration, setAnchorCalibration } = require('./kalman_filter');
const { broadcastToClients } = require('./websocket_service');

let activeSession = null;

function getMedian(values) {
  if (!values || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Start a 1-Click Calibration Session for a specific ward and reference landmark
 */
async function startSession({ ward_id, tag_id, target_x, target_y, target_z = 0.85, duration_sec = 10, path_loss_n = 3.2 }) {
  const pool = getPool();
  const wardId = ward_id || 'WARD-001';
  const cleanTag = (tag_id || '').toUpperCase().trim();

  // Query anchors assigned to this ward
  const [anchors] = await pool.query(
    `SELECT wa.anchor_id, wa.device_id, wa.mac_address, wa.x, wa.y, wa.z, 
            wa.calibrated_a, wa.calibrated_n, d.mac_address AS dev_mac
     FROM ward_anchors wa
     LEFT JOIN devices d ON wa.device_id = d.device_id
     WHERE wa.ward_id = ?`,
    [wardId]
  );

  if (!anchors || anchors.length === 0) {
    throw new Error(`No anchors found assigned to ward ${wardId}.`);
  }

  const anchorList = anchors.map(a => {
    const curCal = getCalibration(a.anchor_id) || getCalibration(a.device_id);
    return {
      anchor_id: a.anchor_id,
      device_id: a.device_id || null,
      mac_address: (a.mac_address || a.dev_mac || '').toUpperCase(),
      x: parseFloat(a.x) || 0.0,
      y: parseFloat(a.y) || 0.0,
      z: parseFloat(a.z) || 1.80,
      current_a: curCal ? curCal.A : -52.0,
      current_n: curCal ? curCal.n : 3.2
    };
  });

  const durationMs = Math.max(5000, Math.min(30000, (parseInt(duration_sec, 10) || 10) * 1000));
  const startTime = Date.now();
  const endTime = startTime + durationMs;

  activeSession = {
    sessionId: `cal_${Date.now()}`,
    ward_id: wardId,
    tag_id: cleanTag,
    target: {
      x: parseFloat(target_x) || 0.0,
      y: parseFloat(target_y) || 0.0,
      z: parseFloat(target_z) || 0.85
    },
    durationMs,
    startTime,
    endTime,
    path_loss_n: parseFloat(path_loss_n) || 3.2,
    samplesByAnchor: new Map(), // anchor_id -> array of raw RSSI values
    anchors: anchorList,
    completed: false
  };

  // Pre-populate sample array for each anchor
  for (const a of anchorList) {
    activeSession.samplesByAnchor.set(a.anchor_id, []);
    if (a.device_id) {
      activeSession.samplesByAnchor.set(a.device_id.toUpperCase(), []);
    }
  }

  console.log(`[CALIBRATION] Started session ${activeSession.sessionId} for Ward ${wardId}, Tag ${cleanTag} at (${target_x}, ${target_y}, ${target_z}) for ${durationMs / 1000}s`);

  // Broadcast session started
  broadcastToClients({
    type: 'CALIBRATION_STARTED',
    session_id: activeSession.sessionId,
    ward_id: wardId,
    tag_id: cleanTag,
    target: activeSession.target,
    duration_sec: durationMs / 1000
  });

  return {
    success: true,
    session_id: activeSession.sessionId,
    ward_id: wardId,
    tag_id: cleanTag,
    target: activeSession.target,
    duration_sec: durationMs / 1000,
    anchors: anchorList
  };
}

/**
 * Ingest live raw RSSI packet if a calibration session is active
 */
function recordSample(anchorId, devId, tagId, rawRssi) {
  if (!activeSession || activeSession.completed) return;
  const now = Date.now();
  if (now > activeSession.endTime) {
    activeSession.completed = true;
    return;
  }

  // Check if tag matches (compare uppercase canonical ID or substring)
  const cleanTag = (tagId || '').toUpperCase().trim();
  if (activeSession.tag_id && cleanTag !== activeSession.tag_id && !cleanTag.includes(activeSession.tag_id)) {
    return;
  }

  // Push to anchor sample buffers
  let matched = false;
  if (anchorId && activeSession.samplesByAnchor.has(anchorId)) {
    activeSession.samplesByAnchor.get(anchorId).push(rawRssi);
    matched = true;
  }
  if (devId && activeSession.samplesByAnchor.has(devId.toUpperCase())) {
    activeSession.samplesByAnchor.get(devId.toUpperCase()).push(rawRssi);
    matched = true;
  }

  // Broadcast real-time sample count pulse so UI updates live
  if (matched) {
    const counts = {};
    for (const a of activeSession.anchors) {
      const s1 = activeSession.samplesByAnchor.get(a.anchor_id) || [];
      const s2 = a.device_id ? (activeSession.samplesByAnchor.get(a.device_id.toUpperCase()) || []) : [];
      counts[a.anchor_id] = Math.max(s1.length, s2.length);
    }

    const remainingMs = Math.max(0, activeSession.endTime - now);
    broadcastToClients({
      type: 'CALIBRATION_PROGRESS',
      session_id: activeSession.sessionId,
      remaining_sec: Math.round(remainingMs / 100) / 10,
      counts
    });
  }
}

/**
 * Get current session status or final calculated results
 */
function getSessionResults() {
  if (!activeSession) {
    return { success: false, error: 'No active or recent calibration session found.' };
  }

  const now = Date.now();
  const isFinished = now >= activeSession.endTime || activeSession.completed;
  const target = activeSession.target;
  const n = activeSession.path_loss_n || 3.2;

  const results = activeSession.anchors.map(a => {
    const s1 = activeSession.samplesByAnchor.get(a.anchor_id) || [];
    const s2 = a.device_id ? (activeSession.samplesByAnchor.get(a.device_id.toUpperCase()) || []) : [];
    // Combine and deduplicate if both recorded
    const samples = s1.length >= s2.length ? s1 : s2;

    // 3D True Euclidean Distance
    const dx = target.x - a.x;
    const dy = target.y - a.y;
    const dz = target.z - a.z;
    const dTrue = Math.max(0.2, Math.sqrt(dx * dx + dy * dy + dz * dz));

    let medianRssi = null;
    let newA = a.current_a;
    let deltaA = 0;
    let status = 'INSUFFICIENT_DATA';

    if (samples.length >= 3) {
      medianRssi = Math.round(getMedian(samples) * 10) / 10;
      // Invert Path Loss Model:
      // RSSI = A - 10 * n * log10(d)
      // => A = RSSI + 10 * n * log10(d)
      const computedA = medianRssi + 10.0 * n * Math.log10(dTrue);
      // Realistic RF clamp [-75.0, -35.0 dBm]
      newA = Math.max(-75.0, Math.min(-35.0, Math.round(computedA * 10) / 10));
      deltaA = Math.round((newA - a.current_a) * 10) / 10;
      status = 'CALCULATED';
    }

    return {
      anchor_id: a.anchor_id,
      device_id: a.device_id,
      mac_address: a.mac_address,
      x: a.x,
      y: a.y,
      z: a.z,
      d_true: Math.round(dTrue * 100) / 100,
      samples_count: samples.length,
      median_rssi: medianRssi,
      current_a: a.current_a,
      new_a: newA,
      delta_a: deltaA,
      n: n,
      status
    };
  });

  return {
    success: true,
    session_id: activeSession.sessionId,
    ward_id: activeSession.ward_id,
    tag_id: activeSession.tag_id,
    target: activeSession.target,
    is_finished: isFinished,
    results
  };
}

/**
 * Apply the calculated calibrations to the database and in-memory filter
 */
async function applyCalibrations(wardId, calibrations) {
  const wardService = require('./ward_service');
  const ipsService = require('./ips_service');

  if (!Array.isArray(calibrations) || calibrations.length === 0) {
    throw new Error('No calibrations array provided to apply.');
  }

  // 1. Save to MySQL database
  await wardService.saveWardAnchorCalibrations(wardId, calibrations);

  // 2. Update runtime in-memory Kalman filter overrides
  for (const cal of calibrations) {
    const aId = cal.anchor_id;
    const aVal = parseFloat(cal.A);
    const nVal = parseFloat(cal.n || 3.2);

    setAnchorCalibration(aId, aVal, nVal);
    if (cal.device_id) {
      setAnchorCalibration(cal.device_id, aVal, nVal);
    }
  }

  // 3. Broadcast to all Web Dashboards and VR Quest 3 clients
  broadcastToClients({
    type: 'ANCHOR_CALIBRATION_APPLIED',
    ward_id: wardId,
    calibrations,
    timestamp: new Date().toLocaleTimeString()
  });

  // Reset active session
  activeSession = null;

  return {
    success: true,
    message: 'Anchor calibrations successfully applied and permanently stored in database.'
  };
}

module.exports = {
  startSession,
  recordSample,
  getSessionResults,
  applyCalibrations
};
