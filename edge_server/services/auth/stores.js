// =============================================================================
// SHIRO Edge Server - Storage of accounts, sessions and headset pairings
// mysqlStore is used by the server. memoryStore keeps the same data in memory,
// for the unit tests, which run without a database.
// =============================================================================

const CLINICIAN_COLUMNS = 'clinician_id, username, full_name, role, password_hash, is_active, created_at, created_by, last_login_at';

function mysqlStore() {
  const pool = () => require('../../database/db').getPool();

  return {
    async countClinicians() {
      const [rows] = await pool().query('SELECT COUNT(*) AS n FROM clinicians');
      return Number(rows[0].n);
    },
    async countActiveAdmins() {
      const [rows] = await pool().query("SELECT COUNT(*) AS n FROM clinicians WHERE role = 'ADMIN' AND is_active = 1");
      return Number(rows[0].n);
    },
    async maxClinicianNumber() {
      const [rows] = await pool().query(
        "SELECT MAX(CAST(SUBSTRING(clinician_id, 5) AS UNSIGNED)) AS n FROM clinicians WHERE clinician_id LIKE 'CLN-%'"
      );
      return Number(rows[0].n) || 0;
    },
    async findClinicianByUsername(username) {
      const [rows] = await pool().query(`SELECT ${CLINICIAN_COLUMNS} FROM clinicians WHERE username = ? LIMIT 1`, [username]);
      return rows[0] || null;
    },
    async findClinicianById(id) {
      const [rows] = await pool().query(`SELECT ${CLINICIAN_COLUMNS} FROM clinicians WHERE clinician_id = ? LIMIT 1`, [id]);
      return rows[0] || null;
    },
    async listClinicians() {
      const [rows] = await pool().query(`SELECT ${CLINICIAN_COLUMNS} FROM clinicians ORDER BY clinician_id`);
      return rows;
    },
    async insertClinician(c) {
      await pool().query(
        'INSERT INTO clinicians (clinician_id, username, full_name, role, password_hash, is_active, created_by) VALUES (?, ?, ?, ?, ?, 1, ?)',
        [c.clinician_id, c.username, c.full_name, c.role, c.password_hash, c.created_by || null]
      );
    },
    async updateClinician(id, fields) {
      const allowed = ['is_active', 'password_hash', 'last_login_at'];
      const keys = Object.keys(fields).filter(k => allowed.includes(k));
      if (keys.length === 0) return;
      await pool().query(
        `UPDATE clinicians SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE clinician_id = ?`,
        [...keys.map(k => fields[k]), id]
      );
    },

    async insertSession(s) {
      await pool().query(
        'INSERT INTO auth_sessions (token_hash, clinician_id, expires_at, ip_address) VALUES (?, ?, ?, ?)',
        [s.token_hash, s.clinician_id, s.expires_at, s.ip_address || null]
      );
    },
    async findSession(tokenHash) {
      const [rows] = await pool().query(
        'SELECT token_hash, clinician_id, expires_at, revoked_at FROM auth_sessions WHERE token_hash = ? LIMIT 1',
        [tokenHash]
      );
      return rows[0] || null;
    },
    async revokeSession(tokenHash) {
      await pool().query('UPDATE auth_sessions SET revoked_at = NOW() WHERE token_hash = ? AND revoked_at IS NULL', [tokenHash]);
    },
    async revokeSessionsOf(clinicianId) {
      await pool().query('UPDATE auth_sessions SET revoked_at = NOW() WHERE clinician_id = ? AND revoked_at IS NULL', [clinicianId]);
    },
    async deleteExpiredSessions() {
      await pool().query('DELETE FROM auth_sessions WHERE expires_at < NOW() - INTERVAL 7 DAY');
    },

    async upsertPairing(p) {
      await pool().query(
        `INSERT INTO headset_pairings (device_id, token_hash, paired_by, paired_at, revoked_at, revoked_by,
           assigned_clinician_id, assigned_at, assigned_by)
         VALUES (?, ?, ?, NOW(), NULL, NULL, NULL, NULL, NULL)
         ON DUPLICATE KEY UPDATE token_hash = VALUES(token_hash), paired_by = VALUES(paired_by),
           paired_at = NOW(), revoked_at = NULL, revoked_by = NULL,
           assigned_clinician_id = NULL, assigned_at = NULL, assigned_by = NULL`,
        [p.device_id, p.token_hash, p.paired_by]
      );
    },
    async findPairingByHash(tokenHash) {
      const [rows] = await pool().query(
        `SELECT p.device_id, p.paired_by, p.paired_at, p.revoked_at, p.assigned_clinician_id,
                c.full_name AS assigned_name, c.is_active AS assigned_active
         FROM headset_pairings p LEFT JOIN clinicians c ON c.clinician_id = p.assigned_clinician_id
         WHERE p.token_hash = ? LIMIT 1`,
        [tokenHash]
      );
      return rows[0] || null;
    },
    async revokePairing(deviceId, revokedBy) {
      const [result] = await pool().query(
        'UPDATE headset_pairings SET revoked_at = NOW(), revoked_by = ? WHERE device_id = ? AND revoked_at IS NULL',
        [revokedBy, deviceId]
      );
      return result.affectedRows > 0;
    },
    async listPairings() {
      const [rows] = await pool().query(
        `SELECT p.device_id, p.paired_by, p.paired_at, p.revoked_at, p.revoked_by,
                p.assigned_clinician_id, p.assigned_at, p.assigned_by,
                c.full_name AS assigned_name, c.is_active AS assigned_active
         FROM headset_pairings p LEFT JOIN clinicians c ON c.clinician_id = p.assigned_clinician_id
         ORDER BY p.paired_at DESC`
      );
      return rows;
    },
    async assignPairing(deviceId, clinicianId, assignedBy) {
      const [result] = await pool().query(
        `UPDATE headset_pairings SET assigned_clinician_id = ?, assigned_at = IF(? IS NULL, NULL, NOW()), assigned_by = ?
         WHERE device_id = ? AND revoked_at IS NULL`,
        [clinicianId, clinicianId, clinicianId ? assignedBy : null, deviceId]
      );
      return result.affectedRows > 0;
    },
    async listPairingsAssignedTo(clinicianId) {
      const [rows] = await pool().query(
        'SELECT device_id FROM headset_pairings WHERE assigned_clinician_id = ? AND revoked_at IS NULL',
        [clinicianId]
      );
      return rows.map(r => r.device_id);
    }
  };
}

function memoryStore() {
  const clinicians = new Map();
  const sessions = new Map();
  const pairings = new Map();
  const copy = (row) => (row ? { ...row } : null);
  // As the SQL join: the assigned clinician's name and state with the pairing
  const withClinician = (p) => {
    if (!p) return null;
    const c = p.assigned_clinician_id ? clinicians.get(p.assigned_clinician_id) : null;
    return { ...p, assigned_name: c ? c.full_name : null, assigned_active: c ? c.is_active : null };
  };

  return {
    async countClinicians() { return clinicians.size; },
    async countActiveAdmins() { return [...clinicians.values()].filter(c => c.role === 'ADMIN' && c.is_active).length; },
    async maxClinicianNumber() {
      return Math.max(0, ...[...clinicians.keys()].map(id => Number(id.replace(/^CLN-/, '')) || 0));
    },
    async findClinicianByUsername(username) { return copy([...clinicians.values()].find(c => c.username === username)); },
    async findClinicianById(id) { return copy(clinicians.get(id)); },
    async listClinicians() { return [...clinicians.values()].map(copy); },
    async insertClinician(c) {
      if ([...clinicians.values()].some(x => x.username === c.username)) {
        throw Object.assign(new Error('duplicate username'), { code: 'ER_DUP_ENTRY' });
      }
      clinicians.set(c.clinician_id, { ...c, is_active: 1, created_at: new Date(), last_login_at: null });
    },
    async updateClinician(id, fields) {
      const c = clinicians.get(id);
      if (c) Object.assign(c, fields);
    },

    async insertSession(s) { sessions.set(s.token_hash, { ...s, revoked_at: null }); },
    async findSession(tokenHash) { return copy(sessions.get(tokenHash)); },
    async revokeSession(tokenHash) { const s = sessions.get(tokenHash); if (s && !s.revoked_at) s.revoked_at = new Date(); },
    async revokeSessionsOf(clinicianId) {
      for (const s of sessions.values()) if (s.clinician_id === clinicianId && !s.revoked_at) s.revoked_at = new Date();
    },
    async deleteExpiredSessions() {},

    async upsertPairing(p) {
      pairings.set(p.device_id, { ...p, paired_at: new Date(), revoked_at: null, revoked_by: null, assigned_clinician_id: null, assigned_at: null, assigned_by: null });
    },
    async findPairingByHash(tokenHash) { return withClinician([...pairings.values()].find(p => p.token_hash === tokenHash)); },
    async revokePairing(deviceId, revokedBy) {
      const p = pairings.get(deviceId);
      if (!p || p.revoked_at) return false;
      p.revoked_at = new Date();
      p.revoked_by = revokedBy;
      return true;
    },
    async listPairings() { return [...pairings.values()].map(withClinician); },
    async assignPairing(deviceId, clinicianId, assignedBy) {
      const p = pairings.get(deviceId);
      if (!p || p.revoked_at) return false;
      p.assigned_clinician_id = clinicianId;
      p.assigned_at = clinicianId ? new Date() : null;
      p.assigned_by = clinicianId ? assignedBy : null;
      return true;
    },
    async listPairingsAssignedTo(clinicianId) {
      return [...pairings.values()].filter(p => p.assigned_clinician_id === clinicianId && !p.revoked_at).map(p => p.device_id);
    }
  };
}

module.exports = { mysqlStore, memoryStore };
