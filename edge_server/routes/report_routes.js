// =============================================================================
// SHIRO Edge Server - Report routes (thesis section 4.7)
//   GET /api/reports/shifts         the shifts and the one running now
//   GET /api/reports/shift-summary  ?ward_id=&date=YYYY-MM-DD&shift=MORNING|EVENING|NIGHT
//                                   (date and shift default to the shift running now)
// Signed-in clinicians only (not in the permission table, so STAFF). Each shift
// report is recorded in the audit log: it gathers patient data.
// =============================================================================
const reportService = require('../services/reports/shift_report_service');
const shifts = require('../config/shifts');
const audit = require('../services/audit_service');
const { clientIp } = require('../services/auth/request_auth');
const { actorLabel } = require('../services/auth/auth_service');
const { sendJson, sendFailure, HttpError } = require('../utils/http');
const { requireId, requireOneOf } = require('../utils/validate');
const { parseDay } = require('../services/reports/shift_rules');

async function handleReportRoutes(pathname, req, res, parsedUrl) {
  if (pathname === '/api/reports/shifts' && req.method === 'GET') {
    try {
      sendJson(res, 200, { success: true, ...reportService.shiftOptions() });
    } catch (err) {
      sendFailure(res, err, 'getShifts');
    }
    return true;
  }

  if (pathname === '/api/reports/shift-summary' && req.method === 'GET') {
    try {
      const q = parsedUrl.searchParams;
      const wardId = requireId(q.get('ward_id'), 'ward_id');
      const day = q.get('date') || null;
      if (day !== null && !parseDay(day)) throw new HttpError(400, 'date must be a calendar day written YYYY-MM-DD.');
      const shiftKey = q.get('shift') ? requireOneOf(q.get('shift'), shifts.map(s => s.key), 'shift') : null;
      const generatedBy = req.actor ? actorLabel(req.actor) : null;

      const report = await reportService.buildShiftReport({ wardId, day, shiftKey, generatedBy });
      sendJson(res, 200, { success: true, report });

      audit.record({
        actor: req.actor || null,
        action: 'SHIFT_REPORT',
        targetType: 'WARD',
        targetId: wardId,
        details: { date: report.shift.day, shift: report.shift.key, patients: report.patients.length },
        ip: clientIp(req)
      });
    } catch (err) {
      sendFailure(res, err, 'getShiftSummary');
    }
    return true;
  }

  return false;
}

module.exports = { handleReportRoutes };
