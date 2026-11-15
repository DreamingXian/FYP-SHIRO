// =============================================================================
// SHIRO Edge Server - Logger
// One place that decides what is written to the console, with a time stamp and
// a level. LOG_LEVEL in edge_server/.env chooses the least important level that
// is still written: error, warn, info (default) or debug.
//
// The console methods are looked up at every call, so tests can replace them.
// =============================================================================
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const CONSOLE_METHOD = { error: 'error', warn: 'warn', info: 'log', debug: 'log' };
const LABEL = { error: 'ERROR', warn: 'WARN ', info: 'INFO ', debug: 'DEBUG' };

let warnedAboutLevel = false;

function currentLevel() {
  const name = String(process.env.LOG_LEVEL || 'info').trim().toLowerCase();
  if (name in LEVELS) return LEVELS[name];
  if (!warnedAboutLevel) {
    warnedAboutLevel = true;
    console.warn(`${timestamp()} WARN  [LOGGER] LOG_LEVEL "${name.slice(0, 20)}" is not error, warn, info or debug: using info.`);
  }
  return LEVELS.info;
}

function timestamp() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function isEnabled(level) {
  return LEVELS[level] <= currentLevel();
}

function write(level, args) {
  if (!isEnabled(level)) return;
  // An Error is written with its stack at debug level, with its message otherwise
  const parts = args.map(a => (a instanceof Error ? (isEnabled('debug') && a.stack ? a.stack : a.message) : a));
  console[CONSOLE_METHOD[level]](`${timestamp()} ${LABEL[level]}`, ...parts);
}

// Rate limit: true when the key has not been let through within intervalMs
const lastByKey = new Map();
const MAX_KEYS = 1000;

function every(key, intervalMs) {
  const now = Date.now();
  if (now - (lastByKey.get(key) || 0) < intervalMs) return false;
  if (lastByKey.size >= MAX_KEYS) lastByKey.clear();
  lastByKey.set(key, now);
  return true;
}

module.exports = {
  error: (...args) => write('error', args),
  warn: (...args) => write('warn', args),
  info: (...args) => write('info', args),
  debug: (...args) => write('debug', args),
  isEnabled,
  every,
  LEVELS
};
