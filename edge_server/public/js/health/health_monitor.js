// =============================================================================
// System Health tab: live server and device status.
// Reads /api/system/stats and the device registry every 5 s while the tab is
// open. Every value comes from the server; unknown values are shown as "--".
// =============================================================================
(function () {
  const REFRESH_MS = 5000;
  let previous = null; // last stats sample, for the query rate
  let timer = null;
  // Pages of 8 (ui_kit.js); the lists are kept so a page button needs no new request
  const pages = { anchor: 1, lidar: 1, headset: 1 };
  const lists = { anchor: [], lidar: [], headset: [] };

  const $ = (id) => document.getElementById(id);
  const setText = (id, text) => { const el = $(id); if (el) el.textContent = text; };

  function setBadge(id, text, kind) {
    const el = $(id);
    if (!el) return;
    el.textContent = text;
    el.className = `badge ${kind}`;
  }

  function formatUptime(seconds) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d} d ${h} h`;
    if (h > 0) return `${h} h ${m} min`;
    return `${m} min ${Math.floor(seconds % 60)} s`;
  }

  function formatLastSeen(value) {
    if (!value) return 'never';
    const t = new Date(value);
    if (Number.isNaN(t.getTime())) return '--';
    const ageS = Math.max(0, Math.round((Date.now() - t.getTime()) / 1000));
    if (ageS < 60) return `${ageS} s ago`;
    if (ageS < 3600) return `${Math.round(ageS / 60)} min ago`;
    return t.toLocaleString();
  }

  // A status badge: the class is one of three fixed names, the text is escaped
  function statusBadge(status) {
    const s = String(status || 'UNKNOWN').toUpperCase();
    if (s === 'ONLINE') return '<span class="badge badge-live">● On</span>';
    if (s === 'CHARGING') return '<span class="badge badge-info">⚡ Charging</span>';
    return '<span class="badge badge-neutral">○ Off</span>';
  }

  /** One page of a list into its table, with the pager below. */
  function renderPage(kind, bodyId, pagerId, cols, rowHtml, emptyText) {
    const body = $(bodyId);
    if (!body) return;
    const data = window.ShiroUI.paginate(lists[kind], pages[kind]);
    pages[kind] = data.page;
    window.ShiroUI.renderPager($(pagerId), {
      total: data.total, page: data.page, noun: 'devices',
      onPage: (n) => { pages[kind] = n; renderPage(kind, bodyId, pagerId, cols, rowHtml, emptyText); }
    });
    body.innerHTML = data.total === 0
      ? `<tr><td colspan="${Number(cols)}" class="empty-state">${escapeHtml(emptyText)}</td></tr>`
      : data.items.map(rowHtml).join('');
  }

  function renderStats(stats) {
    const now = Date.now();
    setBadge('health-server-badge', '● Running', 'badge-live');
    setText('health-uptime', `Running for ${formatUptime(stats.uptime_s)}`);
    setText('health-memory', `Memory: ${stats.memory_mb.rss} MB`);
    // The longest the server could not answer since the last refresh (the true worst:
    // a 99th percentile would hide a single long pause)
    const loop = stats.event_loop_delay_ms;
    const worst = Number.isFinite(loop.max) ? loop.max : loop.p99;
    setText('health-loop', `Response time: ${worst <= 50 ? 'fast' : worst <= 200 ? 'normal' : 'slow'} (${worst} ms at worst)`);
    if (worst > 200) setBadge('health-server-badge', '● Busy', 'badge-warning');

    if (previous) {
      const seconds = (now - previous.at) / 1000;
      const rate = seconds > 0 ? (stats.db_queries_total - previous.queries) / seconds : 0;
      setText('health-db-rate', `${rate.toFixed(1)} / second`);
      setBadge('health-db-badge', '● Working', 'badge-live');
    } else {
      setText('health-db-rate', 'Measuring…');
    }
    previous = { at: now, queries: stats.db_queries_total };
    const pending = stats.device_presence ? stats.device_presence.pending : null;
    setText('health-presence', `Device updates waiting to be saved: ${pending === null ? '--' : pending} (saved every 5 s)`);
    setText('health-ws-count', `Screens and headsets connected: ${stats.websocket_clients}`);
  }

  function renderAnchors(devices) {
    const online = devices.filter(d => d.status === 'ONLINE').length;
    setText('health-anchor-count', `${online} of ${devices.length} wall sensors on`);
    setBadge('health-conn-badge', devices.length === 0 ? 'No wall sensors' : (online === devices.length ? '● All on' : `${devices.length - online} off`),
      devices.length > 0 && online === devices.length ? 'badge-live' : 'badge-warning');
    lists.anchor = devices;
    renderPage('anchor', 'health-anchor-rows', 'health-anchor-pager', 5, d => `
        <tr>
          <td><b style="color: var(--text-primary);">${escapeHtml(d.device_id)}</b></td>
          <td class="mono">${escapeHtml(d.mac_address || '--')}</td>
          <td class="mono">${escapeHtml(d.ip_address || '--')}</td>
          <td>${statusBadge(d.status)}</td>
          <td style="color: var(--text-muted);">${escapeHtml(formatLastSeen(d.last_seen))}</td>
        </tr>`, 'No wall sensors added. Add them under Setup → Devices.');
  }

  /** LiDAR nodes: the registry, with the live scanning state when the node reports. */
  function renderLidars(devices, statuses) {
    const live = new Map();
    for (const s of statuses || []) {
      if (s.device_id) live.set(String(s.device_id), s);
      if (s.mac) live.set(String(s.mac).toUpperCase(), s);
    }
    lists.lidar = devices;
    renderPage('lidar', 'health-lidar-rows', 'health-lidar-pager', 6, d => {
      const s = live.get(String(d.device_id)) || live.get(String(d.mac_address || '').toUpperCase());
      const scanning = !s || !s.online ? '–'
        : s.scanning ? `${s.turns_per_s} turns/s${s.last_frame ? ` · ${s.last_frame.valid} points` : ''}`
          : 'connected, not scanning';
      const healthNote = s && s.online && s.node && s.node.health && s.node.health !== 'OK'
        ? ` <span class="badge badge-warning">LiDAR reports ${escapeHtml(s.node.health)}</span>` : '';
      const lidarStatusHtml = statusBadge(s && s.online ? 'ONLINE' : d.status);
      return `
        <tr>
          <td><b style="color: var(--text-primary);">${escapeHtml(d.device_id)}</b></td>
          <td>${escapeHtml(d.assigned_ward_id || '–')}</td>
          <td class="mono">${escapeHtml(d.mac_address || '--')}</td>
          <td>${lidarStatusHtml}</td>
          <td>${escapeHtml(scanning)}${healthNote}</td>
          <td style="color: var(--text-muted);">${escapeHtml(formatLastSeen(d.last_seen))}</td>
        </tr>`;
    }, 'No LiDAR added. A LiDAR node that is switched on appears under Setup → Devices.');
  }

  function renderHeadsets(devices) {
    const online = devices.filter(d => d.status === 'ONLINE').length;
    setText('health-headset-count', `Headsets on: ${online} of ${devices.length}`);
    lists.headset = devices;
    renderPage('headset', 'health-headset-rows', 'health-headset-pager', 6, d => `
        <tr>
          <td><b style="color: var(--text-primary);">${escapeHtml(d.device_id)}</b></td>
          <td class="mono">${escapeHtml(d.mac_address || '--')}</td>
          <td class="mono">${escapeHtml(d.ip_address || '--')}</td>
          <td>${escapeHtml(d.battery_level === null || d.battery_level === undefined ? '--' : `${d.battery_level} %`)}</td>
          <td>${statusBadge(d.status)}</td>
          <td style="color: var(--text-muted);">${escapeHtml(formatLastSeen(d.last_seen))}</td>
        </tr>`, 'No headsets added. A headset that connects appears under Setup → Devices.');
  }

  async function getJson(url, signal) {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // One refresh at a time: a slow answer is waited for (up to 8 s), never stacked
  // with the next one, so the page updates once per beat and not in bursts
  const REQUEST_TIMEOUT_MS = 8000;
  let inFlight = false;

  async function refresh() {
    if (inFlight) return;
    inFlight = true;
    const ctrl = new AbortController();
    const abortTimer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const [statsResp, anchorsResp, headsetsResp, lidarResp, lidarLive] = await Promise.all([
        getJson('/api/system/stats', ctrl.signal),
        getJson('/api/devices/list?type=ANCHOR', ctrl.signal),
        getJson('/api/devices/list?type=HEADSET', ctrl.signal),
        getJson('/api/devices/list?type=ROOM_SENSOR', ctrl.signal),
        getJson('/api/room-sensors/status', ctrl.signal).catch(() => ({ success: false }))
      ]);
      if (statsResp.success) renderStats(statsResp.stats);
      if (anchorsResp.success) renderAnchors(anchorsResp.devices || []);
      if (headsetsResp.success) renderHeadsets(headsetsResp.devices || []);
      if (lidarResp.success) renderLidars(lidarResp.devices || [], lidarLive.success ? lidarLive.sensors : []);
      setText('health-updated', `Updated ${new Date().toLocaleTimeString()} · every 5 s while open`);
    } catch (err) {
      const why = err && err.name === 'AbortError' ? `no answer within ${REQUEST_TIMEOUT_MS / 1000} s` : err.message;
      setBadge('health-server-badge', '● Not answering', 'badge-warning');
      setText('health-updated', `The server does not answer (${why}), ${new Date().toLocaleTimeString()}`);
      previous = null;
    } finally {
      clearTimeout(abortTimer);
      inFlight = false;
    }
  }

  function isHealthTabOpen() {
    const pane = $('tab-health');
    return Boolean(pane && pane.classList.contains('active') && !document.hidden);
  }

  // A steady beat of 5 s from when the page was opened: each refresh starts on the
  // beat; one that is still waiting makes the next beat skip (no catching up)
  let beatStart = Date.now();
  function schedule() {
    if (timer) clearTimeout(timer);
    const wait = REFRESH_MS - ((Date.now() - beatStart) % REFRESH_MS);
    timer = setTimeout(async () => {
      if (isHealthTabOpen()) await refresh();
      schedule();
    }, wait);
  }

  function start() {
    if (timer) return;
    beatStart = Date.now();
    refresh();
    schedule();
  }

  // Refresh at once when the tab is opened; the beat starts again from then
  document.addEventListener('click', (event) => {
    const btn = event.target.closest && event.target.closest('[data-tab="tab-health"]');
    if (!btn) return;
    setTimeout(() => {
      beatStart = Date.now();
      refresh();
      if (timer) schedule();
    }, 0);
  });

  window.initHealthMonitor = start;
})();
