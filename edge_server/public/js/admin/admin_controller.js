// =============================================================================
// Admin tab: clinician accounts, headset pairing and the audit log
// =============================================================================
(function () {
  let wired = false;
  let pairingTimer = null;

  async function api(url, options = {}) {
    const res = await fetch(url, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    let data = {};
    try {
      data = await res.json();
    } catch (err) {
      console.warn('[ADMIN] Answer was not JSON:', err);
    }
    if (!res.ok || data.success === false) throw new Error(data.error || `The server answered ${res.status}.`);
    return data;
  }

  function formatTime(value) {
    if (!value) return '—';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
  }

  function emptyRow(columns, text) {
    return `<tr><td colspan="${escapeHtml(columns)}" style="text-align: center; color: var(--text-muted); padding: 24px;">${escapeHtml(text)}</td></tr>`;
  }

  // ----- accounts -----

  async function loadAccounts() {
    const body = document.getElementById('admin-accounts-body');
    if (!body) return;
    try {
      const { clinicians } = await api('/api/admin/clinicians');
      const me = window.shiroAuth && window.shiroAuth.user ? window.shiroAuth.user.clinician_id : null;
      body.innerHTML = clinicians.length === 0 ? emptyRow(7, 'No accounts.') : clinicians.map((c) => {
        const active = c.is_active;
        const statusBadge = active ? '<span class="badge badge-live">Active</span>' : '<span class="badge badge-neutral">Deactivated</span>';
        const typeBadge = c.role === 'ADMIN' ? '<span class="badge badge-info">Admin</span>' : '<span class="badge badge-neutral">Clinician</span>';
        const toggle = c.clinician_id === me
          ? '<span style="font-size: 12px; color: var(--text-muted);">(you)</span>'
          : `<button class="btn btn-outline btn-sm"${actionAttrs('adminSetActive', [c.clinician_id, !active])}>${active ? 'Deactivate' : 'Activate'}</button>`;
        return `<tr>
          <td class="mono">${escapeHtml(c.clinician_id)}</td>
          <td>${escapeHtml(c.full_name)}</td>
          <td class="mono">${escapeHtml(c.username)}</td>
          <td>${typeBadge}</td>
          <td>${statusBadge}</td>
          <td style="font-size: 12px;">${escapeHtml(formatTime(c.last_login_at))}</td>
          <td style="text-align: right; white-space: nowrap;">
            <button class="btn btn-outline btn-sm"${actionAttrs('adminResetPassword', [c.clinician_id, c.full_name])}>Reset password</button>
            ${toggle}
          </td>
        </tr>`;
      }).join('');
    } catch (err) {
      body.innerHTML = emptyRow(7, `Could not load the accounts: ${err.message}`);
    }
  }

  async function createAccount(event) {
    event.preventDefault();
    try {
      const { clinician } = await api('/api/admin/clinicians/create', {
        method: 'POST',
        body: JSON.stringify({
          full_name: document.getElementById('admin-new-fullname').value,
          username: document.getElementById('admin-new-username').value,
          role: document.getElementById('admin-new-role').value,
          password: document.getElementById('admin-new-password').value
        })
      });
      showToast(`Account ${clinician.clinician_id} (${clinician.username}) created.`, 'success');
      event.target.reset();
      loadAccounts();
      loadAudit();
    } catch (err) {
      showToast(err.message, 'danger', 5000);
    }
  }

  window.adminSetActive = async function (clinicianId, active) {
    try {
      await api('/api/admin/clinicians/set-active', { method: 'POST', body: JSON.stringify({ clinician_id: clinicianId, active }) });
      showToast(`${clinicianId} ${active ? 'activated' : 'deactivated and signed out'}.`, 'success');
      loadAccounts();
      loadAudit();
    } catch (err) {
      showToast(err.message, 'danger', 5000);
    }
  };

  window.adminResetPassword = function (clinicianId, fullName) {
    showModal({
      title: `New password for ${fullName}`,
      customHtml: `
        <p style="margin: 0 0 10px; font-size: 13px;">The account is signed out everywhere. Give the new password to ${escapeHtml(fullName)} in person.</p>
        <input class="form-control" type="password" id="admin-reset-password" minlength="10" maxlength="128" placeholder="At least 10 characters" autocomplete="new-password">`,
      confirmText: 'Set password',
      cancelText: 'Cancel',
      onConfirm: async () => {
        const input = document.getElementById('admin-reset-password');
        try {
          await api('/api/admin/clinicians/reset-password', {
            method: 'POST',
            body: JSON.stringify({ clinician_id: clinicianId, password: input ? input.value : '' })
          });
          showToast(`Password of ${clinicianId} changed.`, 'success');
          loadAudit();
        } catch (err) {
          showToast(err.message, 'danger', 5000);
        }
      }
    });
  };

  // ----- headset pairing -----

  const NETWORK_KIND_TEXT = {
    wifi: 'Wi-Fi',
    hotspot: 'this computer\'s mobile hotspot',
    ethernet: 'wired network',
    other: 'network'
  };

  // The address the headset app types on its hand slate (System → 🌐 Server address)
  async function loadServerAddress() {
    const box = document.getElementById('admin-server-address');
    if (!box) return;
    try {
      const { port, addresses } = await api('/api/admin/server-address');
      const usable = addresses.filter(a => a.usable);
      if (usable.length === 0) {
        box.innerHTML = '<strong>This computer has no network address.</strong> Connect it to the ward Wi-Fi (or switch on its mobile hotspot), then press ↻ Refresh. Over the Quest Link cable the headset uses 127.0.0.1.';
        return;
      }
      const [first, ...others] = usable;
      // "Wi-Fi", not "Wi-Fi, Wi-Fi" when the adapter is named after its kind
      const describe = (a) => {
        const kind = NETWORK_KIND_TEXT[a.kind] || 'network';
        return kind.toLowerCase() === a.name.toLowerCase() ? kind : `${kind}, ${a.name}`;
      };
      const firstKind = describe(first);
      const othersText = others.map(a => `${a.address} (${describe(a)})`).join(' · ');
      const othersHtml = others.length === 0 ? ''
        : `<div style="margin-top: 4px; color: var(--text-secondary);">Other networks of this computer: <span class="mono">${escapeHtml(othersText)}</span></div>`;
      box.innerHTML = `
        <div>Server address for the headset: <strong class="mono" style="font-size: 16px;">${escapeHtml(first.address)}</strong>
          <span style="color: var(--text-secondary);">(${escapeHtml(firstKind)}) · port ${escapeHtml(port)}</span></div>
        ${othersHtml}
        <div style="margin-top: 4px; color: var(--text-muted);">On the headset: hand slate → System → 🌐 Server address. The headset must be on the same network. Over the Quest Link cable: 💻 Quest Link (127.0.0.1).</div>`;
    } catch (err) {
      box.textContent = `Could not read the server address: ${err.message}`;
    }
  }

  async function loadHeadsets() {
    const body = document.getElementById('admin-headsets-body');
    if (!body) return;
    try {
      const [{ pairings }, { clinicians }] = await Promise.all([api('/api/admin/headsets'), api('/api/admin/clinicians')]);
      const activeClinicians = clinicians.filter(c => c.is_active);
      body.innerHTML = pairings.length === 0 ? emptyRow(6, 'No headset is paired yet.') : pairings.map((p) => {
        const revoked = Boolean(p.revoked_at);
        // Who uses the headset: what it does is recorded in this clinician's name
        let assignCell;
        if (revoked) {
          assignCell = '<span style="font-size: 12px; color: var(--text-muted);">—</span>';
        } else {
          const assigned = p.assigned_clinician_id || '';
          const stale = assigned && !p.assigned_user
            ? `<option value="${escapeHtml(assigned)}" selected>${escapeHtml(assigned)} (deactivated: acts for nobody)</option>`
            : '';
          const clinicianOptions = activeClinicians.map(c =>
            `<option value="${escapeHtml(c.clinician_id)}"${c.clinician_id === assigned ? ' selected' : ''}>${escapeHtml(c.full_name)} (${escapeHtml(c.clinician_id)})</option>`).join('');
          assignCell = `<select class="form-control" style="font-size: 12px; padding: 4px 6px; width: auto;"${actionAttrs('adminAssignHeadset', [p.device_id], { event: 'change', value: true })}>
              <option value=""${assigned ? '' : ' selected'}>— Nobody assigned —</option>
              ${stale}
              ${clinicianOptions}
            </select>`;
        }
        const statusBadgeHtml = revoked
          ? `<span class="badge badge-neutral">Revoked ${escapeHtml(formatTime(p.revoked_at))}</span>`
          : '<span class="badge badge-live">Paired</span>';
        const secondaryActionBtn = revoked
          ? ''
          : `<button class="btn btn-outline btn-sm"${actionAttrs('adminRevokeHeadset', [p.device_id])}>Revoke</button>`;
        return `<tr>
          <td class="mono">${escapeHtml(p.device_id)}</td>
          <td>${assignCell}</td>
          <td class="mono">${escapeHtml(p.paired_by)}</td>
          <td style="font-size: 12px;">${escapeHtml(formatTime(p.paired_at))}</td>
          <td>${statusBadgeHtml}</td>
          <td style="text-align: right;">${secondaryActionBtn}</td>
        </tr>`;
      }).join('');
    } catch (err) {
      body.innerHTML = emptyRow(6, `Could not load the pairings: ${err.message}`);
    }
  }

  window.adminAssignHeadset = async function (deviceId, clinicianId) {
    try {
      const { assigned_user: user } = await api('/api/admin/headsets/assign', {
        method: 'POST',
        body: JSON.stringify({ device_id: deviceId, clinician_id: clinicianId || null })
      });
      showToast(user ? `${deviceId} is now used by ${user.name}. Its actions are recorded in this name.` : `${deviceId} is assigned to nobody.`, 'success');
      loadAudit();
    } catch (err) {
      showToast(err.message, 'danger', 5000);
    }
    loadHeadsets();
  };

  async function newPairingCode() {
    try {
      const { code, valid_seconds: validSeconds } = await api('/api/admin/headsets/pairing-code', { method: 'POST' });
      const box = document.getElementById('admin-pairing-code-box');
      const codeEl = document.getElementById('admin-pairing-code');
      const countdown = document.getElementById('admin-pairing-countdown');
      box.style.display = 'block';
      codeEl.textContent = code;
      const ends = Date.now() + validSeconds * 1000;
      if (pairingTimer) clearInterval(pairingTimer);
      const tick = () => {
        const left = Math.max(0, Math.round((ends - Date.now()) / 1000));
        countdown.textContent = left > 0
          ? `Valid for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}. Enter it on the headset: hand slate → System → Pair.`
          : 'Expired. Create a new code.';
        if (left === 0) {
          codeEl.textContent = '——————';
          clearInterval(pairingTimer);
          pairingTimer = null;
          loadHeadsets();
        }
      };
      tick();
      pairingTimer = setInterval(tick, 1000);
    } catch (err) {
      showToast(err.message, 'danger', 5000);
    }
  }

  window.adminRevokeHeadset = function (deviceId) {
    showModal({
      title: `Revoke ${deviceId}?`,
      message: `${deviceId} is disconnected at once and can only connect again after a new pairing.`,
      type: 'danger',
      confirmText: 'Revoke',
      cancelText: 'Cancel',
      onConfirm: async () => {
        try {
          await api('/api/admin/headsets/revoke', { method: 'POST', body: JSON.stringify({ device_id: deviceId }) });
          showToast(`${deviceId} revoked.`, 'success');
          loadHeadsets();
          loadAudit();
        } catch (err) {
          showToast(err.message, 'danger', 5000);
        }
      }
    });
  };

  // ----- audit log -----

  async function loadAudit() {
    const body = document.getElementById('admin-audit-body');
    if (!body) return;
    const params = new URLSearchParams({ limit: '200' });
    const actor = document.getElementById('admin-audit-actor').value.trim();
    const action = document.getElementById('admin-audit-action').value.trim().toUpperCase();
    const target = document.getElementById('admin-audit-target').value.trim();
    if (actor) params.set('actor_id', actor);
    if (action) params.set('action', action);
    if (target) params.set('target_id', target);
    try {
      const { entries } = await api(`/api/admin/audit?${params}`);
      body.innerHTML = entries.length === 0 ? emptyRow(6, 'No entries.') : entries.map((e) => {
        const failed = /FAILED|LOCKED/.test(e.action);
        return `<tr>
          <td style="font-size: 12px; white-space: nowrap;">${escapeHtml(formatTime(e.created_at))}</td>
          <td>${escapeHtml(e.actor_label || 'not signed in')}</td>
          <td><span class="badge ${failed ? 'badge-alert' : 'badge-neutral'}">${escapeHtml(e.action)}</span></td>
          <td class="mono">${escapeHtml(e.target_id || '—')}</td>
          <td class="mono" style="font-size: 11px; color: var(--text-secondary); max-width: 280px; overflow-wrap: anywhere;">${escapeHtml(e.details || '')}</td>
          <td class="mono" style="font-size: 12px;">${escapeHtml(e.ip_address || '—')}</td>
        </tr>`;
      }).join('');
    } catch (err) {
      body.innerHTML = emptyRow(6, `Could not load the audit log: ${err.message}`);
    }
  }

  function wire() {
    if (wired) return;
    const form = document.getElementById('admin-create-account');
    if (!form) return; // the view is not loaded (not an admin)
    wired = true;
    form.addEventListener('submit', createAccount);
    document.getElementById('admin-refresh-accounts').addEventListener('click', loadAccounts);
    document.getElementById('admin-refresh-headsets').addEventListener('click', () => {
      loadHeadsets();
      loadServerAddress();
    });
    document.getElementById('admin-new-pairing-code').addEventListener('click', newPairingCode);
    document.getElementById('admin-audit-filter').addEventListener('submit', (event) => { event.preventDefault(); loadAudit(); });
    document.getElementById('admin-audit-clear').addEventListener('click', () => {
      document.getElementById('admin-audit-filter').reset();
      loadAudit();
    });
  }

  window.initAdminModule = function () {
    wire();
    loadAccounts();
    loadHeadsets();
    loadServerAddress();
    loadAudit();
  };
})();
