// =============================================================================
// SHIRO Edge Server - Reset a clinician's password from the server PC
// For when nobody can sign in as admin any more (forgotten password).
// Whoever can run this can read the database anyway (docs/security.md).
//
//   cd edge_server
//   node tools/reset_password.js <username>
//
// Asks for the new password twice, ends every session of that account and
// unlocks it. The password is never shown on the screen or written to a log.
// =============================================================================
const readline = require('readline');
const logger = require('../utils/logger');

// One reader for every question. Lines are queued, so input that arrives
// before a question is asked (pasted or piped) is not lost.
let reader = null;
const pendingLines = [];
const waiting = [];

/** In a terminal: read one line without showing what is typed. */
function askHiddenInTerminal(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let answer = '';
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\u0003') { // Ctrl+C
          stdin.setRawMode(false);
          process.stdout.write('\n');
          process.exit(130);
        } else if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(answer);
          return;
        } else if (ch === '\u0008' || ch === '\u007f') { // Backspace
          answer = answer.slice(0, -1);
        } else if (ch >= ' ') {
          answer += ch;
        }
      }
    };
    stdin.on('data', onData);
  });
}

function askHidden(question) {
  if (process.stdin.isTTY) return askHiddenInTerminal(question);
  if (!reader) {
    reader = readline.createInterface({ input: process.stdin, terminal: false });
    reader.on('line', (line) => {
      const next = waiting.shift();
      if (next) next(line);
      else pendingLines.push(line);
    });
  }
  // The question is printed; what is typed is not echoed by this script
  process.stdout.write(question);
  return new Promise((resolve) => {
    const done = (answer) => { process.stdout.write('\n'); resolve(answer); };
    if (pendingLines.length > 0) done(pendingLines.shift());
    else waiting.push(done);
  });
}

function closeReader() {
  if (reader) reader.close();
}

async function main() {
  const username = (process.argv[2] || '').trim().toLowerCase();
  if (!username) {
    console.log('Usage: node tools/reset_password.js <username>');
    process.exit(2);
  }

  const { getPool, closePool, dbConfig } = require('../database/db');
  const authService = require('../services/auth/auth_service');
  const audit = require('../services/audit_service');

  const [rows] = await getPool().query('SELECT clinician_id, full_name, role, is_active FROM clinicians WHERE username = ?', [username]);
  if (rows.length === 0) {
    console.log(`No account "${username}" in database "${dbConfig.database}".`);
    await closePool();
    process.exit(1);
  }
  const c = rows[0];
  console.log(`Account ${c.clinician_id}: ${c.full_name} (${c.role}${Number(c.is_active) ? '' : ', deactivated'}) in "${dbConfig.database}".`);

  const first = await askHidden('New password (at least 10 characters): ');
  const second = await askHidden('Repeat the new password: ');
  closeReader();
  if (first !== second) {
    console.log('The two passwords are not the same. Nothing was changed.');
    await closePool();
    process.exit(1);
  }

  try {
    await authService.resetPassword(c.clinician_id, first);
  } catch (err) {
    console.log(`Not changed: ${err.message}`);
    await closePool();
    process.exit(1);
  }
  await audit.record({ action: 'PASSWORD_RESET_ON_SERVER', targetType: 'CLINICIAN', targetId: c.clinician_id, ip: 'server console' });
  console.log(`Password of ${c.clinician_id} changed. Every session of this account has ended.`);
  if (!Number(c.is_active)) console.log('The account is still deactivated: an admin can activate it on the ADMIN tab.');
  await closePool();
}

main().catch((err) => {
  logger.error('[RESET PASSWORD] Failed:', err.message);
  process.exit(1);
});
