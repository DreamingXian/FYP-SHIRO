// =============================================================================
// Central Master Router & Static Asset Handler
// =============================================================================
const logger = require('../utils/logger');
const fs = require('fs');
const path = require('path');
const config = require('../config/app_config');
const { handleWardRoutes } = require('./ward_routes');
const { handlePatientRoutes } = require('./patient_routes');
const { handleDeviceRoutes } = require('./device_routes');
const { handleBindingRoutes } = require('./binding_routes');
const { handleAlertRoutes } = require('./alert_routes');
const { handleSystemRoutes } = require('./system_routes');
const { HttpError, JSON_BODY_LIMIT, PHOTO_BODY_LIMIT, sendError, sendFailure, readBody, isCrossSiteRequest } = require('../utils/http');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
};

const PUBLIC_ROOT = path.resolve(config.PUBLIC_DIR);

const API_ROUTERS = [
  ['/api/ward', handleWardRoutes],
  ['/api/patients', handlePatientRoutes],
  ['/api/devices', handleDeviceRoutes],
  ['/api/bindings', handleBindingRoutes],
  ['/api/alerts', handleAlertRoutes],
  ['/api/system', handleSystemRoutes]
];

/**
 * Turns the path of a request into a file inside public/.
 * Returns null when the path is malformed or would leave that folder.
 */
function resolvePublicFile(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^[/\\]+/, '');
  const filePath = path.resolve(PUBLIC_ROOT, relative);
  if (filePath !== PUBLIC_ROOT && !filePath.startsWith(PUBLIC_ROOT + path.sep)) return null;
  return filePath;
}

function serveStaticFile(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
    res.end('405 Method Not Allowed');
    return;
  }

  const filePath = resolvePublicFile(pathname);
  if (filePath === null) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('400 Bad Request');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT' || err.code === 'EISDIR' || err.code === 'ENOTDIR') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
      } else {
        logger.error(`[STATIC FILE ERROR] ${pathname}:`, err.message);
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('500 Server Error');
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(req.method === 'HEAD' ? undefined : content);
    }
  });
}

async function handleRequest(req, res) {
  // Headers of every response. No cross-origin access is granted: the dashboard
  // is served from this server, and the headset is not bound by browser rules.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  let parsedUrl;
  try {
    parsedUrl = new URL(req.url, 'http://localhost');
  } catch {
    sendError(res, 400, 'The request address is not valid.');
    return;
  }
  const pathname = parsedUrl.pathname;

  if (!pathname.startsWith('/api/')) {
    serveStaticFile(req, res, pathname);
    return;
  }

  try {
    const changesData = req.method !== 'GET' && req.method !== 'HEAD';
    if (changesData && isCrossSiteRequest(req)) {
      throw new HttpError(403, 'Requests from other websites are not accepted.');
    }

    let body = '';
    if (req.method === 'POST' || req.method === 'DELETE') {
      const limit = pathname === '/api/patients/upload-photo' ? PHOTO_BODY_LIMIT : JSON_BODY_LIMIT;
      body = await readBody(req, limit);
    }

    for (const [prefix, handler] of API_ROUTERS) {
      if (pathname === prefix || pathname.startsWith(prefix + '/')) {
        const handled = await handler(pathname, req, res, parsedUrl, body);
        if (handled) return;
      }
    }

    sendError(res, 404, 'This API address does not exist.');
  } catch (err) {
    sendFailure(res, err, `${req.method} ${pathname}`);
  }
}

module.exports = {
  handleRequest,
  resolvePublicFile
};
