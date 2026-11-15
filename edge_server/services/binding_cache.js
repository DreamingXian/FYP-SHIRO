// =============================================================================
// SHIRO Hospital Edge Server - Active Binding Cache
// In-memory map of wristband device ID -> bound patient ID.
// Lets the telemetry pipeline tag each reading with the real patient without a
// database query per packet.
// =============================================================================

const logger = require('../utils/logger');
function normalise(deviceId) {
  return String(deviceId || '').trim().toUpperCase();
}

/**
 * @param {object} options
 * @param {() => Promise<Array<{device_id: string, patient_id: string}>>} options.load
 *        Returns the active bindings.
 * @param {number} [options.maxAgeMs] Age after which a lookup triggers a background refresh.
 * @param {number} [options.retryAfterFailureMs] Wait before the next background attempt after a failed one.
 * @param {() => number} [options.now]
 */
function createBindingCache({ load, maxAgeMs = 15000, retryAfterFailureMs = 5000, now = Date.now }) {
  let byDevice = new Map();
  let lastRefresh = 0;
  let lastFailure = null; // time of the last failed load, null while loads succeed
  let inFlight = null;

  async function refresh() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const rows = await load();
        const next = new Map();
        for (const r of rows) {
          if (r.device_id && r.patient_id) next.set(normalise(r.device_id), r.patient_id);
        }
        byDevice = next;
        lastRefresh = now();
        if (lastFailure !== null) {
          lastFailure = null;
          logger.info(`[BINDING CACHE] Database answers again; ${next.size} active binding(s) loaded.`);
        }
      } catch (err) {
        lastFailure = now();
        throw err;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  /**
   * Returns the patient bound to this wristband, or null when it is unbound.
   * Never blocks: a stale cache answers from memory and refreshes in the background.
   * After a failed refresh the next background attempt waits retryAfterFailureMs,
   * so an unreachable database is not retried on every telemetry packet.
   */
  function getPatientIdForDevice(deviceId) {
    const t = now();
    const stale = t - lastRefresh > maxAgeMs;
    const waitingAfterFailure = lastFailure !== null && t - lastFailure < retryAfterFailureMs;
    if (stale && !waitingAfterFailure) {
      refresh().catch(err => {
        if (logger.every('binding-cache-refresh', 30000)) {
          logger.warn(`[BINDING CACHE] Refresh failed (${err.code || err.message}). Using the last known bindings; retried every ${retryAfterFailureMs / 1000} s.`);
        }
      });
    }
    return byDevice.get(normalise(deviceId)) || null;
  }

  function size() {
    return byDevice.size;
  }

  return { refresh, getPatientIdForDevice, size };
}

async function loadActiveBindingsFromDatabase() {
  const { getPool } = require('../database/db');
  const [rows] = await getPool().query(
    "SELECT device_id, patient_id FROM patient_bindings WHERE status = 'ACTIVE'"
  );
  return rows;
}

// Shared instance used by the running server
const defaultCache = createBindingCache({ load: loadActiveBindingsFromDatabase });

module.exports = {
  createBindingCache,
  refresh: defaultCache.refresh,
  getPatientIdForDevice: defaultCache.getPatientIdForDevice,
  size: defaultCache.size
};
