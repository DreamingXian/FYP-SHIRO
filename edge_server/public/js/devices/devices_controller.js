// =============================================================================
// SHIRO Hospital Edge Admin - Devices Controller (MVC Client Controller)
// Hardware Fleet Provisioning, Discovery Radar, Ward Assignment & Diagnostics
// =============================================================================

let cachedFleet = [];
let cachedUnprovisioned = [];
let cachedDeviceWards = [];
let currentDeviceTypeFilter = 'ALL';
let currentStatusFilter = null; // null | 'ONLINE' | 'OFFLINE'
let currentAvailFilter = null;  // null | 'AVAILABLE' | 'IN_USE' | 'UNAVAILABLE'
let isWsListenersRegistered = false;

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
  await Promise.all([
    fetchWardsForDevices(),
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
}

/**
 * Dynamically marks a device as ONLINE/OFFLINE and updates its row in the UI in real time.
 */
function markDeviceLiveStatus(deviceId, deviceType, extra = {}) {
  const dev = cachedFleet.find(d => d.device_id === deviceId);
  if (dev) {
    dev.status = extra.status || 'ONLINE';
    dev.last_seen = extra.status === 'OFFLINE' ? 'Signal Lost' : 'Just now (Live)';
    if (extra.battery !== null && extra.battery !== undefined) {
      dev.battery_level = extra.battery;
    }

    if (currentStatusFilter !== null) {
      filterDevicesTable();
    } else {
      // Update status badge directly in DOM if visible
      const row = document.querySelector(`tr[data-device-id="${deviceId}"]`);
      if (row) {
        const statusCell = row.querySelector('.device-status-cell');
        if (statusCell) {
          if (dev.status === 'ONLINE') {
            statusCell.innerHTML = `<span class="badge badge-live">● ONLINE</span>`;
          } else if (dev.status === 'OFFLINE') {
            statusCell.innerHTML = `<span class="badge badge-alert">● OFFLINE</span>`;
          } else if (dev.status === 'CHARGING') {
            statusCell.innerHTML = `<span class="badge badge-warning">⚡ CHARGING</span>`;
          } else {
            statusCell.innerHTML = `<span class="badge badge-neutral">● ${dev.status}</span>`;
          }
        }

        const powerCell = row.querySelector('.device-power-cell');
        if (powerCell && dev.battery_level !== null && dev.battery_level !== undefined) {
          const bat = Math.min(100, Math.max(0, dev.battery_level));
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
 * Fetches available wards for the assignment dropdown.
 */
async function fetchWardsForDevices() {
  try {
    const res = await fetch('/api/ward/list');
    const data = await res.json();
    if (data.success) {
      cachedDeviceWards = data.wards || [];
    }
  } catch (err) {
    console.warn('Could not fetch wards for device assignment:', err);
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
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; color:var(--danger); padding:24px;">Failed to load fleet: ${data.error || 'Server error'}</td></tr>`;
    }
  } catch (err) {
    console.error('loadDevicesFleet error:', err);
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; color:var(--danger); padding:24px;">Network error loading hardware fleet from edge server.</td></tr>`;
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
async function refreshDiscoveryRadar() {
  const badge = document.getElementById('radar-status-badge');
  if (badge) badge.innerText = '● Scanning Spectrum...';

  await loadUnprovisionedDiscovery();

  safeShowToast(`Discovery radar refreshed. ${cachedUnprovisioned.length} unprovisioned node(s) detected.`, 'info');

  setTimeout(() => {
    if (badge) badge.innerText = '● MQTT Scanner Active';
  }, 1000);
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
          📡 ${isTracking ? 'Active Tracking' : 'Standby (Scanning)'}
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
  if (d.battery_level !== null && d.battery_level !== undefined) {
    const batVal = Math.min(100, Math.max(0, d.battery_level));
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
  const tbody = document.getElementById('unprovisioned-table-body');
  if (!tbody) return;

  if (!items || items.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:var(--text-muted); padding:24px;">
      No unprovisioned hardware currently broadcasting. Power on a physical node (Anchor, Gateway, or Wristband) to discover it live.
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
    const existingRow = tbody.querySelector(`tr[data-radar-mac="${d.mac}"]`);
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

      const typePill = d.device_type === 'WRISTBAND' 
        ? `<span class="badge badge-info">🛏️ Wristband</span>`
        : d.device_type === 'ANCHOR'
        ? `<span class="badge badge-neutral">📡 Anchor</span>`
        : `<span class="badge badge-neutral">🥽 Headset</span>`;

      tr.innerHTML = `
        <td class="mono" style="font-weight: 700; color: var(--primary);">${d.mac}</td>
        <td>${d.hardware_model}</td>
        <td>${typePill}</td>
        <td class="radar-rssi-cell">${getRadarSignalHtml(d)}</td>
        <td class="radar-battery-cell">${getRadarBatteryHtml(d)}</td>
        <td class="radar-time-cell" style="color: var(--text-secondary); font-size:12px;">
          <span class="mono" style="font-weight:600;">${d.first_detected || 'Just now'}</span>
          <span style="font-size:10px; color:var(--success); margin-left:4px;">● Live</span>
        </td>
        <td style="text-align: right;">
          <button class="btn btn-primary btn-sm" onclick="openEnrollModal('${d.mac}', '${d.hardware_model}', '${d.device_type}', ${d.battery_level !== null ? d.battery_level : 'null'}, '${d.ip_address || ''}')">
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
  if (d.bound_patient_name || d.assigned_ward_id || d.availability_status === 'IN_USE') {
    return 'IN_USE';
  }
  return 'AVAILABLE';
}

/**
 * Toggles the Operating Status filter (ONLINE vs OFFLINE).
 * Mutually exclusive within Operating group. Clicking active button deactivates it.
 */
function toggleStatusFilter(status) {
  currentStatusFilter = (currentStatusFilter === status) ? null : status;
  updateFilterButtonsUI();
  filterDevicesTable();
}

/**
 * Toggles the Availability Status filter (AVAILABLE vs IN_USE vs UNAVAILABLE).
 * Mutually exclusive within Availability group. Clicking active button deactivates it.
 */
function toggleAvailFilter(avail) {
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

  const online = cachedFleet.filter(d => d.status === 'ONLINE' || d.status === 'CHARGING').length;
  const offline = cachedFleet.filter(d => d.status === 'OFFLINE' || (!d.status || d.status === 'STANDBY')).length;

  const available = cachedFleet.filter(d => getEffectiveAvailability(d) === 'AVAILABLE').length;
  const inUse = cachedFleet.filter(d => getEffectiveAvailability(d) === 'IN_USE').length;
  const unavailable = cachedFleet.filter(d => getEffectiveAvailability(d) === 'UNAVAILABLE').length;

  if (pillAll) pillAll.innerText = `All Nodes (${total})`;
  if (pillWristband) pillWristband.innerText = `🛏️ Wristbands (${wristbands})`;
  if (pillAnchor) pillAnchor.innerText = `📡 Anchors (${anchors})`;
  if (pillHeadset) pillHeadset.innerText = `🥽 Headsets (${headsets})`;

  if (countBadge) countBadge.innerText = `${total} Device${total === 1 ? '' : 's'}`;

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

  if (filtered.length === 0) {
    let msg = 'No registered hardware devices in MySQL yet. Power on your physical hardware to discover and enroll them above, or click "➕ Manually Add Device".';
    if (cachedFleet.length > 0) {
      const activeFilters = [];
      if (currentDeviceTypeFilter !== 'ALL') activeFilters.push(`Category: ${currentDeviceTypeFilter}`);
      if (currentStatusFilter) activeFilters.push(`Status: ${currentStatusFilter}`);
      if (currentAvailFilter) activeFilters.push(`Availability: ${currentAvailFilter}`);
      const input = document.getElementById('device-search-input');
      const q = input ? input.value.trim() : '';
      if (q) activeFilters.push(`Search: "${q}"`);

      msg = `No registered hardware matches the active filters (${activeFilters.join(', ')}).`;
    }
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; color:var(--text-muted); padding:32px;">${msg}</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(d => {
    let typeBadge = `<span class="badge badge-info">🛏️ Wristband</span>`;
    if (d.device_type === 'ANCHOR') typeBadge = `<span class="badge badge-neutral">📡 Anchor</span>`;
    if (d.device_type === 'HEADSET') typeBadge = `<span class="badge badge-neutral" style="color:var(--primary); font-weight:700;">🥽 Headset</span>`;

    let statusBadge = `<span class="badge badge-live">● ONLINE</span>`;
    if (d.status === 'CHARGING') {
      statusBadge = `<span class="badge badge-warning">⚡ CHARGING</span>`;
    } else if (d.status === 'OFFLINE' || (!d.status || d.status === 'STANDBY')) {
      statusBadge = `<span class="badge badge-alert">● OFFLINE</span>`;
    }

    let powerDisplay = `<span style="color:var(--text-muted); font-size:11px;">⚡ Mains / USB</span>`;
    if (d.battery_level !== null && d.battery_level !== undefined) {
      const bat = Math.min(100, Math.max(0, d.battery_level));
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
    let availBadge = `<span class="badge badge-live" style="font-size:10px;">Available</span>`;
    if (effectiveAvail === 'IN_USE') {
      let inUseDetail = '';
      if (d.bound_patient_name) {
        inUseDetail = `<div style="font-size:10px; color:var(--text-muted); margin-top:2px;">👤 ${d.bound_patient_name}</div>`;
      } else if (d.assigned_ward_id) {
        inUseDetail = `<div style="font-size:10px; color:var(--text-muted); margin-top:2px;">📍 ${d.assigned_ward_id}</div>`;
      }
      availBadge = `<span class="badge badge-info" style="font-size:10px;">In Use</span>${inUseDetail}`;
    } else if (effectiveAvail === 'UNAVAILABLE') {
      availBadge = `<span class="badge badge-alert" style="font-size:10px;">⚠️ Not Available</span>`;
    }

    return `
      <tr data-device-id="${d.device_id}">
        <td>
          <div style="font-weight: 700; color: var(--text-primary); font-size:13px;">${d.device_id}</div>
        </td>
        <td>${typeBadge}</td>
        <td>
          <div class="mono" style="color: var(--primary); font-weight: 600; font-size:12px;">${d.mac_address}</div>
          <div class="mono" style="color: var(--text-muted); font-size: 11px;">${d.ip_address || 'BLE Beacon (No IP)'}</div>
        </td>
        <td>
          <div style="font-size:12px; color:var(--text-primary);">${d.hardware_model}</div>
          <span class="badge badge-neutral" style="font-size:10px;">${d.firmware_version || 'v1.0.0'}</span>
        </td>
        <td class="device-power-cell">${powerDisplay}</td>
        <td class="device-status-cell">
          ${statusBadge}
        </td>
        <td class="device-avail-cell">
          ${availBadge}
        </td>
        <td style="text-align: right; white-space: nowrap;">
          <button class="btn btn-outline btn-sm" onclick="openEditDeviceModal('${d.device_id}')" title="Configure Availability &amp; Maintenance">
            ⚙️ Edit
          </button>
          <button class="btn btn-danger-outline btn-sm" onclick="confirmDeleteDevice('${d.device_id}')" title="Decommission &amp; Delete Device" style="margin-left:4px;">
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
    const nextRes = await fetch(`/api/devices/next-id?type=${type || 'WRISTBAND'}`);
    const nextData = await nextRes.json();
    if (nextData.success && nextData.nextId) {
      initialId = nextData.nextId;
    }
  } catch (_) {}

  if (!initialId) {
    initialId = type === 'ANCHOR' ? 'anchor-001' : 'TAG-001';
  }

  const typeName = type === 'WRISTBAND' ? '🛏️ Wearable Wristband Tag'
    : type === 'ANCHOR' ? '📡 Stationary Wall Anchor'
    : '🥽 Meta Quest 3 Headset';

  const typePill = type === 'WRISTBAND' ? `<span class="badge badge-info">🛏️ Wristband</span>`
    : type === 'ANCHOR' ? `<span class="badge badge-neutral">📡 Anchor</span>`
    : `<span class="badge badge-neutral">🥽 Headset</span>`;

  const modalHtml = `
    <div style="font-size:13px; color:var(--text-secondary); margin-bottom:16px;">
      Confirm enrollment of detected broadcasting hardware into the hospital active inventory:
    </div>

    <div style="background:var(--bg-card); border:1px solid var(--border); border-radius:8px; padding:16px; margin-bottom:16px;">
      <div style="display:grid; grid-template-columns: 1fr 1fr; gap:14px; font-size:13px;">
        <div>
          <span style="color:var(--text-muted); font-size:11px; text-transform:uppercase; font-weight:600; display:block; margin-bottom:2px;">Assigned Device ID</span>
          <strong class="mono" style="font-size:14px; color:var(--primary);">${initialId}</strong>
        </div>
        <div>
          <span style="color:var(--text-muted); font-size:11px; text-transform:uppercase; font-weight:600; display:block; margin-bottom:2px;">Device Category</span>
          ${typePill}
        </div>
        <div>
          <span style="color:var(--text-muted); font-size:11px; text-transform:uppercase; font-weight:600; display:block; margin-bottom:2px;">Hardware Model</span>
          <strong>${model || 'ESP32'}</strong>
        </div>
        <div>
          <span style="color:var(--text-muted); font-size:11px; text-transform:uppercase; font-weight:600; display:block; margin-bottom:2px;">Physical MAC Address</span>
          <span class="mono" style="font-weight:600; font-size:12px;">${mac}</span>
        </div>
        <div>
          <span style="color:var(--text-muted); font-size:11px; text-transform:uppercase; font-weight:600; display:block; margin-bottom:2px;">Live Connectivity</span>
          <span class="badge badge-live">● ONLINE</span>
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
        <label class="form-label" style="font-weight:600;">Device Category *</label>
        <select class="form-control" id="manual-dev-type" onchange="updateSuggestedManualId()">
          <option value="WRISTBAND" selected>🛏️ Wearable Wristband Tag</option>
          <option value="ANCHOR">📡 Stationary Wall Anchor</option>
          <option value="HEADSET">🥽 Meta Quest 3 Headset</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label" style="font-weight:600;">Device Identifier</label>
        <input type="text" class="form-control mono" id="manual-dev-id" value="TAG-C6-01" readonly style="background:#F1F5F9;">
      </div>
    </div>

    <div class="form-grid-2">
      <div class="form-group">
        <label class="form-label" style="font-weight:600;">Physical MAC Address *</label>
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

    try {
      const res = await fetch(`/api/devices/next-id?type=${t}`);
      const data = await res.json();
      if (data.success && data.nextId) {
        const idEl = document.getElementById('manual-dev-id');
        if (idEl) idEl.value = data.nextId;
      }
    } catch (_) {}
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

/**
 * Opens modal to edit device service availability and maintenance.
 */
function openEditDeviceModal(deviceId) {
  const d = cachedFleet.find(dev => dev.device_id === deviceId);
  if (!d) return;

  const isBound = Boolean(d.bound_patient_name);
  const isAssignedWard = Boolean(d.assigned_ward_id);

  let inUseNote = '';
  if (isBound) {
    inUseNote = `<div style="font-size:11px; color:var(--primary); margin-top:4px;">Currently bound to patient: <strong>${d.bound_patient_name}</strong>. Unbind from Patient profile to mark Available.</div>`;
  } else if (isAssignedWard) {
    inUseNote = `<div style="font-size:11px; color:var(--text-muted); margin-top:4px;">Currently assigned to ward room: <strong>${d.assigned_ward_id}</strong>. Remove in Ward Config to unassign.</div>`;
  }

  const modalHtml = `
    <div style="font-size:13px; color:var(--text-secondary); margin-bottom:14px;">
      Manage service availability and maintenance parameters for <strong>${d.device_id}</strong>.
    </div>

    <div class="form-grid-2">
      <div class="form-group">
        <label class="form-label" style="font-weight:600;">Device Identifier</label>
        <input type="text" class="form-control mono" value="${d.device_id}" readonly style="background:#F1F5F9;">
      </div>
      <div class="form-group">
        <label class="form-label" style="font-weight:600;">Hardware Category</label>
        <input type="text" class="form-control" value="${d.device_type}" readonly style="background:#F1F5F9;">
      </div>
    </div>

    <div class="form-grid-2">
      <div class="form-group">
        <label class="form-label" style="font-weight:600;">Physical MAC Address</label>
        <input type="text" class="form-control mono" value="${d.mac_address}" readonly style="background:#F1F5F9;">
      </div>
      <div class="form-group">
        <label class="form-label" style="font-weight:600;">Live Connectivity</label>
        <div style="padding-top:6px;">
          <span class="badge ${d.status === 'ONLINE' ? 'badge-live' : d.status === 'STANDBY' ? 'badge-neutral' : 'badge-alert'}">● ${d.status}</span>
          <span style="font-size:11px; color:var(--text-muted); margin-left:6px;">(Auto-detected via RF)</span>
        </div>
      </div>
    </div>

    <div class="form-grid-2">
      <div class="form-group">
        <label class="form-label" style="font-weight:600;">Service Availability *</label>
        <select class="form-control" id="edit-dev-availability" ${isBound || isAssignedWard ? 'disabled' : ''}>
          <option value="AVAILABLE" ${d.availability_status === 'AVAILABLE' ? 'selected' : ''}>Available (Ready for Use)</option>
          <option value="UNAVAILABLE" ${d.availability_status === 'UNAVAILABLE' ? 'selected' : ''}>Unavailable (Damaged / Maintenance)</option>
          ${isBound || isAssignedWard ? `<option value="IN_USE" selected>In Use (Currently Deployed)</option>` : ''}
        </select>
        ${inUseNote}
      </div>
      <div class="form-group">
        <label class="form-label" style="font-weight:600;">Firmware Version</label>
        <input type="text" class="form-control" id="edit-dev-fw" value="${d.firmware_version || 'v1.0.0'}">
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

      try {
        const res = await fetch('/api/devices/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            device_id: d.device_id,
            availability_status: availability,
            firmware_version: fw
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
function confirmDeleteDevice(deviceId) {
  safeShowModal({
    title: 'Decommission Hardware Device',
    message: `Are you sure you want to permanently remove device "${deviceId}" from the MySQL database?\n\nIf this device is an active anchor or edge gateway, position tracking in its assigned ward may be disrupted.`,
    type: 'danger',
    confirmText: '🗑️ Delete Permanently',
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
          safeShowToast(`Device ${deviceId} removed from fleet.`, 'success');
          await loadDevicesFleet();
        } else {
          safeShowToast(`Deletion failed: ${result.error}`, 'danger');
        }
      } catch (err) {
        console.error('Delete device error:', err);
        safeShowToast('Network error deleting device.', 'danger');
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
