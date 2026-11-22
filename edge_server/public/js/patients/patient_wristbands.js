// =============================================================================
// SHIRO Dashboard - wristbands from the patient list (Phase 11, step 3)
// Giving a patient a wristband, taking it off, the wristband history, and the
// "⋯" menu of a patient row. Replaces the separate Wristbands page: the
// wristband belongs to the patient, so it is handled where the patient is.
// Uses cachedPatients, bindingByPatient and loadPatientsDirectory() of patients_controller.js.
// =============================================================================
/* global cachedPatients, bindingByPatient, loadPatientsDirectory */
(function () {
  const toast = (msg, type = 'info', ms) => { if (window.showToast) window.showToast(msg, type, ms); };

  // ----- the "⋯" menu of a patient row -----
  let menuEl = null;

  function closeRowMenu() {
    if (menuEl) menuEl.style.display = 'none';
  }

  function ensureMenu() {
    if (menuEl) return menuEl;
    menuEl = document.createElement('div');
    menuEl.className = 'row-menu';
    menuEl.setAttribute('role', 'menu');
    document.body.appendChild(menuEl);
    document.addEventListener('click', (e) => {
      if (menuEl.style.display !== 'none' && !menuEl.contains(e.target) && !e.target.closest('[data-row-menu]')) closeRowMenu();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeRowMenu(); });
    window.addEventListener('scroll', closeRowMenu, true);
    return menuEl;
  }

  /** Opens the menu of one patient under its "⋯" button. */
  window.openPatientRowMenu = function (patientId, button) {
    const p = cachedPatients.find(x => x.patient_id === patientId);
    if (!p) return;
    const menu = ensureMenu();
    const b = bindingByPatient.get(patientId);
    const admitted = p.status === 'ADMITTED';
    const bedInfo = p.assigned_ward_id ? `${p.assigned_ward_id} · ${p.bed_code || p.assigned_bed_id}` : 'assigned bed';
    const items = [];
    items.push(`<button type="button" role="menuitem"${actionAttrs('editPatientInfo', [p.patient_id])}>Edit details</button>`);
    if (admitted && !p.assigned_bed_id) items.push(`<button type="button" role="menuitem"${actionAttrs('openAssignBedModal', [p.patient_id])}>Give a bed</button>`);
    if (admitted && p.assigned_bed_id) items.push(`<button type="button" role="menuitem"${actionAttrs('openAssignBedModal', [p.patient_id])}>Move to another bed</button>`);
    if (!admitted) items.push(`<button type="button" role="menuitem"${actionAttrs('openAssignBedModal', [p.patient_id])}>Admit again…</button>`);
    if (admitted && !b) items.push(`<button type="button" role="menuitem"${actionAttrs('openGiveWristband', [p.patient_id, p.full_name])}>Give a wristband</button>`);
    if (b) items.push(`<button type="button" role="menuitem"${actionAttrs('takeOffWristband', [p.patient_id])}>Take off wristband (${escapeHtml(b.device_id)})</button>`);
    items.push(`<button type="button" role="menuitem"${actionAttrs('openWristbandHistory', [p.patient_id, p.full_name])}>Wristband history</button>`);
    if (admitted && p.assigned_bed_id) items.push(`<button type="button" role="menuitem" class="danger"${actionAttrs('confirmDischargePatient', [p.patient_id, p.full_name, bedInfo])}>Discharge…</button>`);
    items.push(`<button type="button" role="menuitem" class="danger"${actionAttrs('confirmDeletePatient', [p.patient_id, p.full_name])}>Delete record…</button>`);
    menu.innerHTML = items.join('');
    menu.querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => setTimeout(closeRowMenu, 0)));

    const r = button.getBoundingClientRect();
    menu.style.display = 'block';
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w));
    const top = r.bottom + 4 + h > window.innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  };

  // ----- give a wristband -----
  window.openGiveWristband = async function (patientId, patientName) {
    let wristbands = [];
    try {
      const res = await fetch('/api/bindings/unpaired-candidates');
      const data = await res.json();
      wristbands = data.success && Array.isArray(data.wristbands) ? data.wristbands : [];
    } catch (err) {
      toast('The server does not answer. Try again.', 'danger');
      return;
    }
    if (wristbands.length === 0) {
      window.showModal({
        title: 'No free wristband',
        message: 'Every wristband is given to a patient or out of use.\n\nTake one off a patient who no longer needs it, or add a new wristband under Setup → Devices.',
        type: 'warning', confirmText: 'OK', cancelText: null
      });
      return;
    }
    // Wristbands that are on first: they can be checked on the patient at once
    const isOn = (w) => w.device_status === 'ONLINE' || w.device_status === 'CHARGING';
    wristbands.sort((a, b) => Number(isOn(b)) - Number(isOn(a)));
    const rows = wristbands.map((w, i) => {
      const battery = w.battery_level === null || w.battery_level === undefined ? '' : ` · battery ${w.battery_level}%`;
      return `<label class="pick-row" data-search="${escapeHtml(`${w.device_id} ${w.mac_address || ''}`.toLowerCase())}">
        <input type="radio" name="give-wristband" value="${escapeHtml(w.device_id)}"${i === 0 ? ' checked' : ''}>
        <span class="pick-main"><b>${escapeHtml(w.device_id)}</b><small class="mono">${escapeHtml(w.mac_address || '')}</small></span>
        <span class="pick-side"><span class="status-word">${escapeHtml(isOn(w) ? '● ON' : '○ OFF')}</span>${escapeHtml(battery)}</span>
      </label>`;
    }).join('');
    window.showModal({
      title: `Give ${patientName} a wristband`,
      customHtml: `
        <div style="font-size: 14px; color: var(--text-secondary); margin-bottom: 10px;">Choose a free wristband. Wristbands that are switched on are listed first.</div>
        <input type="text" class="form-control" id="give-wristband-search" placeholder="🔍 Type the wristband name or MAC" autocomplete="off" style="margin-bottom: 10px;">
        <div class="pick-list" id="give-wristband-list">${rows}</div>`,
      type: 'info',
      confirmText: 'Give this wristband',
      cancelText: 'Cancel',
      onConfirm: async () => {
        const chosen = document.querySelector('input[name="give-wristband"]:checked');
        if (!chosen) { toast('Choose a wristband first.', 'warning'); return; }
        try {
          const res = await fetch('/api/bindings/bind', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ patient_id: patientId, device_id: chosen.value })
          });
          const result = await res.json();
          if (result.success) {
            toast(`${patientName} now wears ${chosen.value}.`, 'success');
            await loadPatientsDirectory();
          } else {
            toast(`Not given: ${result.error || 'server error'}`, 'danger');
          }
        } catch (err) {
          toast('The server does not answer. The wristband was not given.', 'danger');
        }
      }
    });
    setTimeout(() => {
      const search = document.getElementById('give-wristband-search');
      if (!search) return;
      search.focus();
      search.addEventListener('input', () => {
        const q = search.value.trim().toLowerCase();
        document.querySelectorAll('#give-wristband-list .pick-row').forEach(row => {
          row.style.display = !q || row.getAttribute('data-search').includes(q) ? '' : 'none';
        });
      });
    }, 50);
  };

  // ----- take a wristband off -----
  window.takeOffWristband = function (patientId) {
    const b = bindingByPatient.get(patientId);
    if (!b) return;
    window.showModal({
      title: `Take off ${b.device_id}?`,
      message: `${b.device_id} becomes free for another patient. The history keeps who wore it and when.`,
      impact: {
        level: 'warning',
        title: `${b.patient_name || patientId} will no longer be watched:`,
        points: ['No heart rate, no fall alarms and no door alerts from this wristband.', 'They leave the ward map until they get another wristband.']
      },
      type: 'warning',
      confirmText: 'Take it off',
      cancelText: 'Cancel',
      onConfirm: async () => {
        try {
          const res = await fetch(`/api/bindings/unbind?id=${encodeURIComponent(b.binding_id)}`, { method: 'POST' });
          const result = await res.json();
          if (result.success) {
            toast(`${b.device_id} taken off ${b.patient_name || patientId}.`, 'info');
            await loadPatientsDirectory();
          } else {
            toast(`Not taken off: ${result.error || 'server error'}`, 'danger');
          }
        } catch (err) {
          toast('The server does not answer. Nothing was changed.', 'danger');
        }
      }
    });
  };

  // ----- wristband history: one patient, or every patient -----
  const durationText = (minutes) => {
    const m = Number(minutes);
    if (!Number.isFinite(m) || m < 0) return 'not recorded';
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
    const d = Math.floor(h / 24);
    return h % 24 ? `${d} d ${h % 24} h` : `${d} day${d === 1 ? '' : 's'}`;
  };
  // The patient profile uses the same wording (patients_controller.js)
  window.formatBindingDuration = durationText;
  const endText = (b) => (b.status === 'ACTIVE' ? 'Wearing it now' : b.status === 'DISCHARGED' ? 'Discharged' : 'Taken off');

  window.openWristbandHistory = async function (patientId = null, patientName = null) {
    let history = [];
    try {
      const res = await fetch('/api/bindings/history?limit=500');
      const data = await res.json();
      history = data.success && Array.isArray(data.history) ? data.history : [];
    } catch (err) {
      toast('The server does not answer. Try again.', 'danger');
      return;
    }
    if (patientId) history = history.filter(b => b.patient_id === patientId);
    let page = 1;
    const draw = () => {
      const body = document.getElementById('wristband-history-body');
      if (!body) return;
      const data = window.ShiroUI.paginate(history, page);
      page = data.page;
      body.innerHTML = data.total === 0
        ? `<tr><td colspan="5" class="empty-state">${escapeHtml(patientId ? 'This patient has not worn a wristband yet.' : 'No wristband has been given yet.')}</td></tr>`
        : data.items.map(b => `<tr>
            <td><b>${escapeHtml(b.patient_name)}</b><div class="mono" style="font-size: 12px; color: var(--text-muted);">${escapeHtml(b.patient_id)}</div></td>
            <td><b>${escapeHtml(b.device_id || 'deleted')}</b><div class="mono" style="font-size: 12px; color: var(--text-muted);">${escapeHtml(b.mac_address || '')}</div></td>
            <td>${escapeHtml(b.bound_at || 'not recorded')}<div style="font-size: 12px; color: var(--text-muted);">by ${escapeHtml(b.bound_by || 'not recorded')}</div></td>
            <td>${escapeHtml(endText(b))}<div style="font-size: 12px; color: var(--text-muted);">${escapeHtml(b.status === 'ACTIVE' ? '' : `${b.unbound_at || ''} ${b.unbound_by ? 'by ' + b.unbound_by : ''}`)}</div></td>
            <td>${escapeHtml(durationText(b.duration_minutes))}${escapeHtml(b.status === 'ACTIVE' ? ' so far' : '')}</td>
          </tr>`).join('');
      window.ShiroUI.renderPager(document.getElementById('wristband-history-pager'), {
        total: data.total, page: data.page, noun: 'entries', onPage: (n) => { page = n; draw(); }
      });
    };
    window.showModal({
      title: patientName ? `Wristbands of ${patientName}` : 'Wristband history',
      customHtml: `
        <div style="font-size: 14px; color: var(--text-secondary); margin-bottom: 10px;">Who wore which wristband, and when. Kept after a wristband is taken off or the patient goes home.</div>
        <div class="data-table-container">
          <table class="data-table">
            <thead><tr><th>Patient</th><th>Wristband</th><th>Given</th><th>Ended</th><th>How long</th></tr></thead>
            <tbody id="wristband-history-body"></tbody>
          </table>
        </div>
        <div id="wristband-history-pager"></div>`,
      isWide: true,
      type: 'info',
      confirmText: 'Close'
    });
    setTimeout(draw, 0);
  };
})();
