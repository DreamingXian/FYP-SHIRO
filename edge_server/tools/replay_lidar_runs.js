#!/usr/bin/env node
// =============================================================================
// SHIRO - Replay of recorded position-test runs through the LiDAR positioning
// (Phase 10, step 5b)
//
// Every run of a position-test session records the LiDAR turns and the
// wristband's Bluetooth positions (services/ips/lidar_record.js). This replays
// them through exactly the code the server runs (services/room_sensor/ward_people.js)
// and scores, at the moments the test took its readings, the position the maps
// would have shown: the LiDAR's when the wristband was linked to a person, else
// the Bluetooth position the test recorded. No database, no network.
//
// Usage (from edge_server):
//   node tools/replay_lidar_runs.js <session-id> [--dir data/position_tests] [--csv out.csv] [--json out.json]
// =============================================================================
const fs = require('fs');
const path = require('path');
const lidarRecord = require('../services/ips/lidar_record');
const { buildZones, zoneAt } = require('../services/ips/zones');
const { createWardPeople } = require('../services/room_sensor/ward_people');

const LIDAR_FRESH_MS = 1000;   // a LiDAR position older than this (no turn) is not used
const BLE_STATUSES = new Set(['ONLINE', 'CHARGING']);

const round = (v, d = 3) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] : null);

function stats(errors) {
  const s = [...errors].sort((a, b) => a - b);
  const n = s.length;
  const within = (m) => (n ? round(100 * s.filter(e => e <= m).length / n, 1) : null);
  return {
    n,
    mean: n ? round(s.reduce((a, b) => a + b, 0) / n) : null,
    median: round(percentile(s, 0.5)),
    p95: round(percentile(s, 0.95)),
    max: n ? round(s[n - 1]) : null,
    within_0_25: within(0.25), within_0_5: within(0.5), within_1_0: within(1.0), within_1_5: within(1.5)
  };
}

/**
 * Replays one run. Returns its readings with the position the maps would show.
 * @param {object} run       the run from the session file
 * @param {object} rec       lidarRecord.unpack of its LiDAR file
 * @param {object} layout    the session's ward_snapshot
 * @param {object} [options] overrides for ward_people
 */
function replayRun(run, rec, layout, options = {}) {
  const wp = createWardPeople(options);
  const sensors = new Map(rec.sensors.filter(s => s.background && s.background.model).map(s => [s.device_id, s]));
  const room = { length_x: layout.length_x, width_y: layout.width_y };
  const track = (rec.track || []).filter(e => BLE_STATUSES.has(e.status) && Number.isFinite(e.raw_x) && Number.isFinite(e.raw_y));
  const timeline = [];   // { t_ms, pos|null, people }
  let ti = -1;
  let firstLinkMs = null;
  for (const f of rec.frames) {
    const sensor = sensors.get(f.device_id);
    if (!sensor) continue;
    while (ti + 1 < track.length && track[ti + 1].t_ms <= f.t_ms) ti++;
    const e = ti >= 0 ? track[ti] : null;
    const wristbands = e ? [{ tagId: run.tag_id, x: e.raw_x, y: e.raw_y, at: rec.starts_at + e.t_ms }] : [];
    const out = wp.turn({
      deviceId: f.device_id, distancesMm: f.distancesMm, model: sensor.background.model,
      pose: { x: sensor.x, y: sensor.y, heading_deg: sensor.heading_deg },
      room, beds: layout.beds || [], t: rec.starts_at + f.t_ms, wristbands
    });
    const pos = out.positions.find(p => p.tagId === run.tag_id) || null;
    if (pos && !pos.held && firstLinkMs === null) firstLinkMs = f.t_ms;
    timeline.push({ t_ms: f.t_ms, pos, people: out.people.length });
  }

  const zoneMap = buildZones(layout);
  const readings = [];
  let k = -1;
  for (const s of run.samples) {
    if (s.t_ms < 0 || s.t_ms > run.duration_s * 1000) continue;
    while (k + 1 < timeline.length && timeline[k + 1].t_ms <= s.t_ms) k++;
    const at = k >= 0 ? timeline[k] : null;
    const lidar = at && at.pos && s.t_ms - at.t_ms <= LIDAR_FRESH_MS ? at.pos : null;
    let x = null;
    let y = null;
    let source = null;
    if (lidar) {
      x = lidar.x; y = lidar.y; source = lidar.held ? 'LIDAR_HELD' : 'LIDAR';
    } else if (s.available) {
      x = s.x; y = s.y; source = 'BLE';
    }
    const error = source ? Math.hypot(x - run.true_x, y - run.true_y) : null;
    const zone = source ? zoneAt(zoneMap, x, y).id : null;
    readings.push({
      run: run.number, spot: run.spot, posture: run.posture, facing: run.facing, t_ms: s.t_ms,
      true_x: run.true_x, true_y: run.true_y, true_zone: run.true_zone,
      source, x: round(x), y: round(y), error_m: round(error), zone, zone_ok: zone === run.true_zone,
      shown_source: s.available ? s.source : null, shown_error_m: s.available ? s.error_m : null,
      shown_zone_ok: s.available ? !!s.zone_ok : null,
      people_seen: at ? at.people : 0
    });
  }
  return { readings, first_link_ms: firstLinkMs, turns: timeline.length };
}

function summarise(readings) {
  const available = readings.filter(r => r.source);
  const sources = {};
  for (const r of available) sources[r.source] = (sources[r.source] || 0) + 1;
  for (const k of Object.keys(sources)) sources[k] = round(100 * sources[k] / available.length, 1);
  const shown = readings.filter(r => r.shown_source);
  return {
    readings: readings.length,
    available_pct: readings.length ? round(100 * available.length / readings.length, 1) : null,
    sources,
    replay: stats(available.map(r => r.error_m)),
    replay_zone_ok_pct: available.length ? round(100 * available.filter(r => r.zone_ok).length / available.length, 1) : null,
    shown: stats(shown.map(r => r.shown_error_m)),
    shown_zone_ok_pct: shown.length ? round(100 * shown.filter(r => r.shown_zone_ok).length / shown.length, 1) : null
  };
}

function replaySession(sessionId, dir, options = {}) {
  const session = JSON.parse(fs.readFileSync(path.join(dir, `${sessionId}.json`), 'utf8'));
  const layout = session.ward_snapshot;
  const all = [];
  const runs = [];
  for (const run of session.runs) {
    const file = path.join(dir, `${sessionId}-run${run.number}.lidar.json.gz`);
    if (!fs.existsSync(file)) {
      runs.push({ number: run.number, skipped: 'no LiDAR record' });
      continue;
    }
    const rec = lidarRecord.unpack(fs.readFileSync(file));
    const r = replayRun(run, rec, layout, options);
    all.push(...r.readings);
    const st = summarise(r.readings);
    runs.push({
      number: run.number, spot: run.spot, posture: run.posture, facing: run.facing,
      first_link_ms: r.first_link_ms, turns: r.turns, sources: st.sources,
      replay_mean: st.replay.mean, replay_p95: st.replay.p95, shown_mean: st.shown.mean
    });
  }
  const groups = { all: all, standing: all.filter(r => r.posture === 'STANDING'), sitting: all.filter(r => r.posture === 'SITTING'), lying: all.filter(r => r.posture === 'LYING') };
  const summary = {};
  for (const [k, list] of Object.entries(groups)) summary[k] = summarise(list);
  return { session_id: sessionId, name: session.name, runs, summary, readings: all };
}

function printReport(result) {
  const line = (label, st) => `| ${label} | ${st.n} | ${st.mean} m | ${st.median} m | ${st.p95} m | ${st.within_0_25} % | ${st.within_0_5} % | ${st.within_1_0} % | ${st.within_1_5} % |`;
  console.log(`Replay of ${result.session_id} (${result.name || ''})\n`);
  console.log('| Group | Readings | Mean | Median | 95 % | ≤ 0.25 m | ≤ 0.5 m | ≤ 1.0 m | ≤ 1.5 m |');
  console.log('| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const [k, s] of Object.entries(result.summary)) {
    if (!s.readings) continue;
    console.log(line(`${k}, shown then`, s.shown));
    console.log(line(`${k}, replay`, s.replay));
  }
  console.log('\nSources in the replay and correct zone:');
  for (const [k, s] of Object.entries(result.summary)) {
    if (!s.readings) continue;
    console.log(`  ${k}: ${JSON.stringify(s.sources)}; zone correct ${s.replay_zone_ok_pct} % (shown then ${s.shown_zone_ok_pct} %)`);
  }
  console.log('\nRuns:');
  for (const r of result.runs) {
    if (r.skipped) { console.log(`  run ${r.number}: ${r.skipped}`); continue; }
    console.log(`  run ${String(r.number).padStart(2)} ${String(r.spot).padEnd(4)} ${r.posture.padEnd(8)} ${String(r.facing).padEnd(2)} linked at ${r.first_link_ms === null ? 'never' : `${(r.first_link_ms / 1000).toFixed(1)} s`}, mean ${r.replay_mean} m (shown then ${r.shown_mean} m), ${JSON.stringify(r.sources)}`);
  }
}

function toCsv(readings) {
  const head = ['run', 'spot', 'posture', 'facing', 't_s', 'true_x', 'true_y', 'true_zone', 'source', 'x', 'y', 'error_m', 'zone', 'zone_ok', 'shown_source', 'shown_error_m', 'people_seen'];
  const rows = readings.map(r => [r.run, r.spot, r.posture, r.facing, round(r.t_ms / 1000, 2), r.true_x, r.true_y, r.true_zone,
    r.source || '', r.x ?? '', r.y ?? '', r.error_m ?? '', r.zone || '', r.zone_ok ? 'yes' : 'no', r.shown_source || '', r.shown_error_m ?? '', r.people_seen]);
  return [head, ...rows].map(cols => cols.map(c => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(',')).join('\n') + '\n';
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const sessionId = args.find(a => !a.startsWith('--'));
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  if (!sessionId) {
    console.error('Usage: node tools/replay_lidar_runs.js <session-id> [--dir data/position_tests] [--csv out.csv] [--json out.json]');
    process.exit(2);
  }
  const dir = opt('--dir') || path.join(__dirname, '..', 'data', 'position_tests');
  const result = replaySession(sessionId, dir);
  printReport(result);
  if (opt('--csv')) fs.writeFileSync(opt('--csv'), toCsv(result.readings));
  if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify({ ...result, readings: undefined }, null, 2));
}

module.exports = { replayRun, replaySession, summarise, stats, toCsv };
