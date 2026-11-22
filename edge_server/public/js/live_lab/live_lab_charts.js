// =============================================================================
// Live Telemetry Lab & Real-Time Signal Processing Controller
// =============================================================================

let totalPackets = 0;
let lastPacketTime = Date.now();

// The raw pulse signal (infrared / red light) is not drawn: the wristband
// computes heart rate and SpO2 itself and packet v2 carries only those results
// (docs/protocol.md), so there is no waveform to show.

const rssiHistoryRaw = [];
const rssiHistoryFilt = [];
const maxRssiPoints = 80;

/** The Live Lab page is shown (and the browser tab visible). */
function isLiveLabOpen() {
  const pane = document.getElementById('tab-live-lab');
  return Boolean(pane && pane.classList.contains('active') && !document.hidden);
}

function resizeCanvases() {
  const rssiCanvas = document.getElementById('rssiCanvas');
  if (rssiCanvas && rssiCanvas.parentElement) {
    rssiCanvas.width = rssiCanvas.parentElement.clientWidth;
    rssiCanvas.height = rssiCanvas.parentElement.clientHeight;
  }
}

function drawRSSI() {
  const rssiCanvas = document.getElementById('rssiCanvas');
  if (!rssiCanvas) return;
  const rssiCtx = rssiCanvas.getContext('2d');
  if (!rssiCtx) return;

  rssiCtx.clearRect(0, 0, rssiCanvas.width, rssiCanvas.height);

  // Clean horizontal grid lines
  rssiCtx.strokeStyle = '#F1F5F9';
  rssiCtx.lineWidth = 1;
  for (let y = 1; y < 4; y++) {
    rssiCtx.beginPath();
    rssiCtx.moveTo(0, (rssiCanvas.height / 4) * y);
    rssiCtx.lineTo(rssiCanvas.width, (rssiCanvas.height / 4) * y);
    rssiCtx.stroke();
  }

  if (rssiHistoryRaw.length < 2) return;
  const minRssi = -95;
  const maxRssi = -45;
  const range = maxRssi - minRssi;
  const step = rssiCanvas.width / (maxRssiPoints - 1);

  // 1. Raw RSSI (Amber Orange Dotted)
  rssiCtx.strokeStyle = '#D97706';
  rssiCtx.lineWidth = 1.5;
  rssiCtx.setLineDash([3, 3]);
  rssiCtx.beginPath();
  for (let i = 0; i < rssiHistoryRaw.length; i++) {
    const x = i * step;
    const normalized = (rssiHistoryRaw[i] - minRssi) / range;
    const y = rssiCanvas.height - (normalized * (rssiCanvas.height - 20)) - 10;
    if (i === 0) rssiCtx.moveTo(x, y);
    else rssiCtx.lineTo(x, y);
  }
  rssiCtx.stroke();
  rssiCtx.setLineDash([]);

  // 2. Kalman Filtered RSSI (Royal Electric Blue Solid)
  rssiCtx.strokeStyle = '#1E60F2';
  rssiCtx.lineWidth = 3;
  rssiCtx.beginPath();
  for (let i = 0; i < rssiHistoryFilt.length; i++) {
    const x = i * step;
    const normalized = (rssiHistoryFilt[i] - minRssi) / range;
    const y = rssiCanvas.height - (normalized * (rssiCanvas.height - 20)) - 10;
    if (i === 0) rssiCtx.moveTo(x, y);
    else rssiCtx.lineTo(x, y);
  }
  rssiCtx.stroke();
}

function initLiveLabListeners() {
  const btnSaveCal = document.getElementById('btn-save-cal');
  const inputCalA = document.getElementById('input-cal-a');
  const inputCalN = document.getElementById('input-cal-n');

  if (btnSaveCal && inputCalA && inputCalN) {
    btnSaveCal.onclick = () => {
      const a = parseFloat(inputCalA.value);
      const n = parseFloat(inputCalN.value);
      if (window.wsClient) {
        window.wsClient.sendCalibration(a, n);
        btnSaveCal.innerText = 'Saved!';
        setTimeout(() => { btnSaveCal.innerText = 'Save Calibration'; }, 1500);
      }
    };
  }

  if (window.wsClient) {
    window.wsClient.on('STATUS', (msg) => {
      if (msg.calibration && inputCalA && inputCalN) {
        inputCalA.value = msg.calibration.A;
        inputCalN.value = msg.calibration.n;
      }
    });

    window.wsClient.on('CALIBRATION_SYNC', (msg) => {
      if (msg.calibration && inputCalA && inputCalN) {
        inputCalA.value = msg.calibration.A;
        inputCalN.value = msg.calibration.n;
      }
    });

    window.wsClient.on('WARD_CONFIG_UPDATED', () => {
      if (typeof window.loadWardDataFromDB === 'function') {
        window.loadWardDataFromDB();
      }
    });

    window.wsClient.on('ANCHOR_RSSI', (msg) => {
      // Many times a second (every wall sensor, every wristband): the history is kept
      // always, the page (numbers, chart, log) is touched only while the Live Lab is open
      rssiHistoryRaw.push(msg.raw_rssi);
      rssiHistoryFilt.push(msg.filtered_rssi);
      if (rssiHistoryRaw.length > maxRssiPoints) rssiHistoryRaw.shift();
      if (rssiHistoryFilt.length > maxRssiPoints) rssiHistoryFilt.shift();
      if (!isLiveLabOpen()) return;

      const valDistA = document.getElementById('val-dist-a');
      const valRawA = document.getElementById('val-raw-a');
      const valFiltA = document.getElementById('val-filt-a');
      const anchorABadge = document.getElementById('anchor-a-badge');

      const valDistB = document.getElementById('val-dist-b');
      const valRawB = document.getElementById('val-raw-b');
      const valFiltB = document.getElementById('val-filt-b');
      const anchorBBadge = document.getElementById('anchor-b-badge');

      const healthRawA = document.getElementById('health-raw-a');
      const healthFiltA = document.getElementById('health-filt-a');
      const healthDistA = document.getElementById('health-dist-a');
      const healthTimeA = document.getElementById('health-time-a');
      const logBody = document.getElementById('log-body');

      const isAnchorA = msg.anchor === 'anchor-A' || msg.anchor === 'anchor-001' || msg.anchor?.endsWith('001') || msg.anchor?.endsWith('-A');
      const isAnchorB = msg.anchor === 'anchor-B' || msg.anchor === 'anchor-002' || msg.anchor?.endsWith('002') || msg.anchor?.endsWith('-B');

      if (isAnchorA) {
        if (valDistA) valDistA.innerHTML = `${escapeHtml(Number(msg.filtered_distance).toFixed(2))} <span class="metric-unit">meters</span>`;
        if (valRawA) valRawA.innerText = msg.raw_rssi;
        if (valFiltA) valFiltA.innerText = msg.filtered_rssi;
        if (anchorABadge) {
          anchorABadge.innerText = '● Tracking Active';
          anchorABadge.className = 'badge badge-live';
        }

        // Sync to Health Tab
        if (healthRawA) healthRawA.innerText = `${msg.raw_rssi} dBm`;
        if (healthFiltA) healthFiltA.innerText = `${msg.filtered_rssi} dBm`;
        if (healthDistA) healthDistA.innerText = `${msg.filtered_distance.toFixed(2)} m`;
        if (healthTimeA) healthTimeA.innerText = msg.timestamp;
      } else if (isAnchorB) {
        if (valDistB) valDistB.innerHTML = `${escapeHtml(Number(msg.filtered_distance).toFixed(2))} <span class="metric-unit">meters</span>`;
        if (valRawB) valRawB.innerText = msg.raw_rssi;
        if (valFiltB) valFiltB.innerText = msg.filtered_rssi;
        if (anchorBBadge) {
          anchorBBadge.innerText = '● Tracking Active';
          anchorBBadge.className = 'badge badge-live';
        }
      }

      drawRSSI();

      if (logBody) {
        const row = `<tr>
          <td style="color: var(--text-muted);">${escapeHtml(msg.timestamp)}</td>
          <td class="mono" style="color: var(--telemetry-purple); font-weight: 600;">${escapeHtml(msg.topic)}</td>
          <td class="mono">Raw: ${escapeHtml(msg.raw_rssi)} dBm ➔ Filtered: ${escapeHtml(msg.filtered_rssi)} dBm (Dist: ${escapeHtml(msg.filtered_distance)}m)</td>
          <td style="color: var(--primary); font-weight: 600;">✓ Kalman filtered</td>
        </tr>`;
        logBody.insertAdjacentHTML('afterbegin', row);
        if (logBody.children.length > 10) logBody.removeChild(logBody.lastChild);
      }
    });

    window.wsClient.on('TELEMETRY', (msg) => {
      const now = Date.now();
      const delta = now - lastPacketTime;
      lastPacketTime = now;

      totalPackets++;
      if (!isLiveLabOpen()) return;   // counted; shown while the Live Lab is open
      const packetCounter = document.getElementById('packet-counter');
      const latencyDisplay = document.getElementById('latency-display');
      if (packetCounter) packetCounter.innerText = `Packets Received: ${totalPackets}`;
      if (latencyDisplay) latencyDisplay.innerText = `Interval: ${delta} ms (${Math.round(1000/delta)} Hz)`;

      const d = msg.data;
      if (!d) return;

      const fingerBadge = document.getElementById('finger-badge');
      const contactStatus = document.getElementById('contact-status');
      const valBpm = document.getElementById('val-bpm');
      const bpmStatus = document.getElementById('bpm-status');
      const valSpo2 = document.getElementById('val-spo2');
      const spo2Badge = document.getElementById('spo2-badge');
      const valG = document.getElementById('val-g');
      const gMeter = document.getElementById('g-meter');
      const gBadge = document.getElementById('g-badge');
      const logBody = document.getElementById('log-body');

      // Vitals: BPM & SpO2
      if (d.touch === 1) {
        if (fingerBadge) {
          fingerBadge.innerText = '● Skin contact';
          fingerBadge.className = 'badge badge-live';
        }
        if (contactStatus) {
          contactStatus.innerText = 'Pulse Active';
          contactStatus.style.color = '#059669';
        }

        if (d.bpm && d.bpm > 30) {
          if (valBpm) valBpm.innerHTML = `${escapeHtml(d.bpm)} <span class="metric-unit">BPM</span>`;
          if (bpmStatus) {
            bpmStatus.innerText = 'Synchronized with Pulse';
            bpmStatus.style.color = '#059669';
          }
        } else {
          if (valBpm) valBpm.innerHTML = `<span style="font-size:32px; color: var(--primary);">Reading...</span>`;
          if (bpmStatus) {
            bpmStatus.innerText = 'Detecting pulse (keep finger steady)...';
            bpmStatus.style.color = 'var(--primary)';
          }
        }

        if (d.spo2 && d.spo2 > 70) {
          if (valSpo2) valSpo2.innerHTML = `${escapeHtml(d.spo2)} <span class="metric-unit">%</span>`;
          if (spo2Badge) {
            // Not calibrated: no "optimal" or "hypoxia" verdict is shown for this value
            spo2Badge.innerText = '● Indicative only';
            spo2Badge.className = 'badge badge-info';
            spo2Badge.title = 'The SpO2 measurement is not calibrated and does not raise alarms.';
          }
        } else {
          if (valSpo2) valSpo2.innerHTML = `<span style="font-size:32px; color: var(--primary);">Reading...</span>`;
          if (spo2Badge) {
            spo2Badge.innerText = 'Calibrating';
            spo2Badge.className = 'badge badge-info';
          }
        }
      } else {
        if (fingerBadge) {
          fingerBadge.innerText = 'No contact';
          fingerBadge.className = 'badge badge-neutral';
        }
        if (contactStatus) {
          contactStatus.innerText = 'Idle / Removed';
          contactStatus.style.color = 'var(--text-muted)';
        }
        if (valBpm) valBpm.innerHTML = `-- <span class="metric-unit">BPM</span>`;
        if (bpmStatus) {
          bpmStatus.innerText = 'Place finger on HW-605 sensor';
          bpmStatus.style.color = 'var(--text-muted)';
        }
        if (valSpo2) valSpo2.innerHTML = `-- <span class="metric-unit">%</span>`;
        if (spo2Badge) {
          spo2Badge.innerText = 'Standby';
          spo2Badge.className = 'badge badge-neutral';
        }
      }

      // G-Force & Fall status. No g value means the accelerometer is not delivering data.
      const hasG = typeof d.g === 'number' && Number.isFinite(d.g);
      if (valG) valG.innerHTML = hasG ? `${d.g.toFixed(2)} <span class="metric-unit">g</span>` : `-- <span class="metric-unit">g</span>`;
      if (gMeter) {
        const meterPct = hasG ? Math.min(100, Math.max(0, (d.g / 3.0) * 100)) : 0;
        gMeter.style.width = `${meterPct}%`;
      }

      if (gBadge) {
        if (d.imu_fault || !hasG) {
          gBadge.innerText = '⚠ SENSOR FAULT (accelerometer)';
          gBadge.className = 'badge badge-alert';
        } else if (d.fall) {
          gBadge.innerText = '🚨 FALL CONFIRMED BY WRISTBAND';
          gBadge.className = 'badge badge-alert';
        } else if (d.g < 0.5) {
          gBadge.innerText = '● FREE-FALL DETECTED';
          gBadge.className = 'badge badge-alert';
        } else if (d.g > 2.5) {
          gBadge.innerText = '● IMPACT SPIKE DETECTED';
          gBadge.className = 'badge badge-alert';
        } else {
          gBadge.innerText = '● Normal (Stable)';
          gBadge.className = 'badge badge-info';
        }
      }

      if (logBody) {
        const row = `<tr>
          <td style="color: var(--text-muted);">${escapeHtml(msg.timestamp)}</td>
          <td class="mono" style="color: var(--telemetry-purple); font-weight: 600;">${escapeHtml(msg.topic)}</td>
          <td class="mono" style="font-size: 12px; color: var(--text-secondary);">${escapeHtml(JSON.stringify(d))}</td>
          <td style="color: var(--status-success-text); font-weight: 600;">✓ Delivered (${delta}ms)</td>
        </tr>`;

        if (totalPackets === 1) logBody.innerHTML = row;
        else logBody.insertAdjacentHTML('afterbegin', row);

        if (logBody.children.length > 8) {
          logBody.removeChild(logBody.lastChild);
        }
      }
    });
  }

  // Bind Emergency Simulation Test Bench Buttons
  const btnSimFall = document.getElementById('btn-sim-fall');
  const btnSimVitals = document.getElementById('btn-sim-vitals');
  const btnSimGeofence = document.getElementById('btn-sim-geofence');
  const simPatientSelect = document.getElementById('sim-patient-select');

  // The test bench offers the patients that are admitted now. The server reads
  // the name, ward, bed and wristband of the chosen patient from the database.
  async function loadSimulationPatients() {
    if (!simPatientSelect) return;
    const chosen = simPatientSelect.value;
    let patients = [];
    let failed = false;
    try {
      const res = await fetch('/api/patients/list?status=ADMITTED');
      const data = await res.json();
      if (data.success && Array.isArray(data.patients)) patients = data.patients;
      else failed = true;
    } catch (e) {
      failed = true;
      console.error('[SIMULATION] Could not load the patient list:', e);
    }

    // Built with DOM methods, so a patient name is always shown as text
    simPatientSelect.replaceChildren();
    if (patients.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = failed ? 'Patient list could not be loaded' : 'No admitted patient';
      simPatientSelect.appendChild(option);
      return;
    }
    for (const p of patients) {
      const option = document.createElement('option');
      option.value = p.patient_id;
      const place = p.bed_code ? ` (${p.assigned_ward_id}, ${p.bed_code})` : ' (no bed assigned)';
      option.textContent = `${p.patient_id}: ${p.full_name}${place}`;
      simPatientSelect.appendChild(option);
    }
    if (patients.some(p => p.patient_id === chosen)) simPatientSelect.value = chosen;
  }

  if (simPatientSelect) {
    loadSimulationPatients();
    // Refreshed whenever the list is opened, so new admissions appear without a reload
    simPatientSelect.addEventListener('focus', loadSimulationPatients);
  }

  async function triggerSimulation(category) {
    const patientId = simPatientSelect ? simPatientSelect.value : '';
    if (!patientId) {
      if (typeof showToast === 'function') showToast('Admit a patient first: a simulation needs an existing patient.', 'warning');
      return;
    }

    try {
      const res = await fetch('/api/alerts/trigger-simulation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, patient_id: patientId })
      });
      const data = await res.json();
      if (typeof showToast === 'function') {
        if (data.success) showToast(`Triggered ${category.replace('_', ' ')} simulation`, 'warning');
        else showToast(data.error || 'The simulation could not be triggered.', 'error');
      }
    } catch (e) {
      console.error('[SIMULATION ERROR]', e);
    }
  }

  if (btnSimFall) btnSimFall.onclick = () => triggerSimulation('FALL_ACCIDENT');
  if (btnSimVitals) btnSimVitals.onclick = () => triggerSimulation('CRITICAL_VITALS');
  if (btnSimGeofence) btnSimGeofence.onclick = () => triggerSimulation('GEOFENCE_BREACH');
}

// Global exposure
window.resizeCanvases = resizeCanvases;
window.drawRSSI = drawRSSI;
window.initLiveLabListeners = initLiveLabListeners;

