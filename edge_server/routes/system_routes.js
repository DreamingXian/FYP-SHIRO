// =============================================================================
// System status of the edge server itself: memory, uptime, database load and
// how quickly the server reacts. Read-only; used by the load test
// (tools/load_test.js) and available for the health page.
// =============================================================================
const { monitorEventLoopDelay } = require('perf_hooks');
const { getQueryCount } = require('../database/db');
const deviceService = require('../services/device_service');
const { getConnectedClientsCount } = require('../services/websocket_service');

// Event loop delay: how long work waits before it runs. High values mean the
// server is too busy to answer MQTT, WebSocket and HTTP on time.
// The histogram measures the whole sampling interval, so the interval itself is
// subtracted. What remains on an idle Windows PC is about 10 to 15 ms of timer
// granularity (measured 15 Nov 2026): that is the baseline, not load.
const SAMPLING_MS = 20;
const loopDelay = monitorEventLoopDelay({ resolution: SAMPLING_MS });
loopDelay.enable();
const beyondSampling = (ns) => Math.max(0, ns / 1e6 - SAMPLING_MS);

const MB = 1024 * 1024;
const round1 = (x) => Math.round(x * 10) / 10;

function buildStats() {
  const mem = process.memoryUsage();
  const stats = {
    uptime_s: Math.round(process.uptime()),
    memory_mb: { rss: round1(mem.rss / MB), heap_used: round1(mem.heapUsed / MB), heap_total: round1(mem.heapTotal / MB) },
    event_loop_delay_ms: {
      mean: round1(beyondSampling(loopDelay.mean)),
      p99: round1(beyondSampling(loopDelay.percentile(99))),
      max: round1(beyondSampling(loopDelay.max))
    },
    db_queries_total: getQueryCount(),
    device_presence: deviceService.getPresenceStats(),
    websocket_clients: getConnectedClientsCount()
  };
  loopDelay.reset(); // the next call reports the period since this one
  return stats;
}

async function handleSystemRoutes(pathname, req, res) {
  if (pathname === '/api/system/stats' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: true, stats: buildStats() }));
    return true;
  }
  return false;
}

module.exports = { handleSystemRoutes, buildStats };
