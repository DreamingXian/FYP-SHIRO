// Integration test: device presence is written in batches, status changes at once,
// silent devices go OFFLINE, and a clean shutdown writes what is still in memory.
// Starts the real server on spare ports against shiro_test.
process.env.INFLUX_TOKEN = '';

const { db, freshDatabase, startServer, connectMqtt, anchorClientId } = require('./helper');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');

const HTTP_PORT = 3992;
const MQTT_PORT = 1882;
const ANCHOR_MAC = 'A0:00:00:00:00:41';
const TAG_MAC = 'B0:00:00:00:00:41';
const ANCHOR_ID = 'itest-anchor-41';
const TAG_ID = 'ITEST-TAG-41';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function deviceRow(pool, deviceId) {
  const [[row]] = await pool.query('SELECT status, battery_level, UNIX_TIMESTAMP(last_seen) AS seen FROM devices WHERE device_id = ?', [deviceId]);
  return row;
}

async function waitFor(check, timeoutMs, stepMs = 200) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) return value;
    await sleep(stepMs);
  }
}

function anchorMessage(battery) {
  return { anchor_mac: ANCHOR_MAC, tag_mac: TAG_MAC, rssi: -60, v: 2, bpm: 72, spo2: 98, battery, charging: false, ts: 1 };
}

describe('device presence', () => {
  let server;
  let pool;
  let ws;
  const received = [];

  before(async () => {
    pool = await freshDatabase();
    await pool.query(
      "INSERT INTO devices (device_id, mac_address, device_type, hardware_model, status) VALUES (?, ?, 'ANCHOR', 'TEST', 'OFFLINE'), (?, ?, 'WRISTBAND', 'TEST', 'OFFLINE')",
      [ANCHOR_ID, ANCHOR_MAC, TAG_ID, TAG_MAC]
    );
    server = startServer({ HTTP_PORT: String(HTTP_PORT), MQTT_PORT: String(MQTT_PORT) });
    await server.ready;
    ws = new WebSocket(`ws://127.0.0.1:${HTTP_PORT}`);
    ws.on('message', (data) => { received.push(JSON.parse(data.toString())); });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  });

  after(async () => {
    if (ws) ws.close();
    if (server) await server.stop();
    await db.closePool();
  });

  test('a status change is written at once, presence within one batch interval', async () => {
    const anchor = await connectMqtt(MQTT_PORT, anchorClientId(ANCHOR_MAC));
    try {
      // The anchor's connection alone marks it ONLINE, without waiting for a batch
      const online = await waitFor(async () => (await deviceRow(pool, ANCHOR_ID)).status === 'ONLINE', 1500);
      assert.ok(online, 'the anchor is ONLINE in the database within 1.5 s');

      // 3 s of messages at about 7 Hz, the battery falling from 80 to 60
      const sentFrom = Math.floor(Date.now() / 1000);
      for (let i = 0; i < 21; i++) {
        anchor.publish(anchorMessage(80 - i));
        await sleep(143);
      }
      const lastSent = Date.now() / 1000;

      const tag = await waitFor(async () => {
        const row = await deviceRow(pool, TAG_ID);
        return row.battery_level === 60 ? row : null;
      }, 6500);
      assert.ok(tag, 'the last battery value is in the database within one batch interval');
      assert.equal(tag.status, 'ONLINE');
      assert.ok(Number(tag.seen) >= sentFrom && Number(tag.seen) <= lastSent + 1, `last_seen ${tag.seen} lies in the sending period`);
    } finally {
      anchor.close();
    }
  });

  test('a device that falls silent is marked OFFLINE after 12 s, and the dashboard is told', async () => {
    const offline = await waitFor(async () => (await deviceRow(pool, TAG_ID)).status === 'OFFLINE', 17000, 500);
    assert.ok(offline, 'the wristband is OFFLINE in the database');
    assert.ok(received.some(m => m.type === 'DEVICE_HEARTBEAT' && m.device_id === TAG_ID && m.status === 'OFFLINE'));
    assert.match(server.output, /\[DEVICE\] ITEST-TAG-41 OFFLINE \(nothing received for 12 s\)/);
  });

  test('/api/system/stats reports memory, delay, query count and presence writes', async () => {
    const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/system/stats`);
    assert.equal(res.status, 200);
    const { stats } = await res.json();
    assert.ok(stats.uptime_s >= 0);
    assert.ok(stats.memory_mb.rss > 0 && stats.memory_mb.heap_used > 0);
    assert.ok(Number.isFinite(stats.event_loop_delay_ms.p99));
    assert.ok(stats.db_queries_total > 0);
    assert.ok(stats.device_presence.presenceWrites >= 1, JSON.stringify(stats.device_presence));
    assert.ok(stats.device_presence.statusWrites >= 2, 'anchor and wristband went ONLINE');
    assert.ok(stats.websocket_clients >= 1);
  });

  test('a clean shutdown writes the presence still in memory and exits with code 0', async () => {
    const anchor = await connectMqtt(MQTT_PORT, anchorClientId(ANCHOR_MAC));
    // Back ONLINE (written at once), then a battery value that only the batch would write
    anchor.publish(anchorMessage(55));
    await sleep(300);
    anchor.publish(anchorMessage(42));
    await sleep(200);

    const code = await server.shutdown();
    assert.equal(code, 0, server.output.slice(-2000));
    assert.equal((await deviceRow(pool, TAG_ID)).battery_level, 42, 'the value received just before the shutdown is stored');
    assert.match(server.output, /\[SHUTDOWN\] Written: presence of [1-9]\d* device\(s\)/);
    assert.match(server.output, /\[SHUTDOWN\] Done\./);
    assert.doesNotMatch(server.output, /\[SHUTDOWN\] .* failed/);
  });
});
