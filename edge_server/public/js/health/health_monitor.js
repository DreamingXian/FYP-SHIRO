// =============================================================================
// System Health tab: live server and device status.
// Reads /api/system/stats and the device registry every 5 s while the tab is
// open. Every value comes from the server; unknown values are shown as "--".
// =============================================================================
(function () {
  const REFRESH_MS = 5000;
  let previous = null; // last stats sample, for the query rate
  let timer = null;

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
    const badgeClass = s === 'ONLINE' ? 'badge-live' : (s === 'CHARGING' ? 'badge-info' : 'badge-neutral');
    return `<span class="badge ${badgeClass}">${escapeHtml(s)}</span>`;
  }

  function renderStats(stats) {
    const now = Date.now();
    setBadge('health-server-badge', 'RUNNING', 'badge-live');
    setText('health-uptime', `Up ${formatUptime(stats.uptime_s)}`);
    setText('health-memory', `Memory: ${stats.memory_mb.rss} MB in use (JavaScript heap ${stats.memory_mb.heap_used} MB)`);
    const p99 = stats.event_loop_delay_ms.p99;
    setText('health-loop', `Response delay (event loop, 99th percentile): ${p99} ms`);
    if (p99 > 200) setBadge('health-server-badge', 'BUSY', 'badge-warning');

    if (previous) {
      const seconds = (now - previous.at) / 1000;
      const rate = seconds > 0 ? (stats.db_queries_total - previous.queries) / seconds : 0;
      setText('health-db-rate', `${rate.toFixed(1)} queries/s`);
    } else {
      setText('health-db-rate', 'Measuring...');
    }
    previous = { at: now, queries: stats.db_queries_total };
    const pending = stats.device_presence ? stats.device_presence.pending : null;
    setText('health-presence', `Device presence waiting to be written: ${pending === null ? '--' : pending} (written every 5 s)`);
    setText('health-ws-count', `Dashboards and headsets connected: ${stats.websocket_clients}`);
  }

  function renderAnchors(devices) {
    const body = $('health-anchor-rows');
    if (!body) return;
    const online = devices.filter(d => d.status === 'ONLINE').length;
    setText('health-anchor-count', `${online} / ${devices.length} anchors online`);
    setBadge('health-conn-badge', devices.length === 0 ? 'NO ANCHORS' : (online === devices.length ? 'ALL ONLINE' : `${devices.length - online} OFFLINE`),
      devices.length > 0 && online === devices.length ? 'badge-live' : 'badge-warning');
    body.innerHTML = devices.length === 0
      ? '<tr><td colspan="5" style="color: var(--text-muted);">No anchors enrolled. Enrol them on the Devices tab.</td></tr>'
      : devices.map(d => `
        <tr>
          <td><b style="color: var(--primary);">${escapeHtml(d.device_id)}</b></td>
          <td class="mono">${escapeHtml(d.mac_address || '--')}</td>
          <td class="mono">${escapeHtml(d.ip_address || '--')}</td>
          <td>${statusBadge(d.status)}</td>
          <td style="color: var(--text-muted);">${escapeHtml(formatLastSeen(d.last_seen))}</td>
        </tr>`).join('');
  }

  function renderHeadsets(devices) {
    const body = $('health-headset-rows');
    if (!body) return;
    const online = devices.filter(d => d.status === 'ONLINE').length;
    setText('health-headset-count', `Headsets online: ${online} / ${devices.length}`);
    body.innerHTML = devices.length === 0
      ? '<tr><td colspan="6" style="color: var(--text-muted);">No headsets enrolled. A headset that connects appears on the Devices tab for enrolment.</td></tr>'
      : devices.map(d => `
        <tr>
          <td><b style="color: var(--text-primary);">${escapeHtml(d.device_id)}</b></td>
          <td class="mono">${escapeHtml(d.mac_address || '--')}</td>
          <td class="mono">${escapeHtml(d.ip_address || '--')}</td>
          <td>${escapeHtml(d.battery_level === null || d.battery_level === undefined ? '--' : `${d.battery_level} %`)}</td>
          <td>${statusBadge(d.status)}</td>
          <td style="color: var(--text-muted);">${escapeHtml(formatLastSeen(d.last_seen))}</td>
        </tr>`).join('');
  }

  async function getJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function refresh() {
    try {
      const [statsResp, anchorsResp, headsetsResp] = await Promise.all([
        getJson('/api/system/stats'),
        getJson('/api/devices/list?type=ANCHOR'),
        getJson('/api/devices/list?type=HEADSET')
      ]);
      if (statsResp.success) renderStats(statsResp.stats);
      if (anchorsResp.success) renderAnchors(anchorsResp.devices || []);
      if (headsetsResp.success) renderHeadsets(headsetsResp.devices || []);
      setText('health-updated', `Updated ${new Date().toLocaleTimeString()}`);
    } catch (err) {
      setBadge('health-server-badge', 'NOT ANSWERING', 'badge-warning');
      setText('health-updated', `Server not answering (${err.message}) at ${new Date().toLocaleTimeString()}`);
      previous = null;
    }
  }

  function isHealthTabOpen() {
    const pane = $('tab-health');
    return Boolean(pane && pane.classList.contains('active'));
  }

  function start() {
    if (timer) return;
    refresh();
    timer = setInterval(() => { if (isHealthTabOpen()) refresh(); }, REFRESH_MS);
  }

  // Refresh at once when the tab is opened, then on the timer
  document.addEventListener('click', (event) => {
    const btn = event.target.closest && event.target.closest('.nav-tab-btn[data-tab="tab-health"]');
    if (btn) setTimeout(refresh, 0);
  });

  window.initHealthMonitor = start;
})();
