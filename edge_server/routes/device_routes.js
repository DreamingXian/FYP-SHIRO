// =============================================================================
// Hardware Device Fleet & Discovery Routes Dispatcher
// =============================================================================
const deviceController = require('../controllers/device_controller');

async function handleDeviceRoutes(pathname, req, res, parsedUrl, body) {
  // 1. GET /api/devices/list or /api/devices
  if ((pathname === '/api/devices/list' || pathname === '/api/devices') && req.method === 'GET') {
    await deviceController.listDevices(req, res, parsedUrl);
    return true;
  }

  // 2. GET /api/devices/unprovisioned
  if (pathname === '/api/devices/unprovisioned' && req.method === 'GET') {
    await deviceController.getUnprovisioned(req, res);
    return true;
  }

  // 3. GET /api/devices/next-id
  if (pathname === '/api/devices/next-id' && req.method === 'GET') {
    await deviceController.getNextId(req, res, parsedUrl);
    return true;
  }

  // 4. POST /api/devices/enroll
  if (pathname === '/api/devices/enroll' && req.method === 'POST') {
    await deviceController.enrollDevice(req, res, body);
    return true;
  }

  // 5. POST /api/devices/update
  if (pathname === '/api/devices/update' && req.method === 'POST') {
    await deviceController.updateDevice(req, res, body, parsedUrl);
    return true;
  }

  // 6. POST or DELETE /api/devices/delete
  if (pathname === '/api/devices/delete' && (req.method === 'POST' || req.method === 'DELETE')) {
    await deviceController.deleteDevice(req, res, body, parsedUrl);
    return true;
  }

  // 7. POST /api/devices/ping
  if (pathname === '/api/devices/ping' && req.method === 'POST') {
    await deviceController.pingDevice(req, res, body);
    return true;
  }

  return false;
}

module.exports = {
  handleDeviceRoutes
};

