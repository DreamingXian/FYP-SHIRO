// =============================================================================
// SHIRO Central Ward Management System - Ward Live 2D IPS Map Controller
// Interactive Digital Twin Canvas, Multilateration Visualization & Live Vitals
// =============================================================================

(function() {
  let isLiveMapActive = false;
  let activeWard = null;
  let trackedSubjects = []; // [{ patient_id, full_name, device_id, mac_address, ... }]
  let selectedTagId = null;

  // Localized Tag Positions: tagId -> { x, y, targetX, targetY, confidence, anchors: [], lastSeen }
  const liveTagPositions = new Map();
  // Live Vitals Cache: tagId -> { bpm, spo2, battery, lastSeen }
  const liveVitals = new Map();

  let canvas = null;
  let ctx = null;
  let animationFrameId = null;
  let ripplePhase = 0;

  // Layer Visibility
  const layers = {
    rings: true,
    labels: true,
    grid: true
  };

  /**
   * Enter Live 2D IPS Map View for a given ward
   * @param {string} wardId 
   */
  async function openWardLiveMap(wardId) {
    if (!wardId) return;

    try {
      const res = await fetch(`/api/ward/ips-init?ward_id=${encodeURIComponent(wardId)}`);
      const data = await res.json();
      if (!data.success || !data.ward) {
        if (window.showToast) window.showToast(`Could not initialize live map: ${data.error || 'Ward not found'}`, 'danger');
        return;
      }

      activeWard = data.ward;
      trackedSubjects = Array.isArray(data.tracked_subjects) ? data.tracked_subjects : [];

      // Switch view panels
      const dirView = document.getElementById('ward-directory-view');
      const editView = document.getElementById('ward-editor-view');
      const liveView = document.getElementById('ward-live-map-view');

      if (dirView) dirView.style.display = 'none';
      if (editView) editView.style.display = 'none';
      if (liveView) liveView.style.display = 'block';

      isLiveMapActive = true;

      // Update Top Status Bar
      const wardBadge = document.getElementById('live-map-ward-badge');
      if (wardBadge) wardBadge.innerText = `${activeWard.ward_id} (${activeWard.room_title || 'Ward'})`;

      const dimPill = document.getElementById('live-map-dimensions-pill');
      if (dimPill) dimPill.innerText = `${Number(activeWard.length_x).toFixed(2)}m × ${Number(activeWard.width_y).toFixed(2)}m × ${Number(activeWard.height_z).toFixed(2)}m`;

      const anchorsBadge = document.getElementById('live-map-anchors-badge');
      if (anchorsBadge) {
        const total = activeWard.anchors ? activeWard.anchors.length : 0;
        const onlineCount = activeWard.anchors ? activeWard.anchors.filter(a => a.status === 'ONLINE').length : 0;
        anchorsBadge.innerText = `● ${onlineCount}/${total} Anchors Online`;
        anchorsBadge.className = `badge ${onlineCount >= 3 ? 'badge-live' : 'badge-warning'}`;
      }

      // Populate Tracked Subjects list on Left Panel
      renderSubjectsList();

      // Default select the first subject bound to this ward, or any active subject
      const wardResident = trackedSubjects.find(s => s.is_ward_resident) || trackedSubjects[0];
      if (wardResident) {
        selectSubject(wardResident.device_id);
      } else {
        // Seed an empty subject state
        selectSubject('TAG-001');
      }

      // Initialize Canvas
      initLiveCanvas();

      // Start Clock
      updateClock();

      console.log(`[IPS LIVE MAP] Activated for ${activeWard.ward_id} with ${trackedSubjects.length} subjects.`);
    } catch (err) {
      console.error('[IPS LIVE MAP] Error initializing:', err);
      if (window.showToast) window.showToast(`Error loading live map: ${err.message}`, 'danger');
    }
  }

  /**
   * Exit Live Map and return to Ward Directory
   */
  function closeWardLiveMap() {
    isLiveMapActive = false;
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }

    const liveView = document.getElementById('ward-live-map-view');
    const dirView = document.getElementById('ward-directory-view');

    if (liveView) liveView.style.display = 'none';
    if (dirView) dirView.style.display = 'block';

    if (typeof window.loadWardDirectory === 'function') {
      window.loadWardDirectory();
    }
  }

  /**
   * Render active subject cards on Left Panel
   */
  function renderSubjectsList() {
    const container = document.getElementById('live-map-subjects-container');
    const countBadge = document.getElementById('live-map-subject-count');
    if (!container) return;

    container.innerHTML = '';

    if (countBadge) {
      countBadge.innerText = `${trackedSubjects.length} Subject${trackedSubjects.length === 1 ? '' : 's'}`;
    }

    if (trackedSubjects.length === 0) {
      container.innerHTML = `<div style="color:var(--text-muted); font-size:11px; padding:8px; text-align:center;">No patients currently bound to wristbands in this ward.</div>`;
      return;
    }

    trackedSubjects.forEach(s => {
      const isSelected = (s.device_id === selectedTagId);
      const isResident = s.is_ward_resident;
      const bedLabel = s.assigned_bed_id ? s.assigned_bed_id : 'No Bed';
      const pos = liveTagPositions.get(s.device_id);
      const isTagOffline = pos ? (pos.status === 'OFFLINE' || (Date.now() - (pos.lastSeen || 0) > 6000)) : false;

      const item = document.createElement('div');
      item.className = 'live-map-subject-item';
      item.style.cssText = `
        padding: 8px 10px;
        border-radius: 6px;
        border: 1px solid ${isSelected ? 'var(--primary)' : 'var(--border)'};
        background: ${isSelected ? '#EFF6FF' : '#FFFFFF'};
        display: flex;
        justify-content: space-between;
        align-items: center;
        cursor: pointer;
        transition: all 0.15s ease;
      `;

      item.onclick = () => selectSubject(s.device_id);

      item.innerHTML = `
        <div style="display:flex; align-items:center; gap:8px;">
          <span style="font-size:16px;">${s.photo_url ? '👤' : '👤'}</span>
          <div>
            <div style="font-weight:700; font-size:12px; color:var(--text-primary);">${s.full_name || 'Anonymous Patient'}</div>
            <div style="font-size:10px; color:var(--text-muted); font-family:monospace;">${s.device_id} · ${bedLabel}</div>
          </div>
        </div>
        <div style="display:flex; flex-direction:column; align-items:flex-end; gap:3px;">
          <span class="badge ${isTagOffline ? 'badge-alert' : 'badge-live'}" style="font-size:9px;">
            ${isTagOffline ? '● OFFLINE' : '● ONLINE'}
          </span>
          <span style="font-size:9px; color:var(--text-muted);">
            ${isResident ? 'Resident' : 'Visiting'}
          </span>
        </div>
      `;

      container.appendChild(item);
    });
  }

  /**
   * Select a subject to focus on Left Panel and on Canvas
   * @param {string} tagId 
   */
  function selectSubject(tagId) {
    selectedTagId = tagId;
    renderSubjectsList();

    const subject = trackedSubjects.find(s => s.device_id === tagId);

    const nameEl = document.getElementById('live-map-patient-name');
    const subtextEl = document.getElementById('live-map-patient-subtext');
    const hwIdEl = document.getElementById('live-map-hardware-id');
    const bedEl = document.getElementById('live-map-bed-code');
    const demoEl = document.getElementById('live-map-patient-demographics');
    const macEl = document.getElementById('live-map-tag-mac');
    const noteEl = document.getElementById('live-map-medical-note');
    const avatarEl = document.getElementById('live-map-patient-avatar');

    if (subject) {
      if (nameEl) nameEl.innerText = subject.full_name || 'Patient';
      if (subtextEl) subtextEl.innerText = `ID: ${subject.patient_id} · Bed: ${subject.assigned_bed_id || 'Not Assigned'}`;
      if (hwIdEl) hwIdEl.innerText = `Hardware Tag: ${subject.device_id}`;
      if (bedEl) bedEl.innerText = subject.assigned_bed_id || 'Unassigned';
      if (demoEl) {
        const gender = subject.gender || 'Unknown';
        const dob = subject.dob ? new Date(subject.dob).getFullYear() : null;
        const age = dob ? `${new Date().getFullYear() - dob} yrs` : '';
        demoEl.innerText = `${gender} ${age}`.trim();
      }
      if (macEl) macEl.innerText = subject.mac_address || '--:--:--:--:--:--';
      if (noteEl) noteEl.innerText = subject.medical_history || 'No medical precautions or clinical notes on file.';

      if (avatarEl && subject.photo_url) {
        avatarEl.innerHTML = `<img src="${subject.photo_url}" style="width:100%; height:100%; object-fit:cover;" onerror="this.parentElement.innerText='👤'">`;
      } else if (avatarEl) {
        avatarEl.innerText = '👤';
      }
    } else {
      if (nameEl) nameEl.innerText = `Hardware Tag (${tagId})`;
      if (subtextEl) subtextEl.innerText = 'Unbound Wristband Device';
      if (hwIdEl) hwIdEl.innerText = `Hardware Tag: ${tagId}`;
      if (bedEl) bedEl.innerText = '--';
      if (demoEl) demoEl.innerText = '--';
      if (macEl) macEl.innerText = '--';
      if (noteEl) noteEl.innerText = 'Wristband is active but not currently bound to an admitted patient in MySQL.';
      if (avatarEl) avatarEl.innerText = '📡';
    }

    // Refresh telemetry displays
    updateTelemetryCard();
  }

  /**
   * Update Left Panel telemetry displays from live cache
   */
  function updateTelemetryCard() {
    if (!selectedTagId) return;

    const vitals = liveVitals.get(selectedTagId) || {};
    const pos = liveTagPositions.get(selectedTagId) || null;
    const isOffline = pos ? (pos.status === 'OFFLINE' || (Date.now() - (pos.lastSeen || 0) > 6000)) : false;

    const bpmEl = document.getElementById('live-map-val-bpm');
    const spo2El = document.getElementById('live-map-val-spo2');
    const batteryEl = document.getElementById('live-map-val-battery');
    const coordsEl = document.getElementById('live-map-val-coords');
    const proximityEl = document.getElementById('live-map-val-proximity');
    const confEl = document.getElementById('live-map-val-confidence');
    const vitalsStatusEl = document.getElementById('live-map-vitals-status');

    if (vitalsStatusEl) {
      if (isOffline) {
        vitalsStatusEl.innerText = '● OFFLINE (LAST KNOWN)';
        vitalsStatusEl.className = 'badge badge-alert';
      } else {
        vitalsStatusEl.innerText = '● LIVE STREAM';
        vitalsStatusEl.className = 'badge badge-live';
      }
    }

    if (bpmEl) {
      bpmEl.innerText = vitals.bpm !== undefined ? vitals.bpm : '--';
      bpmEl.style.color = (vitals.bpm && (vitals.bpm < 50 || vitals.bpm > 110)) ? '#DC2626' : '#991B1B';
    }

    if (spo2El) {
      spo2El.innerText = vitals.spo2 !== undefined ? vitals.spo2 : '--';
      spo2El.style.color = (vitals.spo2 && vitals.spo2 < 94) ? '#DC2626' : '#166534';
    }

    if (batteryEl) {
      const bat = vitals.battery !== undefined ? vitals.battery : (vitals.bat !== undefined ? vitals.bat : null);
      batteryEl.innerText = bat !== null ? `${bat}%` : '--';
    }

    if (coordsEl) {
      if (pos && pos.x !== undefined && pos.y !== undefined) {
        const prefix = isOffline ? 'Last Known: ' : '';
        coordsEl.innerText = `${prefix}(${pos.x.toFixed(2)}m, ${pos.y.toFixed(2)}m)`;
      } else {
        coordsEl.innerText = 'Awaiting signal...';
      }
    }

    if (confEl && pos) {
      if (isOffline) {
        confEl.innerText = 'OFFLINE (LAST KNOWN)';
        confEl.className = 'badge badge-alert';
      } else {
        confEl.innerText = pos.confidence || '3-Anchor 2D';
        confEl.className = `badge ${pos.confidence === 'HIGH' ? 'badge-live' : (pos.confidence === 'MEDIUM' ? 'badge-warning' : 'badge-neutral')}`;
      }
    }

    // Calculate proximity to assigned bed
    if (proximityEl && pos && activeWard && activeWard.beds) {
      const subject = trackedSubjects.find(s => s.device_id === selectedTagId);
      if (subject && subject.assigned_bed_id) {
        const bed = activeWard.beds.find(b => b.bed_id === subject.assigned_bed_id || b.bed_code === subject.assigned_bed_id);
        if (bed) {
          const dx = pos.x - (bed.x + bed.width / 2);
          const dy = pos.y - (bed.y + bed.length / 2);
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 0.85) {
            proximityEl.innerHTML = `<span style="color:#16A34A; font-weight:700;">🛏️ In Bed (${dist.toFixed(2)}m)</span>`;
          } else if (dist < 1.80) {
            proximityEl.innerHTML = `<span style="color:#D97706; font-weight:700;">🚶 Bedside (${dist.toFixed(2)}m)</span>`;
          } else {
            proximityEl.innerHTML = `<span style="color:var(--text-primary);">📍 Ward Ambulatory (${dist.toFixed(2)}m)</span>`;
          }
        } else {
          proximityEl.innerText = 'Bed unplaced in ward';
        }
      } else {
        proximityEl.innerText = 'No assigned bed';
      }
    }

    // Render Wall Anchors Heard breakdown
    renderAnchorsBreakdown(pos);
  }

  function renderAnchorsBreakdown(pos) {
    const container = document.getElementById('live-map-anchors-breakdown');
    if (!container) return;

    if (!pos || !Array.isArray(pos.anchors) || pos.anchors.length === 0) {
      container.innerHTML = `<div style="color:var(--text-muted); text-align:center; padding:6px;">Awaiting anchor reception packets...</div>`;
      return;
    }

    container.innerHTML = pos.anchors.map(a => {
      return `
        <div style="display:flex; justify-content:space-between; align-items:center; background:#FFFFFF; border:1px solid var(--border-light); border-radius:4px; padding:4px 8px;">
          <div><strong style="color:var(--primary);">${a.anchor_id}</strong> <span style="color:var(--text-muted); font-family:monospace;">(${a.device_id})</span></div>
          <div style="font-family:monospace; color:var(--text-secondary);">${Number(a.distance).toFixed(2)}m</div>
          <div><span class="badge badge-info" style="font-size:9px;">${a.rssi} dBm</span></div>
        </div>
      `;
    }).join('');
  }

  /**
   * Initialize Canvas and attach event listeners
   */
  function initLiveCanvas() {
    canvas = document.getElementById('ward-live-map-canvas');
    if (!canvas) return;

    ctx = canvas.getContext('2d');
    resizeCanvas();

    window.addEventListener('resize', resizeCanvas);

    // Click handler to select wristband dots on canvas
    canvas.addEventListener('click', onCanvasClick);

    // Start drawing loop
    if (!animationFrameId) {
      animationFrameId = requestAnimationFrame(renderLoop);
    }
  }

  function resizeCanvas() {
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (parent) {
      const rect = parent.getBoundingClientRect();
      canvas.width = rect.width * (window.devicePixelRatio || 1);
      canvas.height = rect.height * (window.devicePixelRatio || 1);
    }
  }

  function onCanvasClick(evt) {
    if (!canvas || !activeWard) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const clickX = (evt.clientX - rect.left) * dpr;
    const clickY = (evt.clientY - rect.top) * dpr;

    // Get transform
    const t = getCanvasTransform(canvas.width, canvas.height, activeWard.length_x, activeWard.width_y);

    // Hit-test active tags within 30px
    for (const [tagId, pos] of liveTagPositions.entries()) {
      const pt = metricToCanvas(pos.x, pos.y, t);
      const dx = clickX - pt.x;
      const dy = clickY - pt.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= 30 * dpr) {
        selectSubject(tagId);
        if (window.showToast) window.showToast(`Selected ${tagId}`, 'info', 1500);
        return;
      }
    }
  }

  /**
   * Main Canvas Render Loop
   */
  function renderLoop() {
    if (!isLiveMapActive) return;

    ripplePhase = (ripplePhase + 0.04) % (Math.PI * 2);

    // Smooth tag positions toward targets (linear interpolation)
    for (const [tagId, pos] of liveTagPositions.entries()) {
      if (pos.targetX !== undefined && pos.targetY !== undefined) {
        pos.x += (pos.targetX - pos.x) * 0.25;
        pos.y += (pos.targetY - pos.y) * 0.25;
      }
    }

    drawLiveMap();

    animationFrameId = requestAnimationFrame(renderLoop);
  }

  function getCanvasTransform(cWidth, cHeight, roomX, roomY) {
    const padding = 70;
    const availW = cWidth - padding * 2;
    const availH = cHeight - padding * 2;
    const scale = Math.min(availW / roomX, availH / roomY);
    const offsetX = (cWidth - roomX * scale) / 2;
    const offsetY = (cHeight - roomY * scale) / 2;
    return { scale, offsetX, offsetY, roomX, roomY, cHeight };
  }

  function metricToCanvas(mx, my, t) {
    // Room origin (0,0) is at Bottom-Left: Y axis points upward in physical space
    const px = t.offsetX + mx * t.scale;
    const py = t.cHeight - (t.offsetY + my * t.scale);
    return { x: px, y: py };
  }

  /**
   * Core Live 2D Map Drawing Logic
   */
  function drawLiveMap() {
    if (!ctx || !canvas || !activeWard) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const t = getCanvasTransform(w, h, activeWard.length_x, activeWard.width_y);

    // 1. Draw 0.5-Meter Spatial Metric Grid
    if (layers.grid) {
      drawMetricGrid(ctx, t);
    }

    // 2. Draw Room Perimeter Walls
    drawRoomPerimeter(ctx, t, activeWard);

    // 3. Draw Obstacles / Partitions
    if (Array.isArray(activeWard.obstacles)) {
      activeWard.obstacles.forEach(obs => drawObstacle(ctx, t, obs));
    }

    // 4. Draw Door Cutout
    if (activeWard.door) {
      drawDoor(ctx, t, activeWard);
    }

    // 5. Draw Hospital Beds
    if (Array.isArray(activeWard.beds)) {
      activeWard.beds.forEach(bed => drawBed(ctx, t, bed));
    }

    // 6. Draw Wall Anchors & Multilateration Radii
    if (Array.isArray(activeWard.anchors)) {
      activeWard.anchors.forEach(a => drawAnchor(ctx, t, a));
    }

    // 7. Draw Tracked Wristband Dots
    drawWristbandDots(ctx, t);
  }

  function drawMetricGrid(ctx, t) {
    ctx.save();
    ctx.strokeStyle = '#F1F5F9';
    ctx.lineWidth = 1;
    ctx.font = '10px monospace';
    ctx.fillStyle = '#94A3B8';

    const step = 0.5; // 0.5 meter grid lines
    for (let x = 0; x <= t.roomX + 0.01; x += step) {
      const p1 = metricToCanvas(x, 0, t);
      const p2 = metricToCanvas(x, t.roomY, t);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();

      if (Math.round(x * 10) % 10 === 0) {
        ctx.fillText(`${x.toFixed(1)}m`, p1.x - 12, p1.y + 18);
      }
    }

    for (let y = 0; y <= t.roomY + 0.01; y += step) {
      const p1 = metricToCanvas(0, y, t);
      const p2 = metricToCanvas(t.roomX, y, t);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();

      if (Math.round(y * 10) % 10 === 0) {
        ctx.fillText(`${y.toFixed(1)}m`, p1.x - 38, p1.y + 4);
      }
    }

    ctx.restore();
  }

  function drawRoomPerimeter(ctx, t, ward) {
    ctx.save();
    const bl = metricToCanvas(0, 0, t);
    const tr = metricToCanvas(ward.length_x, ward.width_y, t);
    const widthPx = tr.x - bl.x;
    const heightPx = bl.y - tr.y;

    // Room interior fill
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(bl.x, tr.y, widthPx, heightPx);

    // Wall perimeter outline
    ctx.strokeStyle = '#1E293B';
    ctx.lineWidth = 6;
    ctx.lineJoin = 'miter';
    ctx.strokeRect(bl.x, tr.y, widthPx, heightPx);

    ctx.restore();
  }

  function drawObstacle(ctx, t, obs) {
    ctx.save();
    const p = metricToCanvas(obs.x, obs.y + obs.length, t);
    const w = obs.width * t.scale;
    const l = obs.length * t.scale;

    ctx.fillStyle = '#F8FAFC';
    ctx.fillRect(p.x, p.y, w, l);

    // Diagonal hatch pattern
    ctx.strokeStyle = '#CBD5E1';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(p.x, p.y, w, l);

    // Cross lines for architectural wall partition
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + w, p.y + l);
    ctx.moveTo(p.x + w, p.y);
    ctx.lineTo(p.x, p.y + l);
    ctx.stroke();

    if (layers.labels) {
      ctx.fillStyle = '#64748B';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(obs.label || 'Wall Block', p.x + w / 2, p.y + l / 2 + 3);
    }
    ctx.restore();
  }

  function drawDoor(ctx, t, ward) {
    const door = ward.door;
    if (!door) return;

    ctx.save();
    const wall = door.wall || 'SOUTH';
    const x = parseFloat(door.x || 0);
    const w = parseFloat(door.width || 0.90);

    let startMetric = { x: 0, y: 0 };
    if (wall === 'SOUTH') startMetric = { x, y: 0 };
    else if (wall === 'NORTH') startMetric = { x, y: ward.width_y };
    else if (wall === 'WEST') startMetric = { x: 0, y: x };
    else if (wall === 'EAST') startMetric = { x: ward.length_x, y: x };

    const p = metricToCanvas(startMetric.x, startMetric.y, t);

    // Clear wall gap for door
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 8;
    ctx.beginPath();
    if (wall === 'SOUTH' || wall === 'NORTH') {
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + w * t.scale, p.y);
    } else {
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x, p.y - w * t.scale);
    }
    ctx.stroke();

    // Draw door panel & swing arc
    ctx.strokeStyle = '#0284C7';
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (wall === 'SOUTH') {
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + w * t.scale, p.y - w * t.scale * 0.7);
    } else {
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + w * t.scale * 0.7, p.y - w * t.scale);
    }
    ctx.stroke();

    if (layers.labels) {
      ctx.fillStyle = '#0284C7';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('🚪 Door', p.x + (w * t.scale) / 2, p.y + 16);
    }
    ctx.restore();
  }

  function drawBed(ctx, t, bed) {
    ctx.save();
    const p = metricToCanvas(bed.x, bed.y + bed.length, t);
    const bw = bed.width * t.scale;
    const bl = bed.length * t.scale;

    // Bed frame
    ctx.fillStyle = '#F1F5F9';
    ctx.fillRect(p.x, p.y, bw, bl);
    ctx.strokeStyle = '#94A3B8';
    ctx.lineWidth = 2;
    ctx.strokeRect(p.x, p.y, bw, bl);

    // Bed Pillow (Head)
    ctx.fillStyle = '#FFFFFF';
    ctx.strokeStyle = '#CBD5E1';
    ctx.lineWidth = 1;
    const pillowH = bl * 0.22;
    ctx.fillRect(p.x + 3, p.y + 3, bw - 6, pillowH);
    ctx.strokeRect(p.x + 3, p.y + 3, bw - 6, pillowH);

    // Blanket crease
    ctx.strokeStyle = '#CBD5E1';
    ctx.beginPath();
    ctx.moveTo(p.x + 4, p.y + pillowH + 10);
    ctx.lineTo(p.x + bw - 4, p.y + pillowH + 10);
    ctx.stroke();

    if (layers.labels) {
      ctx.fillStyle = '#334155';
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(bed.bed_code || bed.bed_id, p.x + bw / 2, p.y + bl / 2 + 10);
    }
    ctx.restore();
  }

  function drawAnchor(ctx, t, a) {
    ctx.save();
    const p = metricToCanvas(a.x, a.y, t);
    const isOnline = (a.status === 'ONLINE');

    // 1. Draw Multilateration Distance Radius circle if enabled
    if (layers.rings && selectedTagId) {
      const selectedPos = liveTagPositions.get(selectedTagId);
      if (selectedPos && Array.isArray(selectedPos.anchors)) {
        const match = selectedPos.anchors.find(item => item.device_id === a.device_id || item.anchor_id === a.anchor_id);
        if (match && match.distance > 0) {
          const rPx = match.distance * t.scale;
          ctx.beginPath();
          ctx.arc(p.x, p.y, rPx, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(14, 165, 233, 0.45)';
          ctx.lineWidth = 1.5;
          ctx.setLineDash([5, 4]);
          ctx.stroke();
          ctx.setLineDash([]);

          // Distance label along ring
          ctx.fillStyle = '#0284C7';
          ctx.font = '10px monospace';
          ctx.fillText(`${match.distance.toFixed(2)}m`, p.x + rPx * 0.7, p.y - rPx * 0.7);
        }
      }
    }

    // 2. Pulsing Beacon Glow if Online
    if (isOnline) {
      const pulseSize = 8 + Math.sin(ripplePhase * 2) * 4;
      ctx.beginPath();
      ctx.arc(p.x, p.y, pulseSize, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(16, 185, 129, 0.25)';
      ctx.fill();
    }

    // 3. Anchor Beacon Center
    ctx.beginPath();
    ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = isOnline ? '#10B981' : '#EF4444';
    ctx.fill();
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 2;
    ctx.stroke();

    // 4. Anchor Labels
    if (layers.labels) {
      ctx.fillStyle = '#0F172A';
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      const labelY = (a.y < activeWard.width_y / 2) ? p.y + 18 : p.y - 12;
      ctx.fillText(`📡 ${a.anchor_id}`, p.x, labelY);
      ctx.font = '10px monospace';
      ctx.fillStyle = '#64748B';
      ctx.fillText(`(${a.device_id || 'unassigned'})`, p.x, labelY + 12);
    }

    ctx.restore();
  }

  function drawWristbandDots(ctx, t) {
    const now = Date.now();

    // 1. Reconcile and purge raw MAC ghost keys
    for (const [tagId, pos] of liveTagPositions.entries()) {
      if (tagId.includes(':')) {
        const canonical = trackedSubjects.find(s => s.mac_address && s.mac_address.toUpperCase() === tagId.toUpperCase());
        if (canonical) {
          if (!liveTagPositions.has(canonical.device_id)) {
            liveTagPositions.set(canonical.device_id, { ...pos });
          }
          liveTagPositions.delete(tagId);
          continue;
        }
      }
    }

    for (const [tagId, pos] of liveTagPositions.entries()) {
      if (pos.x === undefined || pos.y === undefined) continue;

      ctx.save();
      const p = metricToCanvas(pos.x, pos.y, t);
      const isSelected = (tagId === selectedTagId);
      const isOffline = (pos.status === 'OFFLINE' || (now - (pos.lastSeen || 0) > 6000));

      // 2. Ripple Expanding Wave Animation (ONLY when ONLINE, disabled when OFFLINE)
      if (!isOffline) {
        const rippleR = 12 + ((ripplePhase * 10) % 20);
        const rippleOpacity = Math.max(0, 1 - (rippleR - 12) / 20);
        ctx.beginPath();
        ctx.arc(p.x, p.y, rippleR, 0, Math.PI * 2);
        ctx.strokeStyle = isSelected 
          ? `rgba(2, 132, 199, ${rippleOpacity})` 
          : `rgba(13, 148, 136, ${rippleOpacity})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // 3. Outer Selection Ring
      if (isSelected) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 16, 0, Math.PI * 2);
        ctx.strokeStyle = isOffline ? 'rgba(100, 116, 139, 0.80)' : '#0284C7';
        ctx.lineWidth = 3;
        ctx.setLineDash([4, 2]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // 4. Core Solid Dot (Grey when OFFLINE, Vibrant Cyan/Teal when ONLINE)
      ctx.beginPath();
      ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
      ctx.fillStyle = isOffline ? '#64748B' : (isSelected ? '#0284C7' : '#0D9488');
      ctx.fill();
      ctx.strokeStyle = isOffline ? '#CBD5E1' : '#FFFFFF';
      ctx.lineWidth = 2.5;
      ctx.stroke();

      // 5. Floating Name Badge above Dot
      if (layers.labels) {
        const subject = trackedSubjects.find(s => s.device_id === tagId);
        const baseName = subject ? subject.full_name : tagId;
        const nameText = isOffline ? `${baseName} [OFFLINE]` : baseName;

        ctx.font = 'bold 11px sans-serif';
        const textW = ctx.measureText(nameText).width;

        // Pill background (Grey when OFFLINE)
        const pillX = p.x - textW / 2 - 8;
        const pillY = p.y - 28;
        ctx.fillStyle = isOffline 
          ? 'rgba(100, 116, 139, 0.90)' 
          : (isSelected ? '#0284C7' : 'rgba(30, 41, 59, 0.85)');
        ctx.beginPath();
        ctx.roundRect(pillX, pillY, textW + 16, 18, 9);
        ctx.fill();

        // Pill text
        ctx.fillStyle = isOffline ? '#F1F5F9' : '#FFFFFF';
        ctx.textAlign = 'center';
        ctx.fillText(nameText, p.x, pillY + 13);
      }

      ctx.restore();
    }
  }

  function updateClock() {
    const el = document.getElementById('live-map-clock');
    if (el) el.innerText = new Date().toLocaleTimeString();
    if (isLiveMapActive) setTimeout(updateClock, 1000);
  }

  // --- Layer Toggles ---
  window.toggleIpsLayer = function(layerName) {
    if (layerName === 'rings') {
      layers.rings = document.getElementById('chk-show-rings')?.checked;
    } else if (layerName === 'labels') {
      layers.labels = document.getElementById('chk-show-labels')?.checked;
    } else if (layerName === 'grid') {
      layers.grid = document.getElementById('chk-show-grid')?.checked;
    }
  };

  window.recenterLiveMap = function() {
    resizeCanvas();
    if (window.showToast) window.showToast('Live map view recentered.', 'info', 1000);
  };

  // --- WebSocket Live Listener ---
  function setupWebSocketListeners() {
    if (!window.wsClient) {
      setTimeout(setupWebSocketListeners, 300);
      return;
    }

    // 1. Ghost Tag Purge event
    window.wsClient.on('IPS_TAG_PURGE', (msg) => {
      if (msg.tag_id && liveTagPositions.has(msg.tag_id)) {
        liveTagPositions.delete(msg.tag_id);
      }
    });

    // 2. Position update from Multilateration Engine
    window.wsClient.on('IPS_POSITION_UPDATE', (msg) => {
      if (!isLiveMapActive || !activeWard) return;
      if (msg.ward_id !== activeWard.ward_id) return;

      const tagId = msg.tag_id;
      if (!tagId) return;

      // Purge ghost MAC key if tag_mac is provided and differs from tagId
      if (msg.tag_mac && msg.tag_mac !== tagId && liveTagPositions.has(msg.tag_mac)) {
        liveTagPositions.delete(msg.tag_mac);
      }

      const existing = liveTagPositions.get(tagId);
      if (!existing) {
        liveTagPositions.set(tagId, {
          x: msg.x,
          y: msg.y,
          targetX: msg.x,
          targetY: msg.y,
          status: msg.status || 'ONLINE',
          confidence: msg.confidence,
          anchors: msg.anchors_used || [],
          lastSeen: msg.timestamp || Date.now()
        });
      } else {
        existing.targetX = msg.x;
        existing.targetY = msg.y;
        existing.status = msg.status || 'ONLINE';
        existing.confidence = msg.confidence;
        existing.anchors = msg.anchors_used || [];
        existing.lastSeen = msg.timestamp || Date.now();
      }

      const tagsBadge = document.getElementById('live-map-tags-badge');
      if (tagsBadge) {
        const onlineCount = Array.from(liveTagPositions.values()).filter(p => p.status !== 'OFFLINE').length;
        tagsBadge.innerText = `● ${onlineCount}/${liveTagPositions.size} Active Tags`;
      }

      renderSubjectsList();

      if (tagId === selectedTagId) {
        updateTelemetryCard();
      }
    });

    // 3. Physiological Telemetry from Wristband (BPM, SpO2, Battery)
    window.wsClient.on('TELEMETRY', (msg) => {
      if (!isLiveMapActive) return;
      const data = msg.data || msg;
      const tagId = data.tag_id || msg.tag_id;
      if (!tagId) return;

      const current = liveVitals.get(tagId) || {};
      if (data.bpm !== undefined) current.bpm = data.bpm;
      if (data.spo2 !== undefined) current.spo2 = data.spo2;
      if (data.bat !== undefined || data.battery !== undefined) {
        current.battery = (data.bat !== undefined) ? data.bat : data.battery;
      }
      current.lastSeen = Date.now();
      liveVitals.set(tagId, current);

      if (tagId === selectedTagId) {
        updateTelemetryCard();
      }
    });

    // 3. Anchor Hardware Heartbeat updates
    window.wsClient.on('DEVICE_HEARTBEAT', (msg) => {
      if (!isLiveMapActive || !activeWard || !Array.isArray(activeWard.anchors)) return;
      const devId = msg.device_id || msg.id;
      if (!devId) return;

      activeWard.anchors.forEach(a => {
        if (a.device_id === devId) {
          a.status = (msg.status || 'ONLINE').toUpperCase();
        }
      });

      const anchorsBadge = document.getElementById('live-map-anchors-badge');
      if (anchorsBadge) {
        const total = activeWard.anchors.length;
        const onlineCount = activeWard.anchors.filter(a => a.status === 'ONLINE').length;
        anchorsBadge.innerText = `● ${onlineCount}/${total} Anchors Online`;
        anchorsBadge.className = `badge ${onlineCount >= 3 ? 'badge-live' : 'badge-warning'}`;
      }
    });
  }

  // Auto setup on load
  document.addEventListener('DOMContentLoaded', setupWebSocketListeners);

  // Global exposure
  window.openWardLiveMap = openWardLiveMap;
  window.closeWardLiveMap = closeWardLiveMap;
})();

