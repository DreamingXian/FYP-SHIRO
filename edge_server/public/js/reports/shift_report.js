// =============================================================================
// SHIRO Dashboard - Nursing shift summary report page (/shift_report.html)
// Thesis section 4.7.1. Loads GET /api/reports/shift-summary for a ward and a
// shift and lays it out for printing (A4). Every value from the server is
// escaped; a value that was not measured is shown as "not measured", never 0.
// =============================================================================
(function () {
  const $ = (id) => document.getElementById(id);
  const sheet = $('report-sheet');
  const statusEl = $('report-status');

  const CATEGORY_TEXT = { FALL_ACCIDENT: 'Fall', CRITICAL_VITALS: 'Critical vitals', GEOFENCE_BREACH: 'Left the ward' };

  const pad = (n) => String(n).padStart(2, '0');
  function fmtTime(isoText) {
    if (!isoText) return '';
    const d = new Date(isoText);
    return Number.isNaN(d.getTime()) ? '' : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function fmtDateTime(isoText) {
    if (!isoText) return '';
    const d = new Date(isoText);
    return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function fmtDuration(seconds) {
    if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) return 'not recorded';
    const s = Math.round(Number(seconds));
    if (s < 60) return `${s} s`;
    if (s < 3600) return `${Math.floor(s / 60)} min ${pad(s % 60)} s`;
    return `${Math.floor(s / 3600)} h ${pad(Math.floor((s % 3600) / 60))} min`;
  }
  function statsText(stats, unit) {
    if (!stats) return 'not measured';
    return `${stats.min} / ${stats.mean} / ${stats.max} ${unit} (${stats.count} readings)`;
  }

  function setStatus(text) { statusEl.textContent = text || ''; }

  function showError(text) {
    sheet.innerHTML = `<div class="error">${escapeHtml(text)}</div>`;
  }

  function showSignIn() {
    sheet.innerHTML = '<div class="error">Please sign in first. <a href="/login.html">Open the sign-in page</a>, then come back to this page.</div>';
  }

  async function getJson(url) {
    const res = await fetch(url);
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    return { status: res.status, data };
  }

  // ----- the report -----

  function tile(label, value) {
    return `<div class="tile"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div></div>`;
  }

  function render(r) {
    const s = r.incidents.summary;
    const c = r.census;
    const shiftText = `${r.shift.label} shift, ${fmtDateTime(r.shift.start)} to ${fmtDateTime(r.shift.end)}`;
    const progress = r.shift.in_progress ? ` · in progress: data until ${fmtDateTime(r.shift.data_until)}` : '';

    const anchorsOnline = r.devices_now.anchors.filter(a => a.status === 'ONLINE').length;
    const tilesHtml = [
      tile('Patients during the shift', String(c.patients_during_shift)),
      tile('In the ward at the end', String(c.in_ward_at_end)),
      tile('Beds occupied / total', `${c.beds_occupied_at_end} / ${r.ward.beds_total}`),
      tile('Admissions / discharges', `${c.admissions} / ${c.discharges}`),
      tile('Incidents (real)', String(s.total)),
      tile('Falls', String(s.falls)),
      tile('Waiting for a response', String(s.pending)),
      tile('Average / slowest response', s.avg_response_seconds === null ? 'none acknowledged' : `${fmtDuration(s.avg_response_seconds)} / ${fmtDuration(s.max_response_seconds)}`),
      tile('Wristbands bound now', String(c.wristbands_bound_now)),
      tile('Wristbands bound / unbound in shift', `${c.bindings_started} / ${c.bindings_ended}`),
      tile('Anchors online now', `${anchorsOnline} / ${r.devices_now.anchors.length}`),
      tile('Live Lab tests (not counted)', String(s.live_lab_tests))
    ].join('');

    const vitalsNote = r.vitals_source.available
      ? ''
      : `<div class="warn">Vitals not available: ${escapeHtml(r.vitals_source.reason || 'InfluxDB could not answer')}. The table shows no values instead of guessed ones.</div>`;

    const patientRowsHtml = r.patients.length === 0
      ? '<tr><td colspan="7" class="muted" style="text-align:center; padding:14px;">No patient was in this ward during the shift.</td></tr>'
      : r.patients.map(p => {
        const attnHtml = p.attention.length > 0
          ? `<span class="attn">ATTN</span>${escapeHtml(p.attention.join('; '))}`
          : '<span class="muted">none</span>';
        const bands = p.wristbands.length === 0 ? 'none' : p.wristbands.map(w =>
          `${w.device_id || 'deleted'}${w.unbound_at ? ` (until ${fmtTime(w.unbound_at)})` : ''}${w.bound_at && new Date(w.bound_at) >= new Date(r.shift.start) ? ` (from ${fmtTime(w.bound_at)})` : ''}`).join(', ');
        const stay = [
          p.admitted_in_shift ? `admitted ${fmtTime(p.admitted_at)}` : '',
          p.discharged_in_shift ? `discharged ${fmtTime(p.discharged_at)}` : ''
        ].filter(Boolean).join(', ');
        return `
          <tr>
            <td>${escapeHtml(p.bed_code || 'no bed')}</td>
            <td><b>${escapeHtml(p.full_name)}</b><div class="muted">${escapeHtml(p.patient_id)}${escapeHtml(stay ? ` · ${stay}` : '')}</div></td>
            <td>${escapeHtml(p.fall_risk || 'not recorded')}</td>
            <td>${escapeHtml(bands)}</td>
            <td>${escapeHtml(r.vitals_source.available ? statsText(p.heart_rate, 'bpm') : 'not available')}</td>
            <td>${escapeHtml(r.vitals_source.available ? statsText(p.spo2, '%') : 'not available')}</td>
            <td>${attnHtml}</td>
          </tr>`;
      }).join('');

    const incidentRowsHtml = r.incidents.list.length === 0
      ? '<tr><td colspan="6" class="muted" style="text-align:center; padding:14px;">No incident in this shift.</td></tr>'
      : r.incidents.list.map(i => {
        const testTag = i.simulated ? ' <span class="test">LIVE LAB TEST</span>' : '';
        const response = i.status === 'PENDING'
          ? 'waiting for a response'
          : `${i.status.toLowerCase()} by ${i.responder || 'not recorded'} at ${fmtTime(i.acknowledged_at) || 'not recorded'} (${fmtDuration(i.response_seconds)})`;
        return `
          <tr>
            <td>${escapeHtml(fmtTime(i.time))}</td>
            <td>${escapeHtml(i.patient_name || 'not recorded')}<div class="muted">${escapeHtml(i.patient_id || '')}</div></td>
            <td>${escapeHtml(CATEGORY_TEXT[i.category] || i.category)}${testTag}</td>
            <td>${escapeHtml(i.message || '')}</td>
            <td>${escapeHtml(response)}</td>
            <td>${escapeHtml(i.notes || '')}</td>
          </tr>`;
      }).join('');

    const deviceRowsHtml = [
      ...r.devices_now.anchors.map(a => `<tr><td>Anchor ${escapeHtml(a.anchor_id)}</td><td>${escapeHtml(a.device_id || '')}</td><td>${escapeHtml(a.status)}</td><td>${escapeHtml(fmtDateTime(a.last_seen) || 'never')}</td><td></td></tr>`),
      ...r.devices_now.wristbands.map(w => `<tr><td>Wristband of ${escapeHtml(w.patient_id)}</td><td>${escapeHtml(w.device_id)}</td><td>${escapeHtml(w.status || 'not recorded')}</td><td>${escapeHtml(fmtDateTime(w.last_seen) || 'never')}</td><td>${escapeHtml(w.battery_level === null || w.battery_level === undefined ? 'not reported' : `${w.battery_level} %`)}</td></tr>`)
    ].join('') || '<tr><td colspan="5" class="muted" style="text-align:center;">No device in this ward.</td></tr>';

    sheet.innerHTML = `
      <h1>Nursing Shift Summary · ${escapeHtml(r.ward.title)} (${escapeHtml(r.ward.ward_id)})</h1>
      <div class="meta">
        ${escapeHtml(shiftText)}${escapeHtml(progress)}<br>
        Generated ${escapeHtml(fmtDateTime(r.generated.at))} by ${escapeHtml(r.generated.by || 'not recorded')} · SHIRO edge server
      </div>

      <h2>1. Ward census and devices</h2>
      <div class="tiles">${tilesHtml}</div>

      <h2>2. Patients and vitals</h2>
      ${vitalsNote}
      <table class="report">
        <thead><tr><th>Bed</th><th>Patient</th><th>Fall risk</th><th>Wristband</th><th>Heart rate min / mean / max</th><th>SpO2 (indicative) min / mean / max</th><th>Attention</th></tr></thead>
        <tbody>${patientRowsHtml}</tbody>
      </table>

      <h2>3. Incidents in the shift</h2>
      <table class="report">
        <thead><tr><th>Time</th><th>Patient</th><th>Type</th><th>Alert</th><th>Response</th><th>Notes</th></tr></thead>
        <tbody>${incidentRowsHtml}</tbody>
      </table>

      <h2>4. Devices (status when this report was made)</h2>
      <table class="report">
        <thead><tr><th>Device</th><th>ID</th><th>Status</th><th>Last seen</th><th>Battery</th></tr></thead>
        <tbody>${deviceRowsHtml}</tbody>
      </table>

      <h2>5. Handover</h2>
      <div class="notes-lines"><div class="muted" style="font-size: 11px;">Notes for the next shift</div><div class="line"></div><div class="line"></div><div class="line"></div></div>
      <div class="signoff">
        <div>
          <div style="font-weight: 600; margin-bottom: 6px;">Outgoing nurse</div>
          <div class="line"></div><div class="caption">Name</div>
          <div class="line"></div><div class="caption">Signature</div>
          <div class="line"></div><div class="caption">Date and time</div>
        </div>
        <div>
          <div style="font-weight: 600; margin-bottom: 6px;">Incoming nurse</div>
          <div class="line"></div><div class="caption">Name</div>
          <div class="line"></div><div class="caption">Signature</div>
          <div class="line"></div><div class="caption">Date and time</div>
        </div>
      </div>

      <div class="footnotes">
        ATTN: a fall, a critical vitals alarm, a ward exit or an unanswered alert in the shift, or a heart rate above ${escapeHtml(r.thresholds.heart_rate_high)} or below ${escapeHtml(r.thresholds.heart_rate_low)} bpm.
        Heart rate and SpO2 come from the wristband at the wrist; readings are counted while it measures, so the mean leans to the times it measured most.
        SpO2 is indicative: its measurement is not calibrated${escapeHtml(r.thresholds.spo2_alarms ? '' : ' and raises no alarm')}.
        Live Lab tests are listed but not counted.
        Mobility is not reported: the wristband's motion state and the positioning accuracy are not validated yet.
        A patient belongs to the ward they are in now, or were discharged from; bed moves during the shift are not kept, and patients discharged before 20 Nov 2026 without a recorded ward are not listed.
        Device status is the status when this report was made, not during the shift.
      </div>`;
  }

  // ----- controls -----

  async function showReport() {
    const ward = $('report-ward').value;
    const date = $('report-date').value;
    const shift = $('report-shift').value;
    if (!ward) { showError('Choose a ward.'); return; }
    const params = new URLSearchParams({ ward_id: ward, date, shift });
    history.replaceState(null, '', `/shift_report.html?${params.toString()}`);
    setStatus('Loading…');
    try {
      const { status, data } = await getJson(`/api/reports/shift-summary?${params.toString()}`);
      if (status === 401) { setStatus(''); showSignIn(); return; }
      if (!data || !data.success) { setStatus(''); showError(`The report could not be made: ${(data && data.error) || `server answered ${status}`}`); return; }
      render(data.report);
      setStatus(`Shown at ${fmtTime(new Date().toISOString())}`);
    } catch (err) {
      setStatus('');
      showError('The edge server cannot be reached.');
    }
  }

  async function init() {
    $('report-show').addEventListener('click', showReport);
    $('report-print').addEventListener('click', () => window.print());
    try {
      const [shiftsRes, wardsRes] = await Promise.all([getJson('/api/reports/shifts'), getJson('/api/ward/list')]);
      if (shiftsRes.status === 401 || wardsRes.status === 401) { showSignIn(); return; }
      if (!shiftsRes.data || !shiftsRes.data.success || !wardsRes.data || !wardsRes.data.success) {
        showError('The shifts or wards could not be loaded.');
        return;
      }
      const shiftSelect = $('report-shift');
      for (const s of shiftsRes.data.shifts) {
        const opt = document.createElement('option');
        opt.value = s.key;
        opt.textContent = `${s.label} (${s.start}–${s.end})`;
        shiftSelect.appendChild(opt);
      }
      const wardSelect = $('report-ward');
      for (const w of wardsRes.data.wards) {
        const opt = document.createElement('option');
        opt.value = w.ward_id;
        opt.textContent = `${w.room_title} (${w.ward_id})`;
        wardSelect.appendChild(opt);
      }

      const q = new URLSearchParams(location.search);
      const cur = shiftsRes.data.current;
      $('report-date').value = q.get('date') || cur.day;
      shiftSelect.value = q.get('shift') || cur.shift;
      if (q.get('ward_id')) wardSelect.value = q.get('ward_id');

      if (q.get('ward_id') || wardsRes.data.wards.length === 1) showReport();
    } catch (err) {
      showError('The edge server cannot be reached.');
    }
  }

  init();
})();
