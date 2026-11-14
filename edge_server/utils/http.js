// =============================================================================
// SHIRO Edge Server - HTTP request and response helpers
// One place for: the response format, reading a request body with a size limit,
// parsing JSON, and deciding what an error may tell the client.
// =============================================================================

/** An error whose message is written for the client and is safe to send. */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

// Largest request body accepted, in bytes.
const JSON_BODY_LIMIT = 256 * 1024;        // every JSON endpoint
const PHOTO_BODY_LIMIT = 4608 * 1024;     // photo upload: a 3 MB image as base64 (4 MB), plus the JSON around it

// A body larger than its limit is read and thrown away, so the client can still
// receive the 413 answer. Beyond this multiple of the limit the connection is cut.
const DRAIN_FACTOR = 8;

const GENERIC_SERVER_ERROR = 'Internal server error. The details are in the server log.';

function sendJson(res, status, data) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function sendError(res, status, message) {
  sendJson(res, status, { success: false, error: message });
}

/**
 * A rule broken by the request (for example "bed is occupied"). The services
 * raise these as plain Error objects with a message written for the user.
 * Database, network and programming errors carry a code or another class.
 */
function isRuleError(err) {
  return Boolean(err) && err.constructor === Error && err.code === undefined && err.errno === undefined;
}

/**
 * Answers a failed request.
 * - HttpError: its own status and message.
 * - A rule broken by the request: 400 with the message.
 * - Anything else (database, network, programming error): logged here, and the
 *   client receives a general message without internal details.
 */
function sendFailure(res, err, context) {
  if (err instanceof HttpError) return sendError(res, err.status, err.message);
  if (isRuleError(err)) return sendError(res, 400, err.message);
  console.error(`[HTTP ERROR] ${context}:`, err);
  sendError(res, 500, GENERIC_SERVER_ERROR);
}

/**
 * Reads the request body as UTF-8 text.
 * Rejects with HttpError 413 when it is larger than limitBytes.
 */
function readBody(req, limitBytes = JSON_BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        tooLarge = true;
        chunks.length = 0;
        if (size > limitBytes * DRAIN_FACTOR) req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) reject(new HttpError(413, `The request is too large. The limit is ${Math.round(limitBytes / 1024)} KB.`));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
    req.on('close', () => {
      if (!req.complete) reject(new HttpError(400, 'The request was cut off before it was complete.'));
    });
  });
}

/**
 * True when the request was sent by a page of another website.
 * Browsers add an Origin header to every POST, DELETE and WebSocket request.
 * The dashboard is served by this server, so its Origin always names this
 * server. The headset and other non-browser clients send no Origin header.
 */
function isCrossSiteRequest(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true; // "null" or malformed: not our dashboard
  }
}

/**
 * Parses a JSON request body into an object.
 * An empty body gives {}. Invalid JSON, or JSON that is not an object, is a 400.
 */
function parseJsonBody(body) {
  if (body === undefined || body === null) return {};
  if (typeof body === 'object') return body;
  if (String(body).trim() === '') return {};
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new HttpError(400, 'The request body is not valid JSON.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'The request body must be a JSON object.');
  }
  return parsed;
}

module.exports = {
  HttpError,
  JSON_BODY_LIMIT,
  PHOTO_BODY_LIMIT,
  GENERIC_SERVER_ERROR,
  sendJson,
  sendError,
  sendFailure,
  isRuleError,
  readBody,
  parseJsonBody,
  isCrossSiteRequest
};
