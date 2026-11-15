// Unit tests: logger levels, format and rate limit (utils/logger.js)
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const logger = require('../../utils/logger');

/** Captures what the logger writes through console.log / warn / error. */
function capture(fn) {
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  for (const m of Object.keys(saved)) console[m] = (...args) => lines.push({ method: m, text: args.join(' ') });
  try { fn(); } finally { Object.assign(console, saved); }
  return lines;
}

describe('logger', () => {
  const savedLevel = process.env.LOG_LEVEL;
  afterEach(() => {
    if (savedLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = savedLevel;
  });

  test('each line has a time stamp and its level, and goes to the matching console method', () => {
    process.env.LOG_LEVEL = 'debug';
    const lines = capture(() => {
      logger.error('[T] e');
      logger.warn('[T] w');
      logger.info('[T] i');
      logger.debug('[T] d');
    });
    assert.deepEqual(lines.map(l => l.method), ['error', 'warn', 'log', 'log']);
    for (const [line, level] of lines.map((l, i) => [l.text, ['ERROR', 'WARN', 'INFO', 'DEBUG'][i]])) {
      assert.match(line, new RegExp(`^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\.\\d{3} ${level}\\s+\\[T\\]`));
    }
  });

  test('the default level is info: debug lines are left out', () => {
    delete process.env.LOG_LEVEL;
    const lines = capture(() => { logger.info('a'); logger.debug('b'); });
    assert.equal(lines.length, 1);
  });

  test('LOG_LEVEL=warn leaves out info and debug, keeps warn and error', () => {
    process.env.LOG_LEVEL = 'warn';
    const lines = capture(() => { logger.error('a'); logger.warn('b'); logger.info('c'); logger.debug('d'); });
    assert.deepEqual(lines.map(l => l.method), ['error', 'warn']);
  });

  test('an unknown LOG_LEVEL falls back to info', () => {
    process.env.LOG_LEVEL = 'verbose';
    const lines = capture(() => { logger.info('a'); logger.debug('b'); });
    assert.equal(lines.filter(l => l.text.endsWith(' a')).length, 1);
    assert.equal(lines.filter(l => l.text.endsWith(' b')).length, 0);
  });

  test('an Error is written with its message, and with its stack at debug level', () => {
    process.env.LOG_LEVEL = 'info';
    const err = new Error('disk full');
    assert.match(capture(() => logger.error('[T]', err))[0].text, /\[T\] disk full$/);
    process.env.LOG_LEVEL = 'debug';
    assert.match(capture(() => logger.error('[T]', err))[0].text, /Error: disk full\n\s+at /);
  });

  test('every() lets a key through once per interval', () => {
    const key = `test-${Math.random()}`;
    assert.equal(logger.every(key, 60000), true);
    assert.equal(logger.every(key, 60000), false);
    assert.equal(logger.every(`${key}-other`, 60000), true);
    assert.equal(logger.every(key, 0), true);
  });
});
