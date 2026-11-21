// =============================================================================
// Ward editor: LiDAR room sensor panel (Phase 10)
// Where each LiDAR stands in the ward, the height of its base, which way the ▲
// on its top points, and which enrolled LiDAR node it is. Saved with the ward
// (room_sensors). The placement planner fills it in too. Under each LiDAR, the
// tools of room_sensor_live.js: live scan, learn empty room, align to walls.
// =============================================================================
(function () {
  let roomSensorDevices = [];

  function ward() {
    const w = window.currentWard;
    if (w && !Array.isArray(w.room_sensors)) w.room_sensors = [];
    return w;
  }

  function changed() {
    if (window.redrawWardMap) window.redrawWardMap();
    if (window.markUnsavedChanges) window.markUnsavedChanges();
  }

  /** Enrolled LiDAR nodes not used elsewhere, plus the one this row already has. */
  function deviceOptions(index, selected) {
    const w = ward();
    const usedHere = new Set(w.room_sensors.filter((_, i) => i !== index && _.device_id).map(_ => _.device_id));
    let html = '<option value="">-- Unassigned --</option>';
    for (const dev of roomSensorDevices) {
      if (usedHere.has(dev.device_id)) continue;
      const otherWard = dev.assigned_ward_id && dev.assigned_ward_id !== w.ward_id;
      if (otherWard && dev.device_id !== selected) continue;
      const state = dev.status === 'ONLINE' ? '● Online' : '○ Offline';
      html += `<option value="${escapeHtml(dev.device_id)}" ${dev.device_id === selected ? 'selected' : ''}>${escapeHtml(dev.device_id)} (${escapeHtml(state)})</option>`;
    }
    if (selected && !roomSensorDevices.some(d => d.device_id === selected)) {
      html += `<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)}</option>`;
    }
    return html;
  }

  function renderRoomSensorsTable() {
    const tbody = document.getElementById('room-sensors-table-body');
    const w = ward();
    if (!tbody || !w) return;
    const list = w.room_sensors;
    const badge = document.getElementById('room-sensor-count-badge');
    if (badge) badge.innerText = `${list.length}`;
    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 14px;">No LiDAR placed. Add one, or let 📐 Plan Anchors &amp; LiDAR suggest a spot.</td></tr>';
      if (window.onRoomSensorsRendered) window.onRoomSensorsRendered();
      return;
    }
    tbody.innerHTML = list.map((s, index) => {
      const xVal = Number(s.x || 0).toFixed(2);
      const yVal = Number(s.y || 0).toFixed(2);
      const hVal = Number(s.base_height !== undefined ? s.base_height : 0.92).toFixed(2);
      const heading = (((Number(s.heading_deg) || 0) % 360) + 360) % 360;
      const optionsHtml = deviceOptions(index, s.device_id);   // built from escaped parts
      const toolsHtml = window.roomSensorToolsHtml ? window.roomSensorToolsHtml(index) : '';   // built from escaped parts
      return `<tr>
        <td><input type="text" class="form-control" style="width: 92px; padding: 4px; font-weight: 700; color: #7C3AED;" maxlength="32" value="${escapeHtml(s.sensor_id || '')}" onchange="updateRoomSensor(${index}, 'sensor_id', this.value)"></td>
        <td><select class="form-control" style="padding: 4px 8px; font-size: 12px; font-weight: 600;" onchange="updateRoomSensor(${index}, 'device_id', this.value)">${optionsHtml}</select></td>
        <td>
          <div style="display: flex; gap: 4px; align-items: center;">
            <span style="font-size: 11px; color: var(--text-muted);">X:</span>
            <input type="number" step="0.01" min="0" class="form-control" style="width: 58px; padding: 4px;" value="${xVal}" oninput="updateRoomSensor(${index}, 'x', this.value)">
            <span style="font-size: 11px; color: var(--text-muted);">Y:</span>
            <input type="number" step="0.01" min="0" class="form-control" style="width: 58px; padding: 4px;" value="${yVal}" oninput="updateRoomSensor(${index}, 'y', this.value)">
            <span style="font-size: 11px; color: var(--text-muted);">Base:</span>
            <input type="number" step="0.01" min="0" class="form-control" style="width: 54px; padding: 4px;" value="${hVal}" oninput="updateRoomSensor(${index}, 'base_height', this.value)">
          </div>
        </td>
        <td>
          <div style="display: flex; gap: 4px; align-items: center;">
            <input type="number" step="0.1" min="0" max="359.9" class="form-control" style="width: 64px; padding: 4px;" value="${heading.toFixed(1)}" title="0° north, 90° east, 180° south, 270° west" onchange="updateRoomSensor(${index}, 'heading_deg', this.value)">
            <span style="font-size: 11px; color: var(--text-muted);">° ${escapeHtml(compassWord(heading))}</span>
          </div>
        </td>
        <td><button class="btn btn-danger-outline btn-sm" onclick="deleteRoomSensor(${index})">🗑</button></td>
      </tr>
      <tr><td colspan="5" style="padding: 2px 6px 10px; border-top: none;">${toolsHtml}</td></tr>`;
    }).join('');
    if (window.onRoomSensorsRendered) window.onRoomSensorsRendered();
  }

  /** A compass word for a heading: north, north-east, ... */
  function compassWord(deg) {
    const names = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
    return names[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
  }

  async function fetchRoomSensorDevices() {
    try {
      const res = await fetch('/api/devices/list?type=ROOM_SENSOR');
      const data = await res.json();
      if (data.success && Array.isArray(data.devices)) roomSensorDevices = data.devices;
    } catch (err) {
      console.warn('Could not load the LiDAR nodes for the ward editor:', err);
    }
  }

  /** Draws the panel now and again once the list of LiDAR nodes has arrived. */
  async function refreshRoomSensorPanel() {
    renderRoomSensorsTable();
    await fetchRoomSensorDevices();
    renderRoomSensorsTable();
  }

  function addRoomSensor() {
    const w = ward();
    if (!w) return;
    const n = w.room_sensors.length + 1;
    w.room_sensors.push({
      sensor_id: `LiDAR ${n}`, device_id: null,
      x: 0.18, y: 0.18, base_height: 0.92, heading_deg: 0, wall_location: ''
    });
    renderRoomSensorsTable();
    changed();
  }

  function updateRoomSensor(index, field, value) {
    const w = ward();
    const s = w && w.room_sensors[index];
    if (!s) return;
    if (field === 'x' || field === 'y' || field === 'base_height') {
      s[field] = Math.max(0, Math.round((parseFloat(value) || 0) * 100) / 100);
    } else if (field === 'heading_deg') {
      // Tenths of a degree: Align to walls finds the heading to about that
      s.heading_deg = Math.round(((((parseFloat(value) || 0) % 360) + 360) % 360) * 10) / 10;
      renderRoomSensorsTable();
    } else if (field === 'device_id') {
      s.device_id = (value || '').trim() || null;
      renderRoomSensorsTable();
    } else if (field === 'sensor_id') {
      s.sensor_id = String(value || '').trim().slice(0, 32) || `LiDAR ${index + 1}`;
    }
    changed();
  }

  function deleteRoomSensor(index) {
    const w = ward();
    if (!w || !w.room_sensors[index]) return;
    w.room_sensors.splice(index, 1);
    renderRoomSensorsTable();
    changed();
  }

  window.renderRoomSensorsTable = renderRoomSensorsTable;
  window.refreshRoomSensorPanel = refreshRoomSensorPanel;
  window.addRoomSensor = addRoomSensor;
  window.updateRoomSensor = updateRoomSensor;
  window.deleteRoomSensor = deleteRoomSensor;
})();
