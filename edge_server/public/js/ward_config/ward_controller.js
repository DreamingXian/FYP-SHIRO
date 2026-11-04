// =============================================================================
// Ward Architectural Configuration Controller
// =============================================================================


    // -------------------------------------------------------------------------
    // 3. Dynamic Ward Configuration Engine & MySQL Synchronization
    // -------------------------------------------------------------------------
    let currentWard = {
      ward_id: 'WARD-001',
      room_title: 'Acute Care Ward 001',
      length_x: 6.40,
      width_y: 4.80,
      height_z: 2.60,
      door: { wall: 'SOUTH', x: 2.80, y: 0.00, width: 0.90 },
      spatial_anchor_uuid: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789',
      layout_type: 'L_SHAPED',
      obstacles: [],
      beds: [],
      anchors: []
    };

    let wardsList = [];
    let availableTemplates = {};
    let isCreatingNew = false;
    let isDirty = false;
    let savedWardSnapshot = '';
    let cachedRegisteredAnchors = [];
    let isWardWsRegistered = false;
    let anchorStatusPollTimer = null;

    function findAnchorInCache(idOrMac) {
      if (!idOrMac) return null;
      const clean = idOrMac.toUpperCase().trim();
      return cachedRegisteredAnchors.find(d => 
        (d.device_id && d.device_id.toUpperCase().trim() === clean) ||
        (d.mac_address && d.mac_address.toUpperCase().trim() === clean)
      ) || null;
    }

    function buildAnchorDropdownOptions(slotIndex, selectedDeviceId) {
      const chosenInOtherSlots = new Set(
        (currentWard.anchors || [])
          .filter((_, idx) => idx !== slotIndex && _.device_id)
          .map(_ => _.device_id)
      );

      let optionsHtml = `<option value="">-- Unassigned (Standby Slot) --</option>`;
      cachedRegisteredAnchors.forEach(dev => {
        // Skip if chosen in another slot row
        if (chosenInOtherSlots.has(dev.device_id)) return;

        // Skip if assigned to another ward in DB (unless assigned to current ward)
        const isAssignedOtherWard = dev.assigned_ward_id && dev.assigned_ward_id !== currentWard.ward_id;
        if (isAssignedOtherWard && dev.device_id !== selectedDeviceId) return;

        // Skip if marked UNAVAILABLE / NOT_AVAILABLE unless selected in this slot
        const isUnavailable = dev.availability_status === 'UNAVAILABLE' || dev.availability_status === 'NOT_AVAILABLE' || dev.availability_status === 'MAINTENANCE';
        if (isUnavailable && dev.device_id !== selectedDeviceId) return;

        // Skip if in use by another ward
        if (dev.availability_status === 'IN_USE' && dev.assigned_ward_id !== currentWard.ward_id && dev.device_id !== selectedDeviceId) return;

        const isSelected = selectedDeviceId && selectedDeviceId === dev.device_id;
        const statusDot = dev.status === 'ONLINE' ? '● Online' : '○ Offline';
        optionsHtml += `<option value="${dev.device_id}" ${isSelected ? 'selected' : ''}>${dev.device_id} (${statusDot})</option>`;
      });
      return optionsHtml;
    }

    function syncWardAnchorUIElements(deviceId, status) {
      // 1. Update dropdown options text across all rows in Ward Editor
      const selects = document.querySelectorAll('.anchor-hardware-select');
      selects.forEach(sel => {
        const opt = sel.querySelector(`option[value="${deviceId}"]`);
        if (opt) {
          const statusDot = status === 'ONLINE' ? '● Online' : '○ Offline';
          opt.textContent = `${deviceId} (${statusDot})`;
        }
      });

      // 2. Update Status column badges in Ward Editor table
      if (currentWard && Array.isArray(currentWard.anchors)) {
        currentWard.anchors.forEach((a, index) => {
          if (a.device_id === deviceId) {
            const statusCell = document.querySelector(`.anchor-status-cell[data-slot-index="${index}"]`);
            if (statusCell) {
              const badgeClass = status === 'ONLINE' ? 'badge-live' : 'badge-alert';
              statusCell.innerHTML = `<span class="badge ${badgeClass}">● ${status}</span>`;
            }
          }
        });
      }

      // 3. Update Modal Cards if View Ward Read-Only modal is open
      const modalCards = document.querySelectorAll(`.modal-anchor-card[data-device-id="${deviceId}"]`);
      modalCards.forEach(card => {
        const badge = card.querySelector('.modal-anchor-badge');
        if (badge) {
          const badgeClass = status === 'ONLINE' ? 'badge-live' : 'badge-alert';
          badge.className = `badge modal-anchor-badge ${badgeClass}`;
          badge.innerText = `● ${status}`;
        }
      });

      // 4. Redraw 2D floor plan map if anchor is placed on the canvas
      if (currentWard && Array.isArray(currentWard.anchors) && currentWard.anchors.some(a => a.device_id === deviceId)) {
        if (typeof window.redrawWardMap === 'function') {
          window.redrawWardMap();
        }
      }
    }

    function updateAnchorLiveStatus(idOrMac, newStatus) {
      if (!idOrMac) return;
      const cleanStatus = (newStatus || 'OFFLINE').toUpperCase();
      let dev = findAnchorInCache(idOrMac);
      const targetId = dev ? dev.device_id : idOrMac;

      if (!dev) {
        // If not found in cache, fetch fresh list then sync
        fetchRegisteredAnchors().then(() => {
          dev = findAnchorInCache(idOrMac);
          if (dev) dev.status = cleanStatus;
          syncWardAnchorUIElements(targetId, cleanStatus);
        });
        return;
      }

      // Update cached device status
      dev.status = cleanStatus;

      // Update in currentWard.anchors if assigned
      if (currentWard && Array.isArray(currentWard.anchors)) {
        currentWard.anchors.forEach(a => {
          if (a.device_id === targetId) {
            a.status = cleanStatus;
          }
        });
      }

      // Dynamically update all DOM elements
      syncWardAnchorUIElements(targetId, cleanStatus);
    }

    function setupWardWsListeners() {
      if (isWardWsRegistered) return;
      if (!window.wsClient) {
        setTimeout(setupWardWsListeners, 300);
        return;
      }
      isWardWsRegistered = true;

      // Listen for DEVICE_HEARTBEAT from Edge Server
      window.wsClient.on('DEVICE_HEARTBEAT', (msg) => {
        if (!msg) return;
        const id = msg.device_id || msg.id;
        if (!id) return;
        if (msg.device_type === 'ANCHOR' || id.startsWith('anchor-') || findAnchorInCache(id)) {
          updateAnchorLiveStatus(id, msg.status || 'ONLINE');
        }
      });

      // Listen for ANCHOR_RSSI packets from active anchors
      window.wsClient.on('ANCHOR_RSSI', (msg) => {
        if (!msg) return;
        const anchorId = msg.anchor || msg.anchor_mac;
        if (anchorId) {
          updateAnchorLiveStatus(anchorId, 'ONLINE');
        }
      });

      startAnchorStatusPolling();
    }

    function startAnchorStatusPolling() {
      if (anchorStatusPollTimer) return;
      anchorStatusPollTimer = setInterval(async () => {
        try {
          const res = await fetch('/api/devices/list?type=ANCHOR');
          const data = await res.json();
          if (data.success && Array.isArray(data.devices)) {
            // Check if device count changed
            const countChanged = data.devices.length !== cachedRegisteredAnchors.length;
            data.devices.forEach(d => {
              updateAnchorLiveStatus(d.device_id, d.status);
            });
            if (countChanged) {
              cachedRegisteredAnchors = data.devices;
              const selects = document.querySelectorAll('.anchor-hardware-select');
              selects.forEach(sel => {
                const idx = parseInt(sel.getAttribute('data-slot-index'), 10);
                if (!isNaN(idx) && currentWard.anchors && currentWard.anchors[idx]) {
                  const val = currentWard.anchors[idx].device_id || '';
                  sel.innerHTML = buildAnchorDropdownOptions(idx, val);
                  sel.value = val;
                }
              });
            }
          }
        } catch (_) {}
      }, 3000);
    }

    async function fetchRegisteredAnchors() {
      try {
        const res = await fetch('/api/devices/list?type=ANCHOR');
        const data = await res.json();
        if (data.success && Array.isArray(data.devices)) {
          cachedRegisteredAnchors = data.devices;
          const selects = document.querySelectorAll('.anchor-hardware-select');
          selects.forEach(sel => {
            const idx = parseInt(sel.getAttribute('data-slot-index'), 10);
            if (!isNaN(idx) && currentWard.anchors && currentWard.anchors[idx]) {
              const val = currentWard.anchors[idx].device_id || '';
              sel.innerHTML = buildAnchorDropdownOptions(idx, val);
              sel.value = val;
            }
          });
        }
      } catch (err) {
        console.warn('Failed to fetch registered anchors for ward configuration:', err);
      }
    }

    setTimeout(setupWardWsListeners, 200);

    function captureWardSnapshot() {
      savedWardSnapshot = JSON.stringify(currentWard);
      isDirty = false;
      const dbBadge = document.getElementById('db-sync-badge');
      if (dbBadge) {
        dbBadge.innerText = '● MySQL Synchronized';
        dbBadge.className = 'badge badge-live';
      }
    }

    function hasUnsavedWardChanges() {
      const editorView = document.getElementById('ward-editor-view');
      if (!editorView || editorView.style.display === 'none') {
        return false;
      }
      if (isDirty) return true;
      try {
        return JSON.stringify(currentWard) !== savedWardSnapshot;
      } catch (e) {
        return isDirty;
      }
    }

    // Helper: Auto-Generate Next Sequential Ward ID (WARD-001, WARD-002, ...)
    function generateNextWardId() {
      const existingNums = (wardsList || [])
        .map(w => {
          const m = (w.ward_id || '').match(/WARD-(\d+)/i);
          return m ? parseInt(m[1], 10) : null;
        })
        .filter(n => n !== null && !isNaN(n));

      let nextNum = 1;
      while (existingNums.includes(nextNum)) {
        nextNum++;
      }
      return `WARD-${String(nextNum).padStart(3, '0')}`;
    }

    // --- Ward Directory CRUD Operations ---
    async function loadWardDirectory() {
      try {
        const res = await fetch('/api/ward/list');
        const data = await res.json();
        if (data.success && Array.isArray(data.wards)) {
          wardsList = data.wards;
          renderWardDirectoryTable(wardsList);
        }
      } catch (err) {
        console.warn('Failed to load wards directory from MySQL:', err);
      }
    }

    function renderWardDirectoryTable(wards) {
      const tbody = document.getElementById('wards-table-body');
      if (!tbody) return;
      tbody.innerHTML = '';

      const countBadge = document.getElementById('ward-total-count');
      if (countBadge) {
        countBadge.innerText = `${wards.length} Ward${wards.length === 1 ? '' : 's'} Configured`;
      }

      if (wards.length === 0) {
        tbody.innerHTML = `<tr><td colspan="10" style="text-align: center; color: var(--text-muted); padding: 24px;">No wards found in database. Click "➕ Create New Ward" above to configure your first room.</td></tr>`;
        return;
      }

      wards.forEach(w => {
        const updated = w.updated_at ? new Date(w.updated_at).toLocaleString() : 'Recently';
        const uuidShort = w.spatial_anchor_uuid ? `${w.spatial_anchor_uuid.substring(0, 8)}...` : '<span style="color:var(--text-muted);">None</span>';
        const isLiveMapReady = (w.anchor_count >= 3 && w.assigned_anchor_count >= w.anchor_count);
        const liveMapBtn = isLiveMapReady
          ? `<button class="btn btn-primary btn-sm" onclick="event.stopPropagation(); window.openWardLiveMap('${w.ward_id}')" style="background:#0EA5E9; border-color:#0284C7;">🗺️ View Live Map</button>`
          : `<button class="btn btn-outline btn-sm" disabled style="opacity:0.45; cursor:not-allowed;" title="Please complete anchor registration &amp; assignment for all anchor slots to enable the live map function." onclick="event.stopPropagation();">🗺️ View Live Map</button>`;

        const row = `<tr class="table-row-clickable" onclick="viewWardDetailsReadOnly('${w.ward_id}')" title="Click to view layout &amp; specifications for ${w.room_title || w.ward_id}">
          <td><b style="color: var(--primary);">${w.ward_id}</b></td>
          <td><b style="color: var(--text-primary);">${w.room_title || 'Ward'}</b></td>
          <td><span class="mono">${Number(w.length_x).toFixed(2)}m × ${Number(w.width_y).toFixed(2)}m × ${Number(w.height_z).toFixed(2)}m</span></td>
          <td><span class="badge badge-neutral">${w.door_wall || 'SOUTH'} @ ${Number(w.door_x).toFixed(2)}m (${Number(w.door_width).toFixed(2)}m w)</span></td>
          <td><span class="badge badge-info">${w.bed_count} Beds</span></td>
          <td><span class="badge ${w.anchor_count >= 3 ? 'badge-live' : 'badge-warning'}">${w.anchor_count} Nodes</span></td>
          <td><span class="badge badge-neutral">${w.obstacle_count} Cutout${w.obstacle_count === 1 ? '' : 's'}</span></td>
          <td class="mono" style="font-size: 11px;" title="${w.spatial_anchor_uuid}">${uuidShort}</td>
          <td style="color: var(--text-muted); font-size: 12px;">${updated}</td>
          <td>
            <div style="display: flex; gap: 6px;">
              ${liveMapBtn}
              <button class="btn btn-outline btn-sm" onclick="event.stopPropagation(); openWardEditor('${w.ward_id}')">✏️ Configure Layout</button>
              <button class="btn btn-danger-outline btn-sm" onclick="event.stopPropagation(); deleteWardRecord('${w.ward_id}')">🗑 Delete</button>
            </div>
          </td>
        </tr>`;
        tbody.insertAdjacentHTML('beforeend', row);
      });
    }

    function filterWardDirectory() {
      const q = (document.getElementById('ward-search-input').value || '').toLowerCase().trim();
      const filtered = wardsList.filter(w =>
        (w.ward_id && w.ward_id.toLowerCase().includes(q)) ||
        (w.room_title && w.room_title.toLowerCase().includes(q))
      );
      renderWardDirectoryTable(filtered);
    }

    function returnToWardDirectory(force = false) {
      if (!force && hasUnsavedWardChanges()) {
        showModal({
          title: 'Unsaved Changes',
          message: `You have unsaved changes to ward "${currentWard.ward_id}".\n\nIf you leave now, your changes will not be saved to MySQL.`,
          type: 'warning',
          confirmText: 'Discard & Leave',
          cancelText: 'Continue Editing',
          onConfirm: () => {
            forceReturnToWardDirectory();
          }
        });
        return;
      }
      forceReturnToWardDirectory();
    }

    function forceReturnToWardDirectory() {
      isDirty = false;
      const editorView = document.getElementById('ward-editor-view');
      const liveMapView = document.getElementById('ward-live-map-view');
      const dirView = document.getElementById('ward-directory-view');
      if (editorView) editorView.style.display = 'none';
      if (liveMapView) liveMapView.style.display = 'none';
      if (dirView) dirView.style.display = 'block';
      loadWardDirectory();
    }

    async function viewWardDetailsReadOnly(wardId) {
      try {
        const res = await fetch(`/api/ward/config?ward_id=${encodeURIComponent(wardId)}`);
        const data = await res.json();
        if (!data.success || !data.ward) {
          if (window.showToast) window.showToast('Ward layout not found.', 'warning');
          return;
        }

        const w = data.ward;
        const bedsList = (w.beds && w.beds.length > 0)
          ? w.beds.map(b => {
              const rot = parseInt(b.rotation_deg, 10) || 0;
              const rotLabel = rot === 0 ? '0° (N)' : rot === 90 ? '90° (E)' : rot === 180 ? '180° (S)' : '270° (W)';
              return `
              <div style="display:flex; justify-content:space-between; align-items:center; padding:6px 8px; border-bottom:1px solid var(--border-light); font-size:12px;">
                <div><strong>${b.bed_code || b.bed_id}</strong> <span style="font-size:10px; color:var(--text-muted); font-weight:600;">[${rotLabel}]</span></div>
                <div style="font-family:monospace; color:var(--text-muted);">${Number(b.x).toFixed(2)}m, ${Number(b.y).toFixed(2)}m</div>
                <span class="badge ${b.status === 'AVAILABLE' ? 'badge-live' : b.status === 'OCCUPIED' ? 'badge-alert' : 'badge-neutral'}">${b.status}</span>
              </div>`;
            }).join('')
          : '<div style="color:var(--text-muted); font-size:12px; padding:8px; text-align:center;">No beds configured.</div>';

        // Format Wall Anchors as structured individual cards
        const anchorsList = (w.anchors && w.anchors.length > 0)
          ? w.anchors.map(a => {
              const isAssigned = !!a.device_id;
              const liveStatus = isAssigned ? (a.status || 'OFFLINE') : 'STANDBY';
              const badgeClass = liveStatus === 'ONLINE' ? 'badge-live' : (liveStatus === 'OFFLINE' ? 'badge-alert' : 'badge-neutral');
              const nodeDisplay = isAssigned 
                ? `<div class="mono" style="font-size:11px; color:var(--primary); font-weight:700;">Node: ${a.device_id}</div>`
                : `<div style="font-size:11px; color:var(--text-muted); font-style:italic;">Node: Unassigned (Standby Slot)</div>`;

              return `
              <div class="modal-anchor-card" data-device-id="${a.device_id || ''}" style="background: #F8FAFC; border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; margin-bottom: 8px; box-shadow: 0 1px 2px rgba(0,0,0,0.03);">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 4px;">
                  <strong style="color:var(--text-primary); font-size:12px;">📡 ${a.anchor_id}</strong>
                  <span class="badge modal-anchor-badge ${badgeClass}" style="font-size:10px;">● ${liveStatus}</span>
                </div>
                <div style="font-size:11px; color:var(--text-secondary); margin-bottom: 3px;">
                  Position: (${Number(a.x).toFixed(2)}m, ${Number(a.y).toFixed(2)}m, ${Number(a.z).toFixed(2)}m) · ${a.wall_location || 'Wall'}
                </div>
                ${nodeDisplay}
              </div>`;
            }).join('')
          : '<div style="color:var(--text-muted); font-size:12px; padding:12px; text-align:center;">No BLE anchors configured.</div>';

        // Format Obstacles as structured individual cards (fixing undefined bug)
        const obstaclesList = (w.obstacles && w.obstacles.length > 0)
          ? w.obstacles.map(o => {
              const typeStr = (o.type || 'CUTOUT').toUpperCase();
              const icon = typeStr === 'TOILET' ? '🚽' : typeStr === 'CUPBOARD' ? '🚪' : typeStr === 'TABLE' ? '🪑' : typeStr === 'PILLAR' ? '🏛️' : typeStr === 'PARTITION' ? '🧱' : '📦';
              const hVal = Number(o.height !== undefined ? o.height : (typeStr === 'TABLE' ? 0.75 : 2.00)).toFixed(2);
              return `
                <div style="background: #F8FAFC; border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; margin-bottom: 8px; box-shadow: 0 1px 2px rgba(0,0,0,0.03);">
                  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 4px;">
                    <strong style="color:var(--text-primary); font-size:12px;">${icon} ${o.label || o.id || 'Obstacle'}</strong>
                    <span class="badge badge-neutral" style="font-size:10px;">${typeStr}</span>
                  </div>
                  <div style="font-size:11px; color:var(--text-secondary); margin-bottom: 2px;">
                    Type: ${typeStr} · Height: ${hVal}m
                  </div>
                  <div style="font-size:11px; color:var(--text-secondary);">
                    Position: (${Number(o.x).toFixed(2)}m, ${Number(o.y).toFixed(2)}m) · Size: ${Number(o.width).toFixed(2)}m × ${Number(o.length).toFixed(2)}m
                  </div>
                </div>`;
            }).join('')
          : '<div style="color:var(--text-muted); font-size:12px; padding:12px; text-align:center;">No obstacles configured.</div>';

        // Door details handling (fixing undefined @ NaNm)
        const doorWall = w.door?.wall || w.door_wall || 'SOUTH';
        const doorX = Number(w.door?.x !== undefined ? w.door.x : (w.door_x !== undefined ? w.door_x : 0)).toFixed(2);
        const doorWidth = Number(w.door?.width !== undefined ? w.door.width : (w.door_width !== undefined ? w.door_width : 0.90)).toFixed(2);

        const modalHtml = `
          <div style="display: grid; grid-template-columns: 460px 1fr; gap: 20px; align-items: start;">
            <!-- Left Column: 2D Architectural Floor Plan Canvas -->
            <div>
              <div style="font-weight: 700; font-size: 12px; color: var(--text-primary); margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center;">
                <span>📐 2D Architectural Floor Plan</span>
                <span class="badge badge-live">Digital Twin Active</span>
              </div>
              <div style="position: relative; width: 100%; height: 320px; border-radius: 10px; overflow: hidden; border: 1.5px solid var(--border); background: #FFFFFF; box-shadow: inset 0 1px 3px rgba(0,0,0,0.05);">
                <canvas id="modal-ward-preview-canvas" width="460" height="320" style="width: 100%; height: 100%; display: block;"></canvas>
              </div>
              <div style="display: flex; justify-content: space-between; font-size: 11px; color: var(--text-muted); margin-top: 6px; padding: 0 4px;">
                <span>Dimensions: ${Number(w.length_x).toFixed(2)}m × ${Number(w.width_y).toFixed(2)}m × ${Number(w.height_z).toFixed(2)}m</span>
                <span>🚪 Door: ${doorWall} wall @ ${doorX}m (${doorWidth}m)</span>
              </div>
            </div>

            <!-- Right Column: Room Specs, Beds Fleet & Devices -->
            <div>
              <div style="margin-bottom: 12px;">
                <div style="font-size: 16px; font-weight: 700; color: var(--text-primary);">${w.room_title || 'Ward'}</div>
                <div style="font-size: 11px; color: var(--primary); font-weight: 600;" class="mono">${w.ward_id} · Archetype: ${w.layout_type || 'RECTANGLE'}</div>
              </div>

              <!-- Quick Meta Card -->
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; background: #F8FAFC; border: 1px solid var(--border); border-radius: 8px; padding: 10px; margin-bottom: 12px; font-size: 11px;">
                <div>
                  <span style="color: var(--text-muted);">Spatial UUID:</span><br>
                  <span class="mono" style="font-size: 10px; color: var(--text-secondary); word-break: break-all;" title="${w.spatial_anchor_uuid || ''}">${w.spatial_anchor_uuid ? w.spatial_anchor_uuid.substring(0, 16) + '...' : 'Not Mapped'}</span>
                </div>
                <div>
                  <span style="color: var(--text-muted);">Total Inventory:</span><br>
                  <strong style="color: var(--text-primary);">${w.beds ? w.beds.length : 0} Beds · ${w.anchors ? w.anchors.length : 0} BLE Nodes</strong>
                </div>
              </div>

              <!-- Beds Fleet Table -->
              <div style="background: #FFFFFF; border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; margin-bottom: 10px;">
                <div style="font-weight: 700; font-size: 11px; color: var(--text-primary); margin-bottom: 6px; display: flex; justify-content: space-between;">
                  <span>🛏️ Hospital Beds Fleet</span>
                  <span class="badge badge-info">${w.beds ? w.beds.length : 0} Beds</span>
                </div>
                <div style="max-height: 120px; overflow-y: auto;">
                  ${bedsList}
                </div>
              </div>

              <!-- BLE Anchors & Obstacles split -->
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
                <div style="background: #FFFFFF; border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px;">
                  <div style="font-weight: 700; font-size: 11px; color: var(--text-primary); margin-bottom: 6px; display: flex; justify-content: space-between;">
                    <span>📡 Wall Anchors</span>
                    <span class="badge badge-neutral" style="font-size:10px;">${w.anchors ? w.anchors.length : 0}</span>
                  </div>
                  <div style="max-height: 160px; overflow-y: auto;">
                    ${anchorsList}
                  </div>
                </div>
                <div style="background: #FFFFFF; border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px;">
                  <div style="font-weight: 700; font-size: 11px; color: var(--text-primary); margin-bottom: 6px; display: flex; justify-content: space-between;">
                    <span>🚪 Obstacles</span>
                    <span class="badge badge-neutral" style="font-size:10px;">${w.obstacles ? w.obstacles.length : 0}</span>
                  </div>
                  <div style="max-height: 160px; overflow-y: auto;">
                    ${obstaclesList}
                  </div>
                </div>
              </div>
            </div>
          </div>
        `;

        const totalAnchors = w.anchors ? w.anchors.length : 0;
        const assignedCount = w.anchors ? w.anchors.filter(a => a.device_id && a.device_id.trim() !== '').length : 0;
        const isModalMapReady = (totalAnchors >= 3 && assignedCount >= totalAnchors);

        if (window.showModal) {
          window.showModal({
            title: `Ward Specifications & 2D Floor Plan: ${w.ward_id}`,
            customHtml: modalHtml,
            isWide: true,
            type: 'info',
            confirmText: '✏️ Configure Layout',
            cancelText: 'Close',
            extraButtonText: '🗺️ View Live Map',
            extraButtonClass: isModalMapReady ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm',
            extraButtonDisabled: !isModalMapReady,
            extraButtonTitle: isModalMapReady ? 'Open real-time 2D IPS live tracking map' : 'Please complete anchor registration & assignment for all anchor slots to enable the live map function.',
            onConfirm: () => {
              openWardEditor(w.ward_id);
            },
            onExtra: () => {
              if (typeof window.openWardLiveMap === 'function') {
                window.openWardLiveMap(w.ward_id);
              }
            }
          });

          // Draw floor plan onto modal canvas with pure white background
          requestAnimationFrame(() => {
            setTimeout(() => {
              const previewCanvas = document.getElementById('modal-ward-preview-canvas');
              if (previewCanvas && typeof window.renderWardToCanvas === 'function') {
                previewCanvas.width = previewCanvas.clientWidth || 460;
                previewCanvas.height = 320;
                window.renderWardToCanvas(previewCanvas, w, { bgColor: '#FFFFFF', padding: 32 });
              }
            }, 40);
          });
        }
      } catch (err) {
        console.error('viewWardDetailsReadOnly error:', err);
      }
    }

    async function openWardEditor(wardId) {
      try {
        setupWardWsListeners();
        await fetchRegisteredAnchors();
        const res = await fetch(`/api/ward/config?ward_id=${encodeURIComponent(wardId)}`);
        const data = await res.json();
        if (data.success && data.ward) {
          isCreatingNew = false;
          currentWard = data.ward;
          document.getElementById('ward-directory-view').style.display = 'none';
          const liveMapView = document.getElementById('ward-live-map-view');
          if (liveMapView) liveMapView.style.display = 'none';
          document.getElementById('ward-editor-view').style.display = 'block';
          const badge = document.getElementById('editor-ward-badge');
          if (badge) badge.innerText = `${currentWard.ward_id} (${currentWard.room_title})`;
          const saveBtn = document.getElementById('btn-save-ward');
          if (saveBtn) saveBtn.innerHTML = '💾 Save Changes';
          populateWardUI();
          captureWardSnapshot();
          const presetSelect = document.getElementById('cfg-template-select');
          if (presetSelect) presetSelect.value = 'NONE';
          setTimeout(redrawWardMap, 60);
          if (window.requestAnimationFrame) window.requestAnimationFrame(redrawWardMap);
        } else {
          showModal({ title: 'Load Error', message: `Could not load ward: ${data.error || 'Unknown error'}`, type: 'danger', confirmText: 'Dismiss' });
        }
      } catch (err) {
        showModal({ title: 'Connection Error', message: `Failed to load ward details: ${err.message}`, type: 'danger', confirmText: 'Dismiss' });
      }
    }

    async function createNewWard() {
      setupWardWsListeners();
      await fetchRegisteredAnchors();
      isCreatingNew = true;
      const newWardId = generateNextWardId();
      const numStr = newWardId.replace('WARD-', '');
      currentWard = {
        ward_id: newWardId,
        room_title: `Standard Ward ${numStr}`,
        length_x: 6.40,
        width_y: 4.80,
        height_z: 2.60,
        door: { wall: 'SOUTH', x: 2.80, y: 0.00, width: 0.90 },
        spatial_anchor_uuid: '',
        layout_type: 'RECTANGLE',
        obstacles: [],
        beds: [
          { bed_id: `BED-${numStr}-01`, bed_code: 'Bed 1', x: 0.80, y: 2.40, width: 0.90, length: 2.00, status: 'AVAILABLE' },
          { bed_id: `BED-${numStr}-02`, bed_code: 'Bed 2', x: 0.80, y: 0.40, width: 0.90, length: 2.00, status: 'AVAILABLE' }
        ],
        anchors: [
          { anchor_id: 'Anchor A', device_id: null, mac_address: '', x: 0.50, y: 4.30, z: 1.80, wall_location: 'North-West Wall', status: 'STANDBY' },
          { anchor_id: 'Anchor B', device_id: null, mac_address: '', x: 5.90, y: 4.30, z: 1.80, wall_location: 'North-East Wall', status: 'STANDBY' },
          { anchor_id: 'Anchor C', device_id: null, mac_address: '', x: 2.80, y: 0.50, z: 1.80, wall_location: 'South Wall', status: 'STANDBY' }
        ]
      };

      document.getElementById('ward-directory-view').style.display = 'none';
      document.getElementById('ward-editor-view').style.display = 'block';
      const badge = document.getElementById('editor-ward-badge');
      if (badge) badge.innerText = `NEW WARD: ${newWardId}`;
      const saveBtn = document.getElementById('btn-save-ward');
      if (saveBtn) saveBtn.innerHTML = '➕ Create New Ward';
      populateWardUI();
      captureWardSnapshot();
      const presetSelect = document.getElementById('cfg-template-select');
      if (presetSelect) presetSelect.value = 'NONE';
      setTimeout(redrawWardMap, 60);
      if (window.requestAnimationFrame) window.requestAnimationFrame(redrawWardMap);
    }

    function deleteWardRecord(wardId) {
      showModal({
        title: 'Delete Hospital Ward',
        message: `Are you sure you want to permanently delete ward "${wardId}"?\n\nThis will remove the room geometry, beds fleet, BLE wall anchors, and obstacle cutouts from MySQL.`,
        type: 'danger',
        confirmText: 'Delete Ward',
        cancelText: 'Cancel',
        onConfirm: async () => {
          try {
            const res = await fetch(`/api/ward/config?ward_id=${encodeURIComponent(wardId)}`, {
              method: 'DELETE'
            });
            const data = await res.json();
            if (data.success) {
              showToast(`Ward ${wardId} deleted successfully.`, 'success');
              loadWardDirectory();
            } else {
              showModal({ title: 'Delete Error', message: data.error, type: 'danger', confirmText: 'Dismiss' });
            }
          } catch (err) {
            showModal({ title: 'Server Error', message: err.message, type: 'danger', confirmText: 'Dismiss' });
          }
        }
      });
    }

    async function loadWardDataFromDB() {
      // Setup live WebSocket listeners for anchors
      setupWardWsListeners();

      // Fetch registered hardware anchors cache
      await fetchRegisteredAnchors();

      // Load directory on boot
      await loadWardDirectory();

      // Fetch templates
      try {
        const tRes = await fetch('/api/ward/templates');
        const tData = await tRes.json();
        if (tData.success) {
          availableTemplates = tData.templates;
        }
      } catch (err) {}

      // Preload WARD-001 for editor ready state
      try {
        const res = await fetch('/api/ward/config?ward_id=WARD-001');
        const data = await res.json();
        if (data.success && data.ward) {
          currentWard = data.ward;
          populateWardUI();
        }
      } catch (err) {
        console.warn('Could not preload WARD-001:', err);
      }
    }

    function populateWardUI() {
      // Room Metadata
      document.getElementById('cfg-room-id').value = currentWard.ward_id || 'WARD-A1';
      document.getElementById('cfg-room-title').value = currentWard.room_title || '';
      document.getElementById('cfg-x-max').value = Number(currentWard.length_x || 6.40).toFixed(2);
      document.getElementById('cfg-y-max').value = Number(currentWard.width_y || 4.80).toFixed(2);
      document.getElementById('cfg-z-max').value = Number(currentWard.height_z || 2.60).toFixed(2);

      // Door
      if (currentWard.door) {
        document.getElementById('cfg-door-wall').value = currentWard.door.wall || 'SOUTH';
        document.getElementById('cfg-door-pos').value = Number(currentWard.door.x !== undefined ? currentWard.door.x : 2.80).toFixed(2);
        document.getElementById('cfg-door-width').value = Number(currentWard.door.width || 0.90).toFixed(2);
      }

      // Spatial Anchor UUID
      document.getElementById('cfg-spatial-uuid').value = currentWard.spatial_anchor_uuid || '';

      // Preset Template default is NONE
      const tplSelect = document.getElementById('cfg-template-select');
      if (tplSelect) {
        tplSelect.value = 'NONE';
      }

      // Render Tables
      renderObstaclesTable();
      renderBedsTable();
      renderAnchorsTable();
      updateWardStats();
      redrawWardMap();
    }

    function syncWardMeta() {
      currentWard.ward_id = document.getElementById('cfg-room-id').value.trim() || currentWard.ward_id;
      currentWard.room_title = document.getElementById('cfg-room-title').value.trim();
      currentWard.spatial_anchor_uuid = document.getElementById('cfg-spatial-uuid').value.trim();
      const badge = document.getElementById('editor-ward-badge');
      if (badge) badge.innerText = `${currentWard.ward_id} (${currentWard.room_title})`;
      markUnsavedChanges();
    }

    function syncWardDimensions() {
      const xVal = parseFloat(document.getElementById('cfg-x-max').value);
      const yVal = parseFloat(document.getElementById('cfg-y-max').value);
      const zVal = parseFloat(document.getElementById('cfg-z-max').value);

      currentWard.length_x = Math.max(0.10, isNaN(xVal) ? 6.40 : Math.round(xVal * 100) / 100);
      currentWard.width_y = Math.max(0.10, isNaN(yVal) ? 4.80 : Math.round(yVal * 100) / 100);
      currentWard.height_z = Math.max(0.10, isNaN(zVal) ? 2.60 : Math.round(zVal * 100) / 100);

      updateWardStats();
      redrawWardMap();
      markUnsavedChanges();
    }

    function syncWardDoor() {
      if (!currentWard.door) currentWard.door = {};
      currentWard.door.wall = document.getElementById('cfg-door-wall').value;
      const pVal = parseFloat(document.getElementById('cfg-door-pos').value);
      const wVal = parseFloat(document.getElementById('cfg-door-width').value);
      currentWard.door.x = Math.max(0, isNaN(pVal) ? 0 : Math.round(pVal * 100) / 100);
      currentWard.door.width = Math.max(0.10, isNaN(wVal) ? 0.90 : Math.round(wVal * 100) / 100);
      redrawWardMap();
      markUnsavedChanges();
    }

    function markUnsavedChanges() {
      isDirty = true;
      const presetSelect = document.getElementById('cfg-template-select');
      if (presetSelect && presetSelect.value !== 'NONE') {
        presetSelect.value = 'NONE';
      }
      const badge = document.getElementById('db-sync-badge');
      if (badge) {
        badge.innerText = '● Unsaved Changes';
        badge.className = 'badge badge-warning';
      }
    }

    // --- Obstacles Manager ---
    function renderObstaclesTable() {
      const tbody = document.getElementById('obstacles-table-body');
      tbody.innerHTML = '';
      const list = currentWard.obstacles || [];
      document.getElementById('obstacle-count-badge').innerText = `${list.length} Obstacle${list.length === 1 ? '' : 's'}`;

      if (list.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 14px;">No obstacles configured. Entire room is open rectangle.</td></tr>`;
        return;
      }

      list.forEach((obs, index) => {
        const roomH = parseFloat(currentWard.height_z) || 2.80;
        const xVal = Number(obs.x !== undefined ? obs.x : 0).toFixed(2);
        const yVal = Number(obs.y !== undefined ? obs.y : 0).toFixed(2);
        const wVal = Number(obs.width !== undefined ? obs.width : 1.0).toFixed(2);
        const lVal = Number(obs.length !== undefined ? obs.length : 1.0).toFixed(2);
        const obsType = (obs.type || 'TOILET').toUpperCase();
        const defaultH = obsType === 'TABLE' ? 0.75 : ((obsType === 'CUPBOARD' || obsType === 'STORAGE') ? Math.min(roomH, 2.00) : roomH);
        const hVal = Number(obs.height !== undefined ? obs.height : defaultH).toFixed(2);

        const row = `<tr>
          <td>
            <select class="form-control" style="padding: 4px 8px; font-size: 11px; font-weight: 600;" onchange="onObstacleTypeChange(${index}, this.value)">
              <option value="TOILET" ${obsType === 'TOILET' ? 'selected' : ''}>🚽 Toilet / Ensuite</option>
              <option value="CUPBOARD" ${obsType === 'CUPBOARD' ? 'selected' : ''}>🚪 Cupboard / Wardrobe</option>
              <option value="TABLE" ${obsType === 'TABLE' ? 'selected' : ''}>🪑 Table / Desk</option>
              <option value="PARTITION" ${obsType === 'PARTITION' ? 'selected' : ''}>🧱 Partition</option>
              <option value="PILLAR" ${obsType === 'PILLAR' ? 'selected' : ''}>🏛️ Pillar</option>
              <option value="STORAGE" ${obsType === 'STORAGE' ? 'selected' : ''}>📦 Storage</option>
            </select>
          </td>
          <td><input type="text" class="form-control" style="padding: 4px 8px; font-size: 12px;" value="${obs.label || ''}" oninput="updateObstacle(${index}, 'label', this.value)"></td>
          <td>
            <div style="display: flex; gap: 4px; align-items: center;">
              <span style="font-size: 11px; color: var(--text-muted);">X:</span>
              <input type="number" step="0.01" min="0" class="form-control" style="width: 65px; padding: 4px;" value="${xVal}" oninput="updateObstacle(${index}, 'x', this.value)">
              <span style="font-size: 11px; color: var(--text-muted);">Y:</span>
              <input type="number" step="0.01" min="0" class="form-control" style="width: 65px; padding: 4px;" value="${yVal}" oninput="updateObstacle(${index}, 'y', this.value)">
            </div>
          </td>
          <td>
            <div style="display: flex; gap: 4px; align-items: center;">
              <input type="number" step="0.01" min="0.10" class="form-control" style="width: 58px; padding: 4px;" value="${wVal}" oninput="updateObstacle(${index}, 'width', this.value)">
              <span style="font-size: 11px; color: var(--text-muted);">×</span>
              <input type="number" step="0.01" min="0.10" class="form-control" style="width: 58px; padding: 4px;" value="${lVal}" oninput="updateObstacle(${index}, 'length', this.value)">
              <span style="font-size: 11px; color: var(--text-muted);">m</span>
            </div>
          </td>
          <td>
            <div style="display: flex; gap: 4px; align-items: center;">
              <input type="number" step="0.05" min="0.10" class="form-control" style="width: 58px; padding: 4px;" value="${hVal}" oninput="updateObstacle(${index}, 'height', this.value)">
              <span style="font-size: 11px; color: var(--text-muted);">m</span>
            </div>
          </td>
          <td>
            <button class="btn btn-danger-outline btn-sm" onclick="deleteObstacle(${index})">🗑</button>
          </td>
        </tr>`;
        tbody.insertAdjacentHTML('beforeend', row);
      });
    }

    function onObstacleTypeChange(index, newType) {
      if (!currentWard.obstacles || !currentWard.obstacles[index]) return;
      const obs = currentWard.obstacles[index];
      const roomH = parseFloat(currentWard.height_z) || 2.80;
      obs.type = newType;

      // When choosing Partition, Toilet, or Pillar: default height to full room ceiling height!
      if (newType === 'TOILET' || newType === 'PARTITION' || newType === 'PILLAR') {
        obs.height = roomH;
        if (newType === 'TOILET' && (!obs.label || obs.label.includes('Table') || obs.label.includes('Cupboard'))) {
          obs.label = `Ensuite Bathroom ${index + 1}`;
        } else if (newType === 'PARTITION' && (!obs.label || obs.label.includes('Table') || obs.label.includes('Cupboard'))) {
          obs.label = `Partition Wall ${index + 1}`;
        } else if (newType === 'PILLAR' && (!obs.label || obs.label.includes('Table') || obs.label.includes('Cupboard'))) {
          obs.label = `Pillar ${index + 1}`;
        }
      } else if (newType === 'TABLE') {
        obs.height = 0.75;
        if (!obs.width || obs.width === 1.80) obs.width = 1.00;
        if (!obs.length || obs.length === 1.60) obs.length = 0.80;
        if (!obs.label || obs.label.includes('Bathroom') || obs.label.includes('Cutout') || obs.label.includes('Cupboard')) obs.label = `Table ${index + 1}`;
      } else if (newType === 'CUPBOARD' || newType === 'STORAGE') {
        obs.height = Math.min(roomH, 2.00);
        if (!obs.width || obs.width === 1.80) obs.width = 1.20;
        if (!obs.length || obs.length === 1.60) obs.length = 0.60;
        if (!obs.label || obs.label.includes('Bathroom') || obs.label.includes('Cutout') || obs.label.includes('Table')) obs.label = `Cupboard ${index + 1}`;
      }
      renderObstaclesTable();
      updateWardStats();
      redrawWardMap();
      markUnsavedChanges();
    }

    function addObstacle() {
      if (!currentWard.obstacles) currentWard.obstacles = [];
      const roomH = parseFloat(currentWard.height_z) || 2.80;
      const newIdx = currentWard.obstacles.length + 1;
      currentWard.obstacles.push({
        id: `OBS-${currentWard.ward_id}-${newIdx}`,
        type: 'PARTITION',
        label: `Partition Wall ${newIdx}`,
        x: 0.00,
        y: Math.max(0, Math.round((currentWard.width_y - 1.20) * 100) / 100),
        width: 1.20,
        length: 0.30,
        height: roomH
      });
      renderObstaclesTable();
      updateWardStats();
      redrawWardMap();
      markUnsavedChanges();
    }

    function updateObstacle(index, field, value) {
      if (currentWard.obstacles && currentWard.obstacles[index]) {
        if (field === 'x' || field === 'y') {
          currentWard.obstacles[index][field] = Math.max(0, Math.round((parseFloat(value) || 0) * 100) / 100);
        } else if (field === 'width' || field === 'length' || field === 'height') {
          currentWard.obstacles[index][field] = Math.max(0.10, Math.round((parseFloat(value) || 0.10) * 100) / 100);
        } else {
          currentWard.obstacles[index][field] = value;
        }
        updateWardStats();
        redrawWardMap();
        markUnsavedChanges();
      }
    }

    function deleteObstacle(index) {
      if (currentWard.obstacles) {
        currentWard.obstacles.splice(index, 1);
        renderObstaclesTable();
        updateWardStats();
        redrawWardMap();
        markUnsavedChanges();
      }
    }

    // --- Beds Manager ---
    function renderBedsTable() {
      const tbody = document.getElementById('beds-table-body');
      tbody.innerHTML = '';
      const list = currentWard.beds || [];
      document.getElementById('bed-count-badge').innerText = `${list.length} Bed${list.length === 1 ? '' : 's'}`;

      if (list.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 14px;">No beds registered in this ward.</td></tr>`;
        return;
      }

      list.forEach((b, index) => {
        const statusVal = b.status === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'AVAILABLE';
        const rot = parseInt(b.rotation_deg, 10) || 0;
        const isHorizontal = (rot === 90 || rot === 270);
        const spanXM = isHorizontal ? (b.length || 2.00) : (b.width || 0.90);
        const spanYM = isHorizontal ? (b.width || 0.90) : (b.length || 2.00);

        const xVal = Number(b.x !== undefined ? b.x : 0).toFixed(2);
        const yVal = Number(b.y !== undefined ? b.y : 0).toFixed(2);

        const row = `<tr>
          <td>
            <input type="text" class="form-control" style="padding: 4px 8px; font-size: 12px; font-weight: 600;" value="${b.bed_code}" oninput="updateBed(${index}, 'bed_code', this.value)">
          </td>
          <td>
            <div style="display: flex; gap: 4px; align-items: center;">
              <span style="font-size: 11px; color: var(--text-muted);">X:</span>
              <input type="number" step="0.01" min="0" class="form-control" style="width: 65px; padding: 4px;" value="${xVal}" oninput="updateBed(${index}, 'x', this.value)">
              <span style="font-size: 11px; color: var(--text-muted);">Y:</span>
              <input type="number" step="0.01" min="0" class="form-control" style="width: 65px; padding: 4px;" value="${yVal}" oninput="updateBed(${index}, 'y', this.value)">
            </div>
          </td>
          <td>
            <select class="form-control" style="padding: 4px 8px; font-size: 11px; font-weight: 600;" onchange="updateBed(${index}, 'rotation_deg', this.value)">
              <option value="0" ${rot === 0 ? 'selected' : ''}>⬆️ 0° (North)</option>
              <option value="90" ${rot === 90 ? 'selected' : ''}>➡️ 90° (East)</option>
              <option value="180" ${rot === 180 ? 'selected' : ''}>⬇️ 180° (South)</option>
              <option value="270" ${rot === 270 ? 'selected' : ''}>⬅️ 270° (West)</option>
            </select>
          </td>
          <td style="color: var(--text-secondary); font-size: 12px; font-weight: 600; white-space: nowrap;">
            ${spanXM.toFixed(2)}m × ${spanYM.toFixed(2)}m
          </td>
          <td>
            <select class="form-control" style="padding: 4px 8px; font-size: 11px;" onchange="updateBed(${index}, 'status', this.value)">
              <option value="AVAILABLE" ${statusVal === 'AVAILABLE' ? 'selected' : ''}>✅ Available</option>
              <option value="UNAVAILABLE" ${statusVal === 'UNAVAILABLE' ? 'selected' : ''}>⛔ Unavailable</option>
            </select>
          </td>
          <td>
            <button class="btn btn-danger-outline btn-sm" onclick="deleteBed(${index})">🗑</button>
          </td>
        </tr>`;
        tbody.insertAdjacentHTML('beforeend', row);
      });
    }

    function addBed() {
      if (!currentWard.beds) currentWard.beds = [];
      const newNum = currentWard.beds.length + 1;
      const col = (newNum - 1) % 2;
      const row = Math.floor((newNum - 1) / 2);
      const newX = Math.round((0.80 + col * 3.90) * 100) / 100;
      const newY = Math.round((0.40 + row * 1.80) * 100) / 100;

      currentWard.beds.push({
        bed_id: `BED-${currentWard.ward_id}-${String(newNum).padStart(2, '0')}`,
        bed_code: `Bed ${newNum}`,
        x: newX,
        y: newY,
        width: 0.90,
        length: 2.00,
        rotation_deg: 0,
        status: 'AVAILABLE'
      });
      renderBedsTable();
      updateWardStats();
      redrawWardMap();
      markUnsavedChanges();
    }

    function updateBed(index, field, value) {
      if (currentWard.beds && currentWard.beds[index]) {
        if (field === 'x' || field === 'y') {
          currentWard.beds[index][field] = Math.max(0, Math.round((parseFloat(value) || 0) * 100) / 100);
        } else if (field === 'rotation_deg') {
          currentWard.beds[index].rotation_deg = parseInt(value, 10) || 0;
          renderBedsTable();
        } else if (field === 'status') {
          currentWard.beds[index].status = value === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'AVAILABLE';
        } else {
          currentWard.beds[index][field] = value;
        }
        redrawWardMap();
        markUnsavedChanges();
      }
    }

    function deleteBed(index) {
      if (currentWard.beds) {
        currentWard.beds.splice(index, 1);
        renderBedsTable();
        updateWardStats();
        redrawWardMap();
        markUnsavedChanges();
      }
    }

    // --- Anchors Manager ---
    function renderAnchorsTable() {
      const tbody = document.getElementById('anchors-table-body');
      tbody.innerHTML = '';
      const list = currentWard.anchors || [];
      document.getElementById('anchor-count-badge').innerText = `${list.length} Mounted`;

      if (list.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 14px;">No BLE anchors mounted. Trilateration requires at least 3 anchors.</td></tr>`;
        return;
      }

      list.forEach((a, index) => {
        const xVal = Number(a.x !== undefined ? a.x : 0).toFixed(2);
        const yVal = Number(a.y !== undefined ? a.y : 0).toFixed(2);
        const zVal = Number(a.z !== undefined ? a.z : 1.80).toFixed(2);

        const optionsHtml = buildAnchorDropdownOptions(index, a.device_id);

        // Status badge: LIVE (ONLINE) / ALERT (OFFLINE) / NEUTRAL (STANDBY)
        const isAssigned = !!a.device_id;
        let statusBadgeHtml = '';
        if (isAssigned) {
          const foundDev = cachedRegisteredAnchors.find(d => d.device_id === a.device_id);
          const liveStatus = (foundDev ? foundDev.status : a.status) || 'OFFLINE';
          statusBadgeHtml = `<span class="badge ${liveStatus === 'ONLINE' ? 'badge-live' : 'badge-alert'}">● ${liveStatus}</span>`;
        } else {
          statusBadgeHtml = `<span class="badge badge-neutral">● STANDBY</span>`;
        }

        const row = `<tr>
          <td><b style="color: var(--primary); font-size: 12px;">${a.anchor_id}</b></td>
          <td>
            <select class="form-control anchor-hardware-select" data-slot-index="${index}" style="padding: 4px 8px; font-size: 12px; font-weight: 600;" onchange="onAnchorDeviceSelected(${index}, this.value)">
              ${optionsHtml}
            </select>
          </td>
          <td>
            <div style="display: flex; gap: 4px; align-items: center;">
              <span style="font-size: 11px; color: var(--text-muted);">X:</span>
              <input type="number" step="0.01" min="0" class="form-control" style="width: 58px; padding: 4px;" value="${xVal}" oninput="updateAnchor(${index}, 'x', this.value)">
              <span style="font-size: 11px; color: var(--text-muted);">Y:</span>
              <input type="number" step="0.01" min="0" class="form-control" style="width: 58px; padding: 4px;" value="${yVal}" oninput="updateAnchor(${index}, 'y', this.value)">
              <span style="font-size: 11px; color: var(--text-muted);">Z:</span>
              <input type="number" step="0.01" min="0" class="form-control" style="width: 54px; padding: 4px;" value="${zVal}" oninput="updateAnchor(${index}, 'z', this.value)">
            </div>
          </td>
          <td class="anchor-status-cell" data-slot-index="${index}">
            ${statusBadgeHtml}
          </td>
          <td>
            <button class="btn btn-danger-outline btn-sm" onclick="deleteAnchor(${index})">🗑</button>
          </td>
        </tr>`;
        tbody.insertAdjacentHTML('beforeend', row);
      });
    }

    function onAnchorDeviceSelected(index, selectedDeviceId) {
      if (!currentWard.anchors || !currentWard.anchors[index]) return;
      const devId = (selectedDeviceId || '').trim();
      if (!devId) {
        currentWard.anchors[index].device_id = null;
        currentWard.anchors[index].mac_address = '';
        currentWard.anchors[index].status = 'STANDBY';
      } else {
        currentWard.anchors[index].device_id = devId;
        const foundDev = cachedRegisteredAnchors.find(d => d.device_id === devId);
        if (foundDev) {
          currentWard.anchors[index].mac_address = foundDev.mac_address || '';
          currentWard.anchors[index].status = foundDev.status || 'OFFLINE';
        }
      }
      renderAnchorsTable();
      redrawWardMap();
      markUnsavedChanges();
    }

    function addAnchor() {
      if (!currentWard.anchors) currentWard.anchors = [];
      const letter = String.fromCharCode(65 + currentWard.anchors.length);
      currentWard.anchors.push({
        anchor_id: `Anchor ${letter}`,
        device_id: null,
        mac_address: '',
        x: 0.50,
        y: 0.50,
        z: 1.80,
        wall_location: `Wall ${letter}`,
        status: 'STANDBY'
      });
      renderAnchorsTable();
      updateWardStats();
      redrawWardMap();
      markUnsavedChanges();
    }

    function updateAnchor(index, field, value) {
      if (currentWard.anchors && currentWard.anchors[index]) {
        if (field === 'x' || field === 'y' || field === 'z') {
          currentWard.anchors[index][field] = Math.max(0, Math.round((parseFloat(value) || 0) * 100) / 100);
        } else {
          currentWard.anchors[index][field] = value;
        }
        redrawWardMap();
        markUnsavedChanges();
      }
    }

    function deleteAnchor(index) {
      if (currentWard.anchors) {
        currentWard.anchors.splice(index, 1);
        renderAnchorsTable();
        updateWardStats();
        redrawWardMap();
        markUnsavedChanges();
      }
    }

    /**
     * Phase 3: Auto-Suggest Optimal BLE Wall Anchors Engine
     * Calculates mathematically optimal perimeter wall coordinates (X, Y, Z)
     * strictly mounted on perimeter walls at ceiling height (Z = room height)
     * maximizing baseline triangle area (low GDOP) and ensuring 3D Line-of-Sight
     * over tables (0.75m) and beds (0.85m).
     *
     * Displays an interactive 2D simulation preview in a modal dialog.
     * Does NOT touch the active configuration until the user confirms "Accept & Apply".
     */
    function autoSuggestAnchors() {
      if (!currentWard) return;
      const roomX = parseFloat(currentWard.length_x) || 6.40;
      const roomY = parseFloat(currentWard.width_y) || 4.80;
      const roomH = parseFloat(currentWard.height_z) || 2.80;
      const obstacles = currentWard.obstacles || [];
      const door = currentWard.door || { wall: 'SOUTH', x: 2.80, width: 0.90 };
      const beds = currentWard.beds || [];

      // Patient wristband nominal height (Z = 0.85m on patient wrist)
      const zWrist = 0.85;

      // Extract 3D bed targets
      const bedTargets = beds.map(b => {
        const rot = parseInt(b.rotation_deg, 10) || 0;
        const isH = (rot === 90 || rot === 270);
        const spanX = isH ? (b.length || 2.00) : (b.width || 0.90);
        const spanY = isH ? (b.width || 0.90) : (b.length || 2.00);
        return {
          code: b.bed_code,
          x: b.x + spanX / 2,
          y: b.y + spanY / 2,
          z: zWrist
        };
      });

      // Ray-cast helper using window.check3dRayLos
      const rayChecker = typeof window.check3dRayLos === 'function' ? window.check3dRayLos : function(A, T, obsList, rH) {
        return { clear: true };
      };

      // Helper to evaluate candidate wall positions
      function findBestWallPosition({ targetWall, rangeMin, rangeMax, step = 0.05 }) {
        let best = null;
        let bestScore = -9999;

        for (let pos = rangeMin; pos <= rangeMax + 0.001; pos += step) {
          const rPos = Math.round(pos * 100) / 100;
          let ax = 0, ay = 0;
          let wallDesc = '';

          if (targetWall === 'NORTH') {
            ax = rPos;
            ay = roomY; // Flush on North wall
            wallDesc = 'North Wall (Flush)';
          } else if (targetWall === 'SOUTH') {
            ax = rPos;
            ay = 0.00; // Flush on South wall
            wallDesc = 'South Wall (Flush)';
          } else if (targetWall === 'WEST') {
            ax = 0.00; // Flush on West wall
            ay = rPos;
            wallDesc = 'West Wall (Flush)';
          } else if (targetWall === 'EAST') {
            ax = roomX; // Flush on East wall
            ay = rPos;
            wallDesc = 'East Wall (Flush)';
          }

          // 1. Must not penetrate an obstacle footprint on the wall
          let insideObs = false;
          for (const obs of obstacles) {
            if (ax >= obs.x - 0.08 && ax <= obs.x + obs.width + 0.08 &&
                ay >= obs.y - 0.08 && ay <= obs.y + obs.length + 0.08) {
              insideObs = true;
              break;
            }
          }
          if (insideObs) continue;

          // 2. Must not collide with door threshold
          if (door && door.wall === targetWall) {
            const doorStart = (door.x || 0) - 0.20;
            const doorEnd = (door.x || 0) + (door.width || 0.90) + 0.20;
            const coord = (targetWall === 'NORTH' || targetWall === 'SOUTH') ? ax : ay;
            if (coord >= doorStart && coord <= doorEnd) continue;
          }

          // 3. 3D Line-of-Sight evaluation to all beds
          let clearCount = 0;
          const aObj = { x: ax, y: ay, z: roomH };
          for (const bt of bedTargets) {
            const los = rayChecker(aObj, bt, obstacles, roomH);
            if (los.clear) clearCount++;
          }

          // Score: prioritize direct 3D LOS, then baseline spread
          let score = clearCount * 100;
          if (targetWall === 'SOUTH') {
            const distFromMid = Math.abs(ax - roomX / 2);
            score -= distFromMid * 10;
          } else if (targetWall === 'NORTH') {
            if (rangeMin < roomX / 2) {
              score -= (ax - rangeMin) * 5; // Favor corner
            } else {
              score -= (rangeMax - ax) * 5;
            }
          }

          if (score > bestScore) {
            bestScore = score;
            best = {
              x: ax,
              y: ay,
              z: roomH,
              wall_location: wallDesc,
              clearBeds: clearCount,
              totalBeds: bedTargets.length
            };
          }
        }
        return best;
      }

      // Anchor A Candidate (North-West)
      // Check North wall first; if completely blocked by obstacle/cutout, try West wall
      let candA = findBestWallPosition({ targetWall: 'NORTH', rangeMin: 0.40, rangeMax: Math.max(0.40, Math.min(roomX / 2 - 0.20, 2.00)) });
      if (!candA) {
        candA = findBestWallPosition({ targetWall: 'WEST', rangeMin: Math.max(0.40, roomY / 2 + 0.20), rangeMax: Math.max(0.40, roomY - 0.40) });
      }
      if (!candA) {
        candA = { x: 0.40, y: roomY, z: roomH, wall_location: 'North Wall (Flush)', clearBeds: bedTargets.length, totalBeds: bedTargets.length };
      }

      // Anchor B Candidate (North-East)
      let candB = findBestWallPosition({ targetWall: 'NORTH', rangeMin: Math.max(roomX / 2 + 0.20, roomX - 2.00), rangeMax: Math.max(0.40, roomX - 0.40) });
      if (!candB) {
        candB = findBestWallPosition({ targetWall: 'EAST', rangeMin: Math.max(0.40, roomY / 2 + 0.20), rangeMax: Math.max(0.40, roomY - 0.40) });
      }
      if (!candB) {
        candB = { x: Math.max(0.40, Math.round((roomX - 0.40) * 100) / 100), y: roomY, z: roomH, wall_location: 'North Wall (Flush)', clearBeds: bedTargets.length, totalBeds: bedTargets.length };
      }

      // Anchor C Candidate (South Wall)
      let candC = findBestWallPosition({ targetWall: 'SOUTH', rangeMin: 0.40, rangeMax: Math.max(0.40, roomX - 0.40) });
      if (!candC) {
        candC = { x: Math.round((roomX / 2) * 100) / 100, y: 0.00, z: roomH, wall_location: 'South Wall (Flush)', clearBeds: bedTargets.length, totalBeds: bedTargets.length };
      }

      // Existing anchors hardware preservation
      const existingAnchors = currentWard.anchors || [];
      const suggestedAnchors = [];

      // Anchor A
      suggestedAnchors.push({
        anchor_id: existingAnchors[0]?.anchor_id || 'Anchor A',
        device_id: existingAnchors[0]?.device_id || null,
        mac_address: existingAnchors[0]?.mac_address || '',
        status: existingAnchors[0]?.status || 'STANDBY',
        x: candA.x,
        y: candA.y,
        z: candA.z,
        wall_location: candA.wall_location,
        clearBeds: candA.clearBeds,
        totalBeds: candA.totalBeds
      });

      // Anchor B
      suggestedAnchors.push({
        anchor_id: existingAnchors[1]?.anchor_id || 'Anchor B',
        device_id: existingAnchors[1]?.device_id || null,
        mac_address: existingAnchors[1]?.mac_address || '',
        status: existingAnchors[1]?.status || 'STANDBY',
        x: candB.x,
        y: candB.y,
        z: candB.z,
        wall_location: candB.wall_location,
        clearBeds: candB.clearBeds,
        totalBeds: candB.totalBeds
      });

      // Anchor C
      suggestedAnchors.push({
        anchor_id: existingAnchors[2]?.anchor_id || 'Anchor C',
        device_id: existingAnchors[2]?.device_id || null,
        mac_address: existingAnchors[2]?.mac_address || '',
        status: existingAnchors[2]?.status || 'STANDBY',
        x: candC.x,
        y: candC.y,
        z: candC.z,
        wall_location: candC.wall_location,
        clearBeds: candC.clearBeds,
        totalBeds: candC.totalBeds
      });

      // If 4th anchor exists
      if (existingAnchors.length >= 4) {
        const candD = findBestWallPosition({ targetWall: 'EAST', rangeMin: 0.40, rangeMax: Math.max(0.40, roomY / 2 - 0.20) }) ||
                      findBestWallPosition({ targetWall: 'WEST', rangeMin: 0.40, rangeMax: Math.max(0.40, roomY / 2 - 0.20) });
        if (candD) {
          suggestedAnchors.push({
            anchor_id: existingAnchors[3]?.anchor_id || 'Anchor D',
            device_id: existingAnchors[3]?.device_id || null,
            mac_address: existingAnchors[3]?.mac_address || '',
            status: existingAnchors[3]?.status || 'STANDBY',
            x: candD.x,
            y: candD.y,
            z: candD.z,
            wall_location: candD.wall_location,
            clearBeds: candD.clearBeds,
            totalBeds: candD.totalBeds
          });
        }
      }

      // Calculate baseline triangle area (GDOP coverage indicator)
      const triArea = Math.abs((candA.x * (candB.y - candC.y) + candB.x * (candC.y - candA.y) + candC.x * (candA.y - candB.y)) / 2);

      // Build proposed anchor cards HTML
      const anchorCardsHtml = suggestedAnchors.map(a => {
        const losText = a.totalBeds > 0
          ? (a.clearBeds === a.totalBeds
              ? `<span style="color:#10B981; font-weight:700;">🟢 ${a.clearBeds}/${a.totalBeds} Beds Clear (100% 3D LOS)</span>`
              : `<span style="color:#D97706; font-weight:700;">🟡 ${a.clearBeds}/${a.totalBeds} Beds Clear</span>`)
          : '<span style="color:var(--text-muted);">No Beds Configured</span>';

        const boundText = a.device_id
          ? `<span class="mono" style="color:var(--primary); font-weight:700;">${a.device_id}</span>`
          : `<span style="color:var(--text-muted); font-style:italic;">Standby (Unbound)</span>`;

        return `
          <div style="background: #F8FAFC; border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; margin-bottom: 6px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 3px;">
              <strong style="font-size:12px; color:var(--text-primary);">📡 ${a.anchor_id}</strong>
              <span style="font-size:11px;">Hardware: ${boundText}</span>
            </div>
            <div style="font-size:11px; color:var(--text-secondary); margin-bottom: 2px;">
              Placement: <strong>${a.wall_location}</strong> · X: <strong>${a.x.toFixed(2)}m</strong>, Y: <strong>${a.y.toFixed(2)}m</strong>, Z: <strong>${a.z.toFixed(2)}m</strong>
            </div>
            <div style="font-size:11px;">
              3D Line-of-Sight: ${losText}
            </div>
          </div>
        `;
      }).join('');

      const modalHtml = `
        <div style="display: grid; grid-template-columns: 460px 1fr; gap: 20px; align-items: start;">
          <!-- Left: 2D Digital Twin Simulation Preview -->
          <div>
            <div style="font-weight: 700; font-size: 12px; color: var(--text-primary); margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center;">
              <span>🗺️ 2D Suggested Placement & 3D LOS Ray Simulation</span>
              <span class="badge badge-live">Wall Mounted</span>
            </div>
            <div style="width: 460px; height: 320px; background: #0B1120; border-radius: 8px; overflow: hidden; border: 1px solid var(--border); position: relative;">
              <canvas id="modal-suggest-preview-canvas" width="460" height="320" style="width: 100%; height: 100%; display: block;"></canvas>
            </div>
            <!-- Visual Legend -->
            <div style="display: flex; justify-content: space-between; font-size: 10px; font-weight: 600; color: var(--text-muted); margin-top: 8px; flex-wrap: wrap; gap: 6px;">
              <span style="color: #0284C7;">🔵 Wall Anchors (Flush)</span>
              <span style="color: #10B981;">🟢 Direct 3D LOS</span>
              <span style="color: #EF4444;">🔴 NLOS Obstruction</span>
              <span>🛏️ Bed Target (0.85m)</span>
            </div>
          </div>

          <!-- Right: Coordinates & 3D Geometric Analysis -->
          <div>
            <!-- Metrics Pill Bar -->
            <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 12px; text-align: center;">
              <div style="background: var(--input-bg); border: 1px solid var(--border); border-radius: 6px; padding: 6px;">
                <div style="font-size: 10px; color: var(--text-muted); text-transform: uppercase; font-weight: 700;">Mounting Height</div>
                <div style="font-size: 14px; font-weight: 700; color: var(--primary); margin-top: 2px;">${roomH.toFixed(2)}m (Ceiling)</div>
              </div>
              <div style="background: var(--input-bg); border: 1px solid var(--border); border-radius: 6px; padding: 6px;">
                <div style="font-size: 10px; color: var(--text-muted); text-transform: uppercase; font-weight: 700;">Wristband Target</div>
                <div style="font-size: 14px; font-weight: 700; color: var(--status-success-text); margin-top: 2px;">Z = 0.85m</div>
              </div>
              <div style="background: var(--input-bg); border: 1px solid var(--border); border-radius: 6px; padding: 6px;">
                <div style="font-size: 10px; color: var(--text-muted); text-transform: uppercase; font-weight: 700;">Triangle Baseline</div>
                <div style="font-size: 14px; font-weight: 700; color: var(--text-primary); margin-top: 2px;">${triArea.toFixed(2)} m²</div>
              </div>
            </div>

            <!-- Proposed Anchors List -->
            <div style="font-weight: 700; font-size: 12px; color: var(--text-primary); margin-bottom: 6px;">
              Proposed Wall Positions:
            </div>
            <div style="max-height: 180px; overflow-y: auto; margin-bottom: 12px;">
              ${anchorCardsHtml}
            </div>

            <!-- Physical Optimization Insights -->
            <div style="background: #EFF6FF; border: 1px solid #BFDBFE; border-radius: 6px; padding: 8px 10px; font-size: 11px; color: #1E40AF; line-height: 1.4;">
              <strong>💡 Physical Optimization Insights:</strong><br>
              • Anchors are positioned <strong>strictly on perimeter walls</strong> (no floating coordinates).<br>
              • Ceiling mount height (${roomH.toFixed(2)}m) allows radio waves to travel <strong>downward over tables (0.75m) and bed frames</strong>.<br>
              • Existing hardware assignments are preserved. Click <strong>Accept & Apply</strong> to load these coordinates, or <strong>Cancel</strong> to keep current values.
            </div>
          </div>
        </div>
      `;

      // Show the confirmation and visual demo modal
      if (window.showModal) {
        window.showModal({
          title: '✨ Auto-Suggested Optimal BLE Wall Anchors',
          customHtml: modalHtml,
          isWide: true,
          type: 'info',
          confirmText: '✅ Accept & Apply',
          cancelText: 'Cancel',
          onConfirm: () => {
            applySuggestedAnchors(suggestedAnchors, triArea, roomH);
          },
          onCancel: () => {
            // Cancelled - do not touch anything
          }
        });

        // Render preview canvas after DOM has painted
        setTimeout(() => {
          const previewCanvas = document.getElementById('modal-suggest-preview-canvas');
          if (previewCanvas && typeof window.renderWardToCanvas === 'function') {
            const previewWard = JSON.parse(JSON.stringify(currentWard));
            previewWard.anchors = suggestedAnchors;
            window.renderWardToCanvas(previewCanvas, previewWard, {
              bgColor: '#FFFFFF',
              padding: 26,
              show3dLosRays: true
            });
          }
        }, 80);
      }
    }

    function applySuggestedAnchors(suggestedAnchors, triArea, roomH) {
      if (!currentWard || !Array.isArray(suggestedAnchors)) return;

      if (!Array.isArray(currentWard.anchors)) currentWard.anchors = [];
      while (currentWard.anchors.length < suggestedAnchors.length) {
        const letter = String.fromCharCode(65 + currentWard.anchors.length);
        currentWard.anchors.push({
          anchor_id: `Anchor ${letter}`,
          device_id: null,
          mac_address: '',
          x: 0,
          y: 0,
          z: roomH || 2.80,
          wall_location: `Wall ${letter}`,
          status: 'STANDBY'
        });
      }

      suggestedAnchors.forEach((sugg, idx) => {
        if (currentWard.anchors[idx]) {
          currentWard.anchors[idx].x = sugg.x;
          currentWard.anchors[idx].y = sugg.y;
          currentWard.anchors[idx].z = sugg.z;
          currentWard.anchors[idx].wall_location = sugg.wall_location;
        }
      });

      renderAnchorsTable();
      redrawWardMap();
      markUnsavedChanges();

      const msg = `✨ Optimal wall anchor layout applied! Ceiling mount: ${roomH.toFixed(2)}m. Baseline coverage: ${triArea.toFixed(2)} m². Click "Save Changes" to commit.`;
      if (typeof showToast === 'function') {
        showToast(msg, 'success', 4500);
      } else if (window.showToast) {
        window.showToast(msg, 'success', 4500);
      }
    }

    function updateWardStats() {
      const grossArea = (currentWard.length_x * currentWard.width_y);
      let cutArea = 0;
      if (currentWard.obstacles) {
        currentWard.obstacles.forEach(o => {
          cutArea += (o.width * o.length);
        });
      }
      const usableArea = Math.max(0, grossArea - cutArea);
      const grossEl = document.getElementById('stat-gross-area');
      const usableEl = document.getElementById('stat-usable-area');
      const bedsEl = document.getElementById('stat-active-beds');
      const anchorsEl = document.getElementById('stat-active-anchors');

      if (grossEl) grossEl.innerText = `${grossArea.toFixed(2)} m²`;
      if (usableEl) usableEl.innerText = `${usableArea.toFixed(2)} m²`;
      if (bedsEl) bedsEl.innerText = `${currentWard.beds ? currentWard.beds.length : 0} Cubicles`;
      if (anchorsEl) anchorsEl.innerText = `${currentWard.anchors ? currentWard.anchors.length : 0} Nodes`;
    }

    // --- Presets, Persistence & Import/Export ---
    function applyWardTemplate(templateId) {
      if (!templateId || templateId === 'NONE') return;
      if (availableTemplates && availableTemplates[templateId]) {
        const tpl = availableTemplates[templateId];
        currentWard.layout_type = templateId;
        currentWard.length_x = tpl.dimensions.length_x;
        currentWard.width_y = tpl.dimensions.width_y;
        currentWard.height_z = tpl.dimensions.height_z;
        currentWard.door = JSON.parse(JSON.stringify(tpl.door));
        currentWard.obstacles = JSON.parse(JSON.stringify(tpl.obstacles));
        currentWard.beds = JSON.parse(JSON.stringify(tpl.beds));
        currentWard.anchors = JSON.parse(JSON.stringify(tpl.anchors));
        populateWardUI();
        markUnsavedChanges();
        const presetSelect = document.getElementById('cfg-template-select');
        if (presetSelect) presetSelect.value = templateId;
      }
    }

    function saveWardConfiguration() {
      // 1. Explicitly sync room meta, dimensions, and door
      syncWardMeta();
      syncWardDimensions();
      syncWardDoor();

      // 2. Explicitly scan each anchor row in DOM table to guarantee currentWard.anchors matches dropdowns
      const anchorSelects = document.querySelectorAll('.anchor-hardware-select');
      anchorSelects.forEach(sel => {
        const idx = parseInt(sel.getAttribute('data-slot-index'), 10);
        if (!isNaN(idx) && currentWard.anchors && currentWard.anchors[idx]) {
          const selectedId = (sel.value || '').trim() || null;
          currentWard.anchors[idx].device_id = selectedId;
          if (selectedId) {
            const dev = cachedRegisteredAnchors.find(d => d.device_id === selectedId);
            if (dev) {
              currentWard.anchors[idx].mac_address = dev.mac_address || '';
              currentWard.anchors[idx].status = dev.status || 'OFFLINE';
            }
          } else {
            currentWard.anchors[idx].mac_address = '';
            currentWard.anchors[idx].status = 'STANDBY';
          }
        }
      });

      const actionText = isCreatingNew ? 'Create New Ward' : 'Save Changes';
      const bedCount = Array.isArray(currentWard.beds) ? currentWard.beds.length : 0;
      const anchorCount = Array.isArray(currentWard.anchors) ? currentWard.anchors.length : 0;
      const obsCount = Array.isArray(currentWard.obstacles) ? currentWard.obstacles.length : 0;

      const confirmMsg = isCreatingNew
        ? `Register and persist new ward "${currentWard.ward_id}" (${currentWard.room_title || 'Standard Ward'}) to MySQL database?\n\nLayout includes ${bedCount} cubicle beds, ${anchorCount} BLE anchors, and ${obsCount} obstacle cutouts.`
        : `Save configuration changes for ward "${currentWard.ward_id}" (${currentWard.room_title || 'Ward'}) to MySQL database?\n\nRoom dimensions, bed coordinates, and anchor positions will be updated.`;

      showModal({
        title: isCreatingNew ? 'Confirm New Ward Creation' : 'Confirm Save Ward Changes',
        message: confirmMsg,
        type: isCreatingNew ? 'info' : 'warning',
        confirmText: actionText,
        cancelText: 'Cancel',
        onConfirm: async () => {
          try {
            const res = await fetch('/api/ward/config', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(currentWard)
            });
            const result = await res.json();
            if (result.success) {
              showToast(isCreatingNew ? `Success! Ward ${currentWard.ward_id} created and committed to MySQL.` : `Success! Changes for ${currentWard.ward_id} committed to MySQL.`, 'success');
              isCreatingNew = false;
              captureWardSnapshot();
              // Directly redirect to Ward Directory list view
              forceReturnToWardDirectory();
            } else {
              showModal({
                title: 'Database Save Failed',
                message: `MySQL Error: ${result.error}`,
                type: 'danger',
                confirmText: 'Dismiss'
              });
            }
          } catch (err) {
            showModal({
              title: 'Connection Error',
              message: `Failed to save ward to server: ${err.message}`,
              type: 'danger',
              confirmText: 'Dismiss'
            });
          }
        }
      });
    }

    function exportWardJSON() {
      const blob = new Blob([JSON.stringify(currentWard, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ward_config_${currentWard.ward_id || 'WARD-001'}.json`;
      a.click();
      URL.revokeObjectURL(url);
    }

    function importWardJSON(event) {
      const file = event.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const parsed = JSON.parse(e.target.result);
          if (parsed.length_x && parsed.width_y) {
            currentWard = parsed;
            populateWardUI();
            markUnsavedChanges();
            showToast(`Imported ward layout: ${currentWard.room_title || currentWard.ward_id}. Review and click "${isCreatingNew ? 'Create New Ward' : 'Save Changes'}" to commit.`, 'info', 4000);
          } else {
            showModal({ title: 'Invalid JSON', message: 'The uploaded file does not contain valid room dimensions.', type: 'danger', confirmText: 'Dismiss' });
          }
        } catch (err) {
          showModal({ title: 'Parse Error', message: 'Could not parse JSON file. Please check syntax.', type: 'danger', confirmText: 'Dismiss' });
        }
      };
      reader.readAsText(file);
      event.target.value = '';
    }

    function resetWardDefault() {
      showModal({
        title: 'Reset Ward Layout',
        message: `Reset configuration for "${currentWard.ward_id}" back to default?\n\nAny unsaved changes made in this session will be reverted.`,
        type: 'warning',
        confirmText: 'Reset Layout',
        cancelText: 'Cancel',
        onConfirm: async () => {
          if (isCreatingNew) {
            // For a new ward, reset to standard rectangular 2-bed template
            applyWardTemplate('RECTANGLE');
            captureWardSnapshot();
            const presetSelect = document.getElementById('cfg-template-select');
            if (presetSelect) presetSelect.value = 'NONE';
            showToast(`New ward ${currentWard.ward_id} layout reset to default template.`, 'info');
          } else {
            // For an existing ward, reload the saved configuration from MySQL
            try {
              const res = await fetch(`/api/ward/config?ward_id=${encodeURIComponent(currentWard.ward_id)}`);
              const data = await res.json();
              if (data.success && data.ward) {
                currentWard = data.ward;
                populateWardUI();
                captureWardSnapshot();
                const presetSelect = document.getElementById('cfg-template-select');
                if (presetSelect) presetSelect.value = 'NONE';
                showToast(`Ward ${currentWard.ward_id} restored to saved database state.`, 'success');
              } else {
                applyWardTemplate(currentWard.layout_type || 'RECTANGLE');
                captureWardSnapshot();
                const presetSelect = document.getElementById('cfg-template-select');
                if (presetSelect) presetSelect.value = 'NONE';
                showToast(`Ward ${currentWard.ward_id} reset to template default.`, 'info');
              }
            } catch (err) {
              applyWardTemplate(currentWard.layout_type || 'RECTANGLE');
              captureWardSnapshot();
              const presetSelect = document.getElementById('cfg-template-select');
              if (presetSelect) presetSelect.value = 'NONE';
              showToast(`Ward ${currentWard.ward_id} reset to template default.`, 'info');
            }
          }
          setTimeout(redrawWardMap, 60);
          if (window.requestAnimationFrame) window.requestAnimationFrame(redrawWardMap);
        }
      });
    }

// Expose state and functions globally for views and event listeners
Object.defineProperty(window, 'currentWard', {
  get: () => currentWard,
  set: (val) => { currentWard = val; },
  configurable: true
});

Object.defineProperty(window, 'wardsList', {
  get: () => wardsList,
  set: (val) => { wardsList = val; },
  configurable: true
});

Object.defineProperty(window, 'availableTemplates', {
  get: () => availableTemplates,
  set: (val) => { availableTemplates = val; },
  configurable: true
});

window.hasUnsavedWardChanges = hasUnsavedWardChanges;
window.captureWardSnapshot = captureWardSnapshot;
window.forceReturnToWardDirectory = forceReturnToWardDirectory;
window.generateNextWardId = generateNextWardId;
window.loadWardDirectory = loadWardDirectory;
window.renderWardDirectoryTable = renderWardDirectoryTable;
window.filterWardDirectory = filterWardDirectory;
window.returnToWardDirectory = returnToWardDirectory;
window.openWardEditor = openWardEditor;
window.viewWardDetailsReadOnly = viewWardDetailsReadOnly;
window.createNewWard = createNewWard;
window.deleteWardRecord = deleteWardRecord;
window.loadWardDataFromDB = loadWardDataFromDB;
window.populateWardUI = populateWardUI;
window.syncWardMeta = syncWardMeta;
window.syncWardDimensions = syncWardDimensions;
window.syncWardDoor = syncWardDoor;
window.markUnsavedChanges = markUnsavedChanges;
window.renderObstaclesTable = renderObstaclesTable;
window.onObstacleTypeChange = onObstacleTypeChange;
window.addObstacle = addObstacle;
window.updateObstacle = updateObstacle;
window.deleteObstacle = deleteObstacle;
window.renderBedsTable = renderBedsTable;
window.addBed = addBed;
window.updateBed = updateBed;
window.deleteBed = deleteBed;
window.renderAnchorsTable = renderAnchorsTable;
window.onAnchorDeviceSelected = onAnchorDeviceSelected;
window.fetchRegisteredAnchors = fetchRegisteredAnchors;
window.setupWardWsListeners = setupWardWsListeners;
window.updateAnchorLiveStatus = updateAnchorLiveStatus;
window.addAnchor = addAnchor;
window.updateAnchor = updateAnchor;
window.deleteAnchor = deleteAnchor;
window.autoSuggestAnchors = autoSuggestAnchors;
window.applySuggestedAnchors = applySuggestedAnchors;
window.updateWardStats = updateWardStats;
window.applyWardTemplate = applyWardTemplate;
window.saveWardConfiguration = saveWardConfiguration;
window.exportWardJSON = exportWardJSON;
window.importWardJSON = importWardJSON;
window.resetWardDefault = resetWardDefault;
