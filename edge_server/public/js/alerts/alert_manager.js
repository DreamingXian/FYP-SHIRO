// =============================================================================
// SHIRO Hospital Web Dashboard - Emergency Incident & Clinical Alert Manager
// Module: Real-time Audio/Visual Pop-up Modal, Acknowledgment & Test Simulation
// Documentation: Chapter 4 (Section 4.2.2, Table 4.13)
// =============================================================================

class EmergencyAlertManager {
  constructor() {
    this.activeAlerts = [];
    this.acknowledgedIncidentIds = new Set();
    this.audioContext = null;
    this.alarmInterval = null;
    this.isMuted = false;
    this.currentModalIncident = null;
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
              🔔 Mute Alarm
            </button>
          </div>

          <!-- Patient & Telemetry Info Grid -->
          <div style="background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 14px; padding: 18px 20px; margin-bottom: 20px;">
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 14px;">
              <div>
                <div style="font-size: 11px; text-transform: uppercase; font-weight: 700; color: #64748B;">Target Patient</div>
                <div style="font-size: 17px; font-weight: 800; color: #0F172A; margin-top: 2px;" id="em-patient-name">--</div>
                <div style="font-size: 12px; color: #64748B;" id="em-patient-id">Patient ID: --</div>
              </div>

              <div>
                <div style="font-size: 11px; text-transform: uppercase; font-weight: 700; color: #64748B;">Ward & Spatial Location</div>
                <div style="font-size: 17px; font-weight: 800; color: #0F172A; margin-top: 2px;" id="em-location">--</div>
                <div style="font-size: 12px; font-family: monospace; color: #1E60F2; font-weight: 700;" id="em-coords">Grid Location: --</div>
              </div>
            </div>

            <div style="margin-top: 14px; padding-top: 12px; border-top: 1px solid #E2E8F0; display: flex; gap: 24px;">
              <div>
                <span style="font-size: 11px; font-weight: 700; color: #64748B;">Impact Force:</span>
                <span style="font-size: 13px; font-weight: 800; color: #DC2626; margin-left: 4px;" id="em-impact">--</span>
              </div>
              <div>
                <span style="font-size: 11px; font-weight: 700; color: #64748B;">Heart Rate:</span>
                <span style="font-size: 13px; font-weight: 800; color: #0F172A; margin-left: 4px;" id="em-bpm">-- BPM</span>
              </div>
              <div>
                <span style="font-size: 11px; font-weight: 700; color: #64748B;">Oxygen (SpO2):</span>
                <span style="font-size: 13px; font-weight: 800; color: #0F172A; margin-left: 4px;" id="em-spo2">--%</span>
              </div>
            </div>
          </div>

          <!-- Alert Message Narrative Box -->
          <div style="background: #FFF1F2; border-left: 4px solid #E11D48; padding: 12px 16px; border-radius: 8px; margin-bottom: 24px;">
            <div style="font-size: 13px; color: #9F1239; font-weight: 600; line-height: 1.5;" id="em-alert-msg">
              CRITICAL FALL DETECTED: Sudden impact spike followed by incapacitation stillness.
            </div>
          </div>

          <!-- Action Buttons -->
          <div style="display: flex; gap: 12px; justify-content: flex-end;">
            <button id="em-btn-locate" class="btn btn-outline" style="border-color: #1E60F2; color: #1E60F2; font-weight: 700; padding: 10px 18px;">
              📍 Locate on Live Map
            </button>
            <button id="em-btn-ack" class="btn btn-primary" style="background: #DC2626; border-color: #DC2626; font-weight: 800; padding: 10px 24px; box-shadow: 0 4px 12px rgba(220, 38, 38, 0.4);">
              ✓ ACKNOWLEDGE & RESPOND
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

      // Listen for Acknowledgment events
      window.wsClient.on('EMERGENCY_ACKNOWLEDGED', (msg) => {
        console.log('[WS EMERGENCY ACKNOWLEDGED]', msg);
        this.activeAlerts = this.activeAlerts.filter(a => a.incident_id !== msg.incident_id);
        this.updateBannerState();
        if (this.currentModalIncident && this.currentModalIncident.incident_id === msg.incident_id) {
          this.hideEmergencyModal();
        }
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

  showEmergencyModal(incident) {
    this.currentModalIncident = incident;
    const backdrop = document.getElementById('emergency-modal-backdrop');
    if (!backdrop) return;

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
      catEl.innerText = '🚪 GEOFENCE BOUNDARY BREACH';
      catEl.style.color = '#7C3AED';
      iconEl.innerText = '📍';
    }

    // Unknown values are shown as unknown. Nothing is filled in on the screen.
    const known = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
    const simulated = incident.is_simulated === true || incident.is_simulated === 1;
    if (simulated) catEl.innerText = `[SIMULATION] ${catEl.innerText}`;

    document.getElementById('em-modal-id').innerText =
      `Incident ID: ${incident.incident_id || 'PENDING'}${simulated ? ' (simulated test alarm)' : ''}`;
    document.getElementById('em-patient-name').innerText = incident.patient_name || 'Unknown patient';
    document.getElementById('em-patient-id').innerText = `Patient ID: ${incident.patient_id || 'not assigned'}`;
    document.getElementById('em-location').innerText = incident.ward_id
      ? `${incident.ward_id}${incident.bed_id ? ` (${incident.bed_id})` : ''}`
      : 'Ward unknown';
    document.getElementById('em-coords').innerText = (known(incident.pos_x) && known(incident.pos_y))
      ? `Grid Location: (${Number(incident.pos_x).toFixed(2)}m, ${Number(incident.pos_y).toFixed(2)}m)`
      : 'Grid Location: unknown';
    document.getElementById('em-impact').innerText = known(incident.kinematic_impact_force)
      ? `${Number(incident.kinematic_impact_force).toFixed(2)}g`
      : 'not reported';
    document.getElementById('em-bpm').innerText = known(incident.heart_rate) ? `${incident.heart_rate} BPM` : '-- BPM';
    document.getElementById('em-spo2').innerText = known(incident.spo2) ? `${incident.spo2}%` : '--%';
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
      bannerText.innerText = `🚨 ${simulatedTag}EMERGENCY: ${String(topAlert.incident_category || 'INCIDENT').replace('_', ' ')} on ${topAlert.patient_name || 'unknown patient'}${bannerWard}! Click to inspect.`;
      banner.style.display = 'block';
    } else {
      banner.style.display = 'none';
      this.stopAudioAlarm();
    }
  }

  async acknowledgeAlert(incidentId) {
    try {
      const res = await fetch('/api/alerts/acknowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          incident_id: incidentId,
          attending_clinician: 'DOC-8821 (Dr. Tan)',
          notes: 'Emergency acknowledged and staff dispatched via Web Dashboard.'
        })
      });
      const data = await res.json();
      if (data.success) {
        this.acknowledgedIncidentIds.add(incidentId);
        if (typeof showToast === 'function') {
          showToast('Emergency alert acknowledged successfully', 'success');
        }
        this.activeAlerts = this.activeAlerts.filter(a => a.incident_id !== incidentId);
        this.updateBannerState();
        this.hideEmergencyModal();
      }
    } catch (e) {
      console.error('[ACKNOWLEDGE ERROR]', e);
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

