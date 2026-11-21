// =============================================================================
// SHIRO Dashboard - Position test panel on the Live Map (Phase 10, evaluation)
// The tester stands on a marked spot and starts a run here; the server records
// the wristband's position for the set time (routes/ips_routes.js). The panel
// shows the countdown and the recording, beeps at the start and twice at the
// end, lists the session's runs with their errors, and downloads the CSVs.
// On the map: the spots of the session (grey), the spot of the next run (red),
// and during a run a line from the true spot to where the wristband is shown.
// Uses the live map through window.liveMapState (ward_live_map.js).
// =============================================================================
(function () {
  const FACING_ORDER = ['N', 'E', 'S', 'W'];
  let open = false;
  let picking = false;
  let facing = 'N';
  let currentSession = null;      // the selected session (with runs), or null for a new one
  let active = null;              // the run in progress, as the server reports it
  let lastFinishedKey = null;     // to notice a run that has just finished
  let pollTimer = null;
  let audio = null;

  const $ = (id) => document.getElementById(id);
  const toast = (text, type = 'info', ms = 3500) => { if (window.showToast) window.showToast(text, type, ms); };
  const metres = (v) => (v === null || v === undefined ? '–' : `${Number(v).toFixed(2)} m`);
  const percent = (v) => (v === null || v === undefined ? '–' : `${Math.round(Number(v))}%`);
  const map = () => window.liveMapState || null;
  const wardId = () => { const w = map() && map().ward(); return w ? w.ward_id : null; };

  async function api(path, options = {}) {
    const res = await fetch(path, options);
    let data = null;
    try { data = await res.json(); } catch { /* no JSON */ }
    if (!res.ok || !data || data.success === false) throw new Error((data && data.error) || `server answered ${res.status}`);
    return data;
  }

  // ---------------------------------------------------------------------------
  // Short beeps, so the tester knows when recording starts and ends without looking
  // ---------------------------------------------------------------------------
  function beep(times = 1) {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      for (let i = 0; i < times; i++) {
        const osc = audio.createOscillator();
        const gain = audio.createGain();
        osc.frequency.value = times > 1 ? 660 : 880;
        gain.gain.value = 0.15;
        osc.connect(gain);
        gain.connect(audio.destination);
        const start = audio.currentTime + i * 0.25;
        osc.start(start);
        osc.stop(start + 0.15);
      }
    } catch {
      // no sound available: the panel text still shows the state
    }
  }

  // ---------------------------------------------------------------------------
  // Opening, closing, lists
  // ---------------------------------------------------------------------------
  async function openPanel() {
    if (!wardId()) {
      toast('Open a ward on the Live Map first.', 'warning');
      return;
    }
    open = true;
    $('position-test-panel').style.display = 'block';
    updateFacingButtons();
    fillTags();
    await loadSessions();
    lastFinishedKey = null;
    await poll();   // learns the last finished run, so only a later one beeps
  }

  function closePanel() {
    open = false;
    picking = false;
    stopPolling();
    const panel = $('position-test-panel');
    if (panel) panel.style.display = 'none';
  }

  function fillTags() {
    const select = $('pt-tag-select');
    const tags = map() ? map().tags() : [];
    const selected = select.value || (map() && map().selectedTag()) || tags[0] || '';
    select.innerHTML = tags.length
      ? tags.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('')
      : '<option value="">No wristband on the map yet</option>';
    if (tags.includes(selected)) select.value = selected;
  }

  async function loadSessions(selectId = null) {
    const select = $('pt-session-select');
    const previous = selectId || select.value || '';
    try {
      const data = await api(`/api/ips/position-test/sessions?ward_id=${encodeURIComponent(wardId())}`);
      select.innerHTML = '<option value="NEW">➕ New session</option>' + data.sessions.map(s => {
        const label = `${s.name} · ${s.runs} runs${s.mean_error === null ? '' : ` · mean ${metres(s.mean_error)}`}`;
        return `<option value="${escapeHtml(s.id)}">${escapeHtml(label)}</option>`;
      }).join('');
      const ids = data.sessions.map(s => s.id);
      if (selectId && ids.includes(selectId)) select.value = selectId;
      else if (ids.includes(previous)) select.value = previous;
      else select.value = ids.length ? ids[0] : 'NEW';
    } catch (err) {
      toast(`Could not load the sessions: ${err.message}`, 'danger');
    }
    await loadSession();
  }

  async function loadSession() {
    const id = $('pt-session-select').value;
    $('pt-session-name').style.display = id === 'NEW' ? 'block' : 'none';
    if (id === 'NEW') {
      currentSession = null;
      renderRuns();
      return;
    }
    try {
      currentSession = (await api(`/api/ips/position-test/session?id=${encodeURIComponent(id)}`)).session;
    } catch (err) {
      currentSession = null;
      toast(`Could not load the session: ${err.message}`, 'danger');
    }
    renderRuns();
  }

  function renderRuns() {
    const body = $('pt-runs-body');
    const summary = $('pt-summary');
    const chips = $('pt-spot-chips');
    if (!currentSession) {
      body.innerHTML = '<tr><td colspan="7" style="color:var(--text-muted); padding:6px 2px;">No runs yet.</td></tr>';
      summary.textContent = 'A new session starts with the first run.';
      chips.innerHTML = '';
      return;
    }
    body.innerHTML = currentSession.runs.length === 0
      ? '<tr><td colspan="7" style="color:var(--text-muted); padding:6px 2px;">No runs yet.</td></tr>'
      : currentSession.runs.map(r => `
        <tr style="border-bottom:1px solid var(--border-light);">
          <td style="padding:3px 2px;">${escapeHtml(r.number)}</td>
          <td>${escapeHtml(r.posture === 'STANDING' ? r.spot : `${r.spot} (${r.posture.toLowerCase()})`)}${r.lidar && r.lidar.turns > 0 ? ' <span title="LiDAR turns recorded with this run">🌀</span>' : ''}</td>
          <td>${escapeHtml(r.facing || '–')}</td>
          <td>${escapeHtml(metres(r.stats.final.mean))}</td>
          <td>${escapeHtml(metres(r.stats.final.p95))}</td>
          <td>${escapeHtml(percent(r.stats.zone_ok_pct))}</td>
          <td><button type="button" class="btn btn-outline btn-sm" style="padding:0 6px; font-size:10px;" title="Remove this run"${actionAttrs('discardPositionTestRun', [r.number])}>🗑</button></td>
        </tr>`).join('');

    const all = currentSession.summary ? currentSession.summary.all : null;
    const lidarRuns = currentSession.runs.filter(r => r.lidar && r.lidar.turns > 0).length;
    summary.textContent = all
      ? `All runs: mean error ${metres(all.final.mean)}, 95% within ${metres(all.final.p95)}, correct zone ${percent(all.zone_ok_pct)}, position available ${percent(all.available_pct)}.` +
        (lidarRuns ? ` LiDAR turns recorded with ${lidarRuns} of ${currentSession.runs.length} runs (🌀).` : '')
      : 'No runs yet.';

    chips.innerHTML = (currentSession.spots || []).map(s =>
      `<button type="button" class="btn btn-outline btn-sm" style="padding:1px 7px; font-size:10px;" title="Use this spot again"${actionAttrs('usePositionTestSpot', [s.spot, s.x, s.y])}>${escapeHtml(s.spot)}</button>`
    ).join('');
  }

  // ---------------------------------------------------------------------------
  // Spot, facing
  // ---------------------------------------------------------------------------
  function updateFacingButtons() {
    document.querySelectorAll('.pt-facing-btn').forEach(b => {
      const on = b.getAttribute('data-facing') === facing;
      b.classList.toggle('btn-primary', on);
      b.classList.toggle('btn-outline', !on);
    });
  }

  function setFacing(value) {
    facing = value;
    updateFacingButtons();
  }

  function togglePick() {
    picking = !picking;
    $('pt-pick-btn').textContent = picking ? '👆 Click the map…' : '📍 Pick on map';
  }

  /** Called by the live map for every click. Returns true when the click was used here. */
  function onMapClick(mx, my) {
    if (!open || !picking) return false;
    const ward = map().ward();
    $('pt-x').value = Math.max(0, Math.min(ward.length_x, mx)).toFixed(2);
    $('pt-y').value = Math.max(0, Math.min(ward.width_y, my)).toFixed(2);
    togglePick();
    return true;
  }

  function useSpot(spot, x, y) {
    $('pt-spot').value = spot;
    $('pt-x').value = Number(x).toFixed(2);
    $('pt-y').value = Number(y).toFixed(2);
  }

  // ---------------------------------------------------------------------------
  // Runs
  // ---------------------------------------------------------------------------
  async function startRun() {
    const x = parseFloat($('pt-x').value);
    const y = parseFloat($('pt-y').value);
    const tagId = $('pt-tag-select').value;
    if (!tagId) return toast('Choose the wristband first (it must be on the map).', 'warning');
    if (!Number.isFinite(x) || !Number.isFinite(y)) return toast('Enter the spot, or use 📍 Pick on map.', 'warning');

    const body = {
      ward_id: wardId(), tag_id: tagId, x, y,
      spot: $('pt-spot').value.trim() || undefined,
      facing, posture: $('pt-posture').value,
      countdown_s: parseInt($('pt-countdown').value, 10),
      duration_s: parseInt($('pt-duration').value, 10)
    };
    if (currentSession) body.session_id = currentSession.id;
    else body.session_name = $('pt-session-name').value.trim() || undefined;

    // Browsers allow sound only after a click: prepare it now, for the beeps later
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
    } catch {
      // no sound available
    }

    try {
      const data = await api('/api/ips/position-test/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      active = data.active;
      if (active.run.state === 'RECORDING') beep(1);   // no countdown: recording starts now
      if (!currentSession) await loadSessions(active.session_id);
      renderLive();
      startPolling(true);
    } catch (err) {
      toast(`Run not started: ${err.message}`, 'danger', 6000);
    }
  }

  async function cancelRun() {
    try {
      await api('/api/ips/position-test/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      active = null;
      renderLive();
      toast('Run cancelled: nothing was kept.', 'info');
    } catch (err) {
      toast(`Could not cancel: ${err.message}`, 'danger');
    }
  }

  function discardRun(number) {
    if (!currentSession) return;
    const doDiscard = async () => {
      try {
        await api('/api/ips/position-test/discard', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: currentSession.id, run: number })
        });
        await loadSessions(currentSession.id);
      } catch (err) {
        toast(`Could not remove the run: ${err.message}`, 'danger');
      }
    };
    if (window.showModal) {
      window.showModal({ title: `Remove run ${number}?`, message: 'Its readings are deleted from this session.', type: 'warning', confirmText: 'Remove', cancelText: 'Keep', onConfirm: doDiscard });
    } else {
      doDiscard();
    }
  }

  async function downloadCsv(kind) {
    if (!currentSession) return toast('Choose a session with runs first.', 'warning');
    try {
      const res = await fetch(`/api/ips/position-test/${kind === 'samples' ? 'samples' : 'summary'}.csv?id=${encodeURIComponent(currentSession.id)}`);
      if (!res.ok) {
        let message = `server answered ${res.status}`;
        try { message = (await res.json()).error || message; } catch { /* not JSON */ }
        return toast(`CSV not downloaded: ${message}`, 'danger');
      }
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = `shiro-position-test_${currentSession.id}_${kind === 'samples' ? 'samples' : 'summary'}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      toast(`CSV not downloaded: ${err.message}`, 'danger');
    }
  }

  function renderLive() {
    const box = $('pt-live');
    const startBtn = $('pt-start-btn');
    startBtn.disabled = !!active;
    if (!active) {
      box.style.display = 'none';
      return;
    }
    box.style.display = 'block';
    const r = active.run;
    if (r.state === 'COUNTDOWN') {
      $('pt-live-text').textContent = `Go to ${r.spot}, face ${r.facing || 'any way'}: recording starts in ${active.seconds_to_start} s`;
      $('pt-live-detail').textContent = `Run ${r.number}, ${r.posture.toLowerCase()}, ${r.duration_s} s.`;
    } else {
      const last = active.last;
      $('pt-live-text').textContent = `Recording… ${active.seconds_left} s left (${active.samples} readings)`;
      $('pt-live-detail').textContent = last && last.available
        ? `Shown ${metres(last.error_m)} from the spot (${last.source}, zone ${last.zone}). Mean so far ${metres(active.mean_error_so_far)}.`
        : 'No position for the wristband right now.';
    }
  }

  // ---------------------------------------------------------------------------
  // Polling the server while the panel is open (fast during a run)
  // ---------------------------------------------------------------------------
  async function poll() {
    if (!open) return;
    try {
      const data = await api('/api/ips/position-test/status');
      const before = active ? active.run.state : null;
      active = data.active;
      if (before === 'COUNTDOWN' && active && active.run.state === 'RECORDING') beep(1);

      const finished = data.last_finished;
      const key = finished ? `${finished.session_id}#${finished.run.number}#${finished.run.finished_at}` : null;
      if (key && lastFinishedKey !== null && key !== lastFinishedKey) {
        beep(2);
        const st = finished.run.stats;
        toast(`Run ${finished.run.number} at ${finished.run.spot}: mean error ${metres(st.final.mean)}, correct zone ${percent(st.zone_ok_pct)}.`, 'success', 6000);
        // Next facing for the same spot, so a spot's four runs need only Start
        const i = FACING_ORDER.indexOf(finished.run.facing);
        if (i >= 0 && i < FACING_ORDER.length - 1) setFacing(FACING_ORDER[i + 1]);
        await loadSessions(finished.session_id);
      }
      lastFinishedKey = key || lastFinishedKey || 'none';
      renderLive();
      startPolling(!!active);
    } catch {
      // a failed poll is retried at the next tick
    }
  }

  function startPolling(fast = false) {
    stopPolling();
    if (open) pollTimer = setTimeout(poll, fast ? 500 : 3000);
  }

  function stopPolling() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
  }

  // ---------------------------------------------------------------------------
  // Drawing on the live map (called by ward_live_map.js on every frame)
  // ---------------------------------------------------------------------------
  function drawCross(ctx, p, colour, size) {
    ctx.strokeStyle = colour;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(p.x - size, p.y);
    ctx.lineTo(p.x + size, p.y);
    ctx.moveTo(p.x, p.y - size);
    ctx.lineTo(p.x, p.y + size);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(p.x, p.y, size * 0.6, 0, Math.PI * 2);
    ctx.stroke();
  }

  function draw(ctx, t, toCanvas) {
    if (!open) return;
    ctx.save();
    ctx.font = '11px sans-serif';
    for (const s of (currentSession && currentSession.spots) || []) {
      const p = toCanvas(s.x, s.y, t);
      drawCross(ctx, p, '#94A3B8', 7);
      ctx.fillStyle = '#64748B';
      ctx.fillText(s.spot, p.x + 9, p.y - 6);
    }
    const target = active ? { x: active.run.true_x, y: active.run.true_y } : { x: parseFloat($('pt-x').value), y: parseFloat($('pt-y').value) };
    if (Number.isFinite(target.x) && Number.isFinite(target.y)) {
      const p = toCanvas(target.x, target.y, t);
      drawCross(ctx, p, '#DC2626', 11);
      if (active && active.run.state === 'RECORDING') {
        const pos = map().tagPosition(active.run.tag_id);
        if (pos) {
          const q = toCanvas(pos.x, pos.y, t);
          ctx.setLineDash([6, 4]);
          ctx.strokeStyle = '#DC2626';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(q.x, q.y);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }
    ctx.restore();
  }

  window.positionTestPanel = { onMapClick, draw, close: closePanel };
  window.openPositionTestPanel = openPanel;
  window.closePositionTestPanel = closePanel;
  window.onPositionTestSessionChanged = loadSession;
  window.togglePositionTestPick = togglePick;
  window.setPositionTestFacing = setFacing;
  window.usePositionTestSpot = useSpot;
  window.startPositionTestRun = startRun;
  window.cancelPositionTestRun = cancelRun;
  window.discardPositionTestRun = discardRun;
  window.downloadPositionTestCsv = downloadCsv;
})();
