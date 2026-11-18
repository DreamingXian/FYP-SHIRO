// =============================================================================
// SHIRO Edge Server - Password hashing
// scrypt from Node's crypto module: a slow, salted hash, so a copy of the
// clinicians table does not reveal the passwords. Stored form:
//   scrypt$<N>$<r>$<p>$<salt, base64>$<hash, base64>
// =============================================================================
const crypto = require('crypto');

const PARAMS = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 64;
const SALT_BYTES = 16;
const MIN_LENGTH = 10;
const MAX_LENGTH = 128;

function scrypt(password, salt, params) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEY_LENGTH, { ...params, maxmem: 64 * 1024 * 1024 }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

/** Returns a reason the password is not acceptable, or null when it is. */
function passwordProblem(password) {
  if (typeof password !== 'string') return 'A password is required.';
  if (password.length < MIN_LENGTH) return `The password must have at least ${MIN_LENGTH} characters.`;
  if (password.length > MAX_LENGTH) return `The password must have at most ${MAX_LENGTH} characters.`;
  return null;
}

async function hashPassword(password) {
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = await scrypt(password, salt, PARAMS);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), key.toString('base64')].join('$');
}

/** True when the password matches the stored hash. Never throws for a wrong password. */
async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string' || password.length > MAX_LENGTH) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), { N: Number(N), r: Number(r), p: Number(p) });
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

module.exports = { hashPassword, verifyPassword, passwordProblem, MIN_LENGTH };
