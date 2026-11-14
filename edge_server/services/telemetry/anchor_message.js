// =============================================================================
// SHIRO Edge Server - Anchor message check
// Checks the addressing part of the JSON an anchor publishes (who heard whom,
// and how strongly) before anything is looked up or stored. The telemetry
// fields of the same message are checked by normalize.js.
// Message format: docs/protocol.md, section 2.
// =============================================================================
const { normalizeMac, toFiniteNumber, isId } = require('../../utils/validate');

// Largest MQTT payload that is read. An anchor message is about 350 bytes.
const MAX_PAYLOAD_BYTES = 2048;

// Signal strength an anchor can report, in dBm. 0 marks a standby heartbeat.
const RSSI_MIN = -120;
const RSSI_MAX = 0;

const DEVICE_TYPES = ['WRISTBAND', 'ANCHOR', 'HEADSET'];

/**
 * @param {*} parsed  the JSON of one MQTT message
 * @returns {{ok: true, anchorMac: string, rssi: number, standby: boolean, tagMac: string|null, tagMacInvalid: boolean}
 *          | {ok: false, reason: string}}
 */
function checkAnchorMessage(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'the message is not a JSON object' };
  }

  const anchorMac = normalizeMac(parsed.anchor_mac);
  if (anchorMac === null) return { ok: false, reason: 'anchor_mac is missing or not a MAC address' };

  const rssi = toFiniteNumber(parsed.rssi);
  if (rssi === null || rssi < RSSI_MIN || rssi > RSSI_MAX) {
    return { ok: false, reason: `rssi is missing or outside ${RSSI_MIN} to ${RSSI_MAX} dBm` };
  }

  const standby = rssi === 0 || parsed.status === 'STANDBY';
  const hasTag = parsed.tag_mac !== undefined && parsed.tag_mac !== null && parsed.tag_mac !== '';
  const tagMac = hasTag ? normalizeMac(parsed.tag_mac) : null;

  return { ok: true, anchorMac, rssi, standby, tagMac, tagMacInvalid: hasTag && tagMac === null };
}

/**
 * Checks a device announcement (discovery topic). Returns the fields the
 * discovery list uses, or null when the announcement is not usable.
 */
function checkDiscoveryMessage(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const mac = normalizeMac(parsed.mac);
  if (mac === null) return null;

  const text = (value, max) => (typeof value === 'string' && value.length <= max && /^[\x20-\x7E]*$/.test(value) && value.trim() !== '' ? value.trim() : undefined);
  const rssi = toFiniteNumber(parsed.rssi);
  const battery = toFiniteNumber(parsed.battery_level);

  return {
    mac,
    suggested_id: isId(parsed.suggested_id) ? parsed.suggested_id : undefined,
    device_type: DEVICE_TYPES.includes(parsed.device_type) ? parsed.device_type : undefined,
    hardware_model: text(parsed.hardware_model, 64),
    rssi: rssi !== null && rssi >= RSSI_MIN && rssi <= RSSI_MAX ? rssi : undefined,
    battery_level: battery !== null && battery >= 0 && battery <= 100 ? Math.round(battery) : undefined,
    is_charging: typeof parsed.is_charging === 'boolean' ? parsed.is_charging : undefined
  };
}

module.exports = { checkAnchorMessage, checkDiscoveryMessage, MAX_PAYLOAD_BYTES, RSSI_MIN, RSSI_MAX };
