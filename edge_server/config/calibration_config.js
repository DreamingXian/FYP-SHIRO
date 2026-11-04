// =============================================================================
// BLE Anchor RF Calibration Constants
// =============================================================================
module.exports = {
  // Measured RSSI at 1.0 meter distance (calibratable via dashboard / empirical anchor tuning)
  A: -52.0,
  // Path loss exponent for indoor clinical ward environment (typical 2.8 - 3.6 with furniture/walls)
  n: 3.2,
  // Kalman Filter covariances
  KALMAN_R: 4.0, // Measurement noise covariance (empirically 4.0 dBm^2)
  KALMAN_Q: 0.05 // Process noise covariance
};

