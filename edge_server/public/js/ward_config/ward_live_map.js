// =============================================================================
// SHIRO Central Ward Management System - Ward Live 2D IPS Map Controller
// Interactive Digital Twin Canvas, Multilateration Visualization & Live Vitals
// =============================================================================

(function() {
  let isLiveMapActive = false;
  let activeWard = null;
  let trackedSubjects = []; // [{ patient_id, full_name, device_id, mac_address, ... }]
  let selectedTagId = null;

  // Empirical Landmark Calibration State
  let isCalibrationOpen = false;
  let isCustomLandmarkSelected = false;
  let calibrationTarget = null; // { x, y, z, label }
  let calibrationCountdownInterval = null;
  let calibrationResults = null;
  let calibrationLiveCounts = {};
  let calCanvas = null;
  let calCtx = null;
  let calAnimationFrameId = null;

  // Localized Tag Positions: tagId -> { x, y, targetX, targetY, confidence, anchors: [], lastSeen }
  const liveTagPositions = new Map();
  // Live Vitals Cache: tagId -> { bpm, spo2, battery, imuFault, ppgFault, lastSeen }
  const liveVitals = new Map();
  // A wristband that has sent nothing for this long is shown as "NO SIGNAL"
  const NO_SIGNAL_AFTER_MS = 5000;
  // People the ward's LiDARs follow (WebSocket ROOM_PEOPLE): [{ key, x, y, tag_id }].
  // Those without a wristband are drawn as grey dots; older than this, not drawn.
  let roomPeople = { at: 0, people: [] };
  const ROOM_PEOPLE_FRESH_MS = 2000;
  // Who has which bed of the shown ward: bed_id -> { patient_id, full_name } (written on the bed)
  let bedOccupants = new Map();
  // The ward each wristband is heard in, from every position message of every ward:
  // tagId -> { ward, online }. The list knows where each patient is; a click opens that ward.
  const tagWard = new Map();

  let canvas = null;
  let ctx = null;
  let animationFrameId = null;
  let ripplePhase = 0;
  let clockTimer = null;
  let lastRenderTime = 0;

  // Layer Visibility
  const layers = {
    rings: false,    // technician view only (Technician details)
    labels: false,
    grid: false
  };

  /**
   * Enter Live 2D IPS Map View for a given ward
   * @param {string} wardId 
   */
  async function openWardLiveMap(wardId, targetTagId = null) {
    if (!wardId) return;

    try {
      const res = await fetch(`/api/ward/ips-init?ward_id=${encodeURIComponent(wardId)}`);
      const data = await res.json();
      if (!data.success || !data.ward) {
        if (window.showToast) window.showToast(`Could not initialize live map: ${data.error || 'Ward not found'}`, 'danger');
        return;
      }

      // Another ward: the wristbands of the one shown before are not on this map
      if (!activeWard || activeWard.ward_id !== data.ward.ward_id) {
        liveTagPositions.clear();
        hoveredTagId = null;
        const tagsBadge = document.getElementById('live-map-tags-badge');
        if (tagsBadge) tagsBadge.innerText = '● 0 wristbands';
      }
      activeWard = data.ward;
      trackedSubjects = Array.isArray(data.tracked_subjects) ? data.tracked_subjects : [];
      roomPeople = { at: 0, people: [] };
      bedOccupants = new Map((Array.isArray(data.bed_occupants) ? data.bed_occupants : []).map(o => [o.bed_id, o]));
      // Where each wristband is now, and this ward's positions at once (not after their next update)
      for (const s of trackedSubjects) {
        if (s.last_ward_id) tagWard.set(s.device_id, { ward: s.last_ward_id, online: Boolean(s.located_ward_id) });
      }
      (Array.isArray(data.positions) ? data.positions : []).forEach(applyPositionMessage);
      // The overview opens this ward next time on this computer
      try { localStorage.setItem('shiro.ward', activeWard.ward_id); } catch (e) { /* private window */ }
      fillWardPicker(activeWard.ward_id);

      // The overview is its own page (tab-ward): only its panel is shown here;
      // the Wards & layout page (tab-ward-config) keeps its own view
      const liveView = document.getElementById('ward-live-map-view');
      if (liveView) liveView.style.display = 'block';

      isLiveMapActive = true;

      // Update calibration display pills
      if (data.calibration) {
        const calA = document.getElementById('live-map-cal-a');
        const calN = document.getElementById('live-map-cal-n');
        if (calA) calA.innerText = `A = ${Number(data.calibration.A).toFixed(1)} dBm`;
        if (calN) calN.innerText = `n = ${Number(data.calibration.n).toFixed(1)}`;
      }

      // Update Top Status Bar
      const wardBadge = document.getElementById('live-map-ward-badge');
      if (wardBadge) wardBadge.innerText = `${activeWard.ward_id} (${activeWard.room_title || 'Ward'})`;

      const dimPill = document.getElementById('live-map-dimensions-pill');
      if (dimPill) dimPill.innerText = `${Number(activeWard.length_x).toFixed(1)} × ${Number(activeWard.width_y).toFixed(1)} m`;
      const titleEl = document.getElementById('live-map-canvas-title');
      if (titleEl) titleEl.innerText = activeWard.room_title ? `${activeWard.ward_id} – ${activeWard.room_title}` : activeWard.ward_id;

      const anchorsBadge = document.getElementById('live-map-anchors-badge');
      if (anchorsBadge) {
        const total = activeWard.anchors ? activeWard.anchors.length : 0;
        const onlineCount = activeWard.anchors ? activeWard.anchors.filter(a => a.status === 'ONLINE').length : 0;
        anchorsBadge.innerText = onlineCount >= 3 ? `● Sensors working (${onlineCount}/${total})` : `● Sensors: only ${onlineCount} of ${total} working`;
        anchorsBadge.className = `badge ${onlineCount >= 3 ? 'badge-live' : 'badge-warning'}`;
      }

      // Populate Tracked Subjects list on Left Panel
      renderSubjectsList();

      // Show the requested patient; else the first one whose wristband is heard in this
      // ward now; else nobody (the card stays empty). Showing never starts live vitals.
      if (targetTagId) {
        selectSubject(targetTagId, false);
      } else {
        const here = trackedSubjects.find(s => isHeardHere(s));
        selectSubject(here ? here.device_id : null, false);
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

  /** Fills the ward picker of the overview, with the shown ward chosen. */
  async function fillWardPicker(selected) {
    const sel = document.getElementById('live-map-ward-select');
    if (!sel) return;
    try {
      const res = await fetch('/api/ward/list');
      const data = await res.json();
      const wards = data && Array.isArray(data.wards) ? data.wards : [];
      sel.innerHTML = wards.map(w => `<option value="${escapeHtml(w.ward_id)}"${w.ward_id === selected ? ' selected' : ''}>${escapeHtml(w.ward_id)}${escapeHtml(w.room_title ? ' – ' + w.room_title : '')}</option>`).join('');
    } catch (e) {
      sel.innerHTML = `<option value="${escapeHtml(selected || '')}">${escapeHtml(selected || 'Ward')}</option>`;
    }
  }

  /** Stops the live map (drawing, position test). The Ward page shows it again with openWardLiveMap. */
  function closeWardLiveMap() {
    isLiveMapActive = false;
    if (window.positionTestPanel) window.positionTestPanel.close();
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
  }

  /**
   * Render active subject cards on Left Panel
   */
  // ----- Phase 11: what a nurse needs to know, in words -----
  const OFFLINE_AFTER_MS = 6000;
  const FIRST_READING_S = 15;     // the wristband's first heart rate takes about 13 s (docs/protocol.md)
  const PASSIVE_CYCLE_S = 180;    // when not live, a measurement every 3 minutes
  const RING_COLOUR = { 'st-alert': '#DC2626', 'st-warn': '#D97706', 'st-ok': '#2563EB', 'st-off': '#94A3B8' };
  let hoveredTagId = null;
  let lastListHtml = '';

  function isPosOffline(pos, now = Date.now()) {
    return !pos || pos.status === 'OFFLINE' || (now - (pos.lastSeen || 0) > OFFLINE_AFTER_MS);
  }

  function initialsOf(name) {
    return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
  }

  const agoText = (t, now) => (window.ShiroUI ? window.ShiroUI.ago(t, now) : '');

  // Beds and the door as rectangles: the same zones as the server (services/ips/zones.js)
  function bedRect(bed) {
    const rot = ((parseInt(bed.rotation_deg, 10) || 0) % 360 + 360) % 360;
    const along = rot === 90 || rot === 270;
    const width = Number(bed.width) || 0.9;
    const length = Number(bed.length) || 2.0;
    return { x: Number(bed.x) || 0, y: Number(bed.y) || 0, w: along ? length : width, l: along ? width : length };
  }

  function doorRect(ward) {
    const d = ward && ward.door;
    if (!d) return null;
    const span = (Number(d.width) || 0.9) + 0.2;
    const start = (Number(d.x) || 0) - 0.1;
    const L = Number(ward.length_x);
    const W = Number(ward.width_y);
    switch (String(d.wall || '').toUpperCase()) {
      case 'NORTH': return { x: start, y: W - 1, w: span, l: 1 };
      case 'EAST': return { x: L - 1, y: start, w: 1, l: span };
      case 'WEST': return { x: 0, y: start, w: 1, l: span };
      case 'SOUTH': return { x: start, y: 0, w: span, l: 1 };
      default: return null;
    }
  }

  const inRect = (r, x, y, m = 0) => !!r && x >= r.x - m && x <= r.x + r.w + m && y >= r.y - m && y <= r.y + r.l + m;
  const bedName = (bed) => String(bed.bed_code || bed.bed_id || 'Bed');

  /** Where a patient's wristband is heard now: { ward, online }, or null. */
  function heardWard(s) {
    return tagWard.get(s.device_id) || (s.mac_address ? tagWard.get(String(s.mac_address).toUpperCase()) : null) || null;
  }

  /** A patient's bed in words: its name in this ward ("Bed 1"), else ward and bed ID. */
  function bedLabelOf(s) {
    if (!s || !s.assigned_bed_id) return '';
    const bed = activeWard && s.assigned_ward_id === activeWard.ward_id
      ? (activeWard.beds || []).find(b => b.bed_id === s.assigned_bed_id) : null;
    if (bed) return bedName(bed);
    return [s.assigned_ward_id, s.assigned_bed_id].filter(Boolean).join(' · ');
  }

  /** The wristband is heard in the shown ward now. */
  function isHeardHere(s) {
    const h = heardWard(s);
    return Boolean(activeWard && h && h.online && h.ward === activeWard.ward_id);
  }

  /**
   * The ward a patient belongs on: where the wristband is heard now; when it is
   * not heard, the ward of their bed (null when they have none).
   */
  function wardOfSubject(s) {
    const h = heardWard(s);
    if (h && h.online && h.ward) return h.ward;
    return s.assigned_ward_id || null;
  }

  /** The alerts of a patient that nobody has answered yet. */
  function pendingAlertsFor(subject, tagId) {
    const am = window.alertManager;
    const list = am && Array.isArray(am.activeAlerts) ? am.activeAlerts : [];
    const answered = am && am.acknowledgedIncidentIds ? am.acknowledgedIncidentIds : new Set();
    return list.filter(a => (a.resolution_status || 'PENDING') === 'PENDING' && !answered.has(a.incident_id) &&
      ((subject && a.patient_id && a.patient_id === subject.patient_id) || (a.device_id && a.device_id === tagId)));
  }

  function alertWords(a) {
    if (a.incident_category === 'FALL_ACCIDENT') return 'Fall';
    if (a.incident_category === 'CRITICAL_VITALS') return 'Critical vitals';
    if (a.incident_category === 'GEOFENCE_BREACH') return a.geofence_kind === 'AT_DOOR' ? 'At the door' : 'Left the ward';
    return 'Alert';
  }

  /** Where the patient is, in words, and how the position was found. */
  function describeWhere(tagId, pos, subject, now = Date.now()) {
    const left = pendingAlertsFor(subject, tagId).find(a => a.incident_category === 'GEOFENCE_BREACH' && a.geofence_kind !== 'AT_DOOR');
    if (!pos || pos.x === undefined) return { main: left ? '🚪 Left the ward' : 'Not located yet', sub: 'No position from the wristband yet' };
    if (isPosOffline(pos, now)) {
      return { main: left ? '🚪 Left the ward' : 'Wristband not heard', sub: `Last heard ${agoText(pos.lastSeen, now)}` };
    }
    if (left) return { main: '🚪 Left the ward', sub: 'The dot is only a Bluetooth estimate now' };
    const beds = (activeWard && activeWard.beds) || [];
    const own = subject ? beds.find(b => b.bed_id === subject.assigned_bed_id || b.bed_code === subject.assigned_bed_id) : null;
    let main;
    if (pos.source === 'LIDAR' && pos.lidarHeld && pos.lidarInBed) {
      const bed = beds.find(b => inRect(bedRect(b), pos.x, pos.y, 0.5));
      main = `🛏 In bed${bed ? ` (${bedName(bed)})` : ''}`;
    } else if (inRect(doorRect(activeWard), pos.x, pos.y)) {
      main = '🚪 At the door';
    } else {
      const bed = beds.find(b => inRect(bedRect(b), pos.x, pos.y, 0.3));
      main = bed ? `By ${bedName(bed)}${own && bed === own ? ' (own bed)' : ''}` : 'In the room';
      if (pos.source === 'LIDAR' && pos.lidarHeld) main = `⏸ ${main}, not seen just now`;
    }
    const sub = pos.source === 'HEADSET' ? 'Seen by a headset'
      : pos.source === 'LIDAR' ? (pos.lidarHeld ? 'Where the LiDAR last saw them' : 'Seen by the LiDAR (about ±0.1 m)')
        : 'Estimated from Bluetooth (about ±1 m)';
    return { main, sub };
  }

  /**
   * The heart rate as a nurse should read it: a live value, measuring (with how long
   * it usually takes), no skin contact, no signal, or the last value while the
   * wristband rests between its automatic measurements.
   */
  function heartState(v, now = Date.now()) {
    if (!v.lastSeen) return { value: '--', text: 'Waiting for the wristband…', cls: '' };
    const silent = now - v.lastSeen;
    if (silent > NO_SIGNAL_AFTER_MS) {
      return { value: '--', text: `No signal for ${Math.round(silent / 1000)} s${v.lastBpmAt ? ` · last ${v.lastBpm} bpm, ${agoText(v.lastBpmAt, now)}` : ''}`, cls: 'is-warn' };
    }
    if (v.ppgFault) return { value: '--', text: 'Pulse sensor fault: check the wristband', cls: 'is-warn' };
    if (v.bpm > 0) return { value: String(v.bpm), text: v.active ? 'Live, every second' : 'Just measured', cls: '' };
    if (v.touch) {
      const s = v.touchSince ? Math.max(0, (now - v.touchSince) / 1000) : 0;
      if (s > 30) return { value: '--', text: 'Still measuring. Keep the arm still and the strap snug.', cls: 'is-measuring', progress: 1, beat: true };
      const left = Math.max(1, Math.round(FIRST_READING_S - s));
      return {
        value: '--',
        text: s < FIRST_READING_S ? `Measuring… ready in about ${left} s` : 'Measuring… almost ready',
        cls: 'is-measuring', progress: Math.min(0.95, s / FIRST_READING_S), beat: true
      };
    }
    if (v.active) return { value: '--', text: 'No skin contact: make the strap snug', cls: 'is-warn' };
    // Resting between the automatic measurements
    const next = v.burstEndAt ? Math.max(0, PASSIVE_CYCLE_S - (now - v.burstEndAt) / 1000) : null;
    const nextText = next !== null && next > 30 ? `Next reading in about ${Math.ceil(next / 60)} min` : 'Next automatic reading within 3 min';
    return {
      value: v.lastBpmAt ? String(v.lastBpm) : '--',
      text: `${nextText}${v.lastBpmAt ? ` · this value ${agoText(v.lastBpmAt, now)}` : ''}`,
      cls: '', dim: Boolean(v.lastBpmAt)
    };
  }

  /** The status colour of a patient: needs help, check, OK or off; with the reason. */
  function tileStatus(s, pos, v, now = Date.now()) {
    const alerts = pendingAlertsFor(s, s.device_id);
    if (alerts.length) return { cls: 'st-alert', flag: `${alertWords(alerts[0])}: waiting for a response` };
    const heard = v.lastSeen && now - v.lastSeen <= NO_SIGNAL_AFTER_MS;
    if (!heard && isPosOffline(pos, now)) return { cls: 'st-off', flag: pos || v.lastSeen ? 'Wristband off or out of reach' : 'Wristband not heard yet' };
    if (v.ppgFault || v.imuFault) return { cls: 'st-warn', flag: 'Sensor fault' };
    if (v.active && !v.touch && !(v.bpm > 0)) return { cls: 'st-warn', flag: 'No skin contact' };
    if (Number.isFinite(Number(v.battery)) && v.battery !== null && Number(v.battery) <= 20 && !v.charging) return { cls: 'st-warn', flag: `Battery low (${v.battery}%)` };
    return { cls: 'st-ok', flag: '' };
  }

  /** The patient tiles. Redrawn every second; the list is only replaced when it changed. */
  function renderSubjectsList() {
    const container = document.getElementById('live-map-subjects-container');
    const countBadge = document.getElementById('live-map-subject-count');
    if (!container) return;

    // In this ward (heard here now, or their bed is here and the wristband is not
    // heard elsewhere) first; the others below, with the ward they are in
    const wardId = activeWard ? activeWard.ward_id : null;
    const here = trackedSubjects.filter(s => wardOfSubject(s) === wardId);
    const elsewhere = trackedSubjects.filter(s => wardOfSubject(s) !== wardId);
    if (countBadge) countBadge.innerText = String(here.length);

    const now = Date.now();
    const tile = (s) => {
      const pos = liveTagPositions.get(s.device_id);
      const v = liveVitals.get(s.device_id) || {};
      const st = tileStatus(s, pos, v, now);
      const where = describeWhere(s.device_id, pos, s, now).main;
      const hr = heartState(v, now);
      const bed = bedLabelOf(s);
      const avatarHtml = s.photo_url
        ? `<img src="${escapeHtml(s.photo_url)}" alt=""${imgFallbackAttrs(initialsOf(s.full_name))}>`
        : escapeHtml(initialsOf(s.full_name));
      const flagHtml = st.flag ? `<span class="wo-tile-flag">${escapeHtml(st.flag)}</span>` : '';
      return `<button type="button" class="wo-tile ${escapeHtml(st.cls)}${s.device_id === selectedTagId ? ' is-selected' : ''}"${actionAttrs('selectWardPatient', [s.device_id])}>
          <span class="wo-initials">${avatarHtml}</span>
          <span class="wo-tile-main">
            <span class="wo-tile-name">${escapeHtml(s.full_name || s.device_id)}</span>
            <span class="wo-tile-where">${escapeHtml(where)}${escapeHtml(bed ? ' · ' + bed : '')}</span>
            ${flagHtml}
          </span>
          <span class="wo-tile-hr${hr.dim ? ' is-dim' : ''}"><b>${escapeHtml(hr.cls === 'is-measuring' ? '♥' : hr.value)}</b><small>${escapeHtml(hr.cls === 'is-measuring' ? 'measuring' : 'bpm')}</small></span>
        </button>`;
    };
    // A patient in another ward: one line, a click opens their ward
    const otherTile = (s) => {
      const h = heardWard(s);
      const ward = wardOfSubject(s);
      const whereText = h && h.online ? `In ${ward}` : ward ? `${ward} · wristband not heard` : 'No bed, wristband not heard';
      return `<button type="button" class="wo-tile wo-tile-other"${actionAttrs('selectWardPatient', [s.device_id])} title="${escapeHtml(ward ? `Open ${ward}` : 'Show this patient')}">
          <span class="wo-initials">${escapeHtml(initialsOf(s.full_name))}</span>
          <span class="wo-tile-main">
            <span class="wo-tile-name">${escapeHtml(s.full_name || s.device_id)}</span>
            <span class="wo-tile-where">${escapeHtml(whereText)}</span>
          </span>
          <span class="wo-tile-go" aria-hidden="true">›</span>
        </button>`;
    };

    let html = here.length
      ? here.map(tile).join('')
      : '<div class="empty-state"><strong>Nobody with a wristband in this ward.</strong>Patients with a bed here appear when they get a wristband (Patients page).</div>';
    if (elsewhere.length) {
      const otherTilesHtml = elsewhere.map(otherTile).join('');   // built from escaped parts
      html += `<div class="wo-list-divider">Other wards (${Number(elsewhere.length)})</div>${otherTilesHtml}`;
    }
    if (html !== lastListHtml) {
      container.innerHTML = html;
      lastListHtml = html;
    }

    // People the LiDAR sees without a wristband
    const note = document.getElementById('live-map-people-note');
    if (note) {
      const fresh = Date.now() - roomPeople.at <= ROOM_PEOPLE_FRESH_MS;
      const n = fresh ? roomPeople.people.filter(p => !p.tag_id).length : 0;
      note.innerText = n ? `${n} ${n === 1 ? 'person' : 'people'} without a wristband in the room (grey on the map): staff, a visitor, or a patient not yet matched.` : '';
    }
  }

  /**
   * Shows a patient in the card. userChose: someone clicked them; only then does
   * the wristband start live vitals (never just because the page opened).
   */
  function selectSubject(tagId, userChose = false) {
    selectedTagId = tagId;
    lastListHtml = '';
    renderSubjectsList();

    const subject = trackedSubjects.find(s => s.device_id === tagId);
    const nameEl = document.getElementById('live-map-patient-name');
    const subtextEl = document.getElementById('live-map-patient-subtext');
    const hwIdEl = document.getElementById('live-map-hardware-id');
    const macEl = document.getElementById('live-map-tag-mac');
    const avatarEl = document.getElementById('live-map-patient-avatar');
    // Nobody chosen: the card shows only how to choose (no empty vitals)
    const card = document.getElementById('live-map-patient-card');
    if (card) card.classList.toggle('is-empty', !tagId);

    if (!tagId) {
      if (nameEl) nameEl.innerText = 'No patient chosen';
      if (subtextEl) subtextEl.innerText = 'Click a patient in the list or on the map to see where they are and their heart rate.';
      if (avatarEl) avatarEl.innerText = '?';
      updateTelemetryCard();
      return;
    }

    if (subject) {
      if (nameEl) nameEl.innerText = subject.full_name || 'Patient';
      const bed = bedLabelOf(subject);
      const year = subject.dob ? new Date(subject.dob).getFullYear() : null;
      const age = year ? `${new Date().getFullYear() - year} years` : '';
      const sex = subject.gender ? String(subject.gender).charAt(0) + String(subject.gender).slice(1).toLowerCase() : '';
      if (subtextEl) subtextEl.innerText = [subject.patient_id, bed || 'no bed', [age, sex].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
      if (avatarEl) {
        if (subject.photo_url) {
          avatarEl.innerHTML = `<img src="${escapeHtml(subject.photo_url)}" alt=""${imgFallbackAttrs(initialsOf(subject.full_name))}>`;
        } else {
          avatarEl.innerText = initialsOf(subject.full_name);
        }
      }
    } else {
      if (nameEl) nameEl.innerText = `Wristband ${tagId}`;
      if (subtextEl) subtextEl.innerText = 'Not given to a patient';
      if (avatarEl) avatarEl.innerText = '?';
    }
    if (hwIdEl) hwIdEl.innerText = tagId;
    if (macEl) macEl.innerText = (subject && subject.mac_address) || '--';

    updateTelemetryCard();
    if (userChose) triggerActiveModeForTag(tagId, false);
  }

  /**
   * A click on a patient: shown here when they are in this ward; else the map
   * opens the ward their wristband is heard in, or, when it is not heard, the
   * ward of their bed. Live vitals start for the chosen patient.
   */
  window.selectWardPatient = async (tagId) => {
    const s = trackedSubjects.find(x => x.device_id === tagId);
    const ward = s ? wardOfSubject(s) : null;
    if (ward && activeWard && ward !== activeWard.ward_id) {
      const heard = s && heardWard(s) && heardWard(s).online;
      if (window.showToast) window.showToast(`${s.full_name} is ${heard ? 'in' : 'not heard; showing the ward of their bed,'} ${ward}.`, 'info', 3000);
      await openWardLiveMap(ward, tagId);
    }
    selectSubject(tagId, true);
  };

  window.openSelectedPatientProfile = function () {
    const s = trackedSubjects.find(x => x.device_id === selectedTagId);
    if (s && s.patient_id && typeof window.viewPatientProfileReadOnly === 'function') window.viewPatientProfileReadOnly(s.patient_id);
    else if (window.showToast) window.showToast('Choose a patient first.', 'info');
  };

  window.openSelectedPatientIncidents = function () {
    const s = trackedSubjects.find(x => x.device_id === selectedTagId);
    if (s && s.patient_id && typeof window.openIncidentHistoryModal === 'function') window.openIncidentHistoryModal(s.patient_id, s.full_name);
    else if (window.showToast) window.showToast('Choose a patient first.', 'info');
  };

  // Active mode throttle cache per tag: tagId -> timestamp
  const lastActiveTriggers = new Map();

  function triggerActiveModeForTag(tagId, force = false) {
    if (!tagId || !window.wsClient) return;

    const now = Date.now();
    const lastTime = lastActiveTriggers.get(tagId) || 0;
    if (!force && (now - lastTime < 18000)) {
      return; // Already triggered within the last 18 seconds
    }
    lastActiveTriggers.set(tagId, now);

    const subject = trackedSubjects.find(s => s.device_id === tagId);
    const targetMac = subject?.mac_address || null;

    window.wsClient.send(JSON.stringify({
      action: 'SET_ACTIVE_MODE',
      data: {
        tagId: tagId,
        targetMac: targetMac,
        duration: 120
      }
    }));

    if (force && window.showToast) {
      window.showToast(`Starting live vitals for ${subject?.full_name || tagId}…`, 'info');
    }
    console.log(`[LIVE MAP] Triggered 1 Hz active mode for ${tagId} (${targetMac || 'auto'})`);
  }

  /**
   * Update Left Panel telemetry displays from live cache
   */
  /** The card of the chosen patient: alert, where, heart rate with its state, SpO2, battery, live button. */
  function updateTelemetryCard() {
    const now = Date.now();
    const tagId = selectedTagId;
    const subject = tagId ? trackedSubjects.find(s => s.device_id === tagId) : null;
    const vitals = (tagId && liveVitals.get(tagId)) || {};
    const pos = (tagId && liveTagPositions.get(tagId)) || null;
    const setText = (id, text) => { const el = document.getElementById(id); if (el) el.innerText = text; };

    // Alert of this patient that nobody has answered yet
    const chip = document.getElementById('live-map-alert-chip');
    if (chip) {
      const alerts = tagId ? pendingAlertsFor(subject, tagId) : [];
      if (alerts.length) {
        const a = alerts[0];
        const when = a.trigger_timestamp ? new Date(a.trigger_timestamp).toLocaleTimeString() : '';
        const html = `<div class="wo-alert-chip"><span>🚨 ${escapeHtml(alertWords(a))}${escapeHtml(when ? ' at ' + when : '')}: waiting for a response</span></div>`;
        if (chip.innerHTML !== html) chip.innerHTML = html;
      } else if (chip.innerHTML) {
        chip.innerHTML = '';
      }
    }

    // Where
    const where = tagId ? describeWhere(tagId, pos, subject, now) : { main: '–', sub: '' };
    setText('live-map-where-main', where.main);
    setText('live-map-where-sub', where.sub);

    // Heart rate, with what the wristband is doing
    const hr = tagId ? heartState(vitals, now) : { value: '--', text: '–', cls: '' };
    const bpmEl = document.getElementById('live-map-val-bpm');
    if (bpmEl) {
      bpmEl.innerText = hr.value;
      bpmEl.style.color = hr.dim ? '#94A3B8' : (vitals.bpm && (vitals.bpm < 50 || vitals.bpm > 110) ? '#DC2626' : '');
    }
    const stateEl = document.getElementById('live-map-bpm-state');
    if (stateEl) {
      stateEl.className = `wo-vital-state ${hr.cls || ''}`;
      if (hr.beat) {
        const html = `<span class="wo-beat">♥</span> ${escapeHtml(hr.text)}`;
        if (stateEl.innerHTML !== html) stateEl.innerHTML = html;
      } else {
        stateEl.innerText = hr.text;
      }
    }
    const bar = document.getElementById('live-map-bpm-progress');
    const fill = document.getElementById('live-map-bpm-progress-fill');
    if (bar && fill) {
      bar.style.display = hr.progress !== undefined ? 'block' : 'none';
      if (hr.progress !== undefined) fill.style.width = `${Math.round(hr.progress * 100)}%`;
    }

    // SpO2: indicative only, comes with the heart rate
    const spo2El = document.getElementById('live-map-val-spo2');
    if (spo2El) {
      const live = vitals.spo2 > 0 && hr.value !== '--' && !hr.dim;
      spo2El.innerText = live ? String(vitals.spo2) : (hr.dim && vitals.lastSpo2 ? String(vitals.lastSpo2) : '--');
      spo2El.style.color = hr.dim ? '#94A3B8' : '';
    }
    setText('live-map-spo2-state', 'Not calibrated: for information only');

    // Battery, last message
    const bat = vitals.battery !== undefined && vitals.battery !== null ? Number(vitals.battery) : null;
    const batEl = document.getElementById('live-map-val-battery');
    if (batEl) {
      batEl.innerText = bat === null ? '--' : `${bat}%${vitals.charging ? ' ⚡ charging' : ''}`;
      batEl.style.color = bat !== null && bat <= 20 && !vitals.charging ? '#B45309' : '';
    }
    // Exact seconds for the last minute, so it never says "just now" next to "no signal for 5 s"
    const sinceS = vitals.lastSeen ? Math.round((now - vitals.lastSeen) / 1000) : null;
    setText('live-map-val-updated', sinceS === null ? '--' : sinceS < 2 ? 'now' : sinceS < 60 ? `${sinceS} s ago` : agoText(vitals.lastSeen, now));

    // Live vitals button: how long live mode still runs
    const btn = document.getElementById('live-map-btn-activate-stream');
    if (btn) {
      const left = vitals.activeUntil ? Math.round((vitals.activeUntil - now) / 1000) : 0;
      if (vitals.active && left > 0) {
        btn.innerText = `● Live: ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left`;
      } else if (vitals.active || vitals.motion === 'FALL_EMERGENCY') {
        btn.innerText = '● Live now';
      } else {
        btn.innerText = '▶ Live vitals for 2 min';
      }
      btn.disabled = !tagId;
    }

    // A wristband that stopped sending can be taken off the map
    const offlineActionEl = document.getElementById('live-map-offline-actions');
    if (offlineActionEl) offlineActionEl.style.display = tagId && pos && isPosOffline(pos, now) ? 'block' : 'none';

    // Technician details
    setText('live-map-val-coords', pos && pos.x !== undefined ? `(${pos.x.toFixed(2)} m, ${pos.y.toFixed(2)} m), ${pos.source || 'BLE'}` : '--');
    setText('live-map-val-confidence', pos ? String(pos.motion_state || '--').toLowerCase() : '--');
    setText('live-map-rate-text', vitals.lastSeen ? `last ${agoText(vitals.lastSeen, now)}` : '--');
    renderAnchorsBreakdown(pos);
  }

  function renderAnchorsBreakdown(pos) {
    const container = document.getElementById('live-map-anchors-breakdown');
    if (!container) return;

    if (!pos || !Array.isArray(pos.anchors) || pos.anchors.length === 0) {
      container.innerHTML = '<div style="color:var(--text-muted);">No wall sensor hears it right now.</div>';
      return;
    }

    container.innerHTML = pos.anchors.map(a => {
      return `
        <div style="display:flex; justify-content:space-between; align-items:center; background:#FFFFFF; border:1px solid var(--border-light); border-radius:4px; padding:4px 8px;">
          <div><strong style="color:var(--primary);">${escapeHtml(a.anchor_id)}</strong> <span style="color:var(--text-muted); font-family:monospace;">(${escapeHtml(a.device_id)})</span></div>
          <div style="font-family:monospace; color:var(--text-secondary);">${Number(a.distance).toFixed(2)}m</div>
          <div><span class="badge badge-info keep-case">${escapeHtml(a.rssi)} dBm</span></div>
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
    canvas.addEventListener('mousemove', onCanvasHover);

    // Manual 1 Hz Active Monitoring button
    const btnActiveStream = document.getElementById('live-map-btn-activate-stream');
    if (btnActiveStream) {
      btnActiveStream.onclick = () => {
        if (selectedTagId) {
          triggerActiveModeForTag(selectedTagId, true);
        } else {
          if (window.showToast) window.showToast('Please select a patient or wristband first.', 'warning');
        }
      };
    }

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

    // Position test: while "Pick on map" is on, a click sets the spot of the next run
    if (window.positionTestPanel) {
      const mx = (clickX - t.offsetX) / t.scale;
      const my = (t.cHeight - clickY - t.offsetY) / t.scale;
      if (window.positionTestPanel.onMapClick(mx, my)) return;
    }

    // If Calibration Modal is open and Custom Point is chosen, click sets calibration target
    if (isCalibrationOpen && isCustomLandmarkSelected) {
      const mx = Math.max(0.15, Math.min(activeWard.length_x - 0.15, (clickX - t.offsetX) / t.scale));
      const my = Math.max(0.15, Math.min(activeWard.width_y - 0.15, (t.cHeight - clickY - t.offsetY) / t.scale));
      calibrationTarget = {
        x: Math.round(mx * 100) / 100,
        y: Math.round(my * 100) / 100,
        z: 0.85,
        label: 'Custom Map Point'
      };
      updateCalibrationTargetDisplay();
      return;
    }

    const hitRadius = Math.max(26, ((0.45 / 2) * t.scale + 8) * dpr);

    // Hit-test active tags within scaled human circle bounds
    for (const [tagId, pos] of liveTagPositions.entries()) {
      const pt = metricToCanvas(pos.x, pos.y, t);
      const dx = clickX - pt.x;
      const dy = clickY - pt.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= hitRadius) {
        selectSubject(tagId, true);
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
    for (const pos of liveTagPositions.values()) {
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

    // 7. People the LiDAR sees who wear no wristband (grey), then the wristbands
    drawRoomPeople(ctx, t);
    drawWristbandDots(ctx, t);

    // 8. Draw Calibration Reference Reticle (when calibration modal is active)
    if (isCalibrationOpen && calibrationTarget) {
      drawCalibrationTarget(ctx, t, calibrationTarget);
    }

    // 9. Position test: the session's spots, the next spot and the error line during a run
    if (window.positionTestPanel) {
      window.positionTestPanel.draw(ctx, t, metricToCanvas);
    }
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

    // Bed names always: nurses find patients by bed. A bed given to a patient also
    // shows their name and ID (shortened to fit); a free bed says so.
    const occupant = bedOccupants.get(bed.bed_id);
    const fit = (text, maxW) => {
      let out = String(text);
      if (ctx.measureText(out).width <= maxW) return out;
      while (out.length > 1 && ctx.measureText(`${out}…`).width > maxW) out = out.slice(0, -1);
      return `${out}…`;
    };
    const cx = p.x + bw / 2;
    const cy = p.y + bl / 2;
    const maxW = Math.max(20, bw - 10);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (occupant && bl >= 44) {
      ctx.fillStyle = '#334155';
      ctx.font = '600 12px Inter, "Segoe UI", sans-serif';
      ctx.fillText(fit(bed.bed_code || bed.bed_id, maxW), cx, cy - 16);
      ctx.fillStyle = '#0F172A';
      ctx.font = '700 13px Inter, "Segoe UI", sans-serif';
      ctx.fillText(fit(occupant.full_name, maxW), cx, cy);
      ctx.fillStyle = '#475569';
      ctx.font = '600 11px Inter, "Segoe UI", sans-serif';
      ctx.fillText(fit(occupant.patient_id, maxW), cx, cy + 15);
    } else {
      ctx.fillStyle = '#334155';
      ctx.font = '600 13px Inter, "Segoe UI", sans-serif';
      ctx.fillText(fit(bed.bed_code || bed.bed_id, maxW), cx, occupant ? cy - 7 : cy);
      ctx.font = '600 11px Inter, "Segoe UI", sans-serif';
      ctx.fillStyle = occupant ? '#0F172A' : '#94A3B8';
      const state = bed.status === 'UNAVAILABLE' ? 'OUT OF USE' : bed.status === 'OCCUPIED' ? 'TAKEN' : 'FREE';
      ctx.fillText(fit(occupant ? occupant.full_name : state, maxW), cx, occupant ? cy + 8 : cy + 15);
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

    // 2. The sensor: a small square, grey-blue when on, hollow and dashed when off
    ctx.beginPath();
    ctx.rect(p.x - 5, p.y - 5, 10, 10);
    if (isOnline) {
      ctx.fillStyle = '#64748B';
      ctx.fill();
    } else {
      ctx.fillStyle = '#FFFFFF';
      ctx.fill();
      ctx.setLineDash([2, 2]);
      ctx.strokeStyle = '#94A3B8';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
    }

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

  /**
   * People the LiDAR follows who are not linked to a wristband: visitors, staff,
   * or a patient whose wristband could not be matched yet. Grey, no name.
   */
  function drawRoomPeople(ctx, t) {
    if (!roomPeople.people.length || Date.now() - roomPeople.at > ROOM_PEOPLE_FRESH_MS) return;
    const r = Math.max(10, (0.4 / 2) * t.scale);
    for (const person of roomPeople.people) {
      if (person.tag_id) continue;   // drawn as the patient's dot
      const p = metricToCanvas(person.x, person.y, t);
      ctx.save();
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(100, 116, 139, 0.45)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(71, 85, 105, 0.9)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      if (layers.labels) {
        ctx.font = '10px sans-serif';
        ctx.fillStyle = 'rgba(51, 65, 85, 0.95)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText('person (no wristband)', p.x, p.y + r + 3);
      }
      ctx.restore();
    }
  }

  /** The status class of a marker: the same as the patient's tile. */
  function markerStatus(tagId, pos, now) {
    const subject = trackedSubjects.find(s => s.device_id === tagId);
    if (subject) return tileStatus(subject, pos, liveVitals.get(tagId) || {}, now).cls;
    return isPosOffline(pos, now) ? 'st-off' : 'st-ok';
  }

  /**
   * Patients on the map (Phase 11): a white disc with the initials and a ring in
   * the status colour (red needs help, pulsing; amber check; blue OK; grey dashed
   * off), a small badge for in bed / at the door / not seen just now / headset.
   * The name only for the chosen or pointed-at patient, so names never pile up.
   */
  function drawWristbandDots(ctx, t) {
    const now = Date.now();

    // Raw MAC keys of known wristbands become their device IDs
    for (const [tagId, pos] of liveTagPositions.entries()) {
      if (tagId.includes(':')) {
        const canonical = trackedSubjects.find(s => s.mac_address && s.mac_address.toUpperCase() === tagId.toUpperCase());
        if (canonical) {
          if (!liveTagPositions.has(canonical.device_id)) liveTagPositions.set(canonical.device_id, { ...pos });
          liveTagPositions.delete(tagId);
        }
      }
    }

    const door = doorRect(activeWard);
    // The chosen patient last, on top
    const entries = [...liveTagPositions.entries()]
      .filter(([, pos]) => pos.x !== undefined && pos.y !== undefined)
      .sort((a, b) => Number(a[0] === selectedTagId) - Number(b[0] === selectedTagId));

    for (const [tagId, pos] of entries) {
      const p = metricToCanvas(pos.x, pos.y, t);
      const isSelected = tagId === selectedTagId;
      const status = markerStatus(tagId, pos, now);
      const off = status === 'st-off';
      const subject = trackedSubjects.find(s => s.device_id === tagId);
      const r = Math.max(15, 0.225 * t.scale);
      ctx.save();

      // The Bluetooth estimate: only for the chosen patient, when the LiDAR or a headset gives the position
      if (isSelected && !off && (pos.source === 'LIDAR' || pos.source === 'HEADSET') && pos.bleX !== undefined && pos.bleY !== undefined) {
        const b = metricToCanvas(pos.bleX, pos.bleY, t);
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = 'rgba(100, 116, 139, 0.5)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(b.x, b.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(b.x, b.y, r * 0.5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Needs help: a pulsing red halo
      if (status === 'st-alert') {
        const k = (Math.sin(ripplePhase * 3) + 1) / 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 6 + k * 10, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(220, 38, 38, ${(0.12 + 0.2 * (1 - k)).toFixed(3)})`;
        ctx.fill();
      }

      // Chosen: a dark outer ring
      if (isSelected) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 6, 0, Math.PI * 2);
        ctx.strokeStyle = '#0F172A';
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // The marker
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = off ? '#E2E8F0' : '#FFFFFF';
      ctx.fill();
      ctx.lineWidth = 4;
      ctx.strokeStyle = RING_COLOUR[status];
      if (off) ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = off ? '#64748B' : '#0F172A';
      ctx.font = `700 ${Math.max(12, Math.round(r * 0.72))}px Inter, "Segoe UI", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(initialsOf(subject ? subject.full_name : tagId), p.x, p.y + 1);

      // Badge: in bed, at the door, not seen just now, seen by a headset
      let badge = '';
      if (pos.source === 'LIDAR' && pos.lidarHeld) badge = pos.lidarInBed ? '🛏' : '⏸';
      else if (inRect(door, pos.x, pos.y)) badge = '🚪';
      else if (pos.source === 'HEADSET') badge = '👁';
      if (badge && !off) {
        const bx = p.x + r * 0.85;
        const by = p.y - r * 0.85;
        ctx.beginPath();
        ctx.arc(bx, by, 11, 0, Math.PI * 2);
        ctx.fillStyle = '#FFFFFF';
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = '#CBD5E1';
        ctx.stroke();
        ctx.font = '13px "Segoe UI Emoji", sans-serif';
        ctx.fillStyle = '#0F172A';
        ctx.fillText(badge, bx, by + 1);
      }

      // Name: the chosen or pointed-at patient (everyone's in technician view)
      if (isSelected || tagId === hoveredTagId || layers.labels) {
        const name = subject ? subject.full_name : `Wristband ${tagId}`;
        ctx.font = '600 13px Inter, "Segoe UI", sans-serif';
        const tw = ctx.measureText(name).width;
        const y = p.y + r + 9;
        ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
        ctx.beginPath();
        ctx.roundRect(p.x - tw / 2 - 8, y, tw + 16, 22, 11);
        ctx.fill();
        ctx.fillStyle = '#FFFFFF';
        ctx.textBaseline = 'middle';
        ctx.fillText(name, p.x, y + 11);
      }
      ctx.restore();
    }
  }

  /** The patient under the mouse: shows their name and a pointer. */
  function onCanvasHover(evt) {
    if (!canvas || !activeWard) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const x = (evt.clientX - rect.left) * dpr;
    const y = (evt.clientY - rect.top) * dpr;
    const t = getCanvasTransform(canvas.width, canvas.height, activeWard.length_x, activeWard.width_y);
    const hit = Math.max(22, (0.225 * t.scale + 8));
    let found = null;
    for (const [tagId, pos] of liveTagPositions.entries()) {
      if (pos.x === undefined) continue;
      const p = metricToCanvas(pos.x, pos.y, t);
      if (Math.hypot(x - p.x, y - p.y) <= hit) { found = tagId; break; }
    }
    hoveredTagId = found;
    canvas.style.cursor = found ? 'pointer' : 'default';
  }

  /**
   * Draw Pulsing Calibration Target Reticle & Coordinate Pill
   */
  function drawCalibrationTarget(ctx, t, target) {
    if (!target || target.x === undefined || target.y === undefined) return;
    const p = metricToCanvas(target.x, target.y, t);

    ctx.save();

    // 1. Pulsing outer animated ring
    const pulseR = 24 + Math.sin(ripplePhase * 3) * 5;
    ctx.beginPath();
    ctx.arc(p.x, p.y, pulseR, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(6, 182, 212, 0.60)';
    ctx.lineWidth = 2.5;
    ctx.setLineDash([4, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    // 2. Middle target ring
    ctx.beginPath();
    ctx.arc(p.x, p.y, 14, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(6, 182, 212, 0.18)';
    ctx.fill();
    ctx.strokeStyle = '#06B6D4';
    ctx.lineWidth = 2;
    ctx.stroke();

    // 3. Center crosshair lines
    ctx.beginPath();
    ctx.moveTo(p.x - 18, p.y);
    ctx.lineTo(p.x + 18, p.y);
    ctx.moveTo(p.x, p.y - 18);
    ctx.lineTo(p.x, p.y + 18);
    ctx.strokeStyle = '#0891B2';
    ctx.lineWidth = 1.8;
    ctx.stroke();

    // Center focal point
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#0E7490';
    ctx.fill();

    // 4. Floating label badge
    const labelText = `🎯 Calibration Reference: ${target.label || 'Target'} (${target.x.toFixed(2)}m, ${target.y.toFixed(2)}m)`;
    ctx.font = 'bold 11px system-ui, -apple-system, sans-serif';
    const textW = ctx.measureText(labelText).width;
    const badgeW = textW + 18;
    const badgeH = 22;
    const badgeX = p.x - badgeW / 2;
    const badgeY = p.y - 36;

    ctx.fillStyle = '#0F172A';
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 6);
    } else {
      ctx.rect(badgeX, badgeY, badgeW, badgeH);
    }
    ctx.fill();
    ctx.strokeStyle = '#06B6D4';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    ctx.fillStyle = '#67E8F9';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(labelText, p.x, badgeY + badgeH / 2);

    ctx.restore();
  }

  function updateClock() {
    const el = document.getElementById('live-map-clock');
    if (el) el.innerText = new Date().toLocaleTimeString();
    // Every second: "no signal", the measuring countdown and the live countdown change
    // even when no message arrives. One timer only, however often the map is opened.
    if (isLiveMapActive) {
      updateTelemetryCard();
      renderSubjectsList();
    }
    if (clockTimer) clearTimeout(clockTimer);
    clockTimer = isLiveMapActive ? setTimeout(updateClock, 1000) : null;
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

  // =========================================================================
  // EMPIRICAL ANCHOR CALIBRATION CONTROLLER
  // =========================================================================

  function getBedCenter(b) {
    const rot = parseInt(b.rotation_deg, 10) || 0;
    const isRotated = (rot === 90 || rot === 270);
    const bw = isRotated ? (parseFloat(b.length) || 2.0) : (parseFloat(b.width) || 0.9);
    const bl = isRotated ? (parseFloat(b.width) || 0.9) : (parseFloat(b.length) || 2.0);
    return {
      x: Math.round((parseFloat(b.x) + bw / 2) * 100) / 100,
      y: Math.round((parseFloat(b.y) + bl / 2) * 100) / 100
    };
  }

  window.openCalibrationModal = function() {
    if (!activeWard) {
      if (window.showToast) window.showToast('No active ward loaded.', 'warning');
      return;
    }

    const modal = document.getElementById('ward-calibration-modal');
    if (!modal) return;
    modal.style.display = 'flex';
    isCalibrationOpen = true;

    // Set ward pill and dimensions in calibration modal
    const wardPill = document.getElementById('cal-modal-ward-pill');
    if (wardPill) wardPill.innerText = activeWard.ward_id;
    const dimPill = document.getElementById('cal-preview-dimensions-pill');
    if (dimPill) dimPill.innerText = `${activeWard.length_x.toFixed(2)}m × ${activeWard.width_y.toFixed(2)}m`;

    // Reset view steps
    resetCalibrationStep();

    // Populate Landmarks Dropdown
    const lSelect = document.getElementById('cal-landmark-select');
    if (lSelect) {
      lSelect.innerHTML = '';

      // 1. Hospital Beds in this ward (Recommended)
      if (Array.isArray(activeWard.beds) && activeWard.beds.length > 0) {
        activeWard.beds.forEach(b => {
          const c = getBedCenter(b);
          const opt = document.createElement('option');
          opt.value = `bed_${b.bed_id}`;
          opt.dataset.x = c.x;
          opt.dataset.y = c.y;
          opt.dataset.z = 0.85;
          opt.dataset.label = `${b.bed_code || 'Bed'} (Mattress Center)`;
          opt.innerText = `🛏️ ${b.bed_code || 'Bed'} (${c.x}m, ${c.y}m) [Recommended]`;
          lSelect.appendChild(opt);
        });
      }

      // 2. Room Center
      const rx = Math.round((activeWard.length_x / 2) * 100) / 100;
      const ry = Math.round((activeWard.width_y / 2) * 100) / 100;
      const optCenter = document.createElement('option');
      optCenter.value = 'room_center';
      optCenter.dataset.x = rx;
      optCenter.dataset.y = ry;
      optCenter.dataset.z = 0.85;
      optCenter.dataset.label = 'Room Center';
      optCenter.innerText = `📍 Room Center (${rx}m, ${ry}m)`;
      lSelect.appendChild(optCenter);

      // 3. Custom Click on 2D Canvas
      const optCustom = document.createElement('option');
      optCustom.value = 'custom';
      optCustom.dataset.x = rx;
      optCustom.dataset.y = ry;
      optCustom.dataset.z = 0.85;
      optCustom.dataset.label = 'Custom Map Point';
      optCustom.innerText = '🎯 Custom Point (Click anywhere on 2D map)';
      lSelect.appendChild(optCustom);
    }

    // Populate Wristband Tags Dropdown
    const tSelect = document.getElementById('cal-tag-select');
    if (tSelect) {
      tSelect.innerHTML = '';
      const availableTags = new Set();
      for (const [tagId] of liveTagPositions.entries()) {
        if (!tagId.includes(':')) availableTags.add(tagId);
      }
      trackedSubjects.forEach(s => {
        if (s.device_id) availableTags.add(s.device_id);
      });
      if (availableTags.size === 0) {
        availableTags.add('TAG-001');
      }

      availableTags.forEach(tagId => {
        const opt = document.createElement('option');
        opt.value = tagId;
        const subj = trackedSubjects.find(s => s.device_id === tagId);
        opt.innerText = subj ? `⌚ ${subj.device_id} (${subj.full_name})` : `⌚ ${tagId}`;
        if (tagId === selectedTagId) opt.selected = true;
        tSelect.appendChild(opt);
      });
    }

    onCalibrationLandmarkChanged();
    initCalCanvas();
  };

  window.closeCalibrationModal = function() {
    const modal = document.getElementById('ward-calibration-modal');
    if (modal) modal.style.display = 'none';
    isCalibrationOpen = false;
    isCustomLandmarkSelected = false;
    calibrationTarget = null;
    if (calAnimationFrameId) {
      cancelAnimationFrame(calAnimationFrameId);
      calAnimationFrameId = null;
    }
    if (calibrationCountdownInterval) {
      clearInterval(calibrationCountdownInterval);
      calibrationCountdownInterval = null;
    }
  };

  window.onCalibrationLandmarkChanged = function() {
    const lSelect = document.getElementById('cal-landmark-select');
    if (!lSelect) return;
    const selectedOpt = lSelect.options[lSelect.selectedIndex];
    if (!selectedOpt) return;

    if (selectedOpt.value === 'custom') {
      isCustomLandmarkSelected = true;
      if (!calibrationTarget || calibrationTarget.label !== 'Custom Map Point') {
        const rx = Math.round((activeWard.length_x / 2) * 100) / 100;
        const ry = Math.round((activeWard.width_y / 2) * 100) / 100;
        calibrationTarget = { x: rx, y: ry, z: 0.85, label: 'Custom Map Point' };
      }
      const note = document.getElementById('cal-landmark-note');
      if (note) note.innerText = 'Click anywhere on 2D map to adjust target';
    } else {
      isCustomLandmarkSelected = false;
      calibrationTarget = {
        x: parseFloat(selectedOpt.dataset.x) || 0,
        y: parseFloat(selectedOpt.dataset.y) || 0,
        z: parseFloat(selectedOpt.dataset.z) || 0.85,
        label: selectedOpt.dataset.label || 'Landmark'
      };
      const note = document.getElementById('cal-landmark-note');
      if (note) note.innerText = selectedOpt.value.startsWith('bed_') ? 'Bed Mattress Elevation (~0.85m)' : 'Standard Elevation';
    }

    updateCalibrationTargetDisplay();
  };

  function updateCalibrationTargetDisplay() {
    if (!calibrationTarget || !activeWard) return;

    const coordsEl = document.getElementById('cal-coords-preview');
    if (coordsEl) {
      coordsEl.innerText = `X: ${calibrationTarget.x.toFixed(2)}m | Y: ${calibrationTarget.y.toFixed(2)}m | Z: ${calibrationTarget.z.toFixed(2)}m`;
    }

    const anchorCountEl = document.getElementById('cal-anchor-count');
    if (anchorCountEl) {
      anchorCountEl.innerText = activeWard.anchors ? activeWard.anchors.length : 0;
    }

    const listEl = document.getElementById('cal-anchors-preview-list');
    if (listEl && Array.isArray(activeWard.anchors)) {
      listEl.innerHTML = '';
      activeWard.anchors.forEach(a => {
        const dx = calibrationTarget.x - a.x;
        const dy = calibrationTarget.y - a.y;
        const dz = calibrationTarget.z - (a.z || 1.80);
        const dTrue = Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz) * 100) / 100;
        const curA = (a.calibrated_a !== null && a.calibrated_a !== undefined) ? Number(a.calibrated_a).toFixed(1) : '-52.0';

        const row = document.createElement('div');
        row.style.cssText = 'display: flex; justify-content: space-between; align-items: center; background: #F8FAFC; border: 1px solid var(--border-light); border-radius: 6px; padding: 7px 12px; font-size: 11px;';
        row.innerHTML = `
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="font-weight: 700; color: var(--text-primary);">${escapeHtml(a.anchor_id)}</span>
            <span class="mono" style="color: var(--text-muted); font-size: 10px;">(${escapeHtml(a.device_id || a.mac_address || 'Unassigned')})</span>
          </div>
          <div style="display: flex; align-items: center; gap: 12px;">
            <span style="color: var(--text-secondary);">True Dist: <b style="color: var(--primary);">${dTrue}m</b></span>
            <span class="badge badge-neutral keep-case">Current A: ${curA} dBm</span>
          </div>
        `;
        listEl.appendChild(row);
      });
    }
  }

  window.startCalibrationSession = async function() {
    if (!activeWard || !calibrationTarget) return;

    const tSelect = document.getElementById('cal-tag-select');
    const selectedTag = tSelect ? tSelect.value : 'TAG-001';

    // Switch step views
    document.getElementById('cal-step-setup').style.display = 'none';
    document.getElementById('cal-step-progress').style.display = 'block';
    document.getElementById('cal-step-results').style.display = 'none';

    document.getElementById('cal-btn-start').style.display = 'none';
    document.getElementById('cal-btn-cancel').disabled = true;

    // Reset sample count UI
    calibrationLiveCounts = {};
    const countsContainer = document.getElementById('cal-live-sample-counts');
    if (countsContainer && Array.isArray(activeWard.anchors)) {
      countsContainer.innerHTML = '';
      activeWard.anchors.forEach(a => {
        calibrationLiveCounts[a.anchor_id] = 0;
        const b = document.createElement('div');
        b.id = `cal-count-${a.anchor_id}`;
        b.className = 'card';
        b.style.cssText = 'padding: 8px 14px; min-width: 110px; border: 1px solid var(--border); border-radius: 8px; text-align: center;';
        b.innerHTML = `
          <div style="font-size: 11px; font-weight: 700; color: var(--text-secondary);">${escapeHtml(a.anchor_id)}</div>
          <div class="mono" style="font-size: 16px; font-weight: 700; color: var(--primary); margin-top: 2px;" id="cal-count-num-${escapeHtml(a.anchor_id)}">0 pkts</div>
        `;
        countsContainer.appendChild(b);
      });
    }

    const durationSec = 10;
    let remainingMs = durationSec * 1000;
    const progressBar = document.getElementById('cal-progress-bar');
    const countdownText = document.getElementById('cal-countdown-text');

    // Call server to start calibration window
    try {
      const res = await fetch('/api/ward/calibration/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ward_id: activeWard.ward_id,
          tag_id: selectedTag,
          target_x: calibrationTarget.x,
          target_y: calibrationTarget.y,
          target_z: calibrationTarget.z,
          duration_sec: durationSec
        })
      });
      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || 'Failed to start calibration session');
      }
    } catch (err) {
      if (window.showToast) window.showToast(`Calibration error: ${err.message}`, 'danger');
      resetCalibrationStep();
      return;
    }

    // Run 100ms countdown timer
    calibrationCountdownInterval = setInterval(() => {
      remainingMs -= 100;
      if (remainingMs <= 0) {
        remainingMs = 0;
        clearInterval(calibrationCountdownInterval);
        calibrationCountdownInterval = null;
        if (progressBar) progressBar.style.width = '100%';
        if (countdownText) countdownText.innerText = '0.0s - Computing results...';
        setTimeout(fetchCalibrationResults, 600);
      } else {
        const pct = Math.min(100, Math.round(((durationSec * 1000 - remainingMs) / (durationSec * 1000)) * 100));
        if (progressBar) progressBar.style.width = `${pct}%`;
        if (countdownText) countdownText.innerText = `${(remainingMs / 1000).toFixed(1)}s remaining`;
      }
    }, 100);
  };

  async function fetchCalibrationResults() {
    try {
      const res = await fetch('/api/ward/calibration/status');
      const data = await res.json();
      if (!data.success || !Array.isArray(data.results)) {
        throw new Error(data.error || 'Could not retrieve calibration results');
      }
      showCalibrationResults(data.results);
    } catch (err) {
      if (window.showToast) window.showToast(`Error retrieving results: ${err.message}`, 'danger');
      resetCalibrationStep();
    }
  }

  function showCalibrationResults(results) {
    calibrationResults = results;
    document.getElementById('cal-step-setup').style.display = 'none';
    document.getElementById('cal-step-progress').style.display = 'none';
    document.getElementById('cal-step-results').style.display = 'block';

    document.getElementById('cal-btn-cancel').disabled = false;
    document.getElementById('cal-btn-start').style.display = 'none';
    document.getElementById('cal-btn-restart').style.display = 'inline-flex';
    document.getElementById('cal-btn-apply').style.display = 'inline-flex';

    const tbody = document.getElementById('cal-results-table-body');
    if (tbody) {
      tbody.innerHTML = '';
      results.forEach(r => {
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid var(--border-light)';
        const deltaSign = r.delta_a > 0 ? `+${r.delta_a}` : `${r.delta_a}`;
        const deltaColor = r.delta_a === 0 ? 'var(--text-muted)' : (Math.abs(r.delta_a) <= 3.0 ? '#16A34A' : '#2563EB');

        tr.innerHTML = `
          <td style="padding: 10px 14px;">
            <b style="color: var(--text-primary);">${escapeHtml(r.anchor_id)}</b>
            <div style="font-size: 10px; color: var(--text-muted); font-family: monospace;">${escapeHtml(r.device_id || r.mac_address || '')}</div>
          </td>
          <td style="padding: 10px 12px;" class="mono">${escapeHtml(r.d_true)}m</td>
          <td style="padding: 10px 12px;">
            ${r.median_rssi !== null ? `<span class="mono">${escapeHtml(r.median_rssi)} dBm</span> <span style="font-size: 10px; color: var(--text-muted);">(${escapeHtml(r.samples_count)} pkts)</span>` : '<span style="color: #DC2626; font-weight: 700;">0 pkts (N/A)</span>'}
          </td>
          <td style="padding: 10px 12px;" class="mono">${Number(r.current_a).toFixed(1)} dBm</td>
          <td style="padding: 10px 12px;">
            <b class="mono" style="color: var(--primary); font-size: 13px;">${Number(r.new_a).toFixed(1)} dBm</b>
          </td>
          <td style="padding: 10px 14px;">
            <span class="badge" style="background: #F1F5F9; color: ${deltaColor}; font-weight: 700; font-family: monospace;">
              ${escapeHtml(deltaSign)} dBm
            </span>
          </td>
        `;
        tbody.appendChild(tr);
      });
    }
  }

  window.applyCalibrationResults = async function() {
    if (!activeWard || !Array.isArray(calibrationResults)) return;

    const btnApply = document.getElementById('cal-btn-apply');
    if (btnApply) {
      btnApply.disabled = true;
      btnApply.innerText = 'Saving...';
    }

    try {
      const payload = {
        ward_id: activeWard.ward_id,
        calibrations: calibrationResults.map(r => ({
          anchor_id: r.anchor_id,
          device_id: r.device_id,
          A: r.new_a,
          n: r.n || 3.2
        }))
      };

      const res = await fetch('/api/ward/calibration/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || 'Failed to apply calibration');
      }

      // Update in-memory activeWard anchors
      calibrationResults.forEach(r => {
        const found = activeWard.anchors.find(a => a.anchor_id === r.anchor_id);
        if (found) {
          found.calibrated_a = r.new_a;
          found.calibrated_n = r.n || 3.2;
        }
      });

      if (window.showToast) {
        window.showToast('✅ Anchor calibrations successfully saved to database and applied!', 'success', 3500);
      }

      closeCalibrationModal();
    } catch (err) {
      if (window.showToast) window.showToast(`Failed to apply calibrations: ${err.message}`, 'danger');
      if (btnApply) {
        btnApply.disabled = false;
        btnApply.innerHTML = '<span>✅</span> Accept &amp; Save to Ward';
      }
    }
  };

  window.resetCalibrationStep = function() {
    if (calibrationCountdownInterval) {
      clearInterval(calibrationCountdownInterval);
      calibrationCountdownInterval = null;
    }
    const stepSetup = document.getElementById('cal-step-setup');
    const stepProg = document.getElementById('cal-step-progress');
    const stepRes = document.getElementById('cal-step-results');
    if (stepSetup) stepSetup.style.display = 'block';
    if (stepProg) stepProg.style.display = 'none';
    if (stepRes) stepRes.style.display = 'none';

    const btnStart = document.getElementById('cal-btn-start');
    const btnRestart = document.getElementById('cal-btn-restart');
    const btnApply = document.getElementById('cal-btn-apply');
    const btnCancel = document.getElementById('cal-btn-cancel');

    if (btnStart) btnStart.style.display = 'inline-flex';
    if (btnRestart) btnRestart.style.display = 'none';
    if (btnApply) {
      btnApply.style.display = 'none';
      btnApply.disabled = false;
      btnApply.innerHTML = '<span>✅</span> Accept &amp; Save to Ward';
    }
    if (btnCancel) btnCancel.disabled = false;

    calibrationResults = null;
    onCalibrationLandmarkChanged();
  };

  // --- Dedicated Calibration Reference Map Preview ---
  function initCalCanvas() {
    calCanvas = document.getElementById('cal-preview-canvas');
    if (!calCanvas) return;
    calCtx = calCanvas.getContext('2d');

    calCanvas.removeEventListener('click', onCalCanvasClick);
    calCanvas.addEventListener('click', onCalCanvasClick);

    // Initial resize after modal flex layout renders
    setTimeout(() => {
      resizeCalCanvas();
      drawCalPreviewMap();
    }, 60);

    if (!calAnimationFrameId) {
      calAnimationFrameId = requestAnimationFrame(calRenderLoop);
    }
  }

  function resizeCalCanvas() {
    if (!calCanvas) return;
    const parent = calCanvas.parentElement;
    if (parent) {
      const rect = parent.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const targetW = Math.max(100, Math.floor(rect.width * dpr));
      const targetH = Math.max(100, Math.floor(rect.height * dpr));
      if (calCanvas.width !== targetW || calCanvas.height !== targetH) {
        calCanvas.width = targetW;
        calCanvas.height = targetH;
      }
    }
  }

  function calRenderLoop() {
    if (!isCalibrationOpen) {
      calAnimationFrameId = null;
      return;
    }
    resizeCalCanvas();
    drawCalPreviewMap();
    calAnimationFrameId = requestAnimationFrame(calRenderLoop);
  }

  function drawCalPreviewMap() {
    if (!calCtx || !calCanvas || !activeWard) return;
    const w = calCanvas.width;
    const h = calCanvas.height;
    calCtx.clearRect(0, 0, w, h);

    const t = getCanvasTransform(w, h, activeWard.length_x, activeWard.width_y);

    // 1. Grid
    drawMetricGrid(calCtx, t);

    // 2. Room Walls
    drawRoomPerimeter(calCtx, t, activeWard);

    // 3. Obstacles
    if (Array.isArray(activeWard.obstacles)) {
      activeWard.obstacles.forEach(obs => drawObstacle(calCtx, t, obs));
    }

    // 4. Door
    if (activeWard.door) {
      drawDoor(calCtx, t, activeWard);
    }

    // 5. Beds (pure layout, with bed labels and rotation)
    if (Array.isArray(activeWard.beds)) {
      activeWard.beds.forEach(bed => drawBed(calCtx, t, bed));
    }

    // 6. Target Reticle (Pulsing Cyan Crosshair + Label)
    if (calibrationTarget) {
      drawCalibrationTarget(calCtx, t, calibrationTarget);
    }
  }

  function onCalCanvasClick(evt) {
    if (!calCanvas || !activeWard) return;

    const rect = calCanvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const clickX = (evt.clientX - rect.left) * dpr;
    const clickY = (evt.clientY - rect.top) * dpr;

    const t = getCanvasTransform(calCanvas.width, calCanvas.height, activeWard.length_x, activeWard.width_y);
    const mx = Math.max(0.15, Math.min(activeWard.length_x - 0.15, (clickX - t.offsetX) / t.scale));
    const my = Math.max(0.15, Math.min(activeWard.width_y - 0.15, (t.cHeight - clickY - t.offsetY) / t.scale));

    // Check if clicked inside any hospital bed
    let clickedBed = null;
    if (Array.isArray(activeWard.beds)) {
      for (const b of activeWard.beds) {
        const rot = parseInt(b.rotation_deg, 10) || 0;
        const isRotated = (rot === 90 || rot === 270);
        const bw = isRotated ? (parseFloat(b.length) || 2.0) : (parseFloat(b.width) || 0.9);
        const bl = isRotated ? (parseFloat(b.width) || 0.9) : (parseFloat(b.length) || 2.0);
        const bx = parseFloat(b.x);
        const by = parseFloat(b.y);

        if (mx >= bx && mx <= bx + bw && my >= by && my <= by + bl) {
          clickedBed = b;
          break;
        }
      }
    }

    const lSelect = document.getElementById('cal-landmark-select');
    if (clickedBed && lSelect) {
      // Auto select bed in dropdown
      const optVal = `bed_${clickedBed.bed_id}`;
      for (let i = 0; i < lSelect.options.length; i++) {
        if (lSelect.options[i].value === optVal) {
          lSelect.selectedIndex = i;
          break;
        }
      }
      onCalibrationLandmarkChanged();
      if (window.showToast) window.showToast(`Selected ${clickedBed.bed_code || 'Bed'}`, 'info', 1000);
    } else {
      // Custom point anywhere on floor
      if (lSelect) {
        for (let i = 0; i < lSelect.options.length; i++) {
          if (lSelect.options[i].value === 'custom') {
            lSelect.selectedIndex = i;
            break;
          }
        }
      }
      isCustomLandmarkSelected = true;
      calibrationTarget = {
        x: Math.round(mx * 100) / 100,
        y: Math.round(my * 100) / 100,
        z: 0.85,
        label: 'Custom Map Point'
      };
      const note = document.getElementById('cal-landmark-note');
      if (note) note.innerText = 'Custom Point Elevation (~0.85m)';
      updateCalibrationTargetDisplay();
    }
  }

  window.resetAnchorCalibrationToDefault = async function() {
    if (!activeWard) return;

    const executeReset = async () => {
      try {
        const res = await fetch('/api/ward/calibration/reset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ward_id: activeWard.ward_id })
        });
        const data = await res.json();
        if (data.success) {
          // Clear calibrated_a and calibrated_n on activeWard anchors
          if (Array.isArray(activeWard.anchors)) {
            activeWard.anchors.forEach(a => {
              a.calibrated_a = null;
              a.calibrated_n = null;
            });
          }

          // Update Card 4 text on main screen
          const calA = document.getElementById('live-map-cal-a');
          const calN = document.getElementById('live-map-cal-n');
          if (calA) calA.innerText = 'A = -52.0 dBm';
          if (calN) calN.innerText = 'n = 3.2';

          // Update modal display if open
          updateCalibrationTargetDisplay();

          if (window.showToast) {
            window.showToast('✅ Ward anchors reset to default factory baseline (-52.0 dBm, n=3.2)', 'success', 3500);
          }
        } else {
          if (window.showToast) window.showToast(`Error: ${data.error || 'Failed to reset calibrations'}`, 'danger');
        }
      } catch (err) {
        if (window.showToast) window.showToast(`Error: ${err.message}`, 'danger');
      }
    };

    if (typeof window.showModal === 'function') {
      window.showModal({
        title: 'Reset Anchor Calibration',
        message: `Are you sure you want to reset all anchors in ${activeWard.ward_id} back to default factory baseline (A = -52.0 dBm, n = 3.2)? This removes all empirical offsets.`,
        type: 'warning',
        confirmText: 'Reset to Defaults',
        cancelText: 'Cancel',
        onConfirm: executeReset
      });
    } else {
      if (confirm(`Reset all anchors in ${activeWard.ward_id} back to default factory baseline (-52.0 dBm, n=3.2)?`)) {
        executeReset();
      }
    }
  };

  /**
   * A position message (IPS_POSITION_UPDATE, also those ips-init sends when the map
   * opens). Every ward's message tells where that wristband is; only the shown
   * ward's moves a dot. A wristband now heard in another ward leaves this map.
   */
  function applyPositionMessage(msg) {
    if (!msg || !activeWard) return;
    const tagId = msg.tag_id;
    if (!tagId) return;
    if (msg.ward_id) tagWard.set(tagId, { ward: msg.ward_id, online: msg.status !== 'OFFLINE' });
    if (msg.ward_id !== activeWard.ward_id) {
      // Heard in another ward now (walked out, or another ward's sensors hear them better)
      if (liveTagPositions.delete(tagId) || (msg.tag_mac && liveTagPositions.delete(msg.tag_mac))) {
        if (hoveredTagId === tagId) hoveredTagId = null;
      }
      renderSubjectsList();
      if (tagId === selectedTagId) updateTelemetryCard();
      return;
    }

    // Purge ghost MAC key if tag_mac is provided and differs from tagId
    if (msg.tag_mac && msg.tag_mac !== tagId && liveTagPositions.has(msg.tag_mac)) {
      liveTagPositions.delete(msg.tag_mac);
    }

    // Where the patient is: seen by a headset (source HEADSET: its depth sensor, about as
    // accurate as the room alignment), by the LiDAR (source LIDAR: about 0.1 m; held when
    // it lost them, for example lying in bed) or the Bluetooth estimate (often 1-3 m off).
    // The Bluetooth position is kept as well, to show how far off it is.
    const seen = {
      source: msg.source === 'HEADSET' || msg.source === 'LIDAR' ? msg.source : 'BLE',
      seenBy: msg.seen_by || null,
      seenManual: !!msg.seen_manual,
      lidarHeld: !!msg.lidar_held,
      lidarInBed: !!msg.lidar_in_bed,
      bleX: msg.has_ble ? msg.ble_x : undefined,
      bleY: msg.has_ble ? msg.ble_y : undefined
    };
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
        lastSeen: msg.timestamp || Date.now(),
        ...seen
      });
    } else {
      existing.targetX = msg.x;
      existing.targetY = msg.y;
      existing.status = msg.status || 'ONLINE';
      existing.motion_state = msg.motion_state || (existing.motion_state || 'STATIONARY');
      existing.confidence = msg.confidence;
      // Updates from a headset carry no anchors: keep the ones last heard
      if (Array.isArray(msg.anchors_used)) existing.anchors = msg.anchors_used;
      existing.lastSeen = msg.timestamp || Date.now();
      Object.assign(existing, seen);
    }

    const tagsBadge = document.getElementById('live-map-tags-badge');
    if (tagsBadge) {
      const onlineCount = Array.from(liveTagPositions.values()).filter(p => p.status !== 'OFFLINE').length;
      tagsBadge.innerText = `● ${onlineCount} of ${liveTagPositions.size} wristband${liveTagPositions.size === 1 ? '' : 's'} online`;
    }

    renderSubjectsList();

    if (tagId === selectedTagId) {
      updateTelemetryCard();
    }
  }

  // --- WebSocket Live Listener ---
  function setupWebSocketListeners() {
    if (!window.wsClient) {
      setTimeout(setupWebSocketListeners, 300);
      return;
    }

    // 0. 1 Hz activation: which anchor carries it, or why it was refused
    window.wsClient.on('ACTIVE_MODE_ENGAGED', (msg) => {
      if (window.showToast && msg.tag_id === selectedTagId) {
        window.showToast(`Live vitals for ${Math.round((Number(msg.duration) || 120) / 60)} minutes asked for (through ${msg.via_anchor || msg.anchor_mac}).`, 'success');
      }
      // How long live mode runs: the button counts down
      if (msg.tag_id) {
        const v = liveVitals.get(msg.tag_id) || {};
        v.activeUntil = Date.now() + (Number(msg.duration) || 120) * 1000;
        liveVitals.set(msg.tag_id, v);
      }
    });
    window.wsClient.on('ERROR', (msg) => {
      if (msg.action !== 'SET_ACTIVE_MODE') return;
      // Refused: allow the next selection to try again at once
      lastActiveTriggers.clear();
      if (window.showToast) window.showToast(`Live vitals not started: ${msg.error}`, 'warning');
    });

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
      targets.forEach(t => tagWard.delete(t));
      if (targets.includes(selectedTagId)) {
        // The removed wristband was shown: the card goes back to empty
        selectSubject(null, false);
        changed = true;
      }
      if (changed) {
        renderSubjectsList();
        updateTelemetryCard();
      }
    });

    // 2. Position update (every ward's): see applyPositionMessage
    window.wsClient.on('IPS_POSITION_UPDATE', (msg) => {
      if (!isLiveMapActive || !activeWard) return;
      applyPositionMessage(msg);
    });
    // 2b. The people the ward's LiDARs follow, with the wristband each is linked to
    window.wsClient.on('ROOM_PEOPLE', (msg) => {
      if (!isLiveMapActive || !activeWard || msg.ward_id !== activeWard.ward_id) return;
      roomPeople = { at: Date.now(), people: Array.isArray(msg.people) ? msg.people : [] };
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
      if (data.charging !== undefined) {
        current.charging = (data.charging === true || data.charging === 'true');
      }
      if (data.active !== undefined) {
        current.active = (data.active === true || data.active === 'true');
      }
      if (data.motion !== undefined) {
        current.motion = data.motion;
      }
      current.imuFault = data.imu_fault === true;
      current.ppgFault = data.ppg_fault === true;
      // Skin contact: when it began (measuring) and when it ended (the sensor rests)
      if (data.touch !== undefined) {
        const touch = data.touch === 1 || data.touch === true || data.touch === '1';
        if (touch && !current.touch) current.touchSince = Date.now();
        if (!touch && current.touch) current.burstEndAt = Date.now();
        current.touch = touch;
      }
      if (Number(data.bpm) > 0) { current.lastBpm = Number(data.bpm); current.lastBpmAt = Date.now(); }
      if (Number(data.spo2) > 0) { current.lastSpo2 = Number(data.spo2); }
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
        anchorsBadge.innerText = onlineCount >= 3 ? `● Sensors working (${onlineCount}/${total})` : `● Sensors: only ${onlineCount} of ${total} working`;
        anchorsBadge.className = `badge ${onlineCount >= 3 ? 'badge-live' : 'badge-warning'}`;
      }
    });

    // 4. Real-Time Calibration Packet Progress Pulse
    window.wsClient.on('CALIBRATION_PROGRESS', (msg) => {
      if (!isCalibrationOpen) return;
      if (msg.counts) {
        for (const [aId, count] of Object.entries(msg.counts)) {
          const el = document.getElementById(`cal-count-num-${aId}`);
          if (el) el.innerText = `${count} pkts`;
        }
      }
    });

    // 5. Calibration synchronization across clients
    window.wsClient.on('ANCHOR_CALIBRATION_APPLIED', (msg) => {
      if (activeWard && msg.ward_id === activeWard.ward_id && Array.isArray(msg.calibrations)) {
        msg.calibrations.forEach(c => {
          const a = activeWard.anchors?.find(x => x.anchor_id === c.anchor_id);
          if (a) {
            a.calibrated_a = c.A;
            a.calibrated_n = c.n;
          }
        });
        if (window.showToast && !isCalibrationOpen) {
          window.showToast(`Ward anchors calibrated (${msg.timestamp})`, 'info', 2000);
        }
      }
    });

    // 6. Anchor calibration reset event
    window.wsClient.on('ANCHOR_CALIBRATION_RESET', (msg) => {
      if (activeWard && msg.ward_id === activeWard.ward_id) {
        if (Array.isArray(activeWard.anchors)) {
          activeWard.anchors.forEach(a => {
            a.calibrated_a = null;
            a.calibrated_n = null;
          });
        }
        const calA = document.getElementById('live-map-cal-a');
        const calN = document.getElementById('live-map-cal-n');
        if (calA) calA.innerText = 'A = -52.0 dBm';
        if (calN) calN.innerText = 'n = 3.2';
        updateCalibrationTargetDisplay();
      }
    });
  }

  // Auto setup on load
  document.addEventListener('DOMContentLoaded', setupWebSocketListeners);

  // Global exposure
  window.openWardLiveMap = openWardLiveMap;
  window.isLiveMapOpen = () => isLiveMapActive;
  window.resizeLiveMap = () => { if (typeof resizeCanvas === 'function') resizeCanvas(); };
  window.closeWardLiveMap = closeWardLiveMap;

  // Read-only view of the live map for the position test panel (position_test_panel.js)
  window.liveMapState = {
    ward: () => activeWard,
    tags: () => [...liveTagPositions.keys()],
    tagPosition: (tagId) => liveTagPositions.get(tagId) || null,
    selectedTag: () => selectedTagId
  };
  window.openCalibrationModal = openCalibrationModal;
  window.closeCalibrationModal = closeCalibrationModal;
  window.onCalibrationLandmarkChanged = onCalibrationLandmarkChanged;
  window.startCalibrationSession = startCalibrationSession;
  window.resetCalibrationStep = resetCalibrationStep;
  window.applyCalibrationResults = applyCalibrationResults;
  window.resetAnchorCalibrationToDefault = resetAnchorCalibrationToDefault;
})();

