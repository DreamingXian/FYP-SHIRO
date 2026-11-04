// =============================================================================
// Ward Configuration Routes Dispatcher
// =============================================================================
const wardController = require('../controllers/ward_controller');

async function handleWardRoutes(pathname, req, res, parsedUrl, body) {
  if (pathname === '/api/ward/list' && req.method === 'GET') {
    await wardController.listWards(req, res);
    return true;
  }

  if (pathname === '/api/ward/ips-init' && req.method === 'GET') {
    await wardController.getWardIps(req, res, parsedUrl);
    return true;
  }

  if ((pathname === '/api/ward/config' || pathname === '/api/ward/get') && req.method === 'GET') {
    await wardController.getWard(req, res, parsedUrl);
    return true;
  }

  if (pathname === '/api/ward/config') {
    if (req.method === 'POST') {
      await wardController.saveWard(req, res, body);
      return true;
    }
    if (req.method === 'DELETE') {
      await wardController.deleteWardRecord(req, res, parsedUrl);
      return true;
    }
  }

  if (pathname === '/api/ward/templates' && req.method === 'GET') {
    wardController.getTemplates(req, res);
    return true;
  }

  if (pathname === '/api/ward/reset-default' && req.method === 'POST') {
    await wardController.resetDefault(req, res);
    return true;
  }

  return false;
}

module.exports = {
  handleWardRoutes
};
