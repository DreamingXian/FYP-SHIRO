// =============================================================================
// Ward editor: placement planner for the anchors and the LiDAR (Phase 10)
// Asks the server (POST /api/ward/placement-plan, services/ips/placement.js)
// where to mount the anchors and the LiDAR for the layout in the editor, and
// shows the result: a floor plan coloured by expected error, which way each
// device faces, current layout against the suggestion, and an installation
// sheet to print. "Apply to Ward" copies the spots into the editor; nothing is
// stored until Save Changes.
// =============================================================================
(function () {
  const PAD = 30;
  const state = { plan: null, view: 'suggested', options: null, request: 0, timer: null, error: null };

  // Expected error colours: the requirement asks for 1.0-1.5 m
  const ERROR_BANDS = [
    { max: 0.5, color: '#047857', label: 'under 0.5 m' },
    { max: 0.75, color: '#22C55E', label: '0.5–0.75 m' },
    { max: 1.0, color: '#FACC15', label: '0.75–1.0 m' },
    { max: 1.5, color: '#F97316', label: '1.0–1.5 m' },
    { max: Infinity, color: '#DC2626', label: 'over 1.5 m' }
  ];
  const errorColor = (e) => (ERROR_BANDS.find(b => e < b.max) || ERROR_BANDS[ERROR_BANDS.length - 1]).color;
  const ACTION_COLOR = { KEEP: '#0284C7', MOVE: '#D97706', NEW: '#059669' };

  const shortName = (id) => {
    const m = /^Anchor\s+(\S+)$/.exec(String(id || ''));
    return m ? m[1] : String(id || '?');
  };

  /** Facing of an anchor already in the ward: into the room from its nearest wall. */
  function facingFromWall(x, y, L, W) {
    const d = [{ f: 0, v: y }, { f: 180, v: W - y }, { f: 90, v: x }, { f: 270, v: L - x }];
    d.sort((a, b) => a.v - b.v);
    return d[0].f;
  }

  // ---------------------------------------------------------------------------
  // Dialog
  // ---------------------------------------------------------------------------

  function shellHtml(ward, opts) {
    const ceiling = Number(ward.height_z) || 2.6;
    let countOptionsHtml = '';
    for (let n = 3; n <= 12; n++) countOptionsHtml += `<option value="${Number(n)}" ${n === opts.anchor_count ? 'selected' : ''}>${Number(n)}</option>`;
    let heightOptionsHtml = '<option value="">Auto</option>';
    for (let h = 2.0; h <= Math.min(3.0, ceiling - 0.05) + 1e-9; h += 0.1) heightOptionsHtml += `<option value="${h.toFixed(2)}">${h.toFixed(2)} m</option>`;
    const placed = (ward.anchors || []).map(a => shortName(a.anchor_id)).join(', ');
    return `
      <div style="display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 18px; align-items: start;">
        <div>
          <div style="display: flex; flex-wrap: wrap; gap: 10px 14px; align-items: center; font-size: 12px; font-weight: 600; margin-bottom: 10px;">
            <label style="display: flex; align-items: center; gap: 6px; margin: 0;">Anchors
              <select id="pp-count" class="form-control" style="width: 64px; padding: 4px 6px;" onchange="onPlannerSettingsChange()">${countOptionsHtml}</select>
            </label>
            <label style="display: flex; align-items: center; gap: 6px; margin: 0;">Height
              <select id="pp-height" class="form-control" style="width: 96px; padding: 4px 6px;" onchange="onPlannerSettingsChange()">${heightOptionsHtml}</select>
            </label>
            <label style="display: flex; align-items: center; gap: 6px; margin: 0;" title="Plan only the new anchors around the ones already mounted">
              <input type="checkbox" id="pp-keep" ${opts.keep_existing ? 'checked' : ''} onchange="onPlannerSettingsChange()"> Keep ${escapeHtml(placed || 'the placed anchors')} where they are
            </label>
            <label style="display: flex; align-items: center; gap: 6px; margin: 0;">
              <input type="checkbox" id="pp-lidar" ${opts.include_lidar ? 'checked' : ''} onchange="onPlannerSettingsChange()"> Place the LiDAR
            </label>
          </div>
          <div style="position: relative; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: #FFFFFF;">
            <canvas id="pp-canvas" width="440" height="380" style="width: 100%; display: block;"></canvas>
            <div id="pp-busy" style="position: absolute; inset: 0; display: none; align-items: center; justify-content: center; background: rgba(255,255,255,0.75); font-weight: 700; color: var(--text-secondary);">Calculating…</div>
          </div>
          <div style="display: flex; gap: 6px; margin-top: 8px; align-items: center; flex-wrap: wrap;">
            <button class="btn btn-primary btn-sm" id="pp-view-suggested" onclick="setPlannerView('suggested')">Suggested</button>
            <button class="btn btn-outline btn-sm" id="pp-view-current" onclick="setPlannerView('current')">Current</button>
            <button class="btn btn-outline btn-sm" style="margin-left: auto;" onclick="printPlacementSheet()">🖨️ Print installation sheet</button>
          </div>
          <div id="pp-legend" style="display: flex; flex-wrap: wrap; gap: 6px 12px; font-size: 10.5px; font-weight: 600; color: var(--text-muted); margin-top: 8px;"></div>
        </div>
        <div>
          <div id="pp-metrics"></div>
          <div style="font-weight: 700; font-size: 12px; color: var(--text-primary); margin: 12px 0 6px;">Installation, one line per device</div>
          <div id="pp-list" style="max-height: 300px; overflow-y: auto;"></div>
          <div id="pp-notes" style="margin-top: 10px;"></div>
        </div>
      </div>`;
  }

  function openPlacementPlanner() {
    const ward = window.currentWard;
    if (!ward) return;
    const anchors = ward.anchors || [];
    state.options = {
      anchor_count: Math.min(12, Math.max(6, anchors.length)),
      mount_height: null,
      keep_existing: anchors.some(a => a.device_id),
      include_lidar: true
    };
    state.plan = null;
    state.error = null;
    state.view = 'suggested';
    showModal({
      title: '📐 Plan Anchors & LiDAR',
      customHtml: shellHtml(ward, state.options),
      isWide: true,
      type: 'info',
      confirmText: '✅ Apply to Ward',
      cancelText: 'Close',
      onConfirm: applyPlan
    });
    renderLegend();
    requestPlan();
  }

  function readSettings() {
    const count = document.getElementById('pp-count');
    const height = document.getElementById('pp-height');
    const keep = document.getElementById('pp-keep');
    const lidar = document.getElementById('pp-lidar');
    state.options = {
      anchor_count: count ? parseInt(count.value, 10) || 6 : 6,
      mount_height: height && height.value ? parseFloat(height.value) : null,
      keep_existing: keep ? keep.checked : false,
      include_lidar: lidar ? lidar.checked : true
    };
  }

  function onPlannerSettingsChange() {
    readSettings();
    clearTimeout(state.timer);
    state.timer = setTimeout(requestPlan, 200);
  }

  async function requestPlan() {
    const id = ++state.request;
    const busy = document.getElementById('pp-busy');
    if (busy) busy.style.display = 'flex';
    try {
      const res = await fetch('/api/ward/placement-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ layout: window.currentWard, options: state.options })
      });
      const data = await res.json();
      if (id !== state.request) return;   // a newer request is on its way
      if (!data.success) throw new Error(data.error || `HTTP ${res.status}`);
      state.plan = data.plan;
      state.error = null;
    } catch (err) {
      if (id !== state.request) return;
      state.plan = null;
      state.error = err.message;
    } finally {
      if (id === state.request && busy) busy.style.display = 'none';
    }
    render();
  }

  function setPlannerView(view) {
    state.view = view === 'current' ? 'current' : 'suggested';
    const s = document.getElementById('pp-view-suggested');
    const c = document.getElementById('pp-view-current');
    if (s) s.className = state.view === 'suggested' ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm';
    if (c) c.className = state.view === 'current' ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm';
    drawPlan(document.getElementById('pp-canvas'), state.view);
  }

  // ---------------------------------------------------------------------------
  // Results
  // ---------------------------------------------------------------------------

  function render() {
    const metrics = document.getElementById('pp-metrics');
    const list = document.getElementById('pp-list');
    const notes = document.getElementById('pp-notes');
    if (!metrics || !list || !notes) return;

    if (!state.plan) {
      metrics.innerHTML = '';
      list.innerHTML = '';
      notes.innerHTML = `<div style="color: var(--danger); font-size: 12px; font-weight: 600;">The plan could not be made: ${escapeHtml(state.error || 'no answer from the server')}</div>`;
      drawPlan(document.getElementById('pp-canvas'), state.view);
      return;
    }
    const plan = state.plan;
    const heightSel = document.getElementById('pp-height');
    if (heightSel && heightSel.options[0]) heightSel.options[0].text = `Auto (${plan.settings.mount_height.toFixed(2)} m)`;

    metrics.innerHTML = metricsHtml(plan);
    list.innerHTML = itemsHtml(plan);
    notes.innerHTML = notesHtml(plan);
    setPlannerView(state.view);
  }

  function metricsHtml(plan) {
    const cur = plan.current;
    const sug = plan.suggested;
    const lidarCur = plan.lidar && plan.lidar.current;
    const lidarSug = plan.lidar && plan.lidar.suggested;
    const cell = (v, unit) => (v === null || v === undefined ? '–' : `${escapeHtml(v)}${escapeHtml(unit)}`);
    // The three cells come from cell(): escaped text
    const row = (label, roomOnlyHtml, currentHtml, suggestedHtml) => `<tr><td style="font-weight: 600;">${escapeHtml(label)}</td><td style="text-align: right;">${roomOnlyHtml}</td><td style="text-align: right;">${currentHtml}</td><td style="text-align: right; font-weight: 700; color: var(--primary);">${suggestedHtml}</td></tr>`;
    const tableRowsHtml = [
      row('Expected error, average', cell(plan.room_only_error_m, ' m'), cell(cur && cur.mean_error_m, ' m'), cell(sug.mean_error_m, ' m')),
      row('95 % of the floor within', '–', cell(cur && cur.p95_error_m, ' m'), cell(sug.p95_error_m, ' m')),
      row('Floor with a clear line to 3+ anchors', '–', cell(cur && cur.clear_to_3_pct, ' %'), cell(sug.clear_to_3_pct, ' %')),
      row('Floor the LiDAR sees', '–', cell(lidarCur && lidarCur.visible_pct, ' %'), cell(lidarSug && lidarSug.visible_pct, ' %'))
    ].join('');
    return `
      <table class="data-table" style="font-size: 12px;">
        <thead><tr><th></th><th style="text-align: right;">No anchors</th><th style="text-align: right;">Current (${escapeHtml(cur ? cur.anchors : 0)})</th><th style="text-align: right;">Suggested (${escapeHtml(sug.anchors.length)})</th></tr></thead>
        <tbody>${tableRowsHtml}</tbody>
      </table>
      <div style="font-size: 10.5px; color: var(--text-muted); line-height: 1.4; margin-top: 6px;">
        Expected error: the lowest error any method can reach from the Bluetooth signal strength of these anchors (Cramér–Rao bound; signal spread ${escapeHtml(plan.settings.shadowing_db)} dB, path-loss exponent ${escapeHtml(plan.settings.path_loss_n)}), at wrist height (${escapeHtml(plan.settings.wrist_height)} m), door and bed areas counted twice. "No anchors" knows only that the patient is in the room. Real readings are worse (body, furniture): use it to compare layouts.
      </div>`;
  }

  function itemsHtml(plan) {
    const anchorItemsHtml = plan.suggested.anchors.map(a => {
      const badgeClass = a.action === 'NEW' ? 'badge-live' : a.action === 'MOVE' ? 'badge-alert' : 'badge-neutral';
      const actionText = a.action === 'NEW' ? 'New' : a.action === 'MOVE' ? 'Move' : 'Keep';
      const movedNote = a.action === 'MOVE' && Number.isFinite(a.moved_m) ? `<span style="color: var(--text-muted);"> (moves ${a.moved_m.toFixed(2)} m)</span>` : '';
      const boardNote = a.device_id ? `<span class="mono" style="color: var(--text-muted);"> ${escapeHtml(a.device_id)}</span>` : '';
      return `
        <div style="background: #F8FAFC; border: 1px solid var(--border); border-radius: 6px; padding: 7px 10px; margin-bottom: 6px; font-size: 11.5px;">
          <div style="display: flex; gap: 8px; align-items: center; margin-bottom: 2px;">
            <span class="badge ${badgeClass}" style="font-size: 10px;">${escapeHtml(actionText)}</span>
            <strong>📡 ${escapeHtml(a.anchor_id)}</strong>${boardNote}${movedNote}
          </div>
          <div style="color: var(--text-secondary);">${escapeHtml(a.instruction)}</div>
        </div>`;
    }).join('');
    const l = plan.lidar && plan.lidar.suggested;
    const lidarItemHtml = l ? `
      <div style="background: #F5F3FF; border: 1px solid #DDD6FE; border-radius: 6px; padding: 7px 10px; margin-bottom: 6px; font-size: 11.5px;">
        <div style="margin-bottom: 2px;"><strong style="color: #6D28D9;">🌀 LiDAR</strong> <span style="color: var(--text-muted);">sees ${escapeHtml(l.visible_pct)} % of the floor</span></div>
        <div style="color: var(--text-secondary);">${escapeHtml(l.instruction)}</div>
      </div>` : '';
    return anchorItemsHtml + lidarItemHtml;
  }

  function notesHtml(plan) {
    const warningsHtml = (plan.warnings || []).map(w => `<div style="color: #B45309; font-size: 11.5px; font-weight: 600; margin-bottom: 4px;">⚠️ ${escapeHtml(w)}</div>`).join('');
    const moved = plan.suggested.anchors.some(a => a.action !== 'KEEP');
    const afterNote = moved
      ? '<div style="font-size: 11px; color: #1E40AF; background: #EFF6FF; border: 1px solid #BFDBFE; border-radius: 6px; padding: 6px 8px;">After <b>Apply to Ward</b>: mount the devices as listed, bind the new boards in Panel 3, <b>Save Changes</b>, then run 🎯 Calibrate Anchors on the Live Map (new and moved anchors need it).</div>'
      : '';
    return warningsHtml + afterNote;
  }

  function renderLegend() {
    const el = document.getElementById('pp-legend');
    if (!el) return;
    const bandsHtml = ERROR_BANDS.map(b => `<span><span style="display: inline-block; width: 10px; height: 10px; border-radius: 2px; background: ${escapeHtml(b.color)}; opacity: 0.6; vertical-align: -1px;"></span> ${escapeHtml(b.label)}</span>`).join('');
    el.innerHTML = `${bandsHtml}
      <span style="color: #0284C7;">● keep</span><span style="color: #D97706;">● move</span><span style="color: #059669;">● new</span>
      <span>→ facing</span><span style="color: #7C3AED;">■ LiDAR ▲</span><span>× not seen by the LiDAR</span><span>┄ walking route</span>`;
  }

  // ---------------------------------------------------------------------------
  // Floor plan
  // ---------------------------------------------------------------------------

  /** Draws the plan (suggested or current) on a canvas. */
  function drawPlan(canvas, view) {
    const ward = window.currentWard;
    if (!canvas || !ward || !window.renderWardToCanvas) return;
    const base = { ...ward, anchors: [], room_sensors: [] };
    window.renderWardToCanvas(canvas, base, { bgColor: '#FFFFFF', padding: PAD });
    const plan = state.plan;
    if (!plan) return;
    const { scale, toPx } = window.wardCanvasTransform(canvas, base, PAD);
    const ctx = canvas.getContext('2d');
    const L = Number(ward.length_x) || 0;
    const W = Number(ward.width_y) || 0;

    // Expected error over the floor
    const summary = view === 'current' ? plan.current : plan.suggested;
    if (summary && Array.isArray(summary.errors)) {
      const half = (plan.grid.step * scale) / 2;
      ctx.save();
      ctx.globalAlpha = 0.36;
      plan.grid.points.forEach((p, i) => {
        const [px, py] = toPx(p[0], p[1]);
        ctx.fillStyle = errorColor(summary.errors[i]);
        ctx.fillRect(px - half, py - half, half * 2, half * 2);
      });
      ctx.restore();
    }

    // Walking routes and what the LiDAR cannot see
    const lidar = plan.lidar ? (view === 'current' ? plan.lidar.current : plan.lidar.suggested) : null;
    if (plan.lidar && Array.isArray(plan.lidar.walking_routes)) {
      ctx.save();
      ctx.strokeStyle = 'rgba(100, 116, 139, 0.7)';
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.5;
      plan.lidar.walking_routes.forEach(([x1, y1, x2, y2]) => {
        const [a, b] = toPx(x1, y1);
        const [c, d] = toPx(x2, y2);
        ctx.beginPath();
        ctx.moveTo(a, b);
        ctx.lineTo(c, d);
        ctx.stroke();
      });
      ctx.restore();
    }
    if (lidar && Array.isArray(lidar.hidden)) {
      ctx.save();
      ctx.strokeStyle = '#475569';
      ctx.lineWidth = 1.2;
      lidar.hidden.forEach(([x, y]) => {
        const [px, py] = toPx(x, y);
        ctx.beginPath();
        ctx.moveTo(px - 3, py - 3); ctx.lineTo(px + 3, py + 3);
        ctx.moveTo(px + 3, py - 3); ctx.lineTo(px - 3, py + 3);
        ctx.stroke();
      });
      ctx.restore();
    }

    // Anchors with the way they face
    const anchors = view === 'current'
      ? (plan.current && plan.current.positions
          ? plan.current.positions.map(a => ({ ...a, action: 'KEEP' }))
          : (ward.anchors || []).map(a => ({ anchor_id: a.anchor_id, x: Number(a.x), y: Number(a.y), facing_deg: facingFromWall(Number(a.x), Number(a.y), L, W), action: 'KEEP' })))
      : plan.suggested.anchors;
    anchors.forEach(a => {
      const [px, py] = toPx(a.x, a.y);
      const color = ACTION_COLOR[a.action] || '#0284C7';
      window.drawFacingArrow(ctx, px, py, a.facing_deg, 24, color);
      ctx.save();
      ctx.fillStyle = color;
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(px, py, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#FFFFFF';
      ctx.font = '700 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(shortName(a.anchor_id), px, py + 0.5);
      ctx.restore();
    });

    if (lidar) {
      const [px, py] = toPx(lidar.x, lidar.y);
      window.drawLidarMarker(ctx, px, py, lidar.heading_deg, 'LiDAR');
    }
  }

  // ---------------------------------------------------------------------------
  // Apply and print
  // ---------------------------------------------------------------------------

  function applyPlan() {
    const plan = state.plan;
    const ward = window.currentWard;
    if (!plan || !ward) return;
    const before = new Map((ward.anchors || []).map(a => [a.anchor_id, a]));
    ward.anchors = plan.suggested.anchors.map(p => {
      const old = before.get(p.anchor_id) || { device_id: null, mac_address: '', status: 'STANDBY' };
      return { ...old, anchor_id: p.anchor_id, x: p.x, y: p.y, z: p.z, wall_location: p.wall_location || old.wall_location || '' };
    });
    const l = plan.lidar && plan.lidar.suggested;
    if (l) {
      const sensors = Array.isArray(ward.room_sensors) ? ward.room_sensors : [];
      const first = sensors[0] || { sensor_id: 'LiDAR 1', device_id: null };
      ward.room_sensors = [{ ...first, x: l.x, y: l.y, base_height: l.base_height, heading_deg: l.heading_deg, wall_location: l.wall_location || '' }, ...sensors.slice(1)];
    }
    if (window.renderAnchorsTable) window.renderAnchorsTable();
    if (window.renderRoomSensorsTable) window.renderRoomSensorsTable();
    if (window.updateWardStats) window.updateWardStats();
    if (window.redrawWardMap) window.redrawWardMap();
    if (window.markUnsavedChanges) window.markUnsavedChanges();
    showToast('Plan applied to the editor. Mount the devices as on the installation sheet, then Save Changes.', 'success', 6000);
  }

  function printPlacementSheet() {
    const plan = state.plan;
    const ward = window.currentWard;
    if (!plan || !ward) return;
    const off = document.createElement('canvas');
    off.width = 900;
    off.height = 760;
    drawPlan(off, 'suggested');
    const image = off.toDataURL('image/png');

    const planRowsHtml = plan.suggested.anchors.map(a => {
      const boardNote = a.device_id ? ` <span class="muted">${escapeHtml(a.device_id)}</span>` : '';
      return `
      <tr><td class="box">☐</td><td><b>${escapeHtml(a.anchor_id)}</b>${boardNote}</td>
      <td>${escapeHtml(a.action === 'NEW' ? 'New' : a.action === 'MOVE' ? 'Move' : 'Keep')}</td><td>${escapeHtml(a.instruction)}</td></tr>`;
    }).join('');
    const l = plan.lidar && plan.lidar.suggested;
    const lidarRowHtml = l ? `<tr><td class="box">☐</td><td><b>LiDAR</b></td><td>Place</td><td>${escapeHtml(l.instruction)}</td></tr>` : '';
    const sheetHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Installation sheet ${escapeHtml(ward.ward_id)}</title>
      <style>
        body { font-family: Arial, sans-serif; color: #0F172A; margin: 18mm; font-size: 12px; }
        h1 { font-size: 18px; margin: 0 0 4px; } .muted { color: #64748B; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; }
        th, td { border: 1px solid #CBD5E1; padding: 6px 8px; text-align: left; vertical-align: top; }
        th { background: #F1F5F9; } td.box { width: 18px; font-size: 16px; text-align: center; }
        img { width: 100%; max-width: 640px; border: 1px solid #CBD5E1; margin-top: 10px; }
        ul { padding-left: 18px; }
      </style></head><body>
      <h1>Installation sheet: ${escapeHtml(ward.ward_id)} ${escapeHtml(ward.room_title || '')}</h1>
      <div class="muted">Room ${escapeHtml(plan.room.length_x)} m (west–east) × ${escapeHtml(plan.room.width_y)} m (south–north), ceiling ${escapeHtml(plan.room.height_z)} m. Printed ${escapeHtml(new Date().toLocaleString())}.</div>
      <img src="${escapeHtml(image)}" alt="Floor plan with the suggested spots">
      <table><thead><tr><th></th><th>Device</th><th>Action</th><th>Where and how</th></tr></thead><tbody>${planRowsHtml}${lidarRowHtml}</tbody></table>
      <ul>
        <li>Distances are measured along the wall from the corner named, to the centre of the board or the LiDAR. Heights are from the floor.</li>
        <li>Anchors: flat on the wall on a 1–2 cm foam pad, no tilt; board upright, antenna end up, components facing into the room, nothing within 5 cm of the antenna. Mount every board the same way. A XIAO ESP32-C3 needs its FPC antenna clipped on, stuck upright above the board.</li>
        <li>LiDAR: level, on a shelf or bracket; nothing within 5 cm of it at the height of its window. Check the direction of the ▲ with a phone compass.</li>
        <li>Expected error with these anchors: ${escapeHtml(plan.suggested.mean_error_m)} m on average (lower bound from the signal strength; real readings are worse).</li>
        <li>Afterwards: bind the new boards in the ward editor, Save Changes, then 🎯 Calibrate Anchors on the Live Map.</li>
      </ul>
      </body></html>`;
    const win = window.open('', '_blank');
    if (!win) {
      showToast('Allow pop-ups for this page to print the installation sheet.', 'warning', 5000);
      return;
    }
    win.document.open();
    win.document.write(sheetHtml);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 400);
  }

  window.openPlacementPlanner = openPlacementPlanner;
  window.onPlannerSettingsChange = onPlannerSettingsChange;
  window.setPlannerView = setPlannerView;
  window.printPlacementSheet = printPlacementSheet;
})();
