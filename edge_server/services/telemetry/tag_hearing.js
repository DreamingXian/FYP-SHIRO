// =============================================================================
// SHIRO Edge Server - which anchor hears each wristband best
// The 1 Hz command must reach a wristband through one anchor only: two anchors
// trying to open a BLE connection to the same wristband at the same time make
// both attempts fail. The server picks the anchor with the strongest recent
// signal and names it in the command.
// =============================================================================

// A reading older than this is not used. The anchors use the same window.
const HEARD_WITHIN_MS = 3500;
// The median of the last few readings, so one strong outlier does not decide
const SAMPLES_PER_ANCHOR = 5;
// Memory bound: wristbands and anchors remembered at most
const MAX_TAGS = 256;
const MAX_ANCHORS_PER_TAG = 16;

const heard = new Map(); // tagMac -> Map(anchorMac -> { samples: number[], at: number })

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function dropStale(now) {
  for (const [tagMac, anchors] of heard) {
    for (const [anchorMac, entry] of anchors) {
      if (now - entry.at > HEARD_WITHIN_MS) anchors.delete(anchorMac);
    }
    if (anchors.size === 0) heard.delete(tagMac);
  }
}

/**
 * Records that an anchor heard a wristband. Both MAC addresses must already be
 * checked and normalised ("AA:BB:CC:DD:EE:FF"); rssi in dBm.
 */
function recordHearing(tagMac, anchorMac, rssi, now = Date.now()) {
  if (!tagMac || !anchorMac || !Number.isFinite(rssi)) return;
  if (!heard.has(tagMac) && heard.size >= MAX_TAGS) dropStale(now);
  if (!heard.has(tagMac)) {
    if (heard.size >= MAX_TAGS) return;
    heard.set(tagMac, new Map());
  }
  const anchors = heard.get(tagMac);
  let entry = anchors.get(anchorMac);
  if (!entry) {
    if (anchors.size >= MAX_ANCHORS_PER_TAG) return;
    entry = { samples: [], at: 0 };
    anchors.set(anchorMac, entry);
  }
  // Samples from an earlier visit do not count
  if (now - entry.at > HEARD_WITHIN_MS) entry.samples = [];
  entry.samples.push(rssi);
  if (entry.samples.length > SAMPLES_PER_ANCHOR) entry.samples.shift();
  entry.at = now;
}

/**
 * The anchor with the strongest recent signal from this wristband.
 * @returns {{anchorMac: string, rssi: number, heardBy: number} | null}
 *          null when no anchor has heard it within HEARD_WITHIN_MS
 */
function strongestAnchor(tagMac, now = Date.now()) {
  const anchors = heard.get(tagMac);
  if (!anchors) return null;
  let best = null;
  let heardBy = 0;
  for (const [anchorMac, entry] of anchors) {
    if (now - entry.at > HEARD_WITHIN_MS || entry.samples.length === 0) continue;
    heardBy++;
    const rssi = median(entry.samples);
    // Equal signal: the lower MAC address wins, so the choice does not change between calls
    if (!best || rssi > best.rssi || (rssi === best.rssi && anchorMac < best.anchorMac)) {
      best = { anchorMac, rssi };
    }
  }
  return best ? { ...best, heardBy } : null;
}

function clear() {
  heard.clear();
}

module.exports = { recordHearing, strongestAnchor, clear, HEARD_WITHIN_MS };
