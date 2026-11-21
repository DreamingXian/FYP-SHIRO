// =============================================================================
// SHIRO Dashboard - Incident history (falls, critical vitals, geofence)
// One patient's incidents, or every patient's, from GET /api/alerts/history.
// Opened from the Patients page: the 🚨 button of a row, the patient profile,
// or "Incident log" above the census table.
// Every value from the server is escaped; nothing missing is filled in.
// =============================================================================
(function () {
  const RANGES = [
    { key: '24h', label: '24 h' },
    { key: '7d', label: '7 days' },
    { key: '30d', label: '30 days' },
    { key: 'all', label: 'All' }
  ];
  const CATEGORY_LABELS = {
    FALL_ACCIDENT: '🚨 Fall',
    CRITICAL_VITALS: '❤️ Critical vitals',
    GEOFENCE_BREACH: '🚪 Left the ward'
  };
  // A geofence alert is one of two kinds (Phase 10); older ones have none
  const GEOFENCE_KIND_LABELS = { LEFT_WARD: '🚪 Left the ward', AT_DOOR: '🚪 At the door' };
  const typeLabel = (inc) => (inc.incident_category === 'GEOFENCE_BREACH' && GEOFENCE_KIND_LABELS[inc.geofence_kind])
    || CATEGORY_LABELS[inc.incident_category] || inc.incident_category;
  const LIST_LIMIT = 200;

  // What the open modal shows. null patientId = every patient.
  const state = { patientId: null, patientName: '', range: '30d', category: '', includeSimulated: true, open: false };
  let liveUpdatesWired = false;
  let reloadTimer = null;

  /** "45 s", "3 min 20 s", "1 h 05 min"; null stays unknown. */
  function formatDuration(seconds) {
    if (seconds === null || seconds === undefined || !isFinite(Number(seconds))) return null;
    const s = Math.max(0, Math.round(Number(seconds)));
    if (s < 60) return `${s} s`;
    if (s < 3600) return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
    return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')} min`;
  }

  function formatTime(value) {
    if (!value) return null;
    const d = new Date(value);
    if (isNaN(d.getTime())) return String(value);
    return d.toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function numberOrNull(v) {
    return v === null || v === undefined || v === '' || !isFinite(Number(v)) ? null : Number(v);
  }

  /** The measurements stored with the incident. Values that were not measured are left out. */
  function measurementsText(inc) {
    const parts = [];
    const impact = numberOrNull(inc.kinematic_impact_force);
    const still = numberOrNull(inc.post_impact_stillness);
    const freefall = numberOrNull(inc.freefall_min_g);
    const hr = numberOrNull(inc.heart_rate);
    const spo2 = numberOrNull(inc.spo2);
    if (impact !== null) parts.push(`impact ${impact.toFixed(2)} g`);
    if (freefall !== null) parts.push(`free-fall min ${freefall.toFixed(2)} g`);
    if (still !== null) parts.push(`stillness ${still.toFixed(2)} g`);
    if (hr !== null && hr > 0) parts.push(`HR ${hr} bpm`);
    if (spo2 !== null && spo2 > 0) parts.push(`SpO2 ~${Math.round(spo2)} %`);
    return parts.length ? parts.join(' · ') : 'not measured';
  }

  // Incidents from before 22 Nov 2026 may have a position but no ward: the ward was
  // taken only from the patient's bed then. Say so instead of showing a bare position.
  function locationText(inc) {
    const place = [inc.ward_id, inc.bed_id].filter(Boolean).join(' · ');
    const x = numberOrNull(inc.pos_x);
    const y = numberOrNull(inc.pos_y);
    const pos = x !== null && y !== null ? `at (${x.toFixed(1)} m, ${y.toFixed(1)} m)` : '';
    if (!place && pos) return `ward not recorded, ${pos}`;
    return [place, pos].filter(Boolean).join(', ') || 'not recorded';
  }

  function incidentRow(inc, showPatient) {
    const typeBadge = `<span class="badge ${inc.incident_category === 'FALL_ACCIDENT' ? 'badge-alert' : 'badge-warning'}">${escapeHtml(typeLabel(inc))}</span>`
      + (Number(inc.is_simulated) === 1 ? ' <span class="badge badge-neutral" title="A test alarm from Test tools, not from a wristband">Test</span>' : '');

    let statusBadge;
    if (inc.resolution_status === 'PENDING') {
      statusBadge = '<span class="badge badge-alert">● Waiting for response</span>';
    } else {
      const took = formatDuration(inc.response_latency_seconds);
      statusBadge = `<span class="badge badge-live">✔ ${escapeHtml(String(inc.resolution_status).replace('_', ' ').toLowerCase())}</span>`
        + `<div style="font-size:11px; color:var(--text-secondary); margin-top:3px;">by ${escapeHtml(inc.attending_clinician || 'not recorded')}</div>`
        + `<div style="font-size:11px; color:var(--text-muted);">${escapeHtml(formatTime(inc.acknowledgment_time) || 'time not recorded')}</div>`
        + `<div style="font-size:11px; font-weight:600; color:var(--text-primary);">response ${escapeHtml(took || 'not recorded')}</div>`;
    }

    const patientCell = showPatient
      ? `<td><div style="font-weight:600;">${escapeHtml(inc.patient_name || 'not recorded')}</div><div class="mono" style="font-size:11px; color:var(--primary);">${escapeHtml(inc.patient_id || 'no patient record')}</div></td>`
      : '';

    return `
      <tr>
        <td style="white-space:nowrap;">
          <div style="font-weight:600;">${escapeHtml(formatTime(inc.trigger_timestamp) || 'not recorded')}</div>
          <div class="mono" style="font-size:10px; color:var(--text-muted);">${escapeHtml(inc.incident_id)}</div>
        </td>
        ${patientCell}
        <td>${typeBadge}<div style="font-size:11px; color:var(--text-secondary); margin-top:4px; max-width:260px;">${escapeHtml(inc.alert_message || '')}</div></td>
        <td style="font-size:12px;">${escapeHtml(locationText(inc))}</td>
        <td style="font-size:12px;">${escapeHtml(measurementsText(inc))}</td>
        <td>${statusBadge}</td>
      </tr>`;
  }

  function summaryTile(label, value, color) {
    return `
      <div style="flex:1; min-width:120px; background:#F8FAFC; border:1px solid var(--border); border-radius:8px; padding:10px 12px;">
        <div style="font-size:11px; color:var(--text-muted);">${escapeHtml(label)}</div>
        <div style="font-size:20px; font-weight:700; color:${escapeHtml(color)};">${escapeHtml(value)}</div>
      </div>`;
  }

  let incidentPage = 1;
  function renderResult(data, page = 1) {
    const container = document.getElementById('incident-history-container');
    if (!container) return;
    incidentPage = page;
    const s = data.summary;
    const showPatient = !state.patientId;

    const summaryHtml = [
      summaryTile('Incidents', String(s.total), 'var(--text-primary)'),
      summaryTile('Falls', String(s.falls), s.falls > 0 ? 'var(--danger)' : 'var(--text-primary)'),
      summaryTile('Waiting for response', String(s.pending), s.pending > 0 ? 'var(--danger)' : 'var(--success)'),
      summaryTile('Average response', formatDuration(s.avg_response_seconds) || 'no response yet', 'var(--text-primary)'),
      summaryTile('Slowest response', formatDuration(s.max_response_seconds) || 'no response yet', 'var(--text-primary)')
    ].join('');

    const testNote = s.simulated > 0 && state.includeSimulated
      ? `${s.simulated} of these ${s.total} are test alarms (marked Test).`
      : '';
    const cutNote = data.truncated ? `Showing the newest ${data.count} of ${s.total}.` : '';
    const filterNote = [testNote, cutNote].filter(Boolean).join(' ');

    const pageData = window.ShiroUI.paginate(data.history, incidentPage);
    incidentPage = pageData.page;
    let incidentRowsHtml;
    if (data.history.length === 0) {
      incidentRowsHtml = `<tr><td colspan="${showPatient ? '6' : '5'}" class="empty-state">No incidents in this period.</td></tr>`;
    } else {
      incidentRowsHtml = pageData.items.map(inc => incidentRow(inc, showPatient)).join('');
    }

    container.innerHTML = `
      <div style="display:flex; gap:10px; flex-wrap:wrap; margin-bottom:10px;">${summaryHtml}</div>
      <div style="font-size:11px; color:var(--text-muted); margin-bottom:8px; min-height:14px;">${escapeHtml(filterNote)}</div>
      <div class="data-table-container">
        <table class="data-table">
          <thead>
            <tr>
              <th>When</th>
              ${showPatient ? '<th>Patient</th>' : ''}
              <th>Type</th>
              <th>Where</th>
              <th>Measured</th>
              <th>Response</th>
            </tr>
          </thead>
          <tbody>${incidentRowsHtml}</tbody>
        </table>
      </div>
      <div id="incident-history-pager"></div>`;
    window.ShiroUI.renderPager(document.getElementById('incident-history-pager'), {
      total: pageData.total, page: pageData.page, noun: 'incidents',
      onPage: (n) => renderResult(data, n)
    });
  }

  async function loadIncidentHistory() {
    const container = document.getElementById('incident-history-container');
    if (!container) { state.open = false; return; }

    const params = new URLSearchParams({ range: state.range, limit: String(LIST_LIMIT), simulated: state.includeSimulated ? 'include' : 'exclude' });
    if (state.patientId) params.set('patient_id', state.patientId);
    if (state.category) params.set('category', state.category);

    try {
      const res = await fetch(`/api/alerts/history?${params.toString()}`);
      const data = await res.json();
      if (!res.ok || !data.success) {
        container.innerHTML = `<div style="padding:28px; text-align:center; color:var(--danger);">Could not load the incident history: ${escapeHtml(data.error || `server answered ${res.status}`)}</div>`;
        return;
      }
      renderResult(data);
    } catch (err) {
      container.innerHTML = '<div style="padding:28px; text-align:center; color:var(--danger);">The edge server cannot be reached. The incident history is not available.</div>';
    }
  }

  /** New and acknowledged incidents appear while the history is open. */
  function wireLiveUpdates() {
    if (liveUpdatesWired || !window.wsClient) return;
    liveUpdatesWired = true;
    const reloadIfOpen = () => {
      if (!state.open || !document.getElementById('incident-history-container')) { state.open = false; return; }
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(loadIncidentHistory, 500);
    };
    window.wsClient.on('EMERGENCY_ALERT', reloadIfOpen);
    window.wsClient.on('EMERGENCY_ACKNOWLEDGED', reloadIfOpen);
  }

  function markActiveRange() {
    document.querySelectorAll('#incident-range-pills .range-btn').forEach(b => {
      b.className = b.getAttribute('data-range') === state.range ? 'btn btn-primary btn-sm range-btn' : 'btn btn-outline btn-sm range-btn';
    });
  }

  /**
   * Opens the incident history. Without a patient ID it lists every patient's incidents.
   */
  function openIncidentHistoryModal(patientId, patientName) {
    state.patientId = patientId || null;
    state.patientName = patientName || '';
    state.range = state.patientId ? 'all' : '30d';
    state.category = '';
    state.includeSimulated = true;
    state.open = true;

    const heading = state.patientId ? (state.patientName || state.patientId) : 'All patients';
    const idTag = state.patientId
      ? `<span class="mono" style="font-size:12px; color:var(--primary); font-weight:600;">(${escapeHtml(state.patientId)})</span>`
      : '';
    const pillsHtml = RANGES.map(r =>
      `<button type="button" class="btn btn-outline btn-sm range-btn" data-range="${escapeHtml(r.key)}"${actionAttrs('setIncidentHistoryRange', [r.key])} style="padding:4px 10px; font-size:11px; font-weight:600;">${escapeHtml(r.label)}</button>`
    ).join('');

    const modalHtml = `
      <div style="margin-bottom:12px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
        <div>
          <div style="font-size:16px; font-weight:700; color:var(--text-primary);">
            🚨 ${escapeHtml(heading)} ${idTag}
          </div>
          <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">Falls, critical vitals and ward exits from the incident audit log (MySQL)</div>
        </div>
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
          <select class="form-control" style="width:auto; font-size:12px; padding:4px 8px;"${actionAttrs('setIncidentHistoryCategory', [], { event: 'change', value: true })}>
            <option value="">All types</option>
            <option value="FALL_ACCIDENT">Falls</option>
            <option value="CRITICAL_VITALS">Critical vitals</option>
            <option value="GEOFENCE_BREACH">Door: at the door, left the ward</option>
          </select>
          <label style="font-size:12px; display:flex; align-items:center; gap:4px; cursor:pointer;">
            <input type="checkbox" checked${actionAttrs('setIncidentHistorySimulated', [], { event: 'change', element: true })}> Live Lab tests
          </label>
          <div id="incident-range-pills" style="display:flex; gap:6px; background:#F1F5F9; padding:4px; border-radius:6px; border:1px solid var(--border);">${pillsHtml}</div>
          <button type="button" class="btn btn-outline btn-sm" id="incident-csv-btn"${actionAttrs('downloadIncidentCsv', [])} title="Download this list (same filters, up to 10,000 incidents) as a CSV file for Excel" style="font-size:12px; font-weight:600;">⬇ CSV</button>
        </div>
      </div>
      <div id="incident-history-container" style="min-height:300px;">
        <div style="text-align:center; padding:48px; color:var(--text-muted);">Loading the incident history…</div>
      </div>`;

    if (window.showModal) {
      window.showModal({
        title: 'Incident History',
        customHtml: modalHtml,
        isWide: true,
        type: 'info',
        confirmText: 'Close'
      });
    }
    markActiveRange();
    wireLiveUpdates();
    loadIncidentHistory();
  }

  function setIncidentHistoryRange(range) {
    if (!RANGES.some(r => r.key === range)) return;
    state.range = range;
    markActiveRange();
    loadIncidentHistory();
  }

  function setIncidentHistoryCategory(value) {
    state.category = CATEGORY_LABELS[value] ? value : '';
    loadIncidentHistory();
  }

  function setIncidentHistorySimulated(checkbox) {
    state.includeSimulated = !!(checkbox && checkbox.checked);
    loadIncidentHistory();
  }

  /** The list with the current filters as a CSV file (GET /api/alerts/history.csv). */
  async function downloadIncidentCsv() {
    const params = new URLSearchParams({ range: state.range, simulated: state.includeSimulated ? 'include' : 'exclude' });
    if (state.patientId) params.set('patient_id', state.patientId);
    if (state.category) params.set('category', state.category);
    const btn = document.getElementById('incident-csv-btn');
    if (btn) btn.disabled = true;
    try {
      const res = await fetch(`/api/alerts/history.csv?${params.toString()}`);
      if (!res.ok) {
        let message = `server answered ${res.status}`;
        try { message = (await res.json()).error || message; } catch { /* not JSON */ }
        if (window.showToast) window.showToast(`CSV export failed: ${message}`, 'danger');
        return;
      }
      const disposition = res.headers.get('Content-Disposition') || '';
      const match = /filename="([^"]+)"/.exec(disposition);
      const fileName = match ? match[1] : 'shiro-incidents.csv';
      const total = Number(res.headers.get('X-Shiro-Total-Count'));
      const exported = Number(res.headers.get('X-Shiro-Exported-Count'));

      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);

      if (window.showToast) {
        window.showToast(Number.isFinite(total) && Number.isFinite(exported) && total > exported
          ? `Saved ${fileName}: the newest ${exported} of ${total} incidents.`
          : `Saved ${fileName} (${Number.isFinite(exported) ? exported : '?'} incidents).`, 'success');
      }
    } catch (err) {
      if (window.showToast) window.showToast('The edge server cannot be reached. The CSV was not saved.', 'danger');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  window.openIncidentHistoryModal = openIncidentHistoryModal;
  window.setIncidentHistoryRange = setIncidentHistoryRange;
  window.setIncidentHistoryCategory = setIncidentHistoryCategory;
  window.setIncidentHistorySimulated = setIncidentHistorySimulated;
  window.downloadIncidentCsv = downloadIncidentCsv;
  // For tests in the browser console
  window.shiroIncidentHistory = { formatDuration, measurementsText, locationText };
})();
