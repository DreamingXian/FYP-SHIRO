// =============================================================================
// SHIRO Hospital Edge Admin - Bindings Controller (MVC Client Controller)
// Manages Searchable Patient-to-Wristband Pairing, Live Telemetry Links & Pagination
// =============================================================================

  let cachedActiveBindings = [];
  let cachedUnpairedPatients = [];
  let cachedUnpairedWristbands = [];

  let selectedPatient = null;
  let selectedWristband = null;

      let bindingSearchQuery = '';
      let bindingStatusFilter = 'ALL'; // 'ALL' | 'ONLINE' | 'OFFLINE'
      let currentBindingPage = 1;
      const BINDING_PAGE_SIZE = 10;

      let isBindingsInitialized = false;
      let isBindingsWsRegistered = false;

      /**
       * Initializes the Bindings module upon tab activation or system boot.
       */
      async function initBindingsModule() {
        setupBindingsGlobalListeners();
        setupBindingsWsListeners();
        await loadBindingsData();
      }

      /**
       * Loads both active bindings and unpaired candidate pools concurrently from MySQL.
       */
      async function loadBindingsData() {
        await Promise.all([
          fetchUnpairedCandidates(),
          fetchActiveBindings()
        ]);
      }

      /**
       * Global document listener to close combobox dropdowns when clicking outside.
       */
      function setupBindingsGlobalListeners() {
        if (isBindingsInitialized) return;
        isBindingsInitialized = true;

        document.addEventListener('click', (e) => {
          const patientContainer = document.getElementById('combobox-patient-container');
          const tagContainer = document.getElementById('combobox-tag-container');

          if (patientContainer && !patientContainer.contains(e.target)) {
            closePatientCombobox();
          }
          if (tagContainer && !tagContainer.contains(e.target)) {
            closeTagCombobox();
          }
        });
      }

        /**
         * Sets up WebSocket listeners for real-time telemetry and binding status sync.
         */
        function setupBindingsWsListeners() {
          if (isBindingsWsRegistered || !window.wsClient) return;
          isBindingsWsRegistered = true;

          window.wsClient.on('PATIENT_BOUND', () => {
            loadBindingsData();
          });

            window.wsClient.on('PATIENT_UNBOUND', () => {
              loadBindingsData();
            });

            // Track wristband heartbeat / telemetry to update live status badges without flashing
            window.wsClient.on('DEVICE_HEARTBEAT', (msg) => {
              if (!msg || !msg.device_id) return;
              if (msg.device_type === 'WRISTBAND' || msg.device_id.startsWith('TAG-') || msg.device_id.startsWith('wristband-')) {
                const status = (msg.is_charging || msg.status === 'CHARGING') ? 'CHARGING' : (msg.status || 'ONLINE');
                updateWristbandLiveStatusInBindings(msg.device_id, status, null, msg.battery_level);
              }
            });

            window.wsClient.on('TELEMETRY', (msg) => {
              const tagId = msg.data?.tag_id || msg.tag_id || 'TAG-001';
              const isChg = msg.data?.charging === true;
              const status = isChg ? 'CHARGING' : 'ONLINE';
              const mode = (msg.data?.motion === 'FALL_EMERGENCY') ? 'ACTIVE' : 'POWER_SAVING';
              updateWristbandLiveStatusInBindings(tagId, status, mode, msg.data?.battery);
            });
          }

          function updateWristbandLiveStatusInBindings(deviceId, status, mode = null, battery = null) {
            let changed = false;
            // Update in active bindings
            cachedActiveBindings.forEach(b => {
              if (b.device_id === deviceId) {
                if (b.device_status !== status) {
                  b.device_status = status;
                  changed = true;
                }
                if (mode && b.telemetry_mode !== mode) {
                  b.telemetry_mode = mode;
                  changed = true;
                }
                if (battery !== null && battery !== undefined && b.battery_level !== battery) {
                  b.battery_level = battery;
                  changed = true;
                }
              }
            });

            // Update in unpaired candidates
            cachedUnpairedWristbands.forEach(w => {
              if (w.device_id === deviceId) {
                if (w.device_status !== status) {
                  w.device_status = status;
                  changed = true;
                }
                if (battery !== null && battery !== undefined && w.battery_level !== battery) {
                  w.battery_level = battery;
                  changed = true;
                }
              }
            });

            // Update selected wristband preview if matched
            if (selectedWristband && selectedWristband.device_id === deviceId) {
              selectedWristband.device_status = status;
              if (battery !== null && battery !== undefined) selectedWristband.battery_level = battery;
              renderTagPreviewCard(selectedWristband);
            }

            if (changed) {
              renderBindingsTable();
            }
          }

          // =============================================================================
          // STEP 1: SEARCHABLE PATIENT COMBOBOX LOGIC
          // =============================================================================

          async function fetchUnpairedCandidates() {
            try {
              const res = await fetch('/api/bindings/unpaired-candidates');
              const data = await res.json();
              if (data.success) {
                // Patients and wristbands are already sorted newest first by MySQL
                cachedUnpairedPatients = data.patients || [];
                cachedUnpairedWristbands = data.wristbands || [];

                // Update badge counts in Wizard
                const pBadge = document.getElementById('unpaired-patient-count-badge');
                if (pBadge) pBadge.innerText = `${cachedUnpairedPatients.length} Unbound`;

                const tBadge = document.getElementById('unpaired-tag-count-badge');
                if (tBadge) tBadge.innerText = `${cachedUnpairedWristbands.length} Standby`;
              }
            } catch (err) {
              console.warn('Failed to fetch unpaired candidates:', err);
            }
          }

          function openPatientCombobox() {
            closeTagCombobox();
            const menu = document.getElementById('patient-combobox-menu');
            if (!menu) return;
            menu.style.display = 'block';

            const searchInput = document.getElementById('bind-patient-search');
            const query = searchInput ? searchInput.value.trim() : '';
            filterPatientCombobox(query);
          }

          function closePatientCombobox() {
            const menu = document.getElementById('patient-combobox-menu');
            if (menu) menu.style.display = 'none';
          }

          function filterPatientCombobox(rawQuery) {
            const menu = document.getElementById('patient-combobox-menu');
            if (!menu) return;

            const query = (rawQuery || '').toLowerCase().trim();
            let filtered = cachedUnpairedPatients;

            if (query && (!selectedPatient || selectedPatient.full_name.toLowerCase() !== query)) {
              filtered = cachedUnpairedPatients.filter(p =>
                (p.full_name && p.full_name.toLowerCase().includes(query)) ||
                (p.patient_id && p.patient_id.toLowerCase().includes(query)) ||
                (p.nric_passport && p.nric_passport.toLowerCase().includes(query)) ||
                (p.bed_code && p.bed_code.toLowerCase().includes(query)) ||
                (p.ward_title && p.ward_title.toLowerCase().includes(query))
              );
            }

            renderPatientComboboxItems(filtered);
          }

          function renderPatientComboboxItems(items) {
            const menu = document.getElementById('patient-combobox-menu');
            if (!menu) return;

            if (!items || items.length === 0) {
              menu.innerHTML = `
      <div style="padding: 16px; text-align: center; color: var(--text-muted); font-size: 12px;">
        ${cachedUnpairedPatients.length === 0 ? 'No unbound admitted patients available.' : 'No matching patients found.'}
      </div>`;
              return;
            }

            menu.innerHTML = items.map(p => {
              const initials = p.full_name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
              const avatarHtml = p.photo_url
                ? `<img src="${p.photo_url}" style="width: 34px; height: 34px; border-radius: 50%; object-fit: cover; border: 1.5px solid var(--border);" onerror="this.outerHTML='<div class=\\'patient-thumb\\' style=\\'width:34px;height:34px;font-size:11px;\\'>${initials}</div>'">`
                : `<div class="patient-thumb" style="width: 34px; height: 34px; font-size: 11px;">${initials}</div>`;

              const riskBadge = p.fall_risk_score === 'HIGH'
                ? '<span class="badge badge-alert" style="font-size: 10px;">● HIGH RISK</span>'
                : p.fall_risk_score === 'MEDIUM'
                  ? '<span class="badge badge-warning" style="font-size: 10px;">● MED RISK</span>'
                  : '<span class="badge badge-live" style="font-size: 10px;">● LOW RISK</span>';

              const bedText = p.bed_code ? `${p.bed_code} (${p.ward_title || 'Ward'})` : 'No Bed Assigned';
              const ageGender = `${p.age || '-'} yrs / ${p.gender ? p.gender[0] : '-'}`;

              return `
      <div class="combobox-item" onclick="selectPatientCandidate('${p.patient_id}')"
        style="padding: 10px 14px; border-bottom: 1px solid var(--border-light); cursor: pointer; display: flex; justify-content: space-between; align-items: center; transition: background 0.15s ease;"
        onmouseover="this.style.background='var(--input-bg)'" onmouseout="this.style.background='#FFFFFF'">
        <div style="display: flex; gap: 10px; align-items: center;">
          ${avatarHtml}
          <div>
            <div style="font-weight: 700; color: var(--text-primary); font-size: 13px;">
              ${p.full_name} <span class="mono" style="color: var(--primary); font-size: 11px; font-weight: 600;">(${p.patient_id})</span>
            </div>
            <div style="font-size: 11px; color: var(--text-muted); margin-top: 1px;">
              🛏️ ${bedText} · ${ageGender}
            </div>
          </div>
        </div>
        <div>
          ${riskBadge}
        </div>
      </div>
    `;
            }).join('');
          }

          function selectPatientCandidate(patientId) {
            const p = cachedUnpairedPatients.find(item => item.patient_id === patientId);
            if (!p) return;

            selectedPatient = p;
            document.getElementById('selected-patient-id').value = p.patient_id;

            const searchInput = document.getElementById('bind-patient-search');
            if (searchInput) {
              searchInput.value = `${p.full_name} (${p.patient_id})`;
            }

            const clearBtn = document.getElementById('btn-clear-patient');
            if (clearBtn) clearBtn.style.display = 'block';

            closePatientCombobox();
            renderPatientPreviewCard(p);
          }

          function clearPatientSelection() {
            selectedPatient = null;
            document.getElementById('selected-patient-id').value = '';

            const searchInput = document.getElementById('bind-patient-search');
            if (searchInput) searchInput.value = '';

            const clearBtn = document.getElementById('btn-clear-patient');
            if (clearBtn) clearBtn.style.display = 'none';

            const preview = document.getElementById('binding-patient-preview');
            if (preview) {
              preview.innerHTML = `
      <div style="color: var(--text-muted); font-size: 12px; font-style: italic; width: 100%; text-align: center;">
        Click above to search and select an unbound admitted patient.
      </div>`;
            }
          }

          function renderPatientPreviewCard(p) {
            const preview = document.getElementById('binding-patient-preview');
            if (!preview) return;

            const initials = p.full_name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
            const avatarHtml = p.photo_url
              ? `<img src="${p.photo_url}" style="width: 48px; height: 48px; border-radius: 50%; object-fit: cover; border: 2px solid var(--border);" onerror="this.outerHTML='<div class=\\'patient-thumb\\' style=\\'width:48px;height:48px;font-size:16px;\\'>${initials}</div>'">`
              : `<div class="patient-thumb" style="width: 48px; height: 48px; font-size: 16px;">${initials}</div>`;

            const riskBadge = p.fall_risk_score === 'HIGH'
              ? '<span class="badge badge-alert">● HIGH FALL RISK</span>'
              : p.fall_risk_score === 'MEDIUM'
                ? '<span class="badge badge-warning">● MEDIUM FALL RISK</span>'
                : '<span class="badge badge-live">● LOW FALL RISK</span>';

            const bedText = p.bed_code ? `${p.bed_code} (${p.ward_title || 'Ward'})` : 'No Bed Assigned';
            const ageGender = `${p.age || '-'} yrs / ${p.gender || 'Unknown'}`;

            preview.innerHTML = `
    <div style="display: flex; gap: 14px; align-items: center; width: 100%;">
      ${avatarHtml}
      <div style="flex: 1;">
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px;">
          <div style="font-weight: 700; color: var(--text-primary); font-size: 14px;">
            ${p.full_name} <span class="mono" style="color: var(--primary); font-size: 12px;">(${p.patient_id})</span>
          </div>
          ${riskBadge}
        </div>
        <div style="font-size: 12px; color: var(--text-muted); margin-top: 3px;">
          NRIC: <span class="mono">${p.nric_passport || '-'}</span> · Age: ${ageGender}
        </div>
        <div style="font-size: 12px; color: var(--text-secondary); margin-top: 2px;">
          🛏️ Assigned Bed: <strong style="color: var(--text-primary);">${bedText}</strong>
        </div>
      </div>
    </div>
  `;
          }

          // =============================================================================
          // STEP 2: SEARCHABLE WRISTBAND COMBOBOX LOGIC
          // =============================================================================

          function openTagCombobox() {
            closePatientCombobox();
            const menu = document.getElementById('tag-combobox-menu');
            if (!menu) return;
            menu.style.display = 'block';

            const searchInput = document.getElementById('bind-tag-search');
            const query = searchInput ? searchInput.value.trim() : '';
            filterTagCombobox(query);
          }

          function closeTagCombobox() {
            const menu = document.getElementById('tag-combobox-menu');
            if (menu) menu.style.display = 'none';
          }

          function filterTagCombobox(rawQuery) {
            const menu = document.getElementById('tag-combobox-menu');
            if (!menu) return;

            const query = (rawQuery || '').toLowerCase().trim();
            let filtered = cachedUnpairedWristbands;

            if (query && (!selectedWristband || selectedWristband.device_id.toLowerCase() !== query)) {
              filtered = cachedUnpairedWristbands.filter(w =>
                (w.device_id && w.device_id.toLowerCase().includes(query)) ||
                (w.mac_address && w.mac_address.toLowerCase().includes(query)) ||
                (w.hardware_model && w.hardware_model.toLowerCase().includes(query))
              );
            }

            renderTagComboboxItems(filtered);
          }

          function renderTagComboboxItems(items) {
            const menu = document.getElementById('tag-combobox-menu');
            if (!menu) return;

            if (!items || items.length === 0) {
              menu.innerHTML = `
      <div style="padding: 16px; text-align: center; color: var(--text-muted); font-size: 12px;">
        ${cachedUnpairedWristbands.length === 0 ? 'No standby wristbands available. Please enroll tags in the Devices page.' : 'No matching wristbands found.'}
      </div>`;
              return;
            }

            menu.innerHTML = items.map(w => {
              const statusUpper = (w.device_status || 'OFFLINE').toUpperCase();
              const statusBadge = statusUpper === 'CHARGING'
                ? '<span class="badge" style="background:#FEF3C7; color:#92400E; border:1px solid #F59E0B; font-size: 10px; font-weight: 600;">⚡ Charging</span>'
                : (statusUpper === 'ONLINE'
                  ? '<span class="badge badge-live" style="font-size: 10px;">● Online</span>'
                  : '<span class="badge badge-neutral" style="font-size: 10px;">○ Standby</span>');

              const batText = w.battery_level !== null && w.battery_level !== undefined ? `${w.battery_level}% Battery` : 'Battery N/A';

              return `
      <div class="combobox-item" onclick="selectWristbandCandidate('${w.device_id}')"
        style="padding: 10px 14px; border-bottom: 1px solid var(--border-light); cursor: pointer; display: flex; justify-content: space-between; align-items: center; transition: background 0.15s ease;"
        onmouseover="this.style.background='var(--input-bg)'" onmouseout="this.style.background='#FFFFFF'">
        <div>
          <div style="font-weight: 700; color: var(--text-primary); font-size: 13px;">
            ${w.device_id} <span class="mono" style="color: var(--text-muted); font-size: 11px;">(${w.mac_address})</span>
          </div>
          <div style="font-size: 11px; color: var(--text-muted); margin-top: 1px;">
            ${w.hardware_model || 'XIAO ESP32-C6'} · ${batText}
          </div>
        </div>
        <div>
          ${statusBadge}
        </div>
      </div>
    `;
            }).join('');
          }

          function selectWristbandCandidate(deviceId) {
            const w = cachedUnpairedWristbands.find(item => item.device_id === deviceId);
            if (!w) return;

            selectedWristband = w;
            document.getElementById('selected-device-id').value = w.device_id;

            const searchInput = document.getElementById('bind-tag-search');
            if (searchInput) {
              searchInput.value = `${w.device_id} (${w.mac_address})`;
            }

            const clearBtn = document.getElementById('btn-clear-tag');
            if (clearBtn) clearBtn.style.display = 'block';

            closeTagCombobox();
            renderTagPreviewCard(w);
          }

          function clearTagSelection() {
            selectedWristband = null;
            document.getElementById('selected-device-id').value = '';

            const searchInput = document.getElementById('bind-tag-search');
            if (searchInput) searchInput.value = '';

            const clearBtn = document.getElementById('btn-clear-tag');
            if (clearBtn) clearBtn.style.display = 'none';

            const preview = document.getElementById('binding-tag-preview');
            if (preview) {
              preview.innerHTML = `
      <div style="color: var(--text-muted); font-size: 12px; font-style: italic; width: 100%; text-align: center;">
        Click above to search and select an available standby wristband.
      </div>`;
            }
          }

          function renderTagPreviewCard(w) {
            const preview = document.getElementById('binding-tag-preview');
            if (!preview) return;

            const statusUpper = (w.device_status || 'OFFLINE').toUpperCase();
            const statusBadge = statusUpper === 'CHARGING'
              ? '<span class="badge" style="background:#FEF3C7; color:#92400E; border:1px solid #F59E0B; font-size: 11px; font-weight: 600;">⚡ Charging</span>'
              : (statusUpper === 'ONLINE'
                ? '<span class="badge badge-live">● Online</span>'
                : '<span class="badge badge-neutral">○ Standby (Ready)</span>');

            const batText = w.battery_level !== null && w.battery_level !== undefined ? `${w.battery_level}% Battery` : 'Battery N/A';

            preview.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; width: 100%; flex-wrap: wrap; gap: 8px;">
      <div>
        <div style="font-weight: 700; color: var(--text-primary); font-size: 14px;">
          ${w.device_id} <span style="font-weight: 400; font-size: 12px; color: var(--text-muted);">(${w.hardware_model || 'XIAO ESP32-C6'})</span>
        </div>
        <div class="mono" style="font-size: 11px; color: var(--primary); font-weight: 600; margin-top: 3px;">
          MAC: ${w.mac_address} · FW: ${w.firmware_version || 'v1.0.0'}
        </div>
        <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">
          ${batText} · Ready for Bio-telemetry stream
        </div>
      </div>
      <div style="text-align: right;">
        ${statusBadge}
        <div style="font-size: 11px; font-weight: 600; color: var(--status-success-text); margin-top: 4px;">
          Spatial Tracking Ready
        </div>
      </div>
    </div>
  `;
          }

          // =============================================================================
          // SUBMISSION: PAIR PATIENT & WRISTBAND
          // =============================================================================

          function handleBindingSubmit(e) {
            if (e) e.preventDefault();

            const patientId = document.getElementById('selected-patient-id')?.value || (selectedPatient ? selectedPatient.patient_id : null);
            const deviceId = document.getElementById('selected-device-id')?.value || (selectedWristband ? selectedWristband.device_id : null);

            if (!patientId || !deviceId) {
              if (window.showToast) {
                window.showToast('Please select both an admitted patient and a standby wristband.', 'warning');
              } else {
                alert('Please select both an admitted patient and a standby wristband.');
              }
              return;
            }

            const patientName = selectedPatient ? selectedPatient.full_name : patientId;

            if (window.showModal) {
              window.showModal({
                title: 'Confirm Patient-Device Binding',
                message: `Pair and bind patient "${patientName}" [${patientId}] with wearable sensor [${deviceId}]?\n\nReal-time indoor location tracking and vital signs telemetry will immediately link to this patient record.`,
                type: 'info',
                confirmText: 'Pair Devices',
                cancelText: 'Cancel',
                onConfirm: async () => {
                  await executeBinding(patientId, deviceId);
                }
              });
            } else {
              if (confirm(`Pair patient [${patientId}] with wristband [${deviceId}]?`)) {
                executeBinding(patientId, deviceId);
              }
            }
          }

                  async function executeBinding(patientId, deviceId) {
                    try {
                      const res = await fetch('/api/bindings/bind', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          patient_id: patientId,
                          device_id: deviceId,
                          bound_by: 'DOC-8821'
                        })
                      });
                      const result = await res.json();
                      if (result.success) {
                        if (window.showToast) {
                          window.showToast(result.message || 'Devices paired successfully!', 'success');
                        }
                        clearPatientSelection();
                        clearTagSelection();
                        await loadBindingsData();
                      } else {
                        if (window.showModal) {
                          window.showModal({
                            title: 'Pairing Failed',
                            message: result.error || 'Server error while binding devices.',
                            type: 'danger',
                            confirmText: 'Dismiss'
                          });
                        } else {
                          alert(result.error);
                        }
                      }
          } catch (err) {
            if (window.showModal) {
              window.showModal({
                title: 'Connection Error',
                message: err.message,
                type: 'danger',
                confirmText: 'Dismiss'
              });
            }
          }
        }

        // =============================================================================
        // LOWER SECTION: ACTIVE BINDINGS TABLE, SEARCH, FILTER & 10-ITEM PAGINATION
        // =============================================================================

        async function fetchActiveBindings() {
          try {
            const res = await fetch('/api/bindings/list');
            const data = await res.json();
            if (data.success && Array.isArray(data.bindings)) {
              cachedActiveBindings = data.bindings;
              renderBindingsTable();
            }
          } catch (err) {
            console.warn('Failed to fetch active bindings:', err);
          }
        }

        function handleBindingSearch(query) {
          bindingSearchQuery = query || '';
          currentBindingPage = 1; // Reset to page 1 upon new search
          renderBindingsTable();
        }

        function handleBindingFilter(status) {
          bindingStatusFilter = status || 'ALL';
          currentBindingPage = 1; // Reset to page 1 upon filter change
          renderBindingsTable();
        }

        function getFilteredBindings() {
          let list = cachedActiveBindings || [];

          // Filter by status
          if (bindingStatusFilter !== 'ALL') {
            list = list.filter(b => (b.device_status || 'OFFLINE').toUpperCase() === bindingStatusFilter);
          }

          // Filter by search text
          if (bindingSearchQuery) {
            const q = bindingSearchQuery.toLowerCase().trim();
            list = list.filter(b =>
              (b.patient_name && b.patient_name.toLowerCase().includes(q)) ||
              (b.patient_id && b.patient_id.toLowerCase().includes(q)) ||
              (b.device_id && b.device_id.toLowerCase().includes(q)) ||
              (b.mac_address && b.mac_address.toLowerCase().includes(q)) ||
              (b.bed_code && b.bed_code.toLowerCase().includes(q)) ||
              (b.ward_title && b.ward_title.toLowerCase().includes(q)) ||
              (b.nric_passport && b.nric_passport.toLowerCase().includes(q))
            );
          }

          return list;
        }

        function renderBindingsTable() {
          const tbody = document.getElementById('bindings-table-body');
          if (!tbody) return;

          const countBadge = document.getElementById('active-binding-count');
          if (countBadge) {
            countBadge.innerText = `${cachedActiveBindings.length} Active Stream${cachedActiveBindings.length === 1 ? '' : 's'}`;
          }

          const filtered = getFilteredBindings();
          const totalItems = filtered.length;
          const totalPages = Math.max(1, Math.ceil(totalItems / BINDING_PAGE_SIZE));

          // Clamp current page
          if (currentBindingPage > totalPages) currentBindingPage = totalPages;
          if (currentBindingPage < 1) currentBindingPage = 1;

          const startIndex = (currentBindingPage - 1) * BINDING_PAGE_SIZE;
          const pageItems = filtered.slice(startIndex, startIndex + BINDING_PAGE_SIZE);

          if (pageItems.length === 0) {
            tbody.innerHTML = `
      <tr>
        <td colspan="8" style="text-align: center; color: var(--text-muted); padding: 32px;">
          ${totalItems === 0 && cachedActiveBindings.length === 0
                ? 'No active patient-to-wristband bindings. Use the wizard above to pair a patient.'
                : 'No matching paired records found matching your search filter.'}
        </td>
      </tr>`;
            renderPaginationControls(0, 0, 0, 1);
            return;
          }

          tbody.innerHTML = pageItems.map(b => {
            const initials = b.patient_name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
            const avatarHtml = b.photo_url
              ? `<img src="${b.photo_url}" style="width: 32px; height: 32px; border-radius: 50%; object-fit: cover; border: 1.5px solid var(--border);" onerror="this.outerHTML='<div class=\\'patient-thumb\\' style=\\'width:32px;height:32px;font-size:11px;\\'>${initials}</div>'">`
              : `<div class="patient-thumb" style="width: 32px; height: 32px; font-size: 11px;">${initials}</div>`;

            const riskBadge = b.fall_risk_score === 'HIGH'
              ? '<span class="badge badge-alert" style="font-size: 10px;">● HIGH RISK</span>'
              : b.fall_risk_score === 'MEDIUM'
                ? '<span class="badge badge-warning" style="font-size: 10px;">● MED RISK</span>'
                : '<span class="badge badge-live" style="font-size: 10px;">● LOW RISK</span>';

            const statusUpper = (b.device_status || 'OFFLINE').toUpperCase();
            let statusBadge = '<span class="badge badge-neutral" style="font-size: 11px;">○ Device Offline</span>';
            if (statusUpper === 'CHARGING') {
              statusBadge = '<span class="badge" style="background:#FEF3C7; color:#92400E; border:1px solid #F59E0B; font-size: 11px; font-weight: 600;">⚡ Charging</span>';
            } else if (statusUpper === 'ONLINE') {
              if (b.telemetry_mode === 'ACTIVE') {
                statusBadge = '<span class="badge badge-live" style="font-size: 11px;">● 1 Hz Active Stream</span>';
              } else {
                statusBadge = '<span class="badge" style="background:#E0F2FE; color:#0369A1; border:1px solid #0EA5E9; font-size: 11px; font-weight: 600;">● 3-Min Power Saving</span>';
              }
            }

            const bedText = b.bed_code ? `${b.bed_code}` : 'Unassigned Bed';
            const wardText = b.ward_title || 'Ward';

            return `
      <tr>
        <td>
          <span class="badge badge-info" style="font-size: 11px; font-weight: 700;">${bedText}</span>
          <div style="font-size: 11px; color: var(--text-muted); margin-top: 3px;">${wardText}</div>
        </td>
        <td>
          <div style="display: flex; gap: 8px; align-items: center;">
            ${avatarHtml}
            <div>
              <b style="color: var(--text-primary); font-size: 13px;">${b.patient_name}</b>
              <div style="font-size: 11px; color: var(--primary); font-weight: 600;" class="mono">${b.patient_id}</div>
            </div>
          </div>
        </td>
        <td>
          ${riskBadge}
        </td>
        <td>
          <span class="mono" style="color: var(--text-secondary); font-size: 12px; font-weight: 600;">${b.mac_address}</span>
          <span class="badge badge-neutral" style="margin-left: 6px; font-size: 10px;">${b.device_id}</span>
          <div style="font-size: 10px; color: var(--text-muted); margin-top: 2px;">${b.hardware_model || 'XIAO ESP32-C6'}</div>
        </td>
        <td>
          ${statusBadge}
        </td>
        <td style="color: var(--text-secondary); font-size: 12px;">
          <div>${b.bound_at || 'Recently'}</div>
        </td>
        <td style="color: var(--text-muted); font-weight: 500; font-size: 12px;">
          ${b.bound_by || 'DOC-8821'}
        </td>
        <td>
          <button class="btn btn-danger-outline btn-sm" onclick="unbindTag('${b.binding_id}', '${b.patient_name.replace(/'/g, "\\'")}', '${b.device_id}')">
            🔓 Unbind Tag
          </button>
        </td>
      </tr>
    `;
          }).join('');

          renderPaginationControls(startIndex + 1, Math.min(startIndex + pageItems.length, totalItems), totalItems, totalPages);
        }

        /**
         * Renders the numbered pagination bar and info counter.
         */
        function renderPaginationControls(startItem, endItem, totalItems, totalPages) {
          const infoEl = document.getElementById('binding-pagination-info');
          if (infoEl) {
            if (totalItems === 0) {
              infoEl.innerText = 'Showing 0 records';
            } else {
              infoEl.innerText = `Showing ${startItem} to ${endItem} of ${totalItems} paired record${totalItems === 1 ? '' : 's'}`;
            }
          }

          const container = document.getElementById('binding-pagination-controls');
          if (!container) return;

          if (totalItems <= BINDING_PAGE_SIZE) {
            container.innerHTML = '';
            return;
          }

          let html = `
    <button class="btn btn-outline btn-sm" style="padding: 4px 10px; font-size: 12px;"
      ${currentBindingPage <= 1 ? 'disabled style="opacity:0.4; cursor:not-allowed;"' : `onclick="changeBindingPage(${currentBindingPage - 1})"`}>
      « Previous
    </button>
  `;

          for (let p = 1; p <= totalPages; p++) {
            const isActive = p === currentBindingPage;
            html += `
      <button class="btn ${isActive ? 'btn-primary' : 'btn-outline'} btn-sm"
        style="min-width: 32px; padding: 4px 8px; font-size: 12px; font-weight: ${isActive ? '700' : '500'};"
        onclick="changeBindingPage(${p})">
        ${p}
      </button>
    `;
          }

          html += `
    <button class="btn btn-outline btn-sm" style="padding: 4px 10px; font-size: 12px;"
      ${currentBindingPage >= totalPages ? 'disabled style="opacity:0.4; cursor:not-allowed;"' : `onclick="changeBindingPage(${currentBindingPage + 1})"`}>
      Next »
    </button>
  `;

          container.innerHTML = html;
        }

        function changeBindingPage(newPage) {
          currentBindingPage = newPage;
          renderBindingsTable();
        }

        /**
         * Unbinds a wearable tag from a patient.
         */
        function unbindTag(bindingId, patientName, deviceId) {
          if (window.showModal) {
            window.showModal({
              title: 'Unbind Wearable Tag',
              message: `Unbind wearable wristband [${deviceId || 'Tag'}] from patient "${patientName}"?\n\nReal-time telemetry streaming will be detached and the wristband returned to Standby pool.`,
              type: 'danger',
              confirmText: 'Unbind Tag',
              cancelText: 'Cancel',
              onConfirm: async () => {
                try {
                  const res = await fetch(`/api/bindings/unbind?id=${encodeURIComponent(bindingId)}`, {
                    method: 'POST'
                  });
                  const result = await res.json();
                  if (result.success) {
                    if (window.showToast) {
                      window.showToast(`Tag successfully unbound from ${patientName}.`, 'info');
                    }
                    await loadBindingsData();
                  } else {
                    if (window.showToast) window.showToast(result.error, 'danger');
                  }
                } catch (err) {
                  if (window.showToast) window.showToast(err.message, 'danger');
                }
              }
            });
          } else {
            if (confirm(`Unbind tag from ${patientName}?`)) {
              fetch(`/api/bindings/unbind?id=${encodeURIComponent(bindingId)}`, { method: 'POST' })
                .then(() => loadBindingsData());
            }
          }
        }

        // =============================================================================
        // GLOBAL EXPORTS
        // =============================================================================

        window.initBindingsModule = initBindingsModule;
        window.loadBindingsData = loadBindingsData;
        window.openPatientCombobox = openPatientCombobox;
        window.closePatientCombobox = closePatientCombobox;
        window.filterPatientCombobox = filterPatientCombobox;
        window.selectPatientCandidate = selectPatientCandidate;
        window.clearPatientSelection = clearPatientSelection;

        window.openTagCombobox = openTagCombobox;
        window.closeTagCombobox = closeTagCombobox;
        window.filterTagCombobox = filterTagCombobox;
        window.selectWristbandCandidate = selectWristbandCandidate;
        window.clearTagSelection = clearTagSelection;

        window.handleBindingSubmit = handleBindingSubmit;
        window.handleBindingSearch = handleBindingSearch;
        window.handleBindingFilter = handleBindingFilter;
        window.changeBindingPage = changeBindingPage;
        window.unbindTag = unbindTag;
