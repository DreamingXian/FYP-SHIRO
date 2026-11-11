// =============================================================================
// Central Master Router & Static Asset Handler
// =============================================================================
const fs = require('fs');
const path = require('path');
const config = require('../config/app_config');
const { handleWardRoutes } = require('./ward_routes');
const { handlePatientRoutes } = require('./patient_routes');
const { handleDeviceRoutes } = require('./device_routes');
const { handleBindingRoutes } = require('./binding_routes');
const { handleAlertRoutes } = require('./alert_routes');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

async function handleRequest(req, res) {
  // 1. Enable Global CORS & Development No-Cache headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // Buffer request body if POST
  let body = '';
  if (req.method === 'POST') {
    await new Promise((resolve) => {
      req.on('data', chunk => { body += chunk; });
      req.on('end', resolve);
    });
  }

  // 2. Dispatch to Module API Routers
  if (pathname.startsWith('/api/ward')) {
    const handled = await handleWardRoutes(pathname, req, res, parsedUrl, body);
    if (handled) return;
  }

  if (pathname.startsWith('/api/patients')) {
    const handled = await handlePatientRoutes(pathname, req, res, parsedUrl, body);
    if (handled) return;
  }

  if (pathname.startsWith('/api/devices')) {
    const handled = await handleDeviceRoutes(pathname, req, res, parsedUrl, body);
    if (handled) return;
  }

  if (pathname.startsWith('/api/bindings')) {
    const handled = await handleBindingRoutes(pathname, req, res, parsedUrl, body);
    if (handled) return;
  }

  if (pathname.startsWith('/api/alerts')) {
    const handled = await handleAlertRoutes(pathname, req, res, parsedUrl, body);
    if (handled) return;
  }

  // 3. Fallback: Static Files & HTML Partials Serving from /public
  let relativePath = pathname === '/' ? 'index.html' : pathname;
  // Prevent directory traversal attacks
  const safePath = path.normalize(relativePath).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(config.PUBLIC_DIR, safePath);

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`404 Not Found: ${pathname}`);
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`Server Error: ${err.code}`);
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    }
  });
}

module.exports = {
  handleRequest
};

