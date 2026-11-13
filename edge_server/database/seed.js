// =============================================================================
// Manual seed command:  npm run db:seed  [-- --force]
// Loads the sample wards and patients. Refuses to touch a database that already
// holds data unless --force is given, because the sample ward layout
// (WARD-001 to WARD-003) would be restored over any edits.
// =============================================================================
const { initDatabase, applySeed, isDatabaseEmpty, closePool, dbConfig } = require('./db');

async function main() {
  const force = process.argv.includes('--force');
  await initDatabase(); // creates tables; seeds automatically when empty

  if (await isDatabaseEmpty()) {
    await applySeed();
    console.log(`[DB SEED] Sample data loaded into "${dbConfig.database}".`);
  } else if (force) {
    await applySeed();
    console.log(`[DB SEED] --force: sample wards restored in "${dbConfig.database}". Existing patients were not overwritten.`);
  } else {
    console.log(`[DB SEED] "${dbConfig.database}" already contains data. Nothing changed.`);
    console.log('[DB SEED] Use "npm run db:seed -- --force" to restore the sample ward layout over your edits.');
  }
}

main()
  .then(() => closePool())
  .catch(async (err) => {
    console.error('[DB SEED ERROR]', err.message);
    await closePool().catch(() => {});
    process.exit(1);
  });
