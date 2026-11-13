// =============================================================================
// SHIRO IPS Geometry - Pure Positioning Maths
// No database, network or timer side effects: safe to unit test in isolation.
// =============================================================================

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

module.exports = {
  getMedian,
  solveWeightedTrilateration,
  refinePositionWithinRoom,
  computeWeightedCentroid
};
