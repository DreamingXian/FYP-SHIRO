// =============================================================================
// SHIRO Edge Server - Position test routes (Phase 10, evaluation)
//   GET  /api/ips/position-test/status        the run in progress and the last finished run
//   POST /api/ips/position-test/start         { ward_id, tag_id, x, y, spot?, facing?, posture?,
//                                               duration_s?, countdown_s?, session_id? | session_name? }
//   POST /api/ips/position-test/cancel        stops the run in progress (not kept)
//   GET  /api/ips/position-test/sessions      ?ward_id=  sessions, newest first
//   GET  /api/ips/position-test/session       ?id=       one session with its runs and statistics
//   POST /api/ips/position-test/discard       { session_id, run }  removes one run
//   GET  /api/ips/position-test/samples.csv   ?id=       every reading of every run
//   GET  /api/ips/position-test/summary.csv   ?id=       one row per run, then ALL / STANDING / SITTING+LYING
// Signed-in clinicians only (not in the permission table, so STAFF).
// =============================================================================
const positionTest = require('../services/ips/position_test');
const { actorLabel } = require('../services/auth/auth_service');
const { sendJson, sendFailure, parseJsonBody, HttpError } = require('../utils/http');

const SESSION_ID = /^PT-\d{8}-\d{6}$/;

function sessionIdFrom(value) {
  const id = String(value || '');
  if (!SESSION_ID.test(id)) throw new HttpError(400, 'id must be a session ID such as PT-20261120-193000.');
  return id;
}

function sendCsv(res, fileName, text) {
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${fileName}"`
  });
  res.end(text);
}

async function handleIpsRoutes(pathname, req, res, parsedUrl, body) {
  const recorder = positionTest.instance();
  const q = parsedUrl.searchParams;
  const route = `${req.method} ${pathname}`;

  try {
    switch (route) {
      case 'GET /api/ips/position-test/status':
        sendJson(res, 200, { success: true, ...recorder.getStatus() });
        return true;

      case 'POST /api/ips/position-test/start': {
        const status = await recorder.startRun(parseJsonBody(body), req.actor ? actorLabel(req.actor) : null);
        sendJson(res, 200, { success: true, active: status });
        return true;
      }

      case 'POST /api/ips/position-test/cancel':
        sendJson(res, 200, { success: true, cancelled: recorder.cancelRun() });
        return true;

      case 'GET /api/ips/position-test/sessions':
        sendJson(res, 200, { success: true, sessions: recorder.listSessions(q.get('ward_id') || null) });
        return true;

      case 'GET /api/ips/position-test/session':
        sendJson(res, 200, { success: true, session: recorder.getSession(sessionIdFrom(q.get('id'))) });
        return true;

      case 'POST /api/ips/position-test/discard': {
        const data = parseJsonBody(body);
        const run = Number(data.run);
        if (!Number.isInteger(run) || run < 1) throw new HttpError(400, 'run must be a run number.');
        sendJson(res, 200, { success: true, ...recorder.discardRun(sessionIdFrom(data.session_id), run) });
        return true;
      }

      case 'GET /api/ips/position-test/samples.csv': {
        const id = sessionIdFrom(q.get('id'));
        sendCsv(res, `shiro-position-test_${id}_samples.csv`, recorder.samplesCsv(id));
        return true;
      }

      case 'GET /api/ips/position-test/summary.csv': {
        const id = sessionIdFrom(q.get('id'));
        sendCsv(res, `shiro-position-test_${id}_summary.csv`, recorder.summaryCsv(id));
        return true;
      }

      default:
        return false;
    }
  } catch (err) {
    sendFailure(res, err, 'positionTest');
    return true;
  }
}

module.exports = { handleIpsRoutes };
