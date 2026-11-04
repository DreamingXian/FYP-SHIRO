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
  let lastRenderTime = 0;

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

      // Update calibration display pills
      if (data.calibration) {
        const calA = document.getElementById('live-map-cal-a');
        const calN = document.getElementById('live-map-cal-n');
        if (calA) calA.innerText = `Log-Distance Model: A = ${Number(data.calibration.A).toFixed(1)} dBm`;
        if (calN) calN.innerText = `Path Loss: n = ${Number(data.calibration.n).toFixed(1)}`;
      }

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

      let statusBadge = '';
      if (isTagOffline) {
        statusBadge = `<span class="badge badge-alert" style="font-size:9px;">● OFFLINE</span>`;
      } else if (pos && pos.motion_state === 'WALKING') {
        statusBadge = `<span class="badge badge-live" style="font-size:9px;">🚶 WALKING</span>`;
      } else if (pos && pos.motion_state === 'HAND_MOVEMENT') {
        statusBadge = `<span class="badge badge-warning" style="font-size:9px; background:#FEF3C7; color:#B45309; border:1px solid #FCD34D;">👋 GESTURE</span>`;
      } else if (pos && pos.motion_state === 'SETTLING') {
        statusBadge = `<span class="badge badge-warning" style="font-size:9px;">🎯 SETTLING</span>`;
      } else {
        statusBadge = `<span class="badge badge-info" style="font-size:9px;">🔒 STILL</span>`;
      }

      item.innerHTML = `
        <div style="display:flex; align-items:center; gap:8px;">
          <span style="font-size:16px;">${s.photo_url ? '👤' : '👤'}</span>
          <div>
            <div style="font-weight:700; font-size:12px; color:var(--text-primary);">${s.full_name || 'Anonymous Patient'}</div>
            <div style="font-size:10px; color:var(--text-muted); font-family:monospace;">${s.device_id} · ${bedLabel}</div>
          </div>
        </div>
        <div style="display:flex; flex-direction:column; align-items:flex-end; gap:3px;">
          ${statusBadge}
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

    const offlineActionEl = document.getElementById('live-map-offline-actions');
    if (offlineActionEl) {
      offlineActionEl.style.display = isOffline ? 'block' : 'none';
    }

    if (confEl && pos) {
      if (isOffline) {
        confEl.innerText = 'OFFLINE (LAST KNOWN)';
        confEl.className = 'badge badge-alert';
        confEl.style.background = '';
        confEl.style.color = '';
      } else if (pos.motion_state === 'WALKING') {
        confEl.innerText = '🚶 WALKING (ACTIVE)';
        confEl.className = 'badge badge-live';
        confEl.style.background = '';
        confEl.style.color = '';
      } else if (pos.motion_state === 'HAND_MOVEMENT') {
        confEl.innerText = '👋 HAND MOVEMENT';
        confEl.className = 'badge badge-warning';
        confEl.style.background = '#FEF3C7';
        confEl.style.color = '#B45309';
      } else if (pos.motion_state === 'SETTLING') {
        confEl.innerText = '🎯 SETTLING (2S WINDOW)';
        confEl.className = 'badge badge-warning';
        confEl.style.background = '';
        confEl.style.color = '';
      } else {
        confEl.innerText = '🔒 STATIONARY (LOCKED)';
        confEl.className = 'badge badge-info';
        confEl.style.background = '';
        confEl.style.color = '';
      }
    }

    // Calculate proximity to assigned bed
    if (proximityEl && pos && activeWard && activeWard.beds) {
      const subject = trackedSubjects.find(s => s.device_id === selectedTagId);
      if (subject && subject.assigned_bed_id) {
        const bed = activeWard.beds.find(b => b.bed_id === subject.assigned_bed_id || b.bed_code === subject.assigned_bed_id);
        if (bed) {
          const rot = parseInt(bed.rotation_deg, 10) || 0;
          const spanX = (rot === 90 || rot === 270) ? (bed.length || 2.00) : (bed.width || 0.90);
          const spanY = (rot === 90 || rot === 270) ? (bed.width || 0.90) : (bed.length || 2.00);
          const dx = pos.x - (bed.x + spanX / 2);
          const dy = pos.y - (bed.y + spanY / 2);
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
      const dpr = window.devicePixelRatio || 1;
      const targetW = Math.max(100, Math.floor(rect.width * dpr));
      const targetH = Math.max(100, Math.floor(rect.height * dpr));
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }
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
    const hitRadius = Math.max(26, ((0.45 / 2) * t.scale + 8) * dpr);

    // Hit-test active tags within scaled human circle bounds
    for (const [tagId, pos] of liveTagPositions.entries()) {
      const pt = metricToCanvas(pos.x, pos.y, t);
      const dx = clickX - pt.x;
      const dy = clickY - pt.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= hitRadius) {
        selectSubject(tagId);
        if (window.showToast) window.showToast(`Selected ${tagId}`, 'info', 1500);
        return;
      }
    }
  }

  /**
   * Main Canvas Render Loop
   * Uses velocity-clamped easing: dots smoothly walk at realistic speeds rather than flashing!
   */
  function renderLoop(frameTimestamp) {
    if (!isLiveMapActive) return;

    const now = frameTimestamp || performance.now();
    const dt = lastRenderTime > 0 ? Math.min(0.06, Math.max(0.005, (now - lastRenderTime) / 1000.0)) : 0.016;
    lastRenderTime = now;

    ripplePhase = (ripplePhase + 0.04) % (Math.PI * 2);

    // Smooth tag positions toward targets (physics-constrained visual gliding)
    for (const [tagId, pos] of liveTagPositions.entries()) {
      if (pos.targetX !== undefined && pos.targetY !== undefined) {
        const dx = pos.targetX - pos.x;
        const dy = pos.targetY - pos.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist > 0.001) {
          if (pos.motion_state === 'STATIONARY' || pos.status === 'OFFLINE') {
            // Settle to locked coordinate smoothly (max 0.45 m/s)
            const maxStep = 0.45 * dt;
            if (dist <= maxStep) {
              pos.x = pos.targetX;
              pos.y = pos.targetY;
            } else {
              pos.x += (dx / dist) * maxStep;
              pos.y += (dy / dist) * maxStep;
            }
          } else {
            // Ambulatory walking speed limit: smooth 0.75 m/s glide (never teleport or flash!)
            const maxStep = 0.75 * dt;
            if (dist <= maxStep) {
              pos.x = pos.targetX;
              pos.y = pos.targetY;
            } else {
              pos.x += (dx / dist) * maxStep;
              pos.y += (dy / dist) * maxStep;
            }
          }
        }
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
    const obsType = (obs.type || 'TOILET').toUpperCase();
    const obsHeight = obs.height !== undefined ? parseFloat(obs.height) : (obsType === 'TABLE' ? 0.75 : 2.00);

    if (obsType === 'CUPBOARD') {
      // Cupboard / Wardrobe cabinet styling
      ctx.fillStyle = '#FFFBEB';
      ctx.fillRect(p.x, p.y, w, l);
      ctx.strokeStyle = '#B45309';
      ctx.lineWidth = 2;
      ctx.strokeRect(p.x, p.y, w, l);

      // Cabinet split & knobs
      ctx.strokeStyle = '#D97706';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      if (w >= l) {
        const midX = p.x + w / 2;
        ctx.moveTo(midX, p.y);
        ctx.lineTo(midX, p.y + l);
        ctx.stroke();
        ctx.fillStyle = '#78350F';
        ctx.beginPath();
        ctx.arc(midX - 3, p.y + l / 2, 2, 0, Math.PI * 2);
        ctx.arc(midX + 3, p.y + l / 2, 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        const midY = p.y + l / 2;
        ctx.moveTo(p.x, midY);
        ctx.lineTo(p.x + w, midY);
        ctx.stroke();
        ctx.fillStyle = '#78350F';
        ctx.beginPath();
        ctx.arc(p.x + w / 2, midY - 3, 2, 0, Math.PI * 2);
        ctx.arc(p.x + w / 2, midY + 3, 2, 0, Math.PI * 2);
        ctx.fill();
      }

      if (layers.labels) {
        ctx.fillStyle = '#92400E';
        ctx.font = 'bold 9px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`🚪 ${obs.label || 'Cupboard'} (${obsHeight.toFixed(1)}m)`, p.x + w / 2, p.y + 12);
      }
    } else if (obsType === 'TABLE') {
      // Table / Desk styling
      ctx.fillStyle = '#F8FAFC';
      ctx.fillRect(p.x, p.y, w, l);
      ctx.strokeStyle = '#475569';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(p.x, p.y, w, l);

      // 4 corner legs
      ctx.fillStyle = '#94A3B8';
      const legS = Math.min(6, Math.max(3, w * 0.12));
      ctx.fillRect(p.x + 2, p.y + 2, legS, legS);
      ctx.fillRect(p.x + w - legS - 2, p.y + 2, legS, legS);
      ctx.fillRect(p.x + 2, p.y + l - legS - 2, legS, legS);
      ctx.fillRect(p.x + w - legS - 2, p.y + l - legS - 2, legS, legS);

      if (layers.labels) {
        ctx.fillStyle = '#334155';
        ctx.font = 'bold 9px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`🪑 ${obs.label || 'Table'} (${obsHeight.toFixed(1)}m)`, p.x + w / 2, p.y + l / 2 + 3);
      }
    } else {
      ctx.fillStyle = obsType === 'PILLAR' ? '#E2E8F0' : '#F8FAFC';
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
        const icon = obsType === 'TOILET' ? '🚽 ' : (obsType === 'PILLAR' ? '🏛️ ' : (obsType === 'PARTITION' ? '🧱 ' : '📦 '));
        ctx.fillText(icon + (obs.label || 'Wall Block'), p.x + w / 2, p.y + l / 2 + 3);
      }
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
    const rot = parseInt(bed.rotation_deg, 10) || 0;
    const isHorizontal = (rot === 90 || rot === 270);
    const spanX = isHorizontal ? (bed.length || 2.00) : (bed.width || 0.90);
    const spanY = isHorizontal ? (bed.width || 0.90) : (bed.length || 2.00);

    const p = metricToCanvas(bed.x, bed.y + spanY, t);
    const bw = spanX * t.scale;
    const bl = spanY * t.scale;

    // Bed frame
    ctx.fillStyle = '#F1F5F9';
    ctx.fillRect(p.x, p.y, bw, bl);
    ctx.strokeStyle = '#94A3B8';
    ctx.lineWidth = 2;
    ctx.strokeRect(p.x, p.y, bw, bl);

    // Bed Pillow (Headboard according to rotation)
    ctx.fillStyle = '#FFFFFF';
    ctx.strokeStyle = '#CBD5E1';
    ctx.lineWidth = 1;

    if (rot === 0) {
      // North / Top
      const pillowH = bl * 0.22;
      ctx.fillRect(p.x + 3, p.y + 3, bw - 6, pillowH);
      ctx.strokeRect(p.x + 3, p.y + 3, bw - 6, pillowH);
      // Blanket crease
      ctx.strokeStyle = '#CBD5E1';
      ctx.beginPath();
      ctx.moveTo(p.x + 4, p.y + pillowH + 6);
      ctx.lineTo(p.x + bw - 4, p.y + pillowH + 6);
      ctx.stroke();
    } else if (rot === 180) {
      // South / Bottom
      const pillowH = bl * 0.22;
      ctx.fillRect(p.x + 3, p.y + bl - 3 - pillowH, bw - 6, pillowH);
      ctx.strokeRect(p.x + 3, p.y + bl - 3 - pillowH, bw - 6, pillowH);
      // Blanket crease
      ctx.strokeStyle = '#CBD5E1';
      ctx.beginPath();
      ctx.moveTo(p.x + 4, p.y + bl - 3 - pillowH - 6);
      ctx.lineTo(p.x + bw - 4, p.y + bl - 3 - pillowH - 6);
      ctx.stroke();
    } else if (rot === 90) {
      // East / Right
      const pillowW = bw * 0.22;
      ctx.fillRect(p.x + bw - 3 - pillowW, p.y + 3, pillowW, bl - 6);
      ctx.strokeRect(p.x + bw - 3 - pillowW, p.y + 3, pillowW, bl - 6);
      // Blanket crease
      ctx.strokeStyle = '#CBD5E1';
      ctx.beginPath();
      ctx.moveTo(p.x + bw - 3 - pillowW - 6, p.y + 4);
      ctx.lineTo(p.x + bw - 3 - pillowW - 6, p.y + bl - 4);
      ctx.stroke();
    } else if (rot === 270) {
      // West / Left
      const pillowW = bw * 0.22;
      ctx.fillRect(p.x + 3, p.y + 3, pillowW, bl - 6);
      ctx.strokeRect(p.x + 3, p.y + 3, pillowW, bl - 6);
      // Blanket crease
      ctx.strokeStyle = '#CBD5E1';
      ctx.beginPath();
      ctx.moveTo(p.x + 3 + pillowW + 6, p.y + 4);
      ctx.lineTo(p.x + 3 + pillowW + 6, p.y + bl - 4);
      ctx.stroke();
    }

    if (layers.labels) {
      ctx.fillStyle = '#334155';
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(bed.bed_code || bed.bed_id, p.x + bw / 2, p.y + bl / 2 + 4);
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

      // 45cm diameter human occupant footprint (radius = 0.225m in physical space)
      const humanRadiusPx = Math.max(14, (0.45 / 2) * t.scale);

      // 2. Ripple Expanding Wave Animation (ONLY when ONLINE, disabled when OFFLINE)
      if (!isOffline) {
        const rippleR = humanRadiusPx + 4 + ((ripplePhase * 8) % 18);
        const rippleOpacity = Math.max(0, 1 - (rippleR - humanRadiusPx - 4) / 18);
        ctx.beginPath();
        ctx.arc(p.x, p.y, rippleR, 0, Math.PI * 2);
        ctx.strokeStyle = isSelected 
          ? `rgba(2, 132, 199, ${rippleOpacity})` 
          : `rgba(13, 148, 136, ${rippleOpacity})`;
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }

      // 3. Outer Selection Ring
      if (isSelected) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, humanRadiusPx + 5, 0, Math.PI * 2);
        ctx.strokeStyle = isOffline ? 'rgba(100, 116, 139, 0.80)' : '#0284C7';
        ctx.lineWidth = 3;
        ctx.setLineDash([5, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // 4. Core Human Scale Circle (~45cm true scale)
      ctx.beginPath();
      ctx.arc(p.x, p.y, humanRadiusPx, 0, Math.PI * 2);
      ctx.fillStyle = isOffline ? '#64748B' : (isSelected ? '#0284C7' : '#0D9488');
      ctx.fill();
      ctx.strokeStyle = isOffline ? '#CBD5E1' : '#FFFFFF';
      ctx.lineWidth = 2.5;
      ctx.stroke();

      // Person Icon / Avatar inside circle
      const subject = trackedSubjects.find(s => s.device_id === tagId);
      ctx.fillStyle = '#FFFFFF';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const iconSize = Math.max(12, Math.round(humanRadiusPx * 0.85));
      ctx.font = `${iconSize}px sans-serif`;
      ctx.fillText(isOffline ? '💤' : '👤', p.x, p.y);

      // 5. Floating Name Badge above Dot
      if (layers.labels) {
        const baseName = subject ? subject.full_name : tagId;
        let nameText = baseName;
        if (isOffline) {
          nameText = `${baseName} [OFFLINE]`;
        } else if (pos.motion_state === 'WALKING') {
          nameText = `🚶 ${baseName}`;
        } else if (pos.motion_state === 'HAND_MOVEMENT') {
          nameText = `👋 ${baseName}`;
        } else if (pos.motion_state === 'SETTLING') {
          nameText = `🎯 ${baseName} (Settling)`;
        } else {
          nameText = `${baseName} 🔒`;
        }

        ctx.font = 'bold 11px sans-serif';
        const textW = ctx.measureText(nameText).width;

        // Pill background positioned above the top of the human circle
        const pillX = p.x - textW / 2 - 8;
        const pillY = p.y - humanRadiusPx - 26;
        ctx.fillStyle = isOffline 
          ? 'rgba(100, 116, 139, 0.90)' 
          : (isSelected ? '#0284C7' : 'rgba(30, 41, 59, 0.85)');
        ctx.beginPath();
        ctx.roundRect(pillX, pillY, textW + 16, 18, 9);
        ctx.fill();

        // Pill text
        ctx.fillStyle = isOffline ? '#F1F5F9' : '#FFFFFF';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
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

  window.removeSelectedOfflineTag = function() {
    if (!selectedTagId) return;
    const tagToPurge = selectedTagId;
    const subject = trackedSubjects.find(s => s.device_id === tagToPurge);
    const displayName = subject ? `${subject.full_name} (${tagToPurge})` : tagToPurge;

    const executeRemoval = async () => {
      try {
        const res = await fetch(`/api/ward/ips-tag?tag_id=${encodeURIComponent(tagToPurge)}`, {
          method: 'DELETE'
        });
        const data = await res.json();
        if (data.success) {
          liveTagPositions.delete(tagToPurge);
          const remaining = Array.from(liveTagPositions.keys());
          selectedTagId = remaining.length > 0 ? remaining[0] : null;
          renderSubjectsList();
          updateTelemetryCard();
          if (window.showToast) window.showToast(`Offline beacon "${displayName}" removed from ward map.`, 'success');
        } else {
          if (window.showToast) window.showToast(`Error: ${data.error || 'Failed to remove tag'}`, 'danger');
        }
      } catch (err) {
        if (window.showToast) window.showToast(`Error: ${err.message}`, 'danger');
      }
    };

    if (typeof window.showModal === 'function') {
      window.showModal({
        title: 'Remove Offline Beacon',
        message: `Are you sure you want to remove offline beacon "${displayName}" from this ward map? This clears its last known spatial coordinates.`,
        type: 'danger',
        confirmText: 'Remove Beacon',
        cancelText: 'Keep on Map',
        onConfirm: executeRemoval
      });
    } else {
      if (confirm(`Remove offline tag "${displayName}" from ward map?`)) {
        executeRemoval();
      }
    }
  };

  // --- WebSocket Live Listener ---
  function setupWebSocketListeners() {
    if (!window.wsClient) {
      setTimeout(setupWebSocketListeners, 300);
      return;
    }

    // 1. Ghost Tag / Deleted Tag Purge event
    window.wsClient.on('IPS_TAG_PURGE', (msg) => {
      const targets = [msg.tag_id, msg.canonical_id, msg.mac].filter(Boolean);
      let changed = false;
      for (const t of targets) {
        if (liveTagPositions.has(t)) {
          liveTagPositions.delete(t);
          changed = true;
        }
      }
      if (targets.includes(selectedTagId)) {
        const remaining = Array.from(liveTagPositions.keys());
        selectedTagId = remaining.length > 0 ? remaining[0] : null;
        changed = true;
      }
      if (changed) {
        renderSubjectsList();
        updateTelemetryCard();
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
          motion_state: msg.motion_state || 'STATIONARY',
          confidence: msg.confidence,
          anchors: msg.anchors_used || [],
          lastSeen: msg.timestamp || Date.now()
        });
      } else {
        existing.targetX = msg.x;
        existing.targetY = msg.y;
        existing.status = msg.status || 'ONLINE';
        existing.motion_state = msg.motion_state || (existing.motion_state || 'STATIONARY');
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

