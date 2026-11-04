// =============================================================================
// Patient-to-Wristband Binding Routes Dispatcher
// =============================================================================
const bindingController = require('../controllers/binding_controller');

async function handleBindingRoutes(pathname, req, res, parsedUrl, body) {
  // 1. GET /api/bindings/list or /api/bindings
  if ((pathname === '/api/bindings/list' || pathname === '/api/bindings') && req.method === 'GET') {
    await bindingController.listBindings(req, res);
    return true;
  }

  // 2. GET /api/bindings/unpaired-candidates
  if (pathname === '/api/bindings/unpaired-candidates' && req.method === 'GET') {
    await bindingController.getUnpairedCandidates(req, res);
    return true;
  }

  // 3. POST /api/bindings/bind
  if (pathname === '/api/bindings/bind' && req.method === 'POST') {
    await bindingController.createBinding(req, res, body);
    return true;
  }

  // 4. POST or DELETE /api/bindings/unbind
  if (pathname === '/api/bindings/unbind' && (req.method === 'POST' || req.method === 'DELETE')) {
    await bindingController.removeBinding(req, res, body, parsedUrl);
    return true;
  }

  return false;
}

module.exports = {
  handleBindingRoutes
};

