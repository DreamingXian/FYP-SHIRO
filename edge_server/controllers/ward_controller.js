// =============================================================================
// Ward Configuration Controller
// =============================================================================
const wardService = require('../services/ward_service');
const { broadcastToClients } = require('../services/websocket_service');

async function listWards(req, res) {
  try {
    const wards = await wardService.getAllWards();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, wards }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
}

async function getWard(req, res, parsedUrl) {
  try {
    const wardId = parsedUrl.searchParams.get('ward_id') || 'WARD-A1';
    const config = await wardService.getWardConfig(wardId);
    if (!config) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Ward not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, ward: config }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
}

async function saveWard(req, res, body) {
  try {
    const payload = JSON.parse(body);
    const result = await wardService.saveWardConfig(payload);

    // Notify connected WebSockets (Web Dashboard & Meta Quest 3)
    broadcastToClients({
      type: 'WARD_CONFIG_UPDATED',
      ward_id: result.ward_id,
      timestamp: new Date().toLocaleTimeString()
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      message: 'Ward configuration saved to database successfully.',
      ward_id: result.ward_id
    }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
}

async function deleteWardRecord(req, res, parsedUrl) {
  try {
    const wardId = parsedUrl.searchParams.get('ward_id');
    if (!wardId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Missing ward_id parameter' }));
      return;
    }

    await wardService.deleteWard(wardId);

    // Broadcast delete event
    broadcastToClients({
      type: 'WARD_CONFIG_UPDATED',
      deleted_ward_id: wardId,
      timestamp: new Date().toLocaleTimeString()
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: `Ward ${wardId} deleted successfully.` }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
}

function getTemplates(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: true, templates: wardService.WARD_TEMPLATES }));
}

async function resetDefault(req, res) {
  try {
    const config = await wardService.resetDefaultWard();
    broadcastToClients({
      type: 'WARD_CONFIG_UPDATED',
      ward_id: 'WARD-A1',
      timestamp: new Date().toLocaleTimeString()
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, ward: config }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
}

async function getWardIps(req, res, parsedUrl) {
  try {
    const wardId = parsedUrl.searchParams.get('ward_id') || 'WARD-004';
    const ipsData = await wardService.getWardIpsData(wardId);
    if (!ipsData) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Ward not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, ...ipsData }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
}

async function removeWardIpsTag(req, res, parsedUrl, body) {
  try {
    let tagId = parsedUrl.searchParams.get('tag_id');
    let mac = parsedUrl.searchParams.get('mac');
    if (!tagId && body) {
      try {
        const parsed = JSON.parse(body);
        tagId = parsed.tag_id;
        mac = parsed.mac;
      } catch (_) {}
    }

    if (!tagId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'tag_id query or body parameter is required' }));
      return;
    }

    const ipsService = require('../services/ips_service');
    ipsService.purgeTag(tagId, mac);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      message: `Tag "${tagId}" purged from ward map.`
    }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
}

async function startCalibration(req, res, body) {
  try {
    const calibrationService = require('../services/calibration_service');
    const payload = JSON.parse(body || '{}');
    const result = await calibrationService.startSession(payload);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
}

async function getCalibrationStatus(req, res) {
  try {
    const calibrationService = require('../services/calibration_service');
    const result = calibrationService.getSessionResults();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
}

async function applyCalibration(req, res, body) {
  try {
    const calibrationService = require('../services/calibration_service');
    const payload = JSON.parse(body || '{}');
    const result = await calibrationService.applyCalibrations(payload.ward_id, payload.calibrations);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
}

module.exports = {
  listWards,
  getWard,
  getWardIps,
  removeWardIpsTag,
  saveWard,
  deleteWardRecord,
  getTemplates,
  resetDefault,
  startCalibration,
  getCalibrationStatus,
  applyCalibration
};

