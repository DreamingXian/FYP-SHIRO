// =============================================================================
// SHIRO Hospital Edge Server - Incident ID Sequence
// Produces INC-YYYYMMDD-NNNN, where NNNN counts up within the day and continues
// from the highest number already stored. Replaces the random suffix, which
// could collide.
// =============================================================================

function dateKey(date) {
  return date.getFullYear().toString() +
    String(date.getMonth() + 1).padStart(2, '0') +
    String(date.getDate()).padStart(2, '0');
}

function formatIncidentId(key, sequence) {
  return `INC-${key}-${String(sequence).padStart(4, '0')}`;
}

/**
 * @param {object} options
 * @param {(key: string) => Promise<number>} options.loadMaxSequence
 *        Highest sequence number already stored for that day (0 when none).
 * @param {() => Date} [options.now]
 * @returns {() => Promise<string>} next()
 */
function createIncidentIdGenerator({ loadMaxSequence, now = () => new Date() }) {
  let currentKey = null;
  let sequence = 0;
  let loading = null; // { key, promise }

  return async function next() {
    const key = dateKey(now());
    if (key !== currentKey) {
      if (!loading || loading.key !== key) {
        const promise = Promise.resolve()
          .then(() => loadMaxSequence(key))
          .then(max => Number(max) || 0, () => 0) // unreachable store: start at 0, the insert retry covers duplicates
          .then(max => {
            currentKey = key;
            sequence = max;
          });
        loading = { key, promise };
      }
      await loading.promise;
    }
    // Synchronous from here on: concurrent callers each receive a distinct number
    sequence += 1;
    return formatIncidentId(key, sequence);
  };
}

async function loadMaxSequenceFromDatabase(key) {
  const { getPool } = require('../../database/db');
  const [rows] = await getPool().query(
    `SELECT MAX(CAST(SUBSTRING_INDEX(incident_id, '-', -1) AS UNSIGNED)) AS max_seq
     FROM emergency_incident_logs
     WHERE incident_id LIKE ?`,
    [`INC-${key}-%`]
  );
  return rows.length > 0 && rows[0].max_seq !== null ? Number(rows[0].max_seq) : 0;
}

const nextIncidentId = createIncidentIdGenerator({ loadMaxSequence: loadMaxSequenceFromDatabase });

module.exports = {
  dateKey,
  formatIncidentId,
  createIncidentIdGenerator,
  loadMaxSequenceFromDatabase,
  nextIncidentId
};
