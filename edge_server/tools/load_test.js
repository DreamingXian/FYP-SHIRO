// =============================================================================
// SHIRO load test: replays anchors and measures how the edge server copes.
//
// Connects N anchors to the MQTT broker with the anchor login, and each anchor
// publishes one message per wristband at the given rate, as the firmware does.
// Meanwhile it measures the answer time of an API call that reads MySQL, and
// reads /api/system/stats when the server offers it.
//
// Usage (from edge_server/, against a server that is already running):
//   node tools/load_test.js --duration 300 --anchors 3 --tags 2 --rate 7
// Options: --host 127.0.0.1 --http-port 3000 --mqtt-port 1883 --json
// The login is read from MQTT_ANCHOR_USER / MQTT_ANCHOR_PASSWORD (.env).
//
// The replayed anchors and wristbands are not enrolled unless you enrol them;
// enrolled devices exercise the database path. Run it against a test server
// (DB_NAME=shiro_test), not against the database with real patients.
// =============================================================================
require('../config/load_env');
const net = require('net');
const http = require('http');

function parseArgs(argv) {
  const opts = { host: '127.0.0.1', httpPort: 3000, mqttPort: 1883, anchors: 3, tags: 2, rate: 7, duration: 60, json: false, macBase: 0x10 };
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    const next = argv[i + 1];
    switch (key) {
      case 'host': opts.host = next; i++; break;
      case 'http-port': opts.httpPort = Number(next); i++; break;
      case 'mqtt-port': opts.mqttPort = Number(next); i++; break;
      case 'anchors': opts.anchors = Number(next); i++; break;
      case 'tags': opts.tags = Number(next); i++; break;
      case 'rate': opts.rate = Number(next); i++; break;
      case 'duration': opts.duration = Number(next); i++; break;
      case 'json': opts.json = true; break;
      default: throw new Error(`Unknown option --${key}`);
    }
  }
  return opts;
}

const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');
const anchorMac = (i, base) => `A0:00:00:00:${hex2(base)}:${hex2(i + 1)}`;
const tagMac = (i, base) => `B0:00:00:00:${hex2(base)}:${hex2(i + 1)}`;

// ----- minimal MQTT 3.1.1 client: CONNECT with login, QoS 0 PUBLISH -----
function mqttString(text) {
  const body = Buffer.from(text, 'utf8');
  const length = Buffer.alloc(2);
  length.writeUInt16BE(body.length);
  return Buffer.concat([length, body]);
}

function mqttPacket(firstByte, body) {
  const lengthBytes = [];
  let remaining = body.length;
  do {
    let digit = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) digit |= 0x80;
    lengthBytes.push(digit);
  } while (remaining > 0);
  return Buffer.concat([Buffer.from([firstByte, ...lengthBytes]), body]);
}

function connectAnchor(host, port, mac, login) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    socket.once('error', reject);
    socket.once('connect', () => {
      const clientId = `SHIRO_Anchor_${mac.replace(/:/g, '')}`;
      const body = Buffer.concat([mqttString('MQTT'), Buffer.from([0x04, 0xC2, 0x00, 0x3C]),
        mqttString(clientId), mqttString(login.username), mqttString(login.password)]);
      socket.write(mqttPacket(0x10, body));
    });
    socket.once('data', (data) => {
      if (data[0] === 0x20 && data[3] === 0x00) {
        socket.on('error', () => {});
        resolve({
          publish: (topic, payload) => socket.write(mqttPacket(0x30, Buffer.concat([mqttString(topic), Buffer.from(JSON.stringify(payload))]))),
          ping: () => socket.write(Buffer.from([0xC0, 0x00])),
          close: () => socket.end()
        });
      } else {
        reject(new Error(`MQTT login refused (return code ${data[3]})`));
      }
    });
  });
}

// ----- HTTP helpers -----
function httpGet(host, port, path, timeoutMs = 5000) {
  const started = process.hrtime.bigint();
  return new Promise((resolve) => {
    const req = http.get({ host, port, path, timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data, ms: Number(process.hrtime.bigint() - started) / 1e6 }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '', ms: timeoutMs }); });
    req.on('error', () => resolve({ status: 0, body: '', ms: Number(process.hrtime.bigint() - started) / 1e6 }));
  });
}

async function readStats(host, port) {
  const res = await httpGet(host, port, '/api/system/stats');
  if (res.status !== 200) return null;
  try { return JSON.parse(res.body).stats; } catch { return null; }
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

const round1 = (x) => (x === null || x === undefined ? null : Math.round(x * 10) / 10);

/**
 * Runs the load and returns the measurements. Exported for scripted runs.
 * @param {object} opts  see parseArgs
 * @param {{username: string, password: string}} login
 */
async function runLoad(opts, login) {
  const anchors = [];
  for (let a = 0; a < opts.anchors; a++) {
    const mac = anchorMac(a, opts.macBase);
    anchors.push({ mac, client: await connectAnchor(opts.host, opts.mqttPort, mac, login) });
  }

  const statsStart = await readStats(opts.host, opts.httpPort);
  const startedAt = Date.now();
  let sent = 0;
  let battery = 90;

  // Each anchor sends one message per wristband every 1/rate seconds
  const intervalMs = 1000 / opts.rate;
  const timers = anchors.map((anchor, a) => setInterval(() => {
    for (let t = 0; t < opts.tags; t++) {
      anchor.client.publish('shiro/ward-A1/anchor/telemetry', {
        anchor_mac: anchor.mac, tag_mac: tagMac(t, opts.macBase), rssi: -55 - a * 6 - t, v: 2,
        bpm: 72 + t, spo2: 97, battery, charging: false, motion: 'STATIONARY', g: 1.0,
        touch: 1, active: false, fall: false, fall_seq: 1, impact_g: 0, freefall_g: 0, still_g: 0,
        imu_fault: false, ppg_fault: false, ts: Date.now() - startedAt
      });
      sent++;
    }
  }, intervalMs));
  const pingTimer = setInterval(() => anchors.forEach(x => x.client.ping()), 20000);
  const batteryTimer = setInterval(() => { battery = battery > 20 ? battery - 1 : 90; }, 10000);

  // Answer time of an API call that reads MySQL, once per second
  const latencies = [];
  let failures = 0;
  const statsSamples = [];
  const probeTimer = setInterval(async () => {
    const res = await httpGet(opts.host, opts.httpPort, '/api/devices/list');
    if (res.status === 200) latencies.push(res.ms); else failures++;
  }, 1000);
  const statsTimer = setInterval(async () => {
    const s = await readStats(opts.host, opts.httpPort);
    if (s) statsSamples.push(s);
  }, 5000);

  await new Promise((resolve) => setTimeout(resolve, opts.duration * 1000));
  [...timers, pingTimer, batteryTimer, probeTimer, statsTimer].forEach(clearInterval);
  const elapsedS = (Date.now() - startedAt) / 1000;
  const statsEnd = await readStats(opts.host, opts.httpPort);
  anchors.forEach(x => x.client.close());

  const result = {
    duration_s: round1(elapsedS),
    anchors: opts.anchors,
    wristbands: opts.tags,
    messages_sent: sent,
    messages_per_s: round1(sent / elapsedS),
    api_answer_ms: { p50: round1(percentile(latencies, 50)), p95: round1(percentile(latencies, 95)), max: round1(latencies.length ? Math.max(...latencies) : null), failed: failures, samples: latencies.length }
  };
  if (statsStart && statsEnd) {
    result.db_queries_per_s = round1((statsEnd.db_queries_total - statsStart.db_queries_total) / elapsedS);
    const rss = statsSamples.map(s => s.memory_mb.rss);
    result.memory_rss_mb = { start: statsStart.memory_mb.rss, end: statsEnd.memory_mb.rss, max: rss.length ? Math.max(...rss) : null };
    result.heap_used_mb = { start: statsStart.memory_mb.heap_used, end: statsEnd.memory_mb.heap_used };
    const p99 = statsSamples.map(s => s.event_loop_delay_ms.p99);
    result.event_loop_delay_p99_ms = { median: round1(percentile(p99, 50)), max: p99.length ? Math.max(...p99) : null };
  } else {
    result.note = 'The server has no /api/system/stats: database queries and memory were not measured here.';
  }
  return result;
}

if (require.main === module) {
  const opts = parseArgs(process.argv);
  const login = { username: process.env.MQTT_ANCHOR_USER, password: process.env.MQTT_ANCHOR_PASSWORD };
  if (!login.username || !login.password) {
    console.error('MQTT_ANCHOR_USER and MQTT_ANCHOR_PASSWORD must be set (edge_server/.env).');
    process.exit(1);
  }
  if (!opts.json) {
    console.log(`Load test: ${opts.anchors} anchor(s) x ${opts.tags} wristband(s) at ${opts.rate} Hz for ${opts.duration} s against ${opts.host}:${opts.mqttPort} / :${opts.httpPort}`);
  }
  runLoad(opts, login).then((result) => {
    console.log(JSON.stringify(result, null, opts.json ? 0 : 2));
  }).catch((err) => {
    console.error(`Load test failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { runLoad, parseArgs, anchorMac, tagMac };
