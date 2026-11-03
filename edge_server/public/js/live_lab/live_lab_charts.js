// =============================================================================
// Live Telemetry Lab & Real-Time Signal Processing Controller
// =============================================================================

let totalPackets = 0;
let lastPacketTime = Date.now();
const ppgHistory = [];
const maxDataPoints = 140;

const rssiHistoryRaw = [];
const rssiHistoryFilt = [];
const maxRssiPoints = 80;

function resizeCanvases() {
  const ppgCanvas = document.getElementById('ppgCanvas');
  const rssiCanvas = document.getElementById('rssiCanvas');

  if (ppgCanvas && ppgCanvas.parentElement) {
    ppgCanvas.width = ppgCanvas.parentElement.clientWidth;
    ppgCanvas.height = ppgCanvas.parentElement.clientHeight;
  }
  if (rssiCanvas && rssiCanvas.parentElement) {
    rssiCanvas.width = rssiCanvas.parentElement.clientWidth;
    rssiCanvas.height = rssiCanvas.parentElement.clientHeight;
  }
}

function drawPPG() {
  const ppgCanvas = document.getElementById('ppgCanvas');
  if (!ppgCanvas) return;
  const ppgCtx = ppgCanvas.getContext('2d');
  if (!ppgCtx) return;

  ppgCtx.clearRect(0, 0, ppgCanvas.width, ppgCanvas.height);

  // Baseline divider
  ppgCtx.strokeStyle = '#E2E8F0';
  ppgCtx.lineWidth = 1;
  ppgCtx.beginPath();
  ppgCtx.moveTo(0, ppgCanvas.height / 2);
  ppgCtx.lineTo(ppgCanvas.width, ppgCanvas.height / 2);
  ppgCtx.stroke();

  if (ppgHistory.length < 2) return;
  const min = Math.min(...ppgHistory);
  const max = Math.max(...ppgHistory);
  const range = (max - min) === 0 ? 1 : (max - min);

  // Royal Electric Blue PPG curve
  ppgCtx.strokeStyle = '#1E60F2';
  ppgCtx.lineWidth = 2.5;
  ppgCtx.beginPath();
  const step = ppgCanvas.width / (maxDataPoints - 1);
  for (let i = 0; i < ppgHistory.length; i++) {
    const x = i * step;
    const normalized = (ppgHistory[i] - min) / range;
    const y = ppgCanvas.height - 15 - (normalized * (ppgCanvas.height - 30));
    if (i === 0) ppgCtx.moveTo(x, y);
    else ppgCtx.lineTo(x, y);
  }
  ppgCtx.stroke();
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
        if (valDistA) valDistA.innerHTML = `${msg.filtered_distance.toFixed(2)} <span class="metric-unit">meters</span>`;
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
        if (valDistB) valDistB.innerHTML = `${msg.filtered_distance.toFixed(2)} <span class="metric-unit">meters</span>`;
        if (valRawB) valRawB.innerText = msg.raw_rssi;
        if (valFiltB) valFiltB.innerText = msg.filtered_rssi;
        if (anchorBBadge) {
          anchorBBadge.innerText = '● Tracking Active';
          anchorBBadge.className = 'badge badge-live';
        }
      }

      rssiHistoryRaw.push(msg.raw_rssi);
      rssiHistoryFilt.push(msg.filtered_rssi);
      if (rssiHistoryRaw.length > maxRssiPoints) rssiHistoryRaw.shift();
      if (rssiHistoryFilt.length > maxRssiPoints) rssiHistoryFilt.shift();
      drawRSSI();

      if (logBody) {
        const row = `<tr>
          <td style="color: var(--text-muted);">${msg.timestamp}</td>
          <td class="mono" style="color: var(--telemetry-purple); font-weight: 600;">${msg.topic}</td>
          <td class="mono">Raw: ${msg.raw_rssi} dBm ➔ Filtered: ${msg.filtered_rssi} dBm (Dist: ${msg.filtered_distance}m)</td>
          <td style="color: var(--primary); font-weight: 600;">✓ EKF Filtered</td>
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
      const rawIrPreview = document.getElementById('raw-ir-preview');
      const valG = document.getElementById('val-g');
      const gMeter = document.getElementById('g-meter');
      const gBadge = document.getElementById('g-badge');
      const logBody = document.getElementById('log-body');

      // Vitals: BPM & SpO2
      if (d.touch === 1 || d.ir > 50000) {
        if (fingerBadge) {
          fingerBadge.innerText = '● Finger Detected';
          fingerBadge.className = 'badge badge-live';
        }
        if (contactStatus) {
          contactStatus.innerText = 'Pulse Active';
          contactStatus.style.color = '#059669';
        }

        if (d.bpm && d.bpm > 30) {
          if (valBpm) valBpm.innerHTML = `${d.bpm} <span class="metric-unit">BPM</span>`;
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
          if (valSpo2) valSpo2.innerHTML = `${d.spo2} <span class="metric-unit">%</span>`;
          if (spo2Badge) {
            spo2Badge.innerText = (d.spo2 >= 95) ? '● Optimal' : '● Mild Hypoxia';
            spo2Badge.className = (d.spo2 >= 95) ? 'badge badge-live' : 'badge badge-alert';
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
          fingerBadge.innerText = 'No Finger';
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

      if (rawIrPreview) {
        rawIrPreview.innerText = `IR: ${d.ir ? d.ir.toLocaleString() : '0'} | Red: ${d.red ? d.red.toLocaleString() : '0'}`;
      }

      ppgHistory.push(d.ir);
      if (ppgHistory.length > maxDataPoints) ppgHistory.shift();
      drawPPG();

      // G-Force & Fall status
      if (valG) valG.innerHTML = `${d.g.toFixed(2)} <span class="metric-unit">g</span>`;
      if (gMeter) {
        const meterPct = Math.min(100, Math.max(0, (d.g / 3.0) * 100));
        gMeter.style.width = `${meterPct}%`;
      }

      if (gBadge) {
        if (d.g < 0.5) {
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
          <td style="color: var(--text-muted);">${msg.timestamp}</td>
          <td class="mono" style="color: var(--telemetry-purple); font-weight: 600;">${msg.topic}</td>
          <td class="mono" style="font-size: 12px; color: var(--text-secondary);">${JSON.stringify(d)}</td>
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
}

// Global exposure
window.resizeCanvases = resizeCanvases;
window.drawPPG = drawPPG;
window.drawRSSI = drawRSSI;
window.initLiveLabListeners = initLiveLabListeners;

