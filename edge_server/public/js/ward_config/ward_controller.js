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
      document.getElementById('ward-editor-view').style.display = 'none';
      document.getElementById('ward-directory-view').style.display = 'block';
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
          ? w.beds.map(b => `
              <div style="display:flex; justify-content:space-between; align-items:center; padding:6px 8px; border-bottom:1px solid var(--border-light); font-size:12px;">
                <div><strong>${b.bed_code || b.bed_id}</strong> (${b.bed_id})</div>
                <div style="font-family:monospace; color:var(--text-muted);">${Number(b.x).toFixed(2)}m, ${Number(b.y).toFixed(2)}m</div>
                <span class="badge ${b.status === 'AVAILABLE' ? 'badge-live' : b.status === 'OCCUPIED' ? 'badge-alert' : 'badge-neutral'}">${b.status}</span>
              </div>`).join('')
          : '<div style="color:var(--text-muted); font-size:12px; padding:8px; text-align:center;">No beds configured.</div>';

        // Format Wall Anchors as structured individual cards
        const anchorsList = (w.anchors && w.anchors.length > 0)
          ? w.anchors.map(a => `
              <div style="background: #F8FAFC; border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; margin-bottom: 8px; box-shadow: 0 1px 2px rgba(0,0,0,0.03);">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 4px;">
                  <strong style="color:var(--text-primary); font-size:12px;">📡 ${a.anchor_id}</strong>
                  <span class="badge ${a.status === 'ONLINE' ? 'badge-live' : 'badge-neutral'}" style="font-size:10px;">${a.status || 'STANDBY'}</span>
                </div>
                <div style="font-size:11px; color:var(--text-secondary); margin-bottom: 2px;">
                  Position: (${Number(a.x).toFixed(2)}m, ${Number(a.y).toFixed(2)}m, ${Number(a.z).toFixed(2)}m) · ${a.wall_location || 'Wall'}
                </div>
                <div class="mono" style="font-size:10px; color:var(--primary); font-weight:600;">
                  ID / MAC: ${a.mac_address || a.id || '-'}
                </div>
              </div>`).join('')
          : '<div style="color:var(--text-muted); font-size:12px; padding:12px; text-align:center;">No BLE anchors configured.</div>';

        // Format Obstacles as structured individual cards (fixing undefined bug)
        const obstaclesList = (w.obstacles && w.obstacles.length > 0)
          ? w.obstacles.map(o => {
              const typeStr = o.type || 'CUTOUT';
              const icon = typeStr === 'TOILET' ? '🚽' : typeStr === 'PILLAR' ? '🏛️' : '📦';
              return `
                <div style="background: #F8FAFC; border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; margin-bottom: 8px; box-shadow: 0 1px 2px rgba(0,0,0,0.03);">
                  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 4px;">
                    <strong style="color:var(--text-primary); font-size:12px;">${icon} ${o.label || o.id || 'Cutout Zone'}</strong>
                    <span class="badge badge-neutral" style="font-size:10px;">${typeStr}</span>
                  </div>
                  <div style="font-size:11px; color:var(--text-secondary); margin-bottom: 2px;">
                    Type: ${typeStr}
                  </div>
                  <div style="font-size:11px; color:var(--text-secondary);">
                    Position: (${Number(o.x).toFixed(2)}m, ${Number(o.y).toFixed(2)}m) · Size: ${Number(o.width).toFixed(2)}m × ${Number(o.length).toFixed(2)}m
                  </div>
                </div>`;
            }).join('')
          : '<div style="color:var(--text-muted); font-size:12px; padding:12px; text-align:center;">No obstacle cutout zones.</div>';

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

        if (window.showModal) {
          window.showModal({
            title: `Ward Specifications & 2D Floor Plan: ${w.ward_id}`,
            customHtml: modalHtml,
            isWide: true,
            type: 'info',
            confirmText: '✏️ Configure Layout',
            cancelText: 'Close',
            onConfirm: () => {
              openWardEditor(w.ward_id);
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
        const res = await fetch(`/api/ward/config?ward_id=${encodeURIComponent(wardId)}`);
        const data = await res.json();
        if (data.success && data.ward) {
          isCreatingNew = false;
          currentWard = data.ward;
          document.getElementById('ward-directory-view').style.display = 'none';
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

    function createNewWard() {
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
          { anchor_id: 'anchor-A', mac_address: 'C4:DE:E2:10:01:BA', x: 0.50, y: 4.30, z: 1.80, wall_location: 'North-West Wall', status: 'STANDBY' },
          { anchor_id: 'anchor-B', mac_address: 'C4:DE:E2:10:01:BB', x: 5.90, y: 4.30, z: 1.80, wall_location: 'North-East Wall', status: 'STANDBY' },
          { anchor_id: 'anchor-C', mac_address: 'C4:DE:E2:10:01:BC', x: 2.80, y: 0.50, z: 1.80, wall_location: 'South Wall', status: 'STANDBY' }
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
      document.getElementById('obstacle-count-badge').innerText = `${list.length} Cutout${list.length === 1 ? '' : 's'}`;

      if (list.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 14px;">No cutouts configured. Entire room is open rectangle.</td></tr>`;
        return;
      }

      list.forEach((obs, index) => {
        const xVal = Number(obs.x !== undefined ? obs.x : 0).toFixed(2);
        const yVal = Number(obs.y !== undefined ? obs.y : 0).toFixed(2);
        const wVal = Number(obs.width !== undefined ? obs.width : 1.0).toFixed(2);
        const lVal = Number(obs.length !== undefined ? obs.length : 1.0).toFixed(2);

        const row = `<tr>
          <td>
            <select class="form-control" style="padding: 4px 8px; font-size: 11px;" onchange="updateObstacle(${index}, 'type', this.value)">
              <option value="TOILET" ${obs.type === 'TOILET' ? 'selected' : ''}>🚽 Toilet</option>
              <option value="PILLAR" ${obs.type === 'PILLAR' ? 'selected' : ''}>🏛️ Pillar</option>
              <option value="STORAGE" ${obs.type === 'STORAGE' ? 'selected' : ''}>📦 Storage</option>
              <option value="PARTITION" ${obs.type === 'PARTITION' ? 'selected' : ''}>🧱 Partition</option>
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
            <button class="btn btn-danger-outline btn-sm" onclick="deleteObstacle(${index})">🗑</button>
          </td>
        </tr>`;
        tbody.insertAdjacentHTML('beforeend', row);
      });
    }

    function addObstacle() {
      if (!currentWard.obstacles) currentWard.obstacles = [];
      const newIdx = currentWard.obstacles.length + 1;
      currentWard.obstacles.push({
        id: `OBS-${currentWard.ward_id}-${newIdx}`,
        type: 'TOILET',
        label: `Bathroom Cutout ${newIdx}`,
        x: 0.00,
        y: Math.max(0, Math.round((currentWard.width_y - 1.60) * 100) / 100),
        width: 1.80,
        length: 1.60
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
        } else if (field === 'width' || field === 'length') {
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
        tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 14px;">No beds registered in this ward.</td></tr>`;
        return;
      }

      list.forEach((b, index) => {
        const statusVal = b.status === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'AVAILABLE';
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
          <td style="color: var(--text-secondary); font-size: 12px;">0.90m × 2.00m</td>
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

        const row = `<tr>
          <td><b style="color: var(--primary); font-size: 12px;">${a.anchor_id}</b></td>
          <td><input type="text" class="form-control mono" style="padding: 4px 8px; font-size: 11px;" value="${a.mac_address}" oninput="updateAnchor(${index}, 'mac_address', this.value)"></td>
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
          <td>
            <span class="badge ${a.status === 'ONLINE' ? 'badge-live' : 'badge-neutral'}">${a.status}</span>
          </td>
          <td>
            <button class="btn btn-danger-outline btn-sm" onclick="deleteAnchor(${index})">🗑</button>
          </td>
        </tr>`;
        tbody.insertAdjacentHTML('beforeend', row);
      });
    }

    function addAnchor() {
      if (!currentWard.anchors) currentWard.anchors = [];
      const letter = String.fromCharCode(65 + currentWard.anchors.length);
      currentWard.anchors.push({
        anchor_id: `anchor-${letter}`,
        mac_address: `C4:DE:E2:10:01:A${letter}`,
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
window.addObstacle = addObstacle;
window.updateObstacle = updateObstacle;
window.deleteObstacle = deleteObstacle;
window.renderBedsTable = renderBedsTable;
window.addBed = addBed;
window.updateBed = updateBed;
window.deleteBed = deleteBed;
window.renderAnchorsTable = renderAnchorsTable;
window.addAnchor = addAnchor;
window.updateAnchor = updateAnchor;
window.deleteAnchor = deleteAnchor;
window.updateWardStats = updateWardStats;
window.applyWardTemplate = applyWardTemplate;
window.saveWardConfiguration = saveWardConfiguration;
window.exportWardJSON = exportWardJSON;
window.importWardJSON = importWardJSON;
window.resetWardDefault = resetWardDefault;
