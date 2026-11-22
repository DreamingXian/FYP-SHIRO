// =============================================================================
// SHIRO Hospital Web Dashboard - Emergency Incident & Clinical Alert Manager
// Module: Real-time Audio/Visual Pop-up Modal, Acknowledgment & Test Simulation
// Documentation: Chapter 4 (Section 4.2.2, Table 4.13)
// =============================================================================

/** The words for an incident's type: a geofence alert says which kind it is. */
function incidentTypeText(incident) {
  if (incident.incident_category === 'GEOFENCE_BREACH') {
    if (incident.geofence_kind === 'AT_DOOR') return 'AT THE DOOR';
    if (incident.geofence_kind === 'LEFT_WARD') return 'LEFT THE WARD';
    return 'GEOFENCE';
  }
  return String(incident.incident_category || 'INCIDENT').replace('_', ' ');
}

class EmergencyAlertManager {
  constructor() {
    this.activeAlerts = [];
    this.acknowledgedIncidentIds = new Set();
    this.audioContext = null;
    this.alarmInterval = null;
    this.isMuted = false;
    this.currentModalIncident = null;
    // Incidents this screen is acknowledging right now (request sent, answer not back yet)
    this.ownAcknowledgements = new Set();
  }

  /**
   * Someone else acknowledged an incident. If it is open here, the pop-up stays
   * and says by whom and when; the alarm stops. Otherwise a note is shown.
   */
  onAcknowledgedElsewhere(incidentId, by, when) {
    const wasActive = this.activeAlerts.some(a => a.incident_id === incidentId);
    this.acknowledgedIncidentIds.add(incidentId);
    this.activeAlerts = this.activeAlerts.filter(a => a.incident_id !== incidentId);
    this.updateBannerState();

    const backdrop = document.getElementById('emergency-modal-backdrop');
    const isOpenHere = backdrop && backdrop.style.display !== 'none'
      && this.currentModalIncident && this.currentModalIncident.incident_id === incidentId;
    if (isOpenHere) {
      this.showAcknowledgedState(by, when);
    } else if (wasActive && typeof showToast === 'function') {
      showToast(`Incident ${incidentId} was acknowledged by ${by || 'a clinician who was not recorded'}.`, 'info');
    }
  }

  /** Turns the open pop-up into "acknowledged by …"; it closes with "OK, close". */
  showAcknowledgedState(by, when) {
    this.stopAudioAlarm();
    let timeText = '';
    if (when) {
      const d = new Date(when);
      timeText = isNaN(d.getTime()) ? String(when) : d.toLocaleTimeString();
    }
    const box = document.getElementById('emergency-modal-box');
    if (box) {
      box.style.borderColor = '#059669';
      box.style.boxShadow = '0 25px 60px -15px rgba(5, 150, 105, 0.35)';
    }
    document.getElementById('em-ack-detail').innerText =
      `Acknowledged by ${by || 'a clinician who was not recorded'}${timeText ? ` at ${timeText}` : ''}. ` +
      'This incident needs no further action from this screen.';
    document.getElementById('em-ack-status').style.display = 'block';
    document.getElementById('em-btn-ack').style.display = 'none';
    document.getElementById('em-btn-close').style.display = 'inline-block';
  }

  /** Back to the normal "respond" pop-up for a pending incident. */
  resetModalState() {
    const box = document.getElementById('emergency-modal-box');
    if (box) {
      box.style.borderColor = '#DC2626';
      box.style.boxShadow = '0 25px 60px -15px rgba(220, 38, 38, 0.5), 0 0 30px rgba(220, 38, 38, 0.3)';
    }
    document.getElementById('em-ack-status').style.display = 'none';
    document.getElementById('em-btn-ack').style.display = 'inline-block';
    document.getElementById('em-btn-close').style.display = 'none';
  }

  /** After a pop-up is closed, the next incident still waiting is shown. */
  showNextPending() {
    if (this.activeAlerts.length > 0) {
      this.showEmergencyModal(this.activeAlerts[0]);
      this.playAudioAlarm();
    }
  }

  init() {
    this.createDomElements();
    this.setupWebSocketListeners();
    this.fetchActiveAlerts();
  }

  createDomElements() {
    // 1. Persistent Top Warning Banner (Shown whenever an emergency is pending)
    if (!document.getElementById('global-emergency-banner')) {
      const banner = document.createElement('div');
      banner.id = 'global-emergency-banner';
      banner.style.cssText = `
        display: none;
        position: sticky;
        top: 64px;
        width: 100%;
        background: linear-gradient(90deg, #DC2626, #B91C1C);
        color: #FFFFFF;
        padding: 10px 24px;
        font-size: 13px;
        font-weight: 700;
        letter-spacing: 0.3px;
        box-shadow: 0 4px 14px rgba(220, 38, 38, 0.4);
        z-index: 98;
        cursor: pointer;
        box-sizing: border-box;
        animation: pulseBanner 1.5s infinite;
      `;
      banner.innerHTML = `
        <div style="max-width: 1400px; margin: 0 auto; display: flex; justify-content: space-between; align-items: center;">
          <div style="display: flex; align-items: center; gap: 12px;">
            <span style="font-size: 20px;">🚨</span>
            <span id="emergency-banner-text">CRITICAL CLINICAL ALERT: Active incident requires immediate response!</span>
          </div>
          <div style="display: flex; gap: 10px; align-items: center;">
            <span class="badge" style="background: rgba(255,255,255,0.25); color: #fff; font-size: 11px;">CLICK TO INSPECT</span>
          </div>
        </div>
      `;
      banner.addEventListener('click', () => {
        if (this.activeAlerts.length > 0) {
          this.showEmergencyModal(this.activeAlerts[0]);
        }
      });
      const globalHeader = document.querySelector('header.global-header');
      if (globalHeader && globalHeader.nextSibling) {
        globalHeader.parentNode.insertBefore(banner, globalHeader.nextSibling);
      } else {
        document.body.insertBefore(banner, document.body.firstChild);
      }
    }

    // 2. High-Priority Emergency Pop-up Modal Backdrop & Box
    if (!document.getElementById('emergency-modal-backdrop')) {
      const modalBackdrop = document.createElement('div');
      modalBackdrop.id = 'emergency-modal-backdrop';
      modalBackdrop.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        background: rgba(15, 23, 42, 0.75);
        backdrop-filter: blur(6px);
        z-index: 999999;
        display: none;
        align-items: center;
        justify-content: center;
        padding: 20px;
        box-sizing: border-box;
      `;

      modalBackdrop.innerHTML = `
        <div id="emergency-modal-box" style="
          background: #FFFFFF;
          border-radius: 20px;
          border: 3px solid #DC2626;
          box-shadow: 0 25px 60px -15px rgba(220, 38, 38, 0.5), 0 0 30px rgba(220, 38, 38, 0.3);
          width: 100%;
          max-width: 680px;
          padding: 28px 32px;
          position: relative;
          box-sizing: border-box;
          animation: modalPopIn 0.25s cubic-bezier(0.16, 1, 0.3, 1);
        ">
          <!-- Flashing Siren Header -->
          <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 2px solid #FEE2E2; padding-bottom: 16px; margin-bottom: 20px;">
            <div style="display: flex; align-items: center; gap: 14px;">
              <div style="
                width: 46px; 
                height: 46px; 
                background: #FEE2E2; 
                border-radius: 12px; 
                display: flex; 
                align-items: center; 
                justify-content: center; 
                font-size: 24px;
                border: 2px solid #FCA5A5;
              " id="em-modal-icon">🚨</div>
              <div>
                <div style="font-size: 20px; font-weight: 800; color: #DC2626; letter-spacing: -0.3px;" id="em-modal-category">
                  CRITICAL FALL DETECTED
                </div>
                <div style="font-size: 13px; color: #64748B; font-weight: 600;" id="em-modal-id">
                  Incident ID: --
                </div>
              </div>
            </div>
            <button id="em-btn-mute" class="btn btn-outline btn-sm" style="font-size: 12px; border-color: #CBD5E1; color: #475569;" title="Mute Alarm Sound">
              🔕 Mute sound
            </button>
          </div>

          <!-- Who, where, when, in words (Phase 11); the sensor values folded away -->
          <div class="em-facts">
            <div class="em-fact">
              <div class="em-fact-label">Patient</div>
              <div class="em-fact-main" id="em-patient-name">--</div>
              <div class="em-fact-sub" id="em-patient-id">--</div>
            </div>
            <div class="em-fact">
              <div class="em-fact-label">Where</div>
              <div class="em-fact-main" id="em-location">--</div>
              <div class="em-fact-sub" id="em-where-sub"></div>
            </div>
            <div class="em-fact">
              <div class="em-fact-label">When</div>
              <div class="em-fact-main" id="em-when">--</div>
              <div class="em-fact-sub" id="em-when-sub"></div>
            </div>
          </div>

          <!-- Vitals only for a vitals alert: a fall or a door alert comes without a fresh measurement -->
          <div class="em-vitals" id="em-vitals-row">
            Heart rate <b id="em-bpm">--</b>
            <span title="Not calibrated: for information only, raises no alarm">· SpO2 (indicative) <b id="em-spo2">--</b></span>
          </div>

          <details class="em-details">
            <summary>Sensor details</summary>
            <div id="em-fall-row" class="em-detail-row">
              Lowest value in the free fall <b id="em-freefall">--</b> · Impact <b id="em-impact">--</b> · Movement after the impact <b id="em-stillness">--</b>
            </div>
            <div class="em-detail-row" id="em-coords">Position: --</div>
            <div class="em-detail-row" id="em-alert-msg"></div>
          </details>

          <!-- Shown when someone else acknowledged this incident while it was open here -->
          <div id="em-ack-status" style="display: none; background: #ECFDF5; border-left: 4px solid #059669; padding: 12px 16px; border-radius: 8px; margin-bottom: 20px;">
            <div style="font-size: 14px; color: #065F46; font-weight: 800;" id="em-ack-title">✔ ACKNOWLEDGED</div>
            <div style="font-size: 13px; color: #065F46; font-weight: 600; margin-top: 4px; line-height: 1.5;" id="em-ack-detail"></div>
          </div>

          <!-- Action Buttons -->
          <div style="display: flex; gap: 12px; justify-content: flex-end;">
            <button id="em-btn-locate" class="btn btn-outline" style="border-color: #1E60F2; color: #1E60F2; font-weight: 700; padding: 10px 18px;">
              📍 Show on map
            </button>
            <button id="em-btn-ack" class="btn btn-primary" style="background: #DC2626; border-color: #DC2626; font-weight: 800; padding: 10px 24px; box-shadow: 0 4px 12px rgba(220, 38, 38, 0.4);">
              ✓ Acknowledge – I'm responding
            </button>
            <button id="em-btn-close" class="btn btn-primary" style="display: none; background: #059669; border-color: #059669; font-weight: 800; padding: 10px 24px;">
              OK, close
            </button>
          </div>
        </div>
      `;

      document.body.appendChild(modalBackdrop);

      // Bind Modal Button Listeners
      document.getElementById('em-btn-mute').addEventListener('click', () => {
        this.toggleMute();
      });

      document.getElementById('em-btn-locate').addEventListener('click', () => {
        const incident = this.currentModalIncident;
        this.hideEmergencyModal();

        const targetWard = incident?.ward_id || null;
        const targetTag = incident?.device_id || incident?.patient_id || null;
        if (!targetWard) {
          if (typeof showToast === 'function') {
            showToast('The ward of this incident is unknown, so it cannot be shown on the live map.', 'warning');
          }
          return;
        }

        if (typeof window.navigateToWardLiveMap === 'function') {
          window.navigateToWardLiveMap(targetWard, targetTag);
        } else if (typeof window.openWardLiveMap === 'function') {
          const wardBtn = document.querySelector('.nav-tab-btn[data-tab="tab-ward-config"]');
          if (wardBtn) {
            const navTabs = document.querySelectorAll('.nav-tab-btn');
            const tabPanes = document.querySelectorAll('.tab-pane');
            navTabs.forEach(b => b.classList.remove('active'));
            tabPanes.forEach(p => p.classList.remove('active'));
            wardBtn.classList.add('active');
            const targetPane = document.getElementById('tab-ward-config');
            if (targetPane) targetPane.classList.add('active');
          }
          window.openWardLiveMap(targetWard, targetTag);
        }
      });

      document.getElementById('em-btn-ack').addEventListener('click', () => {
        if (this.currentModalIncident) {
          this.acknowledgeAlert(this.currentModalIncident.incident_id);
        }
      });

      // Closes an incident that someone else acknowledged; the next pending one is shown
      document.getElementById('em-btn-close').addEventListener('click', () => {
        this.hideEmergencyModal();
        this.showNextPending();
      });
    }

    // Add pulse CSS animation keyframes
    if (!document.getElementById('emergency-anim-styles')) {
      const style = document.createElement('style');
      style.id = 'emergency-anim-styles';
      style.innerHTML = `
        @keyframes pulseBanner {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.92; }
        }
        @keyframes modalPopIn {
          from { opacity: 0; transform: scale(0.92) translateY(12px); }
          to { opacity: 1; transform: scale(1) translateY(0); }
        }
      `;
      document.head.appendChild(style);
    }
  }

  setupWebSocketListeners() {
    if (window.wsClient) {
      // Listen for incoming Emergency Alerts
      window.wsClient.on('EMERGENCY_ALERT', (msg) => {
        console.warn('[WS EMERGENCY ALERT RECEIVED]', msg);
        const incident = msg.incident;
        this.onNewEmergency(incident);
      });

      // An incident was acknowledged: by this screen, another screen or a headset.
      // Every screen that shows it says by whom; it is closed with "OK, close".
      window.wsClient.on('EMERGENCY_ACKNOWLEDGED', (msg) => {
        console.log('[WS EMERGENCY ACKNOWLEDGED]', msg);
        if (!msg || !msg.incident_id) return;
        // This screen's own click: acknowledgeAlert() handles the answer
        if (this.ownAcknowledgements.has(msg.incident_id)) return;
        this.onAcknowledgedElsewhere(msg.incident_id, msg.attending_clinician, msg.timestamp);
      });
    }
  }

  async fetchActiveAlerts() {
    try {
      const res = await fetch('/api/alerts/active');
      const data = await res.json();
      if (data.success && data.alerts && data.alerts.length > 0) {
        this.activeAlerts = data.alerts;
        this.updateBannerState();
        this.showEmergencyModal(this.activeAlerts[0]);
      }
    } catch (e) {
      console.warn('[ALERT MANAGER] Could not fetch active alerts:', e);
    }
  }

  onNewEmergency(incident) {
    if (!incident || !incident.incident_id) return;
    if (this.acknowledgedIncidentIds.has(incident.incident_id)) return;
    if (incident.resolution_status === 'ACKNOWLEDGED') return;

    // Add to active list
    const exists = this.activeAlerts.some(a => a.incident_id === incident.incident_id);
    if (!exists) {
      this.activeAlerts.unshift(incident);
    }

    this.updateBannerState();
    this.showEmergencyModal(incident);
    this.playAudioAlarm();
  }

  /**
   * "When" and "where" in words: how long ago, and the place in the ward
   * (at the door, by a bed, in the room) from the ward's layout and the
   * position stored with the incident.
   */
  async fillWhenAndWhere(incident) {
    const at = incident.trigger_timestamp ? new Date(incident.trigger_timestamp) : null;
    const whenEl = document.getElementById('em-when');
    const whenSub = document.getElementById('em-when-sub');
    if (whenEl) whenEl.innerText = at && window.ShiroUI ? window.ShiroUI.ago(at) || 'just now' : 'not recorded';
    if (whenSub) whenSub.innerText = at ? at.toLocaleTimeString() : '';

    const whereEl = document.getElementById('em-location');
    const whereSub = document.getElementById('em-where-sub');
    const ward = incident.ward_id || null;
    if (whereSub) whereSub.innerText = ward || '';
    if (!whereEl) return;
    if (incident.incident_category === 'GEOFENCE_BREACH') {
      whereEl.innerText = incident.geofence_kind === 'AT_DOOR' ? '🚪 At the door' : '🚪 Left through the door';
      return;
    }
    if (!ward) {
      whereEl.innerText = 'Ward not known';
      return;
    }
    const x = Number(incident.pos_x);
    const y = Number(incident.pos_y);
    if (incident.pos_x === null || incident.pos_x === undefined || !Number.isFinite(x) || !Number.isFinite(y)) {
      whereEl.innerText = ward;
      if (whereSub) whereSub.innerText = 'Exact place not known';
      return;
    }
    whereEl.innerText = ward;
    try {
      this.layouts = this.layouts || new Map();
      if (!this.layouts.has(ward)) {
        const res = await fetch(`/api/ward/config?ward_id=${encodeURIComponent(ward)}`);
        const data = await res.json();
        this.layouts.set(ward, data.success ? data.ward : null);
      }
      const layout = this.layouts.get(ward);
      if (!layout || this.currentModalIncident !== incident) return;
      const inRect = (r, m = 0) => r && x >= r.x - m && x <= r.x + r.w + m && y >= r.y - m && y <= r.y + r.l + m;
      const d = layout.door;
      let door = null;
      if (d) {
        const span = (Number(d.width) || 0.9) + 0.2;
        const start = (Number(d.x) || 0) - 0.1;
        const L = Number(layout.length_x);
        const W = Number(layout.width_y);
        door = { NORTH: { x: start, y: W - 1, w: span, l: 1 }, EAST: { x: L - 1, y: start, w: 1, l: span },
          WEST: { x: 0, y: start, w: 1, l: span }, SOUTH: { x: start, y: 0, w: span, l: 1 } }[String(d.wall || '').toUpperCase()] || null;
      }
      const bed = (layout.beds || []).find(b => {
        const rot = ((parseInt(b.rotation_deg, 10) || 0) % 360 + 360) % 360;
        const along = rot === 90 || rot === 270;
        const w = along ? Number(b.length) || 2 : Number(b.width) || 0.9;
        const l = along ? Number(b.width) || 0.9 : Number(b.length) || 2;
        return inRect({ x: Number(b.x) || 0, y: Number(b.y) || 0, w, l }, 0.3);
      });
      whereEl.innerText = inRect(door) ? '🚪 At the door' : bed ? `By ${bed.bed_code || bed.bed_id}` : 'In the room';
    } catch (err) {
      // The ward name stays
    }
  }

  showEmergencyModal(incident) {
    this.currentModalIncident = incident;
    const backdrop = document.getElementById('emergency-modal-backdrop');
    if (!backdrop) return;
    this.resetModalState();

    // Fill Modal Data
    const catEl = document.getElementById('em-modal-category');
    const iconEl = document.getElementById('em-modal-icon');
    if (incident.incident_category === 'FALL_ACCIDENT') {
      catEl.innerText = '🚨 CRITICAL FALL ACCIDENT';
      catEl.style.color = '#DC2626';
      iconEl.innerText = '🚨';
    } else if (incident.incident_category === 'CRITICAL_VITALS') {
      catEl.innerText = '🫀 CRITICAL VITALS ANOMALY';
      catEl.style.color = '#D97706';
      iconEl.innerText = '⚠️';
    } else if (incident.incident_category === 'GEOFENCE_BREACH') {
      catEl.innerText = `🚪 ${incidentTypeText(incident)}`;
      catEl.style.color = '#7C3AED';
      iconEl.innerText = '🚪';
    }

    // Unknown values are shown as unknown. Nothing is filled in on the screen.
    const known = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
    const simulated = incident.is_simulated === true || incident.is_simulated === 1;
    if (simulated) catEl.innerText = `[SIMULATION] ${catEl.innerText}`;

    document.getElementById('em-modal-id').innerText =
      `Incident ID: ${incident.incident_id || 'PENDING'}${simulated ? ' (simulated test alarm)' : ''}`;
    document.getElementById('em-patient-name').innerText = incident.patient_name || 'Unknown patient';
    document.getElementById('em-patient-id').innerText = [incident.patient_id || 'no patient record', incident.bed_id ? `their bed ${incident.bed_id}` : ''].filter(Boolean).join(' · ');
    document.getElementById('em-coords').innerText = (known(incident.pos_x) && known(incident.pos_y))
      ? `Position: (${Number(incident.pos_x).toFixed(2)} m, ${Number(incident.pos_y).toFixed(2)} m) from the south-west corner of the room`
      : 'Position: not known';
    this.fillWhenAndWhere(incident);
    // The three values of the wristband's fall check, exactly as it measured them
    const gValue = (v) => known(v) ? `${Number(v).toFixed(2)}g` : 'not reported';
    document.getElementById('em-fall-row').style.display =
      incident.incident_category === 'FALL_ACCIDENT' ? 'block' : 'none';
    document.getElementById('em-freefall').innerText = gValue(incident.freefall_min_g);
    document.getElementById('em-impact').innerText = gValue(incident.kinematic_impact_force);
    document.getElementById('em-stillness').innerText = gValue(incident.post_impact_stillness);
    // A fall or a door alert comes suddenly: nothing says the heart rate was being measured
    // then, so the pop-up shows no vitals for them (only for a vitals alert)
    const vitalsAlert = incident.incident_category === 'CRITICAL_VITALS';
    const vitalsRow = document.getElementById('em-vitals-row');
    if (vitalsRow) vitalsRow.style.display = vitalsAlert ? '' : 'none';
    document.getElementById('em-bpm').innerText = known(incident.heart_rate) && Number(incident.heart_rate) > 0 ? `${incident.heart_rate} bpm` : 'not measured';
    document.getElementById('em-spo2').innerText = known(incident.spo2) && Number(incident.spo2) > 0 ? `${incident.spo2}%` : 'not measured';
    document.getElementById('em-alert-msg').innerText = incident.alert_message || 'Clinical safety event detected.';

    backdrop.style.display = 'flex';
  }

  hideEmergencyModal() {
    const backdrop = document.getElementById('emergency-modal-backdrop');
    if (backdrop) backdrop.style.display = 'none';
    this.stopAudioAlarm();
  }

  updateBannerState() {
    const banner = document.getElementById('global-emergency-banner');
    const bannerText = document.getElementById('emergency-banner-text');
    if (!banner) return;

    if (this.activeAlerts.length > 0) {
      const topAlert = this.activeAlerts[0];
      const simulatedTag = (topAlert.is_simulated === true || topAlert.is_simulated === 1) ? '[SIMULATION] ' : '';
      const bannerWard = topAlert.ward_id ? ` in ${topAlert.ward_id}` : ' (ward unknown)';
      bannerText.innerText = `🚨 ${simulatedTag}EMERGENCY: ${incidentTypeText(topAlert)} on ${topAlert.patient_name || 'unknown patient'}${bannerWard}! Click to inspect.`;
      banner.style.display = 'block';
    } else {
      banner.style.display = 'none';
      this.stopAudioAlarm();
    }
  }

  async acknowledgeAlert(incidentId) {
    this.ownAcknowledgements.add(incidentId);
    try {
      const res = await fetch('/api/alerts/acknowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          incident_id: incidentId,
          // The server records the signed-in clinician
          notes: 'Emergency acknowledged and staff dispatched via Web Dashboard.'
        })
      });
      const data = await res.json();
      if (data.success) {
        // Acknowledged by this screen: the pop-up closes, the next pending incident is shown
        this.acknowledgedIncidentIds.add(incidentId);
        if (typeof showToast === 'function') showToast('Emergency alert acknowledged successfully', 'success');
        this.activeAlerts = this.activeAlerts.filter(a => a.incident_id !== incidentId);
        this.updateBannerState();
        this.hideEmergencyModal();
        this.showNextPending();
      } else if (res.status === 409) {
        // Someone else (another screen or a headset) was first: their acknowledgement
        // is the record. The message names them; the pop-up says so until closed.
        const by = /by (.*)\.$/.exec(data.error || '');
        this.onAcknowledgedElsewhere(incidentId, by ? by[1] : null, null);
      } else if (typeof showToast === 'function') {
        showToast(`Not acknowledged: ${data.error || `server answered ${res.status}`}`, 'danger');
      }
    } catch (e) {
      console.error('[ACKNOWLEDGE ERROR]', e);
      if (typeof showToast === 'function') showToast('Not acknowledged: the edge server cannot be reached.', 'danger');
    } finally {
      this.ownAcknowledgements.delete(incidentId);
    }
  }

  // Synthesized 2-Tone Hospital Alarm Chime (Web Audio API)
  playAudioAlarm() {
    if (this.isMuted) return;
    try {
      if (!this.audioContext) {
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (this.audioContext.state === 'suspended') {
        this.audioContext.resume();
      }

      this.stopAudioAlarm();

      const playBeep = () => {
        if (this.isMuted || !this.audioContext) return;
        const now = this.audioContext.currentTime;

        // Tone 1: High Pitch (880 Hz)
        const osc1 = this.audioContext.createOscillator();
        const gain1 = this.audioContext.createGain();
        osc1.type = 'sine';
        osc1.frequency.setValueAtTime(880, now);
        gain1.gain.setValueAtTime(0.25, now);
        gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
        osc1.connect(gain1);
        gain1.connect(this.audioContext.destination);
        osc1.start(now);
        osc1.stop(now + 0.15);

        // Tone 2: Mid-High Pitch (659 Hz)
        const osc2 = this.audioContext.createOscillator();
        const gain2 = this.audioContext.createGain();
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(659, now + 0.18);
        gain2.gain.setValueAtTime(0.25, now + 0.18);
        gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
        osc2.connect(gain2);
        gain2.connect(this.audioContext.destination);
        osc2.start(now + 0.18);
        osc2.stop(now + 0.35);
      };

      playBeep();
      this.alarmInterval = setInterval(playBeep, 1600);
    } catch (err) {
      console.warn('[AUDIO ALARM ERROR]', err);
    }
  }

  stopAudioAlarm() {
    if (this.alarmInterval) {
      clearInterval(this.alarmInterval);
      this.alarmInterval = null;
    }
  }

  toggleMute() {
    this.isMuted = !this.isMuted;
    const btn = document.getElementById('em-btn-mute');
    if (btn) {
      btn.innerText = this.isMuted ? '🔕 Unmute Alarm' : '🔔 Mute Alarm';
    }
    if (this.isMuted) {
      this.stopAudioAlarm();
    } else {
      this.playAudioAlarm();
    }
  }
}

// Global Singleton
window.alertManager = new EmergencyAlertManager();
document.addEventListener('DOMContentLoaded', () => {
  window.alertManager.init();
});

