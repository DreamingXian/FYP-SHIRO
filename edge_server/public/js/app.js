// =============================================================================
// Master Application Orchestrator & Single Page Architecture (SPA) Router
// =============================================================================

async function loadViewPartial(targetId, viewPath) {
  try {
    const url = `${viewPath}?_t=${Date.now()}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} while fetching ${viewPath}`);
    }
    const html = await response.text();
    const container = document.getElementById(targetId);
    if (container) {
      container.innerHTML = html;
    }
  } catch (err) {
    console.error(`[App] Failed to load partial ${viewPath} into #${targetId}:`, err);
  }
}

async function initializeApp() {
  console.log('[App] Initializing Shiro Edge Healthcare Admin (MVC Architecture)...');

  // 1. Concurrently hydrate all HTML View Partials
  try {
    await Promise.all([
      loadViewPartial('tab-patients', '/views/patients/patients.html'),
      loadViewPartial('tab-devices', '/views/devices/devices.html'),
      loadViewPartial('tab-bindings', '/views/bindings/bindings.html'),
      (async () => {
        const [dirHtml, editHtml, liveMapHtml] = await Promise.all([
          fetch(`/views/ward_config/ward_directory.html?_t=${Date.now()}`).then(r => r.text()),
          fetch(`/views/ward_config/ward_editor.html?_t=${Date.now()}`).then(r => r.text()),
          fetch(`/views/ward_config/ward_live_map.html?_t=${Date.now()}`).then(r => r.text())
        ]);
        const wardContainer = document.getElementById('tab-ward-config');
        if (wardContainer) {
          wardContainer.innerHTML = dirHtml + '\n' + editHtml + '\n' + liveMapHtml;
        }
      })(),
      loadViewPartial('tab-health', '/views/health/health.html'),
      loadViewPartial('tab-live-lab', '/views/live_lab/live_lab.html')
    ]);
    console.log('[App] All view partials successfully mounted.');
  } catch (e) {
    console.error('[App] Error mounting partials:', e);
  }

  // 2. Setup Top Navigation Bar Tabs
  const navTabs = document.querySelectorAll('.nav-tab-btn');
  const tabPanes = document.querySelectorAll('.tab-pane');

  function switchTab(targetTabId) {
    navTabs.forEach(b => b.classList.remove('active'));
    tabPanes.forEach(p => p.classList.remove('active'));

    const activeBtn = document.querySelector(`.nav-tab-btn[data-tab="${targetTabId}"]`);
    if (activeBtn) activeBtn.classList.add('active');

    const targetPane = document.getElementById(targetTabId);
    if (targetPane) targetPane.classList.add('active');

    // Trigger module-specific initializations upon tab switch
    if (targetTabId === 'tab-patients') {
      if (typeof window.initPatientsModule === 'function') {
        window.initPatientsModule();
      }
    } else if (targetTabId === 'tab-devices') {
      if (typeof window.initDevicesModule === 'function') {
        window.initDevicesModule();
      }
    } else if (targetTabId === 'tab-bindings') {
      if (typeof window.initBindingsModule === 'function') {
        window.initBindingsModule();
      }
    } else if (targetTabId === 'tab-ward-config') {
      if (typeof window.forceReturnToWardDirectory === 'function') {
        window.forceReturnToWardDirectory();
      } else if (typeof window.returnToWardDirectory === 'function') {
        window.returnToWardDirectory(true);
      }
    } else if (targetTabId === 'tab-live-lab') {
      if (typeof window.resizeCanvases === 'function') {
        window.resizeCanvases();
      }
      if (typeof window.drawPPG === 'function') window.drawPPG();
      if (typeof window.drawRSSI === 'function') window.drawRSSI();
    }
  }

  // Global helper to switch to a ward's live map directly from any tab
  window.navigateToWardLiveMap = function(wardId, targetTagId = null) {
    navTabs.forEach(b => b.classList.remove('active'));
    tabPanes.forEach(p => p.classList.remove('active'));

    const activeBtn = document.querySelector('.nav-tab-btn[data-tab="tab-ward-config"]');
    if (activeBtn) activeBtn.classList.add('active');

    const targetPane = document.getElementById('tab-ward-config');
    if (targetPane) targetPane.classList.add('active');

    if (typeof window.openWardLiveMap === 'function') {
      window.openWardLiveMap(wardId, targetTagId);
    }
  };
  window.switchTab = switchTab;

  navTabs.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetTabId = btn.getAttribute('data-tab');

      // Check if user is currently inside the Ward Editor with unsaved changes
      if (typeof window.hasUnsavedWardChanges === 'function' && window.hasUnsavedWardChanges()) {
        showModal({
          title: 'Unsaved Changes',
          message: `You have unsaved changes in the Ward Layout Editor for "${window.currentWard?.ward_id || 'Ward'}".\n\nIf you leave now, your changes will not be saved to MySQL.`,
          type: 'warning',
          confirmText: 'Discard & Leave',
          cancelText: 'Continue Editing',
          onConfirm: () => {
            if (typeof window.forceReturnToWardDirectory === 'function') {
              window.forceReturnToWardDirectory();
            }
            switchTab(targetTabId);
          }
        });
        return;
      }

      switchTab(targetTabId);
    });
  });

  // 3. Initialize WebSocket Connection
  if (window.wsClient) {
    window.wsClient.connect();
  }

  // 4. Initialize Live Lab Listeners
  if (typeof window.initLiveLabListeners === 'function') {
    window.initLiveLabListeners();
  }

  // 5. Initialize Ward Configuration State & MySQL Directory
  if (typeof window.loadWardDirectory === 'function') {
    window.loadWardDirectory();
  }
  if (typeof window.loadWardDataFromDB === 'function') {
    window.loadWardDataFromDB();
  }
  if (typeof window.initPatientsModule === 'function') {
    window.initPatientsModule();
  }
  if (typeof window.initDevicesModule === 'function') {
    window.initDevicesModule();
  }
  if (typeof window.initBindingsModule === 'function') {
    window.initBindingsModule();
  }

  // 6. Global Window Resize Handling
  window.addEventListener('resize', () => {
    if (typeof window.redrawWardMap === 'function') window.redrawWardMap();
    if (typeof window.resizeCanvases === 'function') window.resizeCanvases();
  });

  console.log('[App] System initialized successfully.');
}

// Boot application upon DOM content ready
document.addEventListener('DOMContentLoaded', initializeApp);

