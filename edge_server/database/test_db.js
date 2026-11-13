// =============================================================================
// Database Verification Script: Tests MySQL Connection & Inspects Tables
// =============================================================================
const { initDatabase, getPool } = require('./db');

async function main() {
  console.log('========================================================');
  console.log('  SHIRO MySQL Database Initialization & Verification');
  console.log('========================================================\n');

  try {
    await initDatabase();
  } catch (err) {
    console.error('[DATABASE ERROR]', err.message);
    console.log('\n[X] Initialization aborted. Please start MySQL in XAMPP Control Panel and try again.');
    process.exit(1);
  }

  const pool = getPool();

  console.log('\n--- 1. Ward Rooms in Database ---');
  const [rooms] = await pool.query('SELECT ward_id, room_title, length_x, width_y, height_z, spatial_anchor_uuid, layout_type FROM ward_rooms');
  console.table(rooms);

  console.log('\n--- 2. Ward Obstacles / Cutout Zones (Toilets) ---');
  const [obstacles] = await pool.query('SELECT obstacle_id, ward_id, obstacle_type, label, x, y, width, length FROM ward_obstacles');
  console.table(obstacles);

  console.log('\n--- 3. Hospital Beds in Ward ---');
  const [beds] = await pool.query('SELECT bed_id, ward_id, bed_code, x, y, width, length, status FROM ward_beds');
  console.table(beds);

  console.log('\n--- 4. Stationary BLE Anchors in Ward ---');
  const [anchors] = await pool.query('SELECT anchor_id, ward_id, mac_address, x, y, z, wall_location, status FROM ward_anchors');
  console.table(anchors);

  console.log('\n[OK] Database verification completed successfully! Everything is ready.');
  process.exit(0);
}

main().catch(err => {
  console.error('[FATAL ERROR]:', err);
  process.exit(1);
});

