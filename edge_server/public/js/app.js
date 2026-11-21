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

  // 0. Signed in? Without a session the browser goes to the sign-in page.
  let user;
  try {
    user = await window.shiroAuth.ready;
  } catch (err) {
    console.error('[App] Cannot check the sign-in:', err);
    document.body.innerHTML = '<p style="padding: 40px; font-family: sans-serif;">The edge server does not answer. Check that it is running, then reload this page.</p>';
    return;
  }
  const logoutBtn = document.getElementById('session-logout');
  if (logoutBtn) logoutBtn.addEventListener('click', () => window.shiroAuth.logout());

  // 1. Concurrently hydrate all HTML View Partials
  try {
    await Promise.all([
      user.role === 'ADMIN' ? loadViewPartial('tab-admin', '/views/admin/admin.html') : Promise.resolve(),
      loadViewPartial('tab-patients', '/views/patients/patients.html'),
      loadViewPartial('tab-devices', '/views/devices/devices.html'),
      loadViewPartial('tab-bindings', '/views/bindings/bindings.html'),
      (async () => {
        const [dirHtml, editHtml] = await Promise.all([
          fetch(`/views/ward_config/ward_directory.html?_t=${Date.now()}`).then(r => r.text()),
          fetch(`/views/ward_config/ward_editor.html?_t=${Date.now()}`).then(r => r.text())
        ]);
        const wardContainer = document.getElementById('tab-ward-config');
        if (wardContainer) {
          wardContainer.innerHTML = dirHtml + '\n' + editHtml;
        }
      })(),
      // The ward overview (live map) is its own page, the first one after sign-in
      loadViewPartial('tab-ward', '/views/ward_config/ward_live_map.html'),
      loadViewPartial('tab-health', '/views/health/health.html'),
      loadViewPartial('tab-live-lab', '/views/live_lab/live_lab.html')
    ]);
    console.log('[App] All view partials successfully mounted.');
  } catch (e) {
    console.error('[App] Error mounting partials:', e);
  }

  // 2. Menu: the tabs, and the Setup menu (admins)
  const navTabs = document.querySelectorAll('[data-tab]');
  const tabPanes = document.querySelectorAll('.tab-pane');
  const setupToggle = document.getElementById('nav-setup-toggle');
  const setupMenu = document.getElementById('nav-setup-menu');

  function closeSetupMenu() {
    if (setupMenu) setupMenu.classList.remove('open');
    if (setupToggle) setupToggle.setAttribute('aria-expanded', 'false');
  }
  if (setupToggle && setupMenu) {
    setupToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = !setupMenu.classList.contains('open');
      setupMenu.classList.toggle('open', open);
      setupToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    document.addEventListener('click', (e) => { if (!setupMenu.contains(e.target)) closeSetupMenu(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSetupMenu(); });
  }

  // The ward the overview shows: the last one looked at on this computer, else the first ward
  async function openWardOverview() {
    if (typeof window.openWardLiveMap !== 'function') return;
    let wardId = null;
    try { wardId = localStorage.getItem('shiro.ward'); } catch (e) { wardId = null; }
    if (!wardId) {
      try {
        const res = await fetch('/api/ward/list');
        const data = await res.json();
        const wards = (data && (data.wards || data.data)) || [];
        if (wards.length) wardId = wards[0].ward_id;
      } catch (e) { wardId = null; }
    }
    if (wardId) window.openWardLiveMap(wardId);
  }
  window.openWardOverview = openWardOverview;

  function switchTab(targetTabId) {
    closeSetupMenu();
    navTabs.forEach(b => b.classList.remove('active'));
    tabPanes.forEach(p => p.classList.remove('active'));

    const activeBtn = document.querySelector(`.nav-tab-btn[data-tab="${targetTabId}"], .nav-menu-item[data-tab="${targetTabId}"]`);
    if (activeBtn) activeBtn.classList.add('active');
    // A page from the Setup menu marks Setup as the current menu
    if (activeBtn && activeBtn.classList.contains('nav-menu-item') && setupToggle) setupToggle.classList.add('active');

    const targetPane = document.getElementById(targetTabId);
    if (targetPane) targetPane.classList.add('active');

    // Trigger module-specific initializations upon tab switch
    if (targetTabId === 'tab-ward') {
      if (typeof window.isLiveMapOpen === 'function' && window.isLiveMapOpen()) {
        if (typeof window.resizeLiveMap === 'function') window.resizeLiveMap();
      } else {
        openWardOverview();
      }
    } else if (targetTabId === 'tab-patients') {
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
    } else if (targetTabId === 'tab-admin') {
      if (typeof window.initAdminModule === 'function') {
        window.initAdminModule();
      }
    } else if (targetTabId === 'tab-live-lab') {
      if (typeof window.resizeCanvases === 'function') {
        window.resizeCanvases();
      }
      if (typeof window.drawRSSI === 'function') window.drawRSSI();
    }
  }

  // Global helper to open a ward's overview (live map) from any page
  window.navigateToWardLiveMap = function(wardId, targetTagId = null) {
    closeSetupMenu();
    navTabs.forEach(b => b.classList.remove('active'));
    tabPanes.forEach(p => p.classList.remove('active'));

    const activeBtn = document.querySelector('.nav-tab-btn[data-tab="tab-ward"]');
    if (activeBtn) activeBtn.classList.add('active');

    const targetPane = document.getElementById('tab-ward');
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
          message: `You have changed the layout of "${window.currentWard?.ward_id || 'this ward'}" without saving.\n\nIf you leave now, the changes are lost.`,
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

  // 5. Wards: the list for Setup, and the overview, the first page after sign-in
  if (typeof window.loadWardDirectory === 'function') {
    window.loadWardDirectory();
  }
  openWardOverview();
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
  if (typeof window.initHealthMonitor === 'function') {
    window.initHealthMonitor();
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

