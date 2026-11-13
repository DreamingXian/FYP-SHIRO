// Integration test: the server must refuse to start without its database
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

function runServer(env, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: path.join(__dirname, '..', '..'),
      env: { ...process.env, ...env }
    });
    let output = '';
    child.stdout.on('data', d => { output += d; });
    child.stderr.on('data', d => { output += d; });
    const timer = setTimeout(() => { child.kill(); resolve({ code: 'TIMEOUT', output }); }, timeoutMs);
    child.on('exit', code => { clearTimeout(timer); resolve({ code, output }); });
  });
}

test('exits with code 1 and a clear message when MySQL is unreachable', async () => {
  const { code, output } = await runServer({
    DB_HOST: '127.0.0.1',
    DB_PORT: '1',          // nothing listens here
    DB_NAME: 'shiro_test',
    HTTP_PORT: '3997',     // never reached; kept away from a running server
    MQTT_PORT: '1887'
  });
  assert.equal(code, 1, `expected exit code 1, got ${code}\n${output}`);
  assert.match(output, /FATAL STARTUP ERROR/);
  assert.match(output, /Could not connect to MySQL/);
  assert.doesNotMatch(output, /Gateway Ready/, 'the server must not report itself ready');
  assert.doesNotMatch(output, /MQTT BROKER\] Listening/, 'the broker must not start');
});
