// =============================================================================
// SHIRO Edge Server - Environment Loader
// Loads edge_server/.env into process.env once. Variables already set in the
// real environment take precedence over the file.
// =============================================================================
const path = require('path');

const ENV_PATH = path.join(__dirname, '..', '.env');

if (typeof process.loadEnvFile !== 'function') {
  throw new Error(`Node.js 20.12 or newer is required (found ${process.version}).`);
}

let envFileLoaded = false;
try {
  process.loadEnvFile(ENV_PATH);
  envFileLoaded = true;
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
  console.warn('[CONFIG] edge_server/.env not found. Using built-in defaults. Copy .env.example to .env to configure.');
}

module.exports = { ENV_PATH, envFileLoaded };
