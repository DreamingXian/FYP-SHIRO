// =============================================================================
// SHIRO Edge Server - Fall Incident De-duplication
// A wristband repeats its fall flag for 45 seconds and every anchor in range
// forwards it, so one fall arrives as hundreds of packets. This tracker decides
// which packet opens a new incident and which ones belong to an open incident.
//
// observe() is synchronous on purpose: the session is registered before the
// caller starts any database work, so two packets that arrive in the same
// instant can never both be "new".
// =============================================================================
const thresholds = require('../../config/clinical_thresholds');

function createFallTracker({ sessionTtlMs = thresholds.fall.sessionTtlMs, now = () => Date.now() } = {}) {
  // key (wristband) -> { seq, startedAt, lastSeen, incidentId, acknowledged }
  const sessions = new Map();

  function isAlive(session, t) {
    return Boolean(session) && (t - session.lastSeen <= sessionTtlMs);
  }

  /**
   * @param {string} key  wristband identity
   * @param {number|null} seq  fall counter from the wristband, null for old firmware
   * @returns {{ isNew: boolean, session: object }}
   */
  function observe(key, seq = null) {
    const t = now();
    const existing = sessions.get(key);

    if (isAlive(existing, t)) {
      // Same counter: the same fall. A missing counter (old firmware) cannot
      // tell two falls apart, so it is treated as the same fall while the
      // session is open.
      const sameFall = seq === null || existing.seq === null || existing.seq === seq;
      if (sameFall) {
        existing.lastSeen = t;
        if (existing.seq === null && seq !== null) existing.seq = seq;
        return { isNew: false, session: existing };
      }
    }

    const session = { seq, startedAt: t, lastSeen: t, incidentId: null, acknowledged: false };
    sessions.set(key, session);
    return { isNew: true, session };
  }

  /** Marks the session of an incident as acknowledged. Returns true when found. */
  function markAcknowledged(incidentId) {
    let found = false;
    for (const session of sessions.values()) {
      if (session.incidentId === incidentId) {
        session.acknowledged = true;
        found = true;
      }
    }
    return found;
  }

  /** Removes sessions that have been silent for longer than the session lifetime. */
  function sweep() {
    const t = now();
    let removed = 0;
    for (const [key, session] of sessions.entries()) {
      if (!isAlive(session, t)) {
        sessions.delete(key);
        removed++;
      }
    }
    return removed;
  }

  return { observe, markAcknowledged, sweep, size: () => sessions.size };
}

module.exports = { createFallTracker };
