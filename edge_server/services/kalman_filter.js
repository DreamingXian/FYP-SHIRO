// =============================================================================
// 1D Kalman Filter & Log-Distance Path Loss Localization Model
// =============================================================================
const defaultCalibration = require('../config/calibration_config');

class KalmanFilter1D {
  constructor(r = defaultCalibration.KALMAN_R, q = defaultCalibration.KALMAN_Q, initialEstimate = -65.0) {
    this.R = r; // Measurement noise covariance
    this.Q = q; // Process noise covariance
    this.x = initialEstimate;
    this.p = 1.0;
    this.initialized = false;
  }

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

function getCalibration() {
  return activeCalibration;
}

function updateCalibration(newA, newN) {
  if (newA !== undefined && !isNaN(parseFloat(newA))) activeCalibration.A = parseFloat(newA);
  if (newN !== undefined && !isNaN(parseFloat(newN))) activeCalibration.n = parseFloat(newN);
  return activeCalibration;
}

function calculateDistance(rssi, A = activeCalibration.A, n = activeCalibration.n) {
  const exp = (A - rssi) / (10.0 * n);
  const dist = Math.pow(10, exp);
  return Math.round(dist * 100) / 100; // Return rounded to 2 decimal places
}

module.exports = {
  KalmanFilter1D,
  calculateDistance,
  getCalibration,
  updateCalibration
};

