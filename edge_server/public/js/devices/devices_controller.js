// =============================================================================
// SHIRO Hospital Edge Admin - Devices Controller (MVC Client Controller)
// Hardware Fleet Provisioning, Discovery Radar, Ward Assignment & Diagnostics
// =============================================================================

let cachedFleet = [];
let cachedUnprovisioned = [];
let currentDeviceTypeFilter = 'ALL';
let currentStatusFilter = null; // null | 'ONLINE' | 'OFFLINE'
let currentAvailFilter = null;  // null | 'AVAILABLE' | 'IN_USE' | 'UNAVAILABLE'
let devicesPage = 1;           // pages of 8 (ui_kit.js)
let discoveryPage = 1;
let isWsListenersRegistered = false;
// Live picture of the LiDAR room sensors (Phase 10), by device ID and by MAC address
const roomSensorLive = new Map();

/** The badge of a device category, the same in the fleet table, the radar and the enrolment window. */
function deviceTypeBadge(type) {
  if (type === 'ANCHOR') return `<span class="badge badge-neutral">📡 Anchor</span>`;
  if (type === 'HEADSET') return `<span class="badge badge-neutral" style="color:var(--primary); font-weight:700;">🥽 Headset</span>`;
  if (type === 'ROOM_SENSOR') return `<span class="badge badge-neutral" style="color:#7C3AED; font-weight:700;">🌀 LiDAR</span>`;
  return `<span class="badge badge-info">🛏️ Wristband</span>`;
}

/** A LiDAR node's live state: scanning and how fast, points per turn, the LiDAR's own health. */
function lidarLiveHtml(s) {
  if (!s) return `<span style="color:var(--text-muted); font-size:11px;">⚡ 5 V supply · no report yet</span>`;
  if (!s.online) return `<span style="color:var(--text-muted); font-size:11px;">⚡ 5 V supply · not connected</span>`;
  const node = s.node || {};
  const health = node.health || 'UNKNOWN';
  const scanText = s.scanning
    ? `${s.turns_per_s} turns/s${s.last_frame ? ` · ${s.last_frame.valid} points` : ''}`
    : `${node.state || 'connected'}, not scanning`;
  return `
    <div style="font-size:11px; line-height:1.45;">
      <div style="font-weight:700; color:${s.scanning ? 'var(--success)' : '#D97706'};">🌀 ${escapeHtml(scanText)}</div>
      <div style="color:${health === 'OK' ? 'var(--success)' : health === 'WARNING' ? '#D97706' : 'var(--danger)'};">LiDAR health ${escapeHtml(health)}</div>
    </div>
  `;
}

function rememberRoomSensor(s) {
  if (!s || !s.mac) return;
  roomSensorLive.set(s.mac, s);
  if (s.device_id) roomSensorLive.set(s.device_id, s);
}

/** Loads the live LiDAR states once; later ones arrive as ROOM_SENSOR_STATUS messages. */
async function loadRoomSensorStatus() {
  try {
    const res = await fetch('/api/room-sensors/status');
    const data = await res.json();
    if (data.success && Array.isArray(data.sensors)) data.sensors.forEach(rememberRoomSensor);
  } catch (err) {
    console.warn('[DEVICES] Could not load the LiDAR status:', err.message);
  }
}

/**
 * Robust helper to invoke custom modal safely.
 */
function safeShowModal(options) {
  const modalFn = window.showModal || (typeof showModal === 'function' ? showModal : null);
  if (modalFn) {
    modalFn(options);
  } else {
    alert(options.message || options.title || 'Notice');
  }
}

/**
 * Robust helper to show toast notifications safely.
 */
function safeShowToast(message, type = 'info', duration = 3500) {
  const toastFn = window.showToast || (typeof showToast === 'function' ? showToast : null);
  if (toastFn) {
    toastFn(message, type, duration);
  } else {
    console.log(`[TOAST ${type}] ${message}`);
  }
}

/**
 * Initializes the Devices module.
 */
async function initDevicesModule() {
  setupDeviceWsListeners();
  await loadRoomSensorStatus();
  await Promise.all([
    loadDevicesFleet(),
    loadUnprovisionedDiscovery()
  ]);
}

/**
 * Registers real-time WebSocket listeners to dynamically track physical hardware activity.
 */
function setupDeviceWsListeners() {
  if (isWsListenersRegistered || !window.wsClient) return;
  isWsListenersRegistered = true;

  // 1. Live RSSI from Anchor nodes
  window.wsClient.on('ANCHOR_RSSI', (msg) => {
    if (!msg || !msg.anchor) return;
    markDeviceLiveStatus(msg.anchor, 'ANCHOR', { rssi: msg.raw_rssi });
  });

  // 2. Live Telemetry from Wristbands via Anchor Beacons
  window.wsClient.on('TELEMETRY', (msg) => {
    const wristbandId = msg.data?.tag_id || msg.tag_id || 'TAG-001';
    const isCharging = (msg.data?.charging === true || msg.data?.charging === 'true');
    markDeviceLiveStatus(wristbandId, 'WRISTBAND', {
      battery: msg.data?.bat !== undefined ? msg.data.bat : (msg.data?.battery !== undefined ? msg.data.battery : null),
      status: isCharging ? 'CHARGING' : 'ONLINE',
      is_charging: isCharging
    });
  });

  // 3. Heartbeat / Discovery updates from Edge Server
  window.wsClient.on('DEVICE_HEARTBEAT', (msg) => {
    if (!msg || !msg.device_id) return;
    markDeviceLiveStatus(msg.device_id, msg.device_type, {
      status: msg.status || 'ONLINE',
      battery: msg.battery_level,
      is_charging: msg.is_charging || (msg.status === 'CHARGING'),
      rssi: msg.rssi
    });
  });

  // 4. Discovery Radar updates
  window.wsClient.on('DISCOVERY_RADAR', (msg) => {
    if (!msg || !msg.device) return;
    const dev = msg.device;
    const idx = cachedUnprovisioned.findIndex(u => u.mac === dev.mac);
    if (idx >= 0) {
      cachedUnprovisioned[idx] = dev;
    } else {
      cachedUnprovisioned.unshift(dev);
    }
    renderDiscoveryTable(cachedUnprovisioned);
  });

  // 5. Radar sync when devices disconnect / drop
  window.wsClient.on('DISCOVERY_RADAR_SYNC', (msg) => {
    if (!msg || !Array.isArray(msg.unprovisioned)) return;
    cachedUnprovisioned = msg.unprovisioned;
    renderDiscoveryTable(cachedUnprovisioned);
  });

  // 6. LiDAR room sensors: scanning, turns per second, LiDAR health (at most once a second each)
  window.wsClient.on('ROOM_SENSOR_STATUS', (msg) => {
    const s = msg && msg.sensor;
    if (!s || !s.mac) return;
    rememberRoomSensor(s);
    if (s.device_id) {
      const row = document.querySelector(`tr[data-device-id="${CSS.escape(String(s.device_id))}"]`);
      const cell = row && row.querySelector('.device-power-cell');
      if (cell) cell.innerHTML = lidarLiveHtml(s);
    }
    const radarRow = document.querySelector(`tr[data-radar-mac="${CSS.escape(String(s.mac))}"]`);
    const radarCell = radarRow && radarRow.querySelector('.radar-rssi-cell');
    if (radarCell) radarCell.innerHTML = lidarLiveHtml(s);
  });
}

/**
 * Dynamically marks a device as ONLINE/OFFLINE and updates its row in the UI in real time.
 */
// With an On/Off filter, a status change redraws the table: at most once a second
let liveFilterTimer = null;
function scheduleFilteredRedraw() {
  if (liveFilterTimer) return;
  liveFilterTimer = setTimeout(() => {
    liveFilterTimer = null;
    filterDevicesTable();
    updateFleetCounts();
  }, 1000);
}

function markDeviceLiveStatus(deviceId, deviceType, extra = {}) {
  const dev = cachedFleet.find(d => d.device_id === deviceId);
  if (dev) {
    const status = extra.status || 'ONLINE';
    const battery = (extra.battery !== null && extra.battery !== undefined) ? extra.battery : dev.battery_level;
    // A wall sensor sends several messages a second: the page changes only when what
    // it shows does (status or battery), never on each message
    const changed = dev.status !== status || String(battery) !== String(dev.battery_level);
    dev.status = status;
    dev.last_seen = extra.status === 'OFFLINE' ? 'Signal Lost' : 'Just now (Live)';
    dev.battery_level = battery;
    if (!changed) return;

    if (currentStatusFilter !== null) {
      scheduleFilteredRedraw();
    } else {
      // Update status badge directly in DOM if visible
      const row = document.querySelector(`tr[data-device-id="${CSS.escape(String(deviceId))}"]`);
      if (row) {
        const statusCell = row.querySelector('.device-status-cell');
        if (statusCell) {
          if (dev.status === 'ONLINE') {
            statusCell.innerHTML = `<span class="badge badge-live">● On</span>`;
          } else if (dev.status === 'OFFLINE') {
            statusCell.innerHTML = `<span class="badge badge-neutral" title="Off, or out of reach">○ Off</span>`;
          } else if (dev.status === 'CHARGING') {
            statusCell.innerHTML = `<span class="badge badge-warning">⚡ Charging</span>`;
          } else {
            statusCell.innerHTML = `<span class="badge badge-neutral">● ${escapeHtml(dev.status)}</span>`;
          }
        }

        const powerCell = row.querySelector('.device-power-cell');
        if (powerCell && dev.battery_level !== null && dev.battery_level !== undefined) {
          const bat = Math.min(100, Math.max(0, Number(dev.battery_level)));
          const isCharging = (dev.status === 'CHARGING' || extra.is_charging === true);
          const barColor = isCharging ? '#D97706' : (bat > 40 ? '#16A34A' : bat > 20 ? '#D97706' : '#DC2626');
          const textColor = isCharging ? '#D97706' : (bat <= 20 ? '#DC2626' : 'var(--text-secondary)');
          powerCell.innerHTML = `
            <div style="width: 100px;">
              <div style="font-size: 11px; font-weight: 600; color: ${textColor}; margin-bottom: 2px;">
                ${bat}% ${isCharging ? '⚡ Charging' : ''}
              </div>
              <div class="progress-bar-bg" style="height:6px; background:#E2E8F0; border-radius:3px; overflow:hidden; margin:0;">
                <div class="progress-bar-fill" style="width: ${bat}%; height:100%; background: ${barColor}; border-radius:3px;"></div>
              </div>
            </div>
          `;
        }
      }
    }
    updateFleetCounts();
  }
}

/**
 * Loads registered devices from MySQL.
 */
async function loadDevicesFleet() {
  const tbody = document.getElementById('devices-table-body');
  if (!tbody) return;

  try {
    const res = await fetch('/api/devices/list');
    const data = await res.json();

    if (data.success) {
      cachedFleet = data.devices || [];
      filterDevicesTable();
      updateFleetCounts();
    } else {
      tbody.innerHTML = `<tr><td colspan="7" class="empty-state" style="color:var(--danger);">The devices could not be loaded: ${escapeHtml(data.error || 'server error')}</td></tr>`;
    }
  } catch (err) {
    console.error('loadDevicesFleet error:', err);
    tbody.innerHTML = `<tr><td colspan="7" class="empty-state" style="color:var(--danger);">The server does not answer. Check that it is running, then reload the page.</td></tr>`;
  }
}

/**
 * Loads unprovisioned devices currently heard on the discovery radar.
 */
async function loadUnprovisionedDiscovery() {
  const tbody = document.getElementById('unprovisioned-table-body');
  if (!tbody) return;

  try {
    const res = await fetch('/api/devices/unprovisioned');
    const data = await res.json();

    if (data.success) {
      cachedUnprovisioned = data.unprovisioned || [];
      renderDiscoveryTable(cachedUnprovisioned);
    }
  } catch (err) {
    console.error('loadUnprovisionedDiscovery error:', err);
  }
}

/**
 * Triggers manual scan / refresh for nearby devices.
 */
async function refreshDiscoveryRadar(button) {
  const badge = document.getElementById('radar-status-badge');
  const done = window.ShiroUI.busy(button || document.getElementById('btn-refresh-radar'), 'Searching…');
  if (badge) badge.innerText = '● Searching…';
  const before = new Set(cachedUnprovisioned.map(d => d.mac));
  const started = Date.now();

  await loadUnprovisionedDiscovery();
  // Long enough to be seen, even when the answer is instant
  const wait = 700 - (Date.now() - started);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  done();
  if (badge) badge.innerText = '● Listening';

  const found = cachedUnprovisioned.length;
  const fresh = cachedUnprovisioned.filter(d => !before.has(d.mac)).length;
  if (found === 0) {
    safeShowToast('No new devices found. Switch the device on near a wall sensor, then search again.', 'info', 5000);
  } else {
    safeShowToast(`${found} device${found === 1 ? '' : 's'} waiting to be added${fresh ? ` (${fresh} new)` : ''}.`, 'success');
  }
}

/**
 * Helper to render connection status badge for discovery radar.
 */
function getRadarSignalHtml(d) {
  if (d.device_type === 'ANCHOR') {
    const isTracking = d.status_text === 'TRACKING' || (d.rssi !== null && d.rssi !== 0 && !isNaN(d.rssi));
    return `
      <div style="display:flex; align-items:center; gap:8px;">
        <span class="badge ${isTracking ? 'badge-live' : 'badge-neutral'}" style="font-size:11px;">
          📡 ${isTracking ? 'Heard now' : 'Waiting'}
        </span>
      </div>
    `;
  }

  if (d.device_type === 'HEADSET') {
    return `
      <div style="display:flex; align-items:center; gap:8px;">
        <span class="badge badge-neutral" style="font-size:11px;">🥽 WebXR Client</span>
      </div>
    `;
  }

  if (d.device_type === 'ROOM_SENSOR') return lidarLiveHtml(roomSensorLive.get(d.mac));

  // WRISTBAND
  return `
    <div style="display:flex; align-items:center; gap:8px;">
      <span class="badge badge-info" style="font-size:11px;">🛏️ BLE Broadcast</span>
    </div>
  `;
}

/**
 * Helper to render power source / battery bar for discovery radar.
 */
function getRadarBatteryHtml(d) {
  if (d.device_type === 'ANCHOR') {
    return `<span style="color:var(--text-muted); font-size:12px;">⚡ AC Mains Power</span>`;
  }
  if (d.device_type === 'ROOM_SENSOR') {
    return `<span style="color:var(--text-muted); font-size:12px;">⚡ 5 V supply</span>`;
  }
  if (d.battery_level !== null && d.battery_level !== undefined) {
    const batVal = Math.min(100, Math.max(0, Number(d.battery_level)));
    const isCharging = (d.is_charging === true || d.status_text === 'CHARGING' || d.status === 'CHARGING');
    const batColor = isCharging ? '#D97706' : (batVal > 40 ? '#16A34A' : batVal > 20 ? '#D97706' : '#DC2626');
    const textColor = isCharging ? '#D97706' : (batVal <= 20 ? '#DC2626' : 'var(--text-secondary)');
    return `
      <div style="width: 100px;">
        <div style="font-size: 11px; font-weight: 600; color: ${textColor}; margin-bottom: 2px;">
          ${batVal}% ${isCharging ? '⚡ Charging' : ''}
        </div>
        <div class="progress-bar-bg" style="height:6px; background:#E2E8F0; border-radius:3px; overflow:hidden; margin:0;">
          <div class="progress-bar-fill" style="width: ${batVal}%; height:100%; background: ${batColor}; border-radius:3px;"></div>
        </div>
      </div>
    `;
  }
  return `<span style="color:var(--text-muted); font-size:12px;">⚡ USB Powered</span>`;
}

/**
 * Renders the Live Discovery Radar table with stable, in-place DOM updates.
 * Never destroys buttons on live updates to prevent jitter, page lag, and unclickable buttons.
 */
function renderDiscoveryTable(items) {
  const pagerEl = document.getElementById('unprovisioned-pager');
  const list = items || [];
  // Nothing new: one slim line instead of an empty table; something new: a banner
  const card = document.getElementById('discovery-card');
  const wrap = document.getElementById('discovery-table-wrap');
  const summary = document.getElementById('discovery-summary');
  if (card) card.classList.toggle('has-new', list.length > 0);
  if (wrap) wrap.style.display = list.length ? '' : 'none';
  if (summary) {
    summary.innerText = list.length
      ? `${list.length} device${list.length === 1 ? ' is' : 's are'} switched on and waiting to be added. Press "Add" on the row.`
      : 'No new devices. Switch a wristband or sensor on near a wall sensor; it appears here within a few seconds.';
  }
  const pageData = window.ShiroUI.paginate(list, discoveryPage);
  discoveryPage = pageData.page;
  if (pagerEl) {
    window.ShiroUI.renderPager(pagerEl, {
      total: pageData.total, page: pageData.page, noun: 'devices',
      onPage: (n) => { discoveryPage = n; renderDiscoveryTable(cachedUnprovisioned); }
    });
  }
  renderDiscoveryRows(pageData.items);
}

function renderDiscoveryRows(items) {
  const tbody = document.getElementById('unprovisioned-table-body');
  if (!tbody) return;

  if (!items || items.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-state">
      <strong>No new devices.</strong>Switch a wristband or sensor on near a wall sensor; it appears here within a few seconds.
    </td></tr>`;
    return;
  }

  // Clear empty state placeholder row if present
  const placeholder = tbody.querySelector('td[colspan="7"]');
  if (placeholder) {
    tbody.innerHTML = '';
  }

  const currentMacs = new Set(items.map(d => d.mac));

  // 1. Remove rows of devices that have stopped broadcasting / unplugged
  tbody.querySelectorAll('tr[data-radar-mac]').forEach(row => {
    const mac = row.getAttribute('data-radar-mac');
    if (!currentMacs.has(mac)) {
      row.remove();
    }
  });

  // 2. In-place update or create rows
  items.forEach(d => {
    const existingRow = tbody.querySelector(`tr[data-radar-mac="${CSS.escape(String(d.mac))}"]`);
    if (existingRow) {
      // In-place update: only refresh RSSI & battery without rebuilding button or row
      const rssiCell = existingRow.querySelector('.radar-rssi-cell');
      if (rssiCell) {
        rssiCell.innerHTML = getRadarSignalHtml(d);
      }
      const batCell = existingRow.querySelector('.radar-battery-cell');
      if (batCell) {
        batCell.innerHTML = getRadarBatteryHtml(d);
      }
    } else {
      // Create new row once
      const tr = document.createElement('tr');
      tr.setAttribute('data-radar-mac', d.mac);

      const typePill = deviceTypeBadge(d.device_type);

      tr.innerHTML = `
        <td class="mono" style="font-weight: 700; color: var(--primary);">${escapeHtml(d.mac)}</td>
        <td>${escapeHtml(d.hardware_model)}</td>
        <td>${typePill}</td>
        <td class="radar-rssi-cell">${getRadarSignalHtml(d)}</td>
        <td class="radar-battery-cell">${getRadarBatteryHtml(d)}</td>
        <td class="radar-time-cell" style="color: var(--text-secondary); font-size:12px;">
          <span class="mono" style="font-weight:600;">${escapeHtml(d.first_detected || 'Just now')}</span>
          <span style="font-size:10px; color:var(--success); margin-left:4px;">● Live</span>
        </td>
        <td style="text-align: right;">
          <button class="btn btn-primary btn-sm"${actionAttrs('openEnrollModal', [d.mac, d.hardware_model, d.device_type, d.battery_level !== null && d.battery_level !== undefined ? d.battery_level : null, d.ip_address || ''])}>
            ➕ Enroll Device
          </button>
        </td>
      `;
      tbody.appendChild(tr);
    }
  });
}

/**
 * Resolves the effective clinical availability status for a device.
 * Priority:
 * 1. UNAVAILABLE / MAINTENANCE -> 'UNAVAILABLE'
 * 2. Assigned to a ward room or bound to a patient or status IN_USE -> 'IN_USE'
 * 3. Otherwise -> 'AVAILABLE'
 */
function getEffectiveAvailability(d) {
  if (d.availability_status === 'UNAVAILABLE' || d.availability_status === 'MAINTENANCE') {
    return 'UNAVAILABLE';
  }
  if (d.bound_patient_name || d.anchor_slot || d.sensor_slot || d.assigned_ward_id || d.availability_status === 'IN_USE') {
    return 'IN_USE';
  }
  return 'AVAILABLE';
}

/**
 * What a device is used for now, in words, or '' when it is free: the patient
 * wearing a wristband, the ward place of a wall sensor or a LiDAR.
 */
function deviceUseText(d) {
  if (d.bound_patient_name) return `worn by ${d.bound_patient_name} (${d.bound_patient_id})`;
  if (d.anchor_slot) return `the wall sensor ${d.anchor_slot}`;
  if (d.sensor_slot) return `the LiDAR ${d.sensor_slot}`;
  if (d.assigned_ward_id) return `assigned to ${d.assigned_ward_id}`;
  if (d.availability_status === 'IN_USE') return 'marked as in use';
  return '';
}

/**
 * Toggles the Operating Status filter (ONLINE vs OFFLINE).
 * Mutually exclusive within Operating group. Clicking active button deactivates it.
 */
function toggleStatusFilter(status) {
  devicesPage = 1;
  currentStatusFilter = (currentStatusFilter === status) ? null : status;
  updateFilterButtonsUI();
  filterDevicesTable();
}

/**
 * Toggles the Availability Status filter (AVAILABLE vs IN_USE vs UNAVAILABLE).
 * Mutually exclusive within Availability group. Clicking active button deactivates it.
 */
function toggleAvailFilter(avail) {
  devicesPage = 1;
  currentAvailFilter = (currentAvailFilter === avail) ? null : avail;
  updateFilterButtonsUI();
  filterDevicesTable();
}

/**
 * Updates the visual active class for all filter buttons.
 */
function updateFilterButtonsUI() {
  const btnOnline = document.getElementById('filter-btn-online');
  const btnOffline = document.getElementById('filter-btn-offline');
  const btnAvail = document.getElementById('filter-btn-available');
  const btnInUse = document.getElementById('filter-btn-inuse');
  const btnUnavail = document.getElementById('filter-btn-unavailable');

  if (btnOnline) btnOnline.classList.toggle('active', currentStatusFilter === 'ONLINE');
  if (btnOffline) btnOffline.classList.toggle('active', currentStatusFilter === 'OFFLINE');
  if (btnAvail) btnAvail.classList.toggle('active', currentAvailFilter === 'AVAILABLE');
  if (btnInUse) btnInUse.classList.toggle('active', currentAvailFilter === 'IN_USE');
  if (btnUnavail) btnUnavail.classList.toggle('active', currentAvailFilter === 'UNAVAILABLE');
}

/**
 * Updates Fleet Category Counts and Status / Availability Badges with live counts.
 */
function updateFleetCounts() {
  const pillAll = document.getElementById('filter-pill-all');
  const pillWristband = document.getElementById('filter-pill-wristband');
  const pillAnchor = document.getElementById('filter-pill-anchor');
  const pillHeadset = document.getElementById('filter-pill-headset');
  const pillRoomSensor = document.getElementById('filter-pill-room-sensor');

  const countBadge = document.getElementById('fleet-count-badge');

  const elOnlineCount = document.getElementById('stat-online-count');
  const elOfflineCount = document.getElementById('stat-offline-count');
  const elAvailCount = document.getElementById('stat-avail-count');
  const elInUseCount = document.getElementById('stat-inuse-count');
  const elUnavailCount = document.getElementById('stat-unavail-count');

  const total = cachedFleet.length;
  const wristbands = cachedFleet.filter(d => d.device_type === 'WRISTBAND').length;
  const anchors = cachedFleet.filter(d => d.device_type === 'ANCHOR').length;
  const headsets = cachedFleet.filter(d => d.device_type === 'HEADSET').length;
  const roomSensors = cachedFleet.filter(d => d.device_type === 'ROOM_SENSOR').length;

  const online = cachedFleet.filter(d => d.status === 'ONLINE' || d.status === 'CHARGING').length;
  const offline = cachedFleet.filter(d => d.status === 'OFFLINE' || (!d.status || d.status === 'STANDBY')).length;

  const available = cachedFleet.filter(d => getEffectiveAvailability(d) === 'AVAILABLE').length;
  const inUse = cachedFleet.filter(d => getEffectiveAvailability(d) === 'IN_USE').length;
  const unavailable = cachedFleet.filter(d => getEffectiveAvailability(d) === 'UNAVAILABLE').length;

  if (pillAll) pillAll.innerText = `All (${total})`;
  if (pillWristband) pillWristband.innerText = `Wristbands (${wristbands})`;
  if (pillAnchor) pillAnchor.innerText = `Wall sensors (${anchors})`;
  if (pillHeadset) pillHeadset.innerText = `Headsets (${headsets})`;
  if (pillRoomSensor) pillRoomSensor.innerText = `LiDAR (${roomSensors})`;

  if (countBadge) countBadge.innerText = `${total} device${total === 1 ? '' : 's'}`;

  if (elOnlineCount) elOnlineCount.innerText = online;
  if (elOfflineCount) elOfflineCount.innerText = offline;
  if (elAvailCount) elAvailCount.innerText = available;
  if (elInUseCount) elInUseCount.innerText = inUse;
  if (elUnavailCount) elUnavailCount.innerText = unavailable;
}

/**
 * Filter table by category tab pill.
 */
function setDeviceTypeFilter(type, btn) {
  currentDeviceTypeFilter = type;
  devicesPage = 1;
  document.querySelectorAll('.filter-pills .filter-pill').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  filterDevicesTable();
}

/**
 * Master multi-dimensional filter across Category, Operating Status, Availability, and Search Query.
 */
function filterDevicesTable() {
  const input = document.getElementById('device-search-input');
  const q = input ? input.value.trim().toLowerCase() : '';

  const filtered = cachedFleet.filter(d => {
    // 1. Category Filter Pill
    if (currentDeviceTypeFilter !== 'ALL' && d.device_type !== currentDeviceTypeFilter) {
      return false;
    }

    // 2. Operating Status Filter (ONLINE vs OFFLINE)
    if (currentStatusFilter === 'ONLINE') {
      const isOnline = (d.status === 'ONLINE' || d.status === 'CHARGING');
      if (!isOnline) return false;
    } else if (currentStatusFilter === 'OFFLINE') {
      const isOffline = (d.status === 'OFFLINE' || (!d.status || d.status === 'STANDBY'));
      if (!isOffline) return false;
    }

    // 3. Availability Status Filter (AVAILABLE vs IN_USE vs UNAVAILABLE)
    if (currentAvailFilter !== null) {
      const effective = getEffectiveAvailability(d);
      if (effective !== currentAvailFilter) return false;
    }

    // 4. Search Query Filter
    if (q) {
      const matchesSearch = (
        (d.device_id && d.device_id.toLowerCase().includes(q)) ||
        (d.mac_address && d.mac_address.toLowerCase().includes(q)) ||
        (d.hardware_model && d.hardware_model.toLowerCase().includes(q)) ||
        (d.assigned_ward_id && d.assigned_ward_id.toLowerCase().includes(q)) ||
        (d.ward_title && d.ward_title.toLowerCase().includes(q)) ||
        (d.bound_patient_name && d.bound_patient_name.toLowerCase().includes(q)) ||
        (d.ip_address && d.ip_address.toLowerCase().includes(q))
      );
      if (!matchesSearch) return false;
    }

    return true;
  });

  renderDevicesTable(filtered);
}

/**
 * Renders the Enrolled Fleet Table.
 * Exactly 8 columns:
 * 1. Device Identifier
 * 2. Category
 * 3. Physical MAC & IP
 * 4. Hardware & Firmware
 * 5. Battery / Power
 * 6. Operating
 * 7. Availability
 * 8. Fleet Actions
 */
function renderDevicesTable(filtered) {
  const tbody = document.getElementById('devices-table-body');
  if (!tbody) return;

  const pagerEl = document.getElementById('devices-pager');
  const pageData = window.ShiroUI.paginate(filtered, devicesPage);
  devicesPage = pageData.page;
  if (pagerEl) {
    window.ShiroUI.renderPager(pagerEl, {
      total: pageData.total, page: pageData.page, noun: 'devices',
      onPage: (n) => { devicesPage = n; renderDevicesTable(filtered); }
    });
  }

  if (filtered.length === 0) {
    let msg = 'No devices added yet. Switch a device on: it appears under "New devices nearby", ready to add. Or use "＋ Add device by hand".';
    if (cachedFleet.length > 0) {
      const activeFilters = [];
      if (currentDeviceTypeFilter !== 'ALL') activeFilters.push(`Category: ${currentDeviceTypeFilter}`);
      if (currentStatusFilter) activeFilters.push(`Status: ${currentStatusFilter}`);
      if (currentAvailFilter) activeFilters.push(`Availability: ${currentAvailFilter}`);
      const input = document.getElementById('device-search-input');
      const q = input ? input.value.trim() : '';
      if (q) activeFilters.push(`Search: "${q}"`);

      msg = `No device matches the filters (${activeFilters.join(', ')}).`;
    }
    tbody.innerHTML = `<tr><td colspan="7" class="empty-state">${escapeHtml(msg)}</td></tr>`;
    return;
  }

  tbody.innerHTML = pageData.items.map(d => {
    const typeBadge = deviceTypeBadge(d.device_type);

    let statusBadge = `<span class="badge badge-live">● On</span>`;
    if (d.status === 'CHARGING') {
      statusBadge = `<span class="badge badge-warning">⚡ Charging</span>`;
    } else if (d.status === 'OFFLINE' || (!d.status || d.status === 'STANDBY')) {
      statusBadge = `<span class="badge badge-neutral" title="Off, or out of reach">○ Off</span>`;
    }

    // Wall sensors run on mains; anything else that has not reported a battery level says so
    let powerDisplay = d.device_type === 'ANCHOR'
      ? '<span style="color:var(--text-muted); font-size:12px;">⚡ Mains / USB</span>'
      : '<span style="color:var(--text-muted); font-size:12px;">not reported yet</span>';
    if (d.device_type === 'ROOM_SENSOR') {
      powerDisplay = lidarLiveHtml(roomSensorLive.get(d.device_id) || roomSensorLive.get(String(d.mac_address || '').toUpperCase()));
    } else if (d.battery_level !== null && d.battery_level !== undefined) {
      const bat = Math.min(100, Math.max(0, Number(d.battery_level)));
      const isCharging = (d.status === 'CHARGING' || d.is_charging === true);
      const batColor = isCharging ? '#D97706' : (bat > 40 ? '#16A34A' : bat > 20 ? '#D97706' : '#DC2626');
      const textColor = isCharging ? '#D97706' : (bat <= 20 ? '#DC2626' : 'var(--text-secondary)');
      powerDisplay = `
        <div style="width: 100px;">
          <div style="font-size: 11px; font-weight: 600; color: ${textColor}; margin-bottom: 2px;">
            ${bat}% ${isCharging ? '⚡ Charging' : ''}
          </div>
          <div class="progress-bar-bg" style="height:6px; background:#E2E8F0; border-radius:3px; overflow:hidden; margin:0;">
            <div class="progress-bar-fill" style="width: ${bat}%; height:100%; background: ${batColor}; border-radius:3px;"></div>
          </div>
        </div>
      `;
    }

    const effectiveAvail = getEffectiveAvailability(d);
    let availBadge = '<span class="badge badge-live">Free</span>';
    if (effectiveAvail === 'IN_USE') {
      availBadge = '<span class="badge badge-info">In use</span>';
    } else if (effectiveAvail === 'UNAVAILABLE') {
      availBadge = '<span class="badge badge-warning">Out of use</span>';
    }
    // Where it is used: the patient wearing it, else its place in a ward
    const whereText = d.bound_patient_name ? `👤 ${d.bound_patient_name}`
      : d.anchor_slot || d.sensor_slot ? `📍 ${d.anchor_slot || d.sensor_slot}`
        : d.assigned_ward_id ? `📍 ${d.assigned_ward_id}` : '–';
    // Technical details on hover; nothing invented when unknown
    const details = [`MAC ${d.mac_address || 'unknown'}`, `network ${d.ip_address || (d.device_type === 'WRISTBAND' ? 'none (Bluetooth only)' : 'unknown')}`,
      `model ${d.hardware_model || 'unknown'}`, `firmware ${d.firmware_version || 'unknown'}`].join(' · ');

    return `
      <tr data-device-id="${escapeHtml(d.device_id)}">
        <td title="${escapeHtml(details)}">
          <div style="font-weight: 700; color: var(--text-primary);">${escapeHtml(d.device_id)}</div>
          <div class="mono" style="color: var(--text-muted); font-size: 12px;">${escapeHtml(d.mac_address || '')}</div>
        </td>
        <td>${typeBadge}</td>
        <td>${escapeHtml(whereText)}</td>
        <td class="device-power-cell">${powerDisplay}</td>
        <td class="device-status-cell">
          ${statusBadge}
        </td>
        <td class="device-avail-cell">
          ${availBadge}
        </td>
        <td style="text-align: right; white-space: nowrap;">
          <button class="btn btn-outline btn-sm"${actionAttrs('openEditDeviceModal', [d.device_id])} title="Name, ward, model, in use or out of use">
            ✏️ Edit
          </button>
          <button class="btn btn-danger-outline btn-sm"${actionAttrs('confirmDeleteDevice', [d.device_id])} title="Delete this device" style="margin-left:4px;">
            🗑️
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

/**
 * Sends Ping LED diagnostic command to physical hardware.
 */
async function pingDevice(deviceId) {
  try {
    const res = await fetch('/api/devices/ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: deviceId })
    });
    const data = await res.json();
    if (data.success) {
      safeShowToast(`MQTT [CMD_PING_LED] dispatched to "${deviceId}". Visual LED is flashing!`, 'info', 4000);
    } else {
      safeShowToast(`Ping failed: ${data.error}`, 'warning');
    }
  } catch (err) {
    console.error('pingDevice error:', err);
    safeShowToast('Network error pinging device.', 'danger');
  }
}

/**
 * Opens modal to enroll an unprovisioned device detected by discovery radar.
 * Dynamically queries MySQL for the current next sequential ID for this category.
 */
async function openEnrollModal(mac, model, type, battery, ip) {
  let initialId = '';
  try {
    const nextRes = await fetch(`/api/devices/next-id?type=${encodeURIComponent(type || 'WRISTBAND')}`);
    const nextData = await nextRes.json();
    if (nextData.success && nextData.nextId) {
      initialId = nextData.nextId;
    }
  } catch (err) {
    console.warn('[DEVICES] Could not get the next device ID:', err.message);
  }

  // No assumed ID: a default such as TAG-001 may already belong to another device.
  if (!initialId) {
    safeShowToast('Could not get a free device ID from the edge server. Please try again.', 'danger');
    return;
  }

  const typePill = deviceTypeBadge(type);

  const modalHtml = `
    <div style="font-size:13px; color:var(--text-secondary); margin-bottom:16px;">
      Confirm enrollment of detected broadcasting hardware into the hospital active inventory:
    </div>

    <div style="background:var(--bg-card); border:1px solid var(--border); border-radius:8px; padding:16px; margin-bottom:16px;">
      <div style="display:grid; grid-template-columns: 1fr 1fr; gap:14px; font-size:13px;">
        <div>
          <span style="color:var(--text-muted); font-size:11px; text-transform:uppercase; font-weight:600; display:block; margin-bottom:2px;">Assigned Device ID</span>
          <strong class="mono" style="font-size:14px; color:var(--primary);">${escapeHtml(initialId)}</strong>
        </div>
        <div>
          <span style="color:var(--text-muted); font-size:11px; text-transform:uppercase; font-weight:600; display:block; margin-bottom:2px;">Device Category</span>
          ${typePill}
        </div>
        <div>
          <span style="color:var(--text-muted); font-size:11px; text-transform:uppercase; font-weight:600; display:block; margin-bottom:2px;">Hardware Model</span>
          <strong>${escapeHtml(model || 'ESP32')}</strong>
        </div>
        <div>
          <span style="color:var(--text-muted); font-size:11px; text-transform:uppercase; font-weight:600; display:block; margin-bottom:2px;">Physical MAC Address</span>
          <span class="mono" style="font-weight:600; font-size:12px;">${escapeHtml(mac)}</span>
        </div>
        <div>
          <span style="color:var(--text-muted); font-size:11px; text-transform:uppercase; font-weight:600; display:block; margin-bottom:2px;">Live Connectivity</span>
          <span class="badge badge-live">● On</span>
        </div>
        <div>
          <span style="color:var(--text-muted); font-size:11px; text-transform:uppercase; font-weight:600; display:block; margin-bottom:2px;">Initial Availability</span>
          <span class="badge badge-live">Available (Ready for Use)</span>
        </div>
      </div>
    </div>
  `;

  safeShowModal({
    title: `Enroll Hardware: ${initialId}`,
    customHtml: modalHtml,
    type: 'info',
    confirmText: '➕ Confirm Enrollment',
    cancelText: 'Cancel',
    onConfirm: async () => {
      try {
        const res = await fetch('/api/devices/enroll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            device_id: initialId,
            mac_address: mac,
            device_type: type,
            hardware_model: model || 'ESP32',
            battery_level: battery,
            ip_address: ip || null,
            status: 'ONLINE',
            availability_status: 'AVAILABLE'
          })
        });

        const result = await res.json();
        if (result.success) {
          safeShowToast(`Device ${initialId} enrolled successfully!`, 'success');
          await Promise.all([
            loadDevicesFleet(),
            loadUnprovisionedDiscovery()
          ]);
        } else {
          safeShowModal({
            title: 'Enrollment Failed',
            message: result.error || 'Server error saving device to MySQL.',
            type: 'danger',
            confirmText: 'OK'
          });
        }
      } catch (err) {
        console.error('Enroll device error:', err);
        safeShowToast('Network error enrolling device.', 'danger');
      }
    }
  });
}

/**
 * Opens modal to manually pre-provision a device.
 */
async function openManualEnrollModal() {
  const modalHtml = `
    <div style="font-size:13px; color:var(--text-secondary); margin-bottom:14px;">
      Manually register an unpowered hardware board into inventory using its physical MAC address.
    </div>

    <div class="form-grid-2">
      <div class="form-group">
        <label class="form-label" style="font-weight:600;">Device Category <span class="req" aria-hidden="true">*</span></label>
        <select class="form-control" id="manual-dev-type" onchange="updateSuggestedManualId()">
          <option value="WRISTBAND" selected>🛏️ Wearable Wristband Tag</option>
          <option value="ANCHOR">📡 Stationary Wall Anchor</option>
          <option value="HEADSET">🥽 Meta Quest 3 Headset</option>
          <option value="ROOM_SENSOR">🌀 LiDAR Room Sensor</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label" style="font-weight:600;">Device Identifier</label>
        <input type="text" class="form-control mono" id="manual-dev-id" value="TAG-C6-01" readonly style="background:#F1F5F9;">
      </div>
    </div>

    <div class="form-grid-2">
      <div class="form-group">
        <label class="form-label" style="font-weight:600;">Physical MAC Address <span class="req" aria-hidden="true">*</span></label>
        <input type="text" class="form-control mono" id="manual-dev-mac" placeholder="e.g. A4:CF:12:01:F8:32" required>
      </div>
      <div class="form-group">
        <label class="form-label" style="font-weight:600;">Hardware Model</label>
        <input type="text" class="form-control" id="manual-dev-model" value="Seeed Studio XIAO ESP32-C6" readonly style="background:#F1F5F9;">
      </div>
    </div>
  `;

  window.updateSuggestedManualId = async function() {
    const t = document.getElementById('manual-dev-type')?.value;
    const modelInput = document.getElementById('manual-dev-model');
    if (t === 'ANCHOR' && modelInput) modelInput.value = 'ESP32-WROOM-32E';
    if (t === 'HEADSET' && modelInput) modelInput.value = 'Meta Quest 3 (128GB)';
    if (t === 'WRISTBAND' && modelInput) modelInput.value = 'Seeed Studio XIAO ESP32-C6';
    if (t === 'ROOM_SENSOR' && modelInput) modelInput.value = 'ESP32-S3 + RPLIDAR C1';

    try {
      const res = await fetch(`/api/devices/next-id?type=${encodeURIComponent(t)}`);
      const data = await res.json();
      if (data.success && data.nextId) {
        const idEl = document.getElementById('manual-dev-id');
        if (idEl) idEl.value = data.nextId;
      }
    } catch (err) {
      console.warn('[DEVICES] Could not get the next device ID:', err.message);
    }
  };

  safeShowModal({
    title: 'Manually Pre-Provision Hardware Device',
    customHtml: modalHtml,
    type: 'info',
    confirmText: '➕ Register Device',
    cancelText: 'Cancel',
    onConfirm: async () => {
      const id = document.getElementById('manual-dev-id')?.value.trim();
      const devType = document.getElementById('manual-dev-type')?.value;
      const mac = document.getElementById('manual-dev-mac')?.value.trim();
      const model = document.getElementById('manual-dev-model')?.value.trim();

      if (!id || !mac || !/^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/.test(mac)) {
        safeShowToast('Please enter a valid MAC address (e.g. A4:CF:12:01:F8:32).', 'warning');
        return;
      }

      try {
        const res = await fetch('/api/devices/enroll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            device_id: id,
            mac_address: mac,
            device_type: devType,
            hardware_model: model,
            availability_status: 'AVAILABLE',
            status: 'OFFLINE'
          })
        });

        const result = await res.json();
        if (result.success) {
          safeShowToast(`Device ${id} successfully pre-provisioned!`, 'success');
          await loadDevicesFleet();
        } else {
          safeShowToast(`Registration failed: ${result.error}`, 'danger');
        }
      } catch (err) {
        console.error('Manual register error:', err);
      }
    }
  });

  setTimeout(window.updateSuggestedManualId, 50);
}

// The boards an anchor can be (Phase 10: not enough WROOM-32E boards for six anchors)
const ANCHOR_MODELS = ['ESP32-WROOM-32E', 'ESP32-S3 (N16R8)', 'Seeed Studio XIAO ESP32-C3'];

/**
 * Opens modal to edit device service availability, hardware model and maintenance.
 */
function openEditDeviceModal(deviceId) {
  const d = cachedFleet.find(dev => dev.device_id === deviceId);
  if (!d) return;

  // An anchor's board is chosen from the list; other devices keep the model they were enrolled with
  const models = d.hardware_model && !ANCHOR_MODELS.includes(d.hardware_model) ? [d.hardware_model, ...ANCHOR_MODELS] : ANCHOR_MODELS;
  const optionsHtml = models.map(m => `<option value="${escapeHtml(m)}" ${m === d.hardware_model ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('');
  const modelField = d.device_type === 'ANCHOR'
    ? `<select class="form-control" id="edit-dev-model">${optionsHtml}</select>`
    : `<input type="text" class="form-control" value="${escapeHtml(d.hardware_model || '')}" readonly style="background:#F1F5F9;">`;

  const isBound = Boolean(d.bound_patient_name);
  const isAssignedWard = Boolean(d.assigned_ward_id);

  let inUseNote = '';
  if (isBound) {
    inUseNote = `<div style="font-size:11px; color:var(--primary); margin-top:4px;">Currently bound to patient: <strong>${escapeHtml(d.bound_patient_name)}</strong>. Unbind from Patient profile to mark Available.</div>`;
  } else if (isAssignedWard) {
    inUseNote = `<div style="font-size:11px; color:var(--text-muted); margin-top:4px;">Currently assigned to ward room: <strong>${escapeHtml(d.assigned_ward_id)}</strong>. Remove in Ward Config to unassign.</div>`;
  }

  const modalHtml = `
    <div style="font-size:13px; color:var(--text-secondary); margin-bottom:14px;">
      Manage service availability and maintenance parameters for <strong>${escapeHtml(d.device_id)}</strong>.
    </div>

    <div class="form-grid-2">
      <div class="form-group">
        <label class="form-label" style="font-weight:600;">Device Identifier</label>
        <input type="text" class="form-control mono" value="${escapeHtml(d.device_id)}" readonly style="background:#F1F5F9;">
      </div>
      <div class="form-group">
        <label class="form-label" style="font-weight:600;">Hardware Category</label>
        <input type="text" class="form-control" value="${escapeHtml(d.device_type)}" readonly style="background:#F1F5F9;">
      </div>
    </div>

    <div class="form-grid-2">
      <div class="form-group">
        <label class="form-label" style="font-weight:600;">Physical MAC Address</label>
        <input type="text" class="form-control mono" value="${escapeHtml(d.mac_address)}" readonly style="background:#F1F5F9;">
      </div>
      <div class="form-group">
        <label class="form-label" style="font-weight:600;">Live Connectivity</label>
        <div style="padding-top:6px;">
          <span class="badge ${d.status === 'ONLINE' ? 'badge-live' : d.status === 'STANDBY' ? 'badge-neutral' : 'badge-alert'}">● ${escapeHtml(d.status)}</span>
          <span style="font-size:11px; color:var(--text-muted); margin-left:6px;">(Auto-detected via RF)</span>
        </div>
      </div>
    </div>

    <div class="form-grid-2">
      <div class="form-group">
        <label class="form-label" style="font-weight:600;">Service Availability <span class="req" aria-hidden="true">*</span></label>
        <select class="form-control" id="edit-dev-availability" ${isBound || isAssignedWard ? 'disabled' : ''}>
          <option value="AVAILABLE" ${d.availability_status === 'AVAILABLE' ? 'selected' : ''}>Available (Ready for Use)</option>
          <option value="UNAVAILABLE" ${d.availability_status === 'UNAVAILABLE' ? 'selected' : ''}>Unavailable (Damaged / Maintenance)</option>
          ${isBound || isAssignedWard ? `<option value="IN_USE" selected>In Use (Currently Deployed)</option>` : ''}
        </select>
        ${inUseNote}
      </div>
      <div class="form-group">
        <label class="form-label" style="font-weight:600;">Firmware Version</label>
        <input type="text" class="form-control" id="edit-dev-fw" value="${escapeHtml(d.firmware_version || 'v1.0.0')}">
      </div>
    </div>

    <div class="form-grid-2">
      <div class="form-group">
        <label class="form-label" style="font-weight:600;">Hardware Model</label>
        ${modelField}
      </div>
    </div>
  `;

  safeShowModal({
    title: `Configure Device: ${d.device_id}`,
    customHtml: modalHtml,
    type: 'info',
    confirmText: '💾 Save Changes',
    cancelText: 'Cancel',
    onConfirm: async () => {
      const availEl = document.getElementById('edit-dev-availability');
      const availability = availEl ? availEl.value : (d.availability_status || 'AVAILABLE');
      const fw = document.getElementById('edit-dev-fw')?.value.trim();
      const modelEl = document.getElementById('edit-dev-model');

      try {
        const res = await fetch('/api/devices/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            device_id: d.device_id,
            availability_status: availability,
            firmware_version: fw,
            ...(modelEl ? { hardware_model: modelEl.value } : {})
          })
        });

        const result = await res.json();
        if (result.success) {
          safeShowToast(`Device ${d.device_id} updated.`, 'success');
          await loadDevicesFleet();
        } else {
          safeShowToast(`Update failed: ${result.error}`, 'danger');
        }
      } catch (err) {
        console.error('Update device error:', err);
        safeShowToast('Network error updating device.', 'danger');
      }
    }
  });
}

/**
 * Prompts danger confirmation modal before deleting a device record.
 */
/**
 * Asks before deleting a device. A device in use says by whom or where, and
 * what stops when it is deleted.
 */
function confirmDeleteDevice(deviceId) {
  const d = cachedFleet.find(x => x.device_id === deviceId) || { device_id: deviceId };
  const use = deviceUseText(d);
  // What stops when it goes, one line each, in the red box of the dialog
  const effects = [];
  if (d.bound_patient_name) {
    effects.push(`It is taken off ${d.bound_patient_name} (${d.bound_patient_id}).`);
    effects.push('Their heart rate, fall alarms, door alerts and position stop until they get another wristband.');
  } else if (d.anchor_slot) {
    effects.push(`Its place (${d.anchor_slot}) stays empty.`);
    effects.push('Positions in that ward get less accurate; with fewer than 3 working wall sensors its live map stops.');
  } else if (d.sensor_slot) {
    effects.push(`Its place (${d.sensor_slot}) stays empty.`);
    effects.push('That ward goes back to Bluetooth positions (about ±1 m), and its door alerts (at the door, left the ward) stop.');
  } else if (use) {
    effects.push('Whatever uses it stops getting its data.');
  }
  effects.push('This cannot be undone. Its history is kept.');
  safeShowModal({
    title: use ? `Delete ${deviceId}? It is in use` : `Delete ${deviceId}?`,
    message: use ? `${deviceId} is ${use}.` : `${deviceId} is not in use.`,
    impact: { level: 'danger', title: use ? 'Deleting it now will:' : 'Before you delete it', points: effects },
    type: 'danger',
    confirmText: use ? 'Delete anyway' : 'Delete',
    cancelText: 'Cancel',
    onConfirm: async () => {
      try {
        const res = await fetch('/api/devices/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ device_id: deviceId })
        });
        const result = await res.json();
        if (result.success) {
          safeShowToast(`${deviceId} deleted.`, 'success');
          await loadDevicesFleet();
        } else {
          safeShowToast(`Not deleted: ${result.error}`, 'danger');
        }
      } catch (err) {
        console.error('Delete device error:', err);
        safeShowToast('The server does not answer. The device was not deleted.', 'danger');
      }
    }
  });
}

// Global exports
window.initDevicesModule = initDevicesModule;
window.refreshDiscoveryRadar = refreshDiscoveryRadar;
window.setDeviceTypeFilter = setDeviceTypeFilter;
window.toggleStatusFilter = toggleStatusFilter;
window.toggleAvailFilter = toggleAvailFilter;
window.filterDevicesTable = filterDevicesTable;
window.pingDevice = pingDevice;
window.openEnrollModal = openEnrollModal;
window.openManualEnrollModal = openManualEnrollModal;
window.openEditDeviceModal = openEditDeviceModal;
window.confirmDeleteDevice = confirmDeleteDevice;

// Wire automatic initialization when document loads or tab switches
document.addEventListener('DOMContentLoaded', () => {
  const devicesTab = document.getElementById('tab-devices');
  if (devicesTab && devicesTab.classList.contains('active')) {
    initDevicesModule();
  }
});
