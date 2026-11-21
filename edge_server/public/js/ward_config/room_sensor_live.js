// =============================================================================
// Ward editor: LiDAR tools under each LiDAR in Panel 3b (Phase 10, step 5a)
//   👁 Live scan          draws the LiDAR's newest turn on the floor plan, three
//                         times a second, at the position and heading in the
//                         panel: grey where it sees the empty room, orange
//                         where something is new (a person). Wrong x, y or
//                         heading shows as walls that do not line up.
//   🧹 Learn empty room   countdown to leave the room (one beep when recording
//                         starts, two when it is done), then 20 s of turns are
//                         stored as the empty room (admin; the ward must be saved).
//   🎯 Align to walls     finds the x, y and heading at which the scan lies on
//                         the drawn walls and tall obstacles; the result is
//                         shown in green on the plan and taken over with
//                         "Use this position" (then Save Changes).
// Server: routes/room_sensor_routes.js.
// =============================================================================
(function () {
  const LIVE_POLL_MS = 330;
  const STATUS_POLL_MS = 2000;
  const DEG = Math.PI / 180;

  const views = {};        // device_id -> last answer of /api/room-sensors/scan
  const alignments = {};   // device_id -> alignment result shown, until used or dismissed
  const learningSeen = {}; // device_id -> last learning state seen (for the beeps)
  let liveDevice = null;   // the LiDAR whose scan is drawn
  let timer = null;
  let lastStatusPoll = 0;
  let audio = null;

  const ward = () => window.currentWard || null;
  const sensorAt = (index) => { const w = ward(); return w && Array.isArray(w.room_sensors) ? w.room_sensors[index] : null; };
  const toast = (text, type = 'info', ms = 4000) => { if (window.showToast) window.showToast(text, type, ms); };
  const editorVisible = () => {
    const canvas = document.getElementById('wardMapCanvas');
    return !!(canvas && canvas.offsetParent !== null);
  };

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
      // no sound: the panel text still shows the state
    }
  }

  async function api(path, options = {}) {
    const res = await fetch(path, options);
    let data = null;
    try { data = await res.json(); } catch { /* no JSON */ }
    if (!res.ok || !data || data.success === false) throw new Error((data && data.error) || `server answered ${res.status}`);
    return data;
  }

  function when(ms) {
    if (!ms) return '–';
    const d = new Date(ms);
    return d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  // ---------------------------------------------------------------------------
  // Panel text
  // ---------------------------------------------------------------------------
  function statusText(view) {
    if (!view) return 'Checking…';
    const parts = [];
    const l = view.learning;
    if (l && (l.state === 'COUNTDOWN' || l.state === 'RECORDING' || l.state === 'SAVING')) {
      if (l.state === 'COUNTDOWN') parts.push(`🚶 Leave the room: recording starts in ${l.seconds_to_start} s.`);
      else if (l.state === 'RECORDING') parts.push(`⏺ Recording the empty room: ${l.seconds_left} s left (${l.turns} turns). Stay out of view.`);
      else parts.push('Saving the empty room…');
      return parts.join(' ');
    }
    if (l && l.state === 'FAILED') parts.push(`⚠️ Not learned: ${l.error}`);
    if (view.background) {
      parts.push(`Empty room learned ${when(view.background.learned_at)} (${view.background.turns} turns, surface in ${view.background.coverage_pct}% of directions).`);
    } else {
      parts.push('Empty room not learned yet.');
    }
    if (view.moved && view.moved.suspected) {
      parts.push(`⚠️ ${view.moved.farther_pct}% of directions read farther than the empty room: the LiDAR may have been moved or turned. Check it, align it and learn the empty room again.`);
    }
    if (l && l.state === 'DONE' && l.result && l.result.warnings && l.result.warnings.length) parts.push(`⚠️ ${l.result.warnings.join(' ')}`);
    if (!view.scan) parts.push('No turns from this LiDAR yet: is it on and scanning (Devices page)?');
    else if (view.scan.age_ms > 3000) parts.push(`Last turn ${Math.round(view.scan.age_ms / 1000)} s ago: is it still scanning?`);
    return parts.join(' ');
  }

  function alignmentHtml(deviceId, index) {
    const a = alignments[deviceId];
    if (!a) return '';
    const cm = (m) => `${m >= 0 ? '+' : ''}${(m * 100).toFixed(1)} cm`;
    const warningsHtml = (a.warnings || []).map(w => `<div style="color: var(--warning); margin-top: 2px;">⚠️ ${escapeHtml(w)}</div>`).join('');
    return `<div style="margin-top: 6px; padding: 6px 8px; border: 1px solid var(--border-light); border-radius: 6px; font-size: 11px; line-height: 1.45;">
      <div><strong>🎯 Fit to the walls</strong> (from ${escapeHtml(a.scan_source === 'EMPTY_ROOM' ? 'the learned empty room' : `the last ${a.scan_turns} turns`)}):
        x ${escapeHtml(a.pose.x.toFixed(2))} m (${escapeHtml(cm(a.change.dx_m))}), y ${escapeHtml(a.pose.y.toFixed(2))} m (${escapeHtml(cm(a.change.dy_m))}),
        heading ${escapeHtml(a.pose.heading_deg.toFixed(1))}° (${escapeHtml(`${a.change.dheading_deg >= 0 ? '+' : ''}${a.change.dheading_deg.toFixed(1)}`)}°).
        <span style="color: ${a.quality === 'GOOD' ? 'var(--success)' : a.quality === 'FAIR' ? 'var(--warning)' : 'var(--danger)'}; font-weight: 700;">${escapeHtml(a.quality)}</span></div>
      <div style="color: var(--text-muted);">Returns within 5 cm of a drawn wall or obstacle: ${escapeHtml(a.before.on_surface_pct)}% at the panel's position, ${escapeHtml(a.after.on_surface_pct)}% at the fit (median ${escapeHtml(a.after.median_residual_mm)} mm off). Shown in green on the plan.</div>
      ${warningsHtml}
      <div style="margin-top: 4px; display: flex; gap: 6px;">
        <button type="button" class="btn btn-primary btn-sm" style="padding: 1px 8px; font-size: 11px;" onclick="useRoomSensorAlignment(${index})">✅ Use this position</button>
        <button type="button" class="btn btn-outline btn-sm" style="padding: 1px 8px; font-size: 11px;" onclick="dismissRoomSensorAlignment(${index})">✕ Dismiss</button>
      </div>
    </div>`;
  }

  /** The tools under a LiDAR's row (called by room_sensor_panel.js). */
  function roomSensorToolsHtml(index) {
    const s = sensorAt(index);
    if (!s) return '';
    if (!s.device_id) {
      return '<div style="font-size: 11px; color: var(--text-muted);">Assign a LiDAR node to see its scan, learn the empty room and align it.</div>';
    }
    const live = liveDevice === s.device_id;
    const view = views[s.device_id];
    const l = view && view.learning;
    const learningNow = !!(l && (l.state === 'COUNTDOWN' || l.state === 'RECORDING' || l.state === 'SAVING'));
    const alignHtml = alignmentHtml(s.device_id, index);   // built from escaped parts
    const learnButtonHtml = learningNow
      ? `<button type="button" class="btn btn-danger-outline btn-sm" style="padding: 1px 8px; font-size: 11px;" onclick="cancelRoomSensorLearning(${index})">✕ Stop learning</button>`
      : `<button type="button" class="btn btn-outline btn-sm" style="padding: 1px 8px; font-size: 11px;" title="Record the room with nobody in it (admin; save the ward first)" onclick="learnRoomSensorEmptyRoom(${index})">🧹 Learn empty room</button>`;
    return `<div style="display: flex; gap: 6px; align-items: center; flex-wrap: wrap;">
        <button type="button" class="btn ${live ? 'btn-primary' : 'btn-outline'} btn-sm" style="padding: 1px 8px; font-size: 11px;" title="Draw this LiDAR's scan on the floor plan" onclick="toggleRoomSensorLive(${index})">👁 Live scan${live ? ' on' : ''}</button>
        ${learnButtonHtml}
        <button type="button" class="btn btn-outline btn-sm" style="padding: 1px 8px; font-size: 11px;" title="Find x, y and heading from the scan of the walls" onclick="alignRoomSensor(${index})">🎯 Align to walls</button>
      </div>
      <div id="rs-status-${index}" style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">${escapeHtml(statusText(view))}</div>
      ${alignHtml}`;
  }

  /** Updates the status lines without redrawing the table (inputs keep their focus). */
  function refreshStatusLines() {
    const w = ward();
    if (!w || !Array.isArray(w.room_sensors)) return;
    w.room_sensors.forEach((s, index) => {
      const el = document.getElementById(`rs-status-${index}`);
      if (el && s.device_id) el.textContent = statusText(views[s.device_id]);
    });
  }

  // ---------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------
  function learningActive() {
    return Object.values(views).some(v => v && v.learning && ['COUNTDOWN', 'RECORDING', 'SAVING'].includes(v.learning.state));
  }

  async function fetchView(deviceId) {
    const w = ward();
    if (!w || !w.ward_id) return null;
    const data = await api(`/api/room-sensors/scan?ward_id=${encodeURIComponent(w.ward_id)}&device_id=${encodeURIComponent(deviceId)}`);
    const before = learningSeen[deviceId];
    const now = data.learning ? data.learning.state : null;
    if (before === 'COUNTDOWN' && now === 'RECORDING') beep(1);
    if ((before === 'RECORDING' || before === 'SAVING') && now === 'DONE') {
      beep(2);
      toast(`Empty room learned for ${deviceId}.`, 'success');
    }
    if ((before === 'COUNTDOWN' || before === 'RECORDING' || before === 'SAVING') && now === 'FAILED') {
      beep(2);
      toast(`Empty room not learned: ${data.learning.error}`, 'danger', 8000);
    }
    learningSeen[deviceId] = now;
    views[deviceId] = data;
    return data;
  }

  async function poll() {
    timer = null;
    const w = ward();
    const devices = w && Array.isArray(w.room_sensors) ? w.room_sensors.map(s => s.device_id).filter(Boolean) : [];
    if (editorVisible() && devices.length > 0) {
      const t = Date.now();
      const statusDue = t - lastStatusPoll >= STATUS_POLL_MS;
      const wanted = devices.filter(d => d === liveDevice || statusDue || (views[d] && views[d].learning && ['COUNTDOWN', 'RECORDING', 'SAVING'].includes(views[d].learning.state)));
      if (statusDue) lastStatusPoll = t;
      const hadLearning = learningActive();
      await Promise.all(wanted.map(d => fetchView(d).catch(() => null)));
      if (hadLearning !== learningActive()) {
        if (window.renderRoomSensorsTable) window.renderRoomSensorsTable();   // the learn button changes
      } else {
        refreshStatusLines();
      }
      if (liveDevice && window.redrawWardMap) window.redrawWardMap();
    }
    schedule();
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(poll, liveDevice || learningActive() ? LIVE_POLL_MS : STATUS_POLL_MS);
  }

  /** Called when the panel has been drawn: start polling (once) and fetch the status now. */
  function onRoomSensorsRendered() {
    if (!timer) {
      lastStatusPoll = 0;
      schedule();
    }
  }

  // ---------------------------------------------------------------------------
  // The scan on the floor plan (called by ward_canvas.js after drawing the ward)
  // ---------------------------------------------------------------------------
  function drawRoomSensorOverlay(canvas, w) {
    if (!liveDevice || !w || !Array.isArray(w.room_sensors) || !window.wardCanvasTransform) return;
    const sensor = w.room_sensors.find(s => s.device_id === liveDevice);
    const view = views[liveDevice];
    if (!sensor || !view || !view.scan) return;
    const ctx = canvas.getContext('2d');
    const tf = window.wardCanvasTransform(canvas, w);
    const fresh = view.scan.age_ms <= 3000;
    const foreground = new Set(view.scan.foreground_bins || []);
    const a = alignments[liveDevice];
    const poses = [{ pose: { x: Number(sensor.x), y: Number(sensor.y), heading: Number(sensor.heading_deg) || 0 }, preview: false }];
    if (a) poses.push({ pose: { x: a.pose.x, y: a.pose.y, heading: a.pose.heading_deg }, preview: true });
    ctx.save();
    for (const { pose, preview } of poses) {
      const d = view.scan.distances_mm;
      for (let i = 0; i < d.length; i++) {
        if (!d[i]) continue;
        const r = d[i] / 1000;
        const b = (pose.heading + (i + 0.5) * 0.5) * DEG;
        const [px, py] = tf.toPx(pose.x + r * Math.sin(b), pose.y + r * Math.cos(b));
        if (preview) ctx.fillStyle = 'rgba(22, 163, 74, 0.85)';
        else if (foreground.has(i)) ctx.fillStyle = 'rgba(249, 115, 22, 0.95)';
        else ctx.fillStyle = a ? 'rgba(100, 116, 139, 0.45)' : 'rgba(71, 85, 105, 0.8)';
        ctx.fillRect(px - 1.5, py - 1.5, 3, 3);
      }
    }
    ctx.fillStyle = fresh ? '#334155' : '#B91C1C';
    ctx.font = '600 10px sans-serif';
    const legend = fresh
      ? `Live scan ${liveDevice}: grey = empty room${view.background ? ', orange = new in the room' : ' (learn it for new things in orange)'}${a ? ', green = fitted to the walls' : ''}`
      : `Live scan ${liveDevice}: no turn for ${Math.round(view.scan.age_ms / 1000)} s`;
    ctx.fillText(legend, 8, canvas.height - 8);
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // Buttons
  // ---------------------------------------------------------------------------
  async function toggleRoomSensorLive(index) {
    const s = sensorAt(index);
    if (!s || !s.device_id) return;
    liveDevice = liveDevice === s.device_id ? null : s.device_id;
    if (liveDevice) await fetchView(liveDevice).catch(err => toast(`Live scan: ${err.message}`, 'danger'));
    if (window.renderRoomSensorsTable) window.renderRoomSensorsTable();
    if (window.redrawWardMap) window.redrawWardMap();
    schedule();
  }

  function learnRoomSensorEmptyRoom(index) {
    const s = sensorAt(index);
    const w = ward();
    if (!s || !s.device_id || !w) return;
    window.showModal({
      title: 'Learn the empty room',
      customHtml: `<div style="font-size: 13px; line-height: 1.55;">
        <p>${escapeHtml(s.sensor_id || 'The LiDAR')} (${escapeHtml(s.device_id)}) will record the room with nobody in it, so that anything closer than this later counts as new in the room (a person).</p>
        <ol style="padding-left: 18px; margin: 6px 0;">
          <li>Put the furniture where it normally stays, and the door as it normally is.</li>
          <li>Press <strong>Start</strong>, then leave the room within <strong>15 s</strong>. One beep: recording starts.</li>
          <li>Stay out of the LiDAR's view for <strong>20 s</strong>, until two beeps.</li>
        </ol>
        <p style="color: var(--text-muted);">The ward must be saved with this node assigned. Learn again after moving the LiDAR or furniture. Admin only.</p>
      </div>`,
      confirmText: '▶ Start',
      cancelText: 'Cancel',
      onConfirm: async () => {
        try {
          // Browsers allow sound only after a click: prepare it now for the beeps
          audio = audio || new (window.AudioContext || window.webkitAudioContext)();
        } catch { /* no sound */ }
        try {
          await api('/api/room-sensors/learn', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ward_id: w.ward_id, device_id: s.device_id, countdown_s: 15, duration_s: 20 })
          });
          learningSeen[s.device_id] = 'COUNTDOWN';
          await fetchView(s.device_id).catch(() => null);
          if (window.renderRoomSensorsTable) window.renderRoomSensorsTable();
          schedule();
        } catch (err) {
          toast(`Learn empty room: ${err.message}`, 'danger', 8000);
        }
      }
    });
  }

  async function cancelRoomSensorLearning(index) {
    const s = sensorAt(index);
    if (!s || !s.device_id) return;
    try {
      await api('/api/room-sensors/learn/cancel', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_id: s.device_id })
      });
      learningSeen[s.device_id] = null;
      await fetchView(s.device_id).catch(() => null);
      toast('Learning stopped; nothing was saved.', 'info');
    } catch (err) {
      toast(`Stop learning: ${err.message}`, 'danger');
    }
    if (window.renderRoomSensorsTable) window.renderRoomSensorsTable();
  }

  async function alignRoomSensor(index) {
    const s = sensorAt(index);
    const w = ward();
    if (!s || !s.device_id || !w) return;
    try {
      const data = await api('/api/room-sensors/align', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          layout: w,
          sensor: { device_id: s.device_id, x: Number(s.x), y: Number(s.y), heading_deg: Number(s.heading_deg) || 0, base_height: Number(s.base_height) || 0.92 }
        })
      });
      alignments[s.device_id] = data.alignment;
      // Show the fit on the plan
      if (liveDevice !== s.device_id) {
        liveDevice = s.device_id;
        await fetchView(liveDevice).catch(() => null);
      }
    } catch (err) {
      toast(`Align to walls: ${err.message}`, 'danger', 8000);
    }
    if (window.renderRoomSensorsTable) window.renderRoomSensorsTable();
    if (window.redrawWardMap) window.redrawWardMap();
    schedule();
  }

  function useRoomSensorAlignment(index) {
    const s = sensorAt(index);
    const a = s && alignments[s.device_id];
    if (!a) return;
    s.x = a.pose.x;
    s.y = a.pose.y;
    s.heading_deg = a.pose.heading_deg;
    delete alignments[s.device_id];
    if (window.renderRoomSensorsTable) window.renderRoomSensorsTable();
    if (window.redrawWardMap) window.redrawWardMap();
    if (window.markUnsavedChanges) window.markUnsavedChanges();
    toast('Position and heading taken over. Press Save Changes to keep them.', 'success', 5000);
  }

  function dismissRoomSensorAlignment(index) {
    const s = sensorAt(index);
    if (!s) return;
    delete alignments[s.device_id];
    if (window.renderRoomSensorsTable) window.renderRoomSensorsTable();
    if (window.redrawWardMap) window.redrawWardMap();
  }

  window.roomSensorToolsHtml = roomSensorToolsHtml;
  window.onRoomSensorsRendered = onRoomSensorsRendered;
  window.drawRoomSensorOverlay = drawRoomSensorOverlay;
  window.toggleRoomSensorLive = toggleRoomSensorLive;
  window.learnRoomSensorEmptyRoom = learnRoomSensorEmptyRoom;
  window.cancelRoomSensorLearning = cancelRoomSensorLearning;
  window.alignRoomSensor = alignRoomSensor;
  window.useRoomSensorAlignment = useRoomSensorAlignment;
  window.dismissRoomSensorAlignment = dismissRoomSensorAlignment;
})();
