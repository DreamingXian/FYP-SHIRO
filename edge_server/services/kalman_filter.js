// =============================================================================
// 1D Kalman Filter & Log-Distance Path Loss Localization Model
// =============================================================================
const defaultCalibration = require('../config/calibration_config');

// KEY LOGIC: why a Kalman filter on RSSI.
// The signal strength (RSSI) of one BLE broadcast jumps by several dB from packet to
// packet (reflections, the body blocking the signal). Each wristband-anchor pair has its
// own filter that keeps one number, the best estimate of the "true" RSSI, and how
// unsure it is (p). Each new reading moves the estimate only part of the way towards
// the reading: K (0..1) is that share.
//   R = how noisy one reading is (large R: trust readings less, smoother but slower)
//   Q = how fast the true value may change (large Q: follows a walking patient sooner)
// The median filter before it (ips_service.filterRssi) removes single outliers first.
class KalmanFilter1D {
  constructor(r = defaultCalibration.KALMAN_R, q = defaultCalibration.KALMAN_Q, initialEstimate = -65.0) {
    this.R = r; // Measurement noise covariance
    this.Q = q; // Process noise covariance
    this.x = initialEstimate;
    this.p = 1.0;
    this.initialized = false;
  }

  /** One new RSSI reading in, the smoothed RSSI out. */
  update(measurement) {
    if (!this.initialized) {
      this.x = measurement;
      this.initialized = true;
      return this.x;
    }
    // 1. Predict
    this.p = this.p + this.Q;

    // 2. Innovation & Kalman Gain
    const K = this.p / (this.p + this.R);

    // 3. Update state estimate and error covariance
    this.x = this.x + K * (measurement - this.x);
    this.p = (1.0 - K) * this.p;

    return this.x;
  }
}

let activeCalibration = {
  A: defaultCalibration.A,
  n: defaultCalibration.n
};

// In-memory per-anchor calibration overrides: anchorId -> { A, n }
const anchorCalibrations = new Map();

function getCalibration(anchorId = null) {
  if (anchorId) {
    const key = anchorId.toString().toLowerCase().trim();
    if (anchorCalibrations.has(key)) {
      return anchorCalibrations.get(key);
    }
  }
  return activeCalibration;
}

function setAnchorCalibration(anchorId, A, n) {
  if (!anchorId) return;
  const key = anchorId.toString().toLowerCase().trim();
  const existing = anchorCalibrations.get(key) || { ...activeCalibration };
  if (A !== undefined && !isNaN(parseFloat(A))) existing.A = parseFloat(A);
  if (n !== undefined && !isNaN(parseFloat(n))) existing.n = parseFloat(n);
  anchorCalibrations.set(key, existing);
  return existing;
}

function clearAnchorCalibration(anchorId) {
  if (!anchorId) return;
  const key = anchorId.toString().toLowerCase().trim();
  anchorCalibrations.delete(key);
}

function updateCalibration(newA, newN) {
  if (newA !== undefined && !isNaN(parseFloat(newA))) activeCalibration.A = parseFloat(newA);
  if (newN !== undefined && !isNaN(parseFloat(newN))) activeCalibration.n = parseFloat(newN);
  return activeCalibration;
}

// KEY LOGIC: log-distance path-loss model, RSSI (dBm) -> distance (m).
//   RSSI = A - 10 * n * log10(d)   so   d = 10 ^ ((A - RSSI) / (10 * n))
//   A = the RSSI measured at 1 m from this anchor (e.g. -59 dBm)
//   n = how fast the signal fades in this room (2 in free space, about 2-4 indoors)
// A and n are calibrated per anchor on the dashboard (landmark calibration), because
// each board and antenna, and each wall position, hears differently.
function calculateDistance(rssi, A = null, n = null, anchorId = null) {
  let effectiveA = A;
  let effectiveN = n;

  if (effectiveA === null || effectiveN === null) {
    const cal = getCalibration(anchorId);
    effectiveA = (effectiveA !== null && effectiveA !== undefined) ? effectiveA : cal.A;
    effectiveN = (effectiveN !== null && effectiveN !== undefined) ? effectiveN : cal.n;
  }

  const exp = (effectiveA - rssi) / (10.0 * effectiveN);
  const dist = Math.pow(10, exp);
  return Math.round(dist * 100) / 100; // Return rounded to 2 decimal places
}

module.exports = {
  KalmanFilter1D,
  calculateDistance,
  getCalibration,
  setAnchorCalibration,
  clearAnchorCalibration,
  updateCalibration
};

