// =============================================================================
// Ward Spatial Configuration Service (MySQL CRUD Operations)
// =============================================================================
const { getPool } = require('../database/db');
const fs = require('fs');
const path = require('path');
const ipsService = require('./ips_service');
const { getCalibration } = require('./kalman_filter');

const WARD_TEMPLATES = {
  'L_SHAPED': {
    template_id: 'L_SHAPED',
    title: 'Acute Ward with Ensuite Bathroom',
    description: '6.4m x 4.8m room with enclosed 1.8m x 1.6m bathroom in North-West corner and 4 beds.',
    dimensions: { length_x: 6.40, width_y: 4.80, height_z: 2.60 },
    door: { wall: 'SOUTH', x: 2.80, y: 0.00, width: 0.90 },
    obstacles: [
      { id: 'OBS-A1-01', type: 'TOILET', label: 'Ensuite Bathroom A1', x: 0.00, y: 3.20, width: 1.80, length: 1.60 }
    ],
    beds: [
      { bed_id: 'BED-A1-01', bed_code: 'Bed 1', x: 0.80, y: 2.20, width: 0.90, length: 2.00, status: 'AVAILABLE' },
      { bed_id: 'BED-A1-02', bed_code: 'Bed 2', x: 0.80, y: 0.40, width: 0.90, length: 2.00, status: 'AVAILABLE' },
      { bed_id: 'BED-A1-03', bed_code: 'Bed 3', x: 4.70, y: 2.20, width: 0.90, length: 2.00, status: 'AVAILABLE' },
      { bed_id: 'BED-A1-04', bed_code: 'Bed 4', x: 4.70, y: 0.40, width: 0.90, length: 2.00, status: 'UNAVAILABLE' }
    ],
    anchors: [
      { anchor_id: 'Anchor A', device_id: null, mac_address: '', x: 0.50, y: 4.30, z: 1.80, wall_location: 'North-West Wall', status: 'STANDBY' },
      { anchor_id: 'Anchor B', device_id: null, mac_address: '', x: 5.90, y: 4.30, z: 1.80, wall_location: 'North-East Wall', status: 'STANDBY' },
      { anchor_id: 'Anchor C', device_id: null, mac_address: '', x: 2.80, y: 0.50, z: 1.80, wall_location: 'South Wall', status: 'STANDBY' }
    ]
  },
  'RECTANGLE': {
    template_id: 'RECTANGLE',
    title: 'Standard 4-Bed Open Bay Ward',
    description: '6.4m x 4.8m open rectangular ward without internal obstacle blocks.',
    dimensions: { length_x: 6.40, width_y: 4.80, height_z: 2.60 },
    door: { wall: 'SOUTH', x: 2.80, y: 0.00, width: 0.90 },
    obstacles: [],
    beds: [
      { bed_id: 'BED-A1-01', bed_code: 'Bed 1', x: 0.80, y: 2.40, width: 0.90, length: 2.00, status: 'AVAILABLE' },
      { bed_id: 'BED-A1-02', bed_code: 'Bed 2', x: 0.80, y: 0.40, width: 0.90, length: 2.00, status: 'AVAILABLE' },
      { bed_id: 'BED-A1-03', bed_code: 'Bed 3', x: 4.70, y: 2.40, width: 0.90, length: 2.00, status: 'AVAILABLE' },
      { bed_id: 'BED-A1-04', bed_code: 'Bed 4', x: 4.70, y: 0.40, width: 0.90, length: 2.00, status: 'AVAILABLE' }
    ],
    anchors: [
      { anchor_id: 'Anchor A', device_id: null, mac_address: '', x: 0.50, y: 4.30, z: 1.80, wall_location: 'North-West Wall', status: 'STANDBY' },
      { anchor_id: 'Anchor B', device_id: null, mac_address: '', x: 5.90, y: 4.30, z: 1.80, wall_location: 'North-East Wall', status: 'STANDBY' },
      { anchor_id: 'Anchor C', device_id: null, mac_address: '', x: 2.80, y: 0.50, z: 1.80, wall_location: 'South Wall', status: 'STANDBY' }
    ]
  },
  'ISOLATION': {
    template_id: 'ISOLATION',
    title: '2-Bed Isolation / Negative Pressure Ward',
    description: '4.8m x 4.0m compact isolation room with 2 beds and ensuite sanitization airlock.',
    dimensions: { length_x: 4.80, width_y: 4.00, height_z: 2.60 },
    door: { wall: 'SOUTH', x: 2.00, y: 0.00, width: 0.90 },
    obstacles: [
      { id: 'OBS-A1-01', type: 'TOILET', label: 'Ensuite Bathroom', x: 0.00, y: 2.40, width: 1.60, length: 1.60 }
    ],
    beds: [
      { bed_id: 'BED-ISO-01', bed_code: 'Bed 1', x: 0.80, y: 0.50, width: 0.90, length: 2.00, status: 'AVAILABLE' },
      { bed_id: 'BED-ISO-02', bed_code: 'Bed 2', x: 3.10, y: 1.50, width: 0.90, length: 2.00, status: 'AVAILABLE' }
    ],
    anchors: [
      { anchor_id: 'Anchor A', device_id: null, mac_address: '', x: 0.40, y: 3.60, z: 1.80, wall_location: 'North-West Wall', status: 'STANDBY' },
      { anchor_id: 'Anchor B', device_id: null, mac_address: '', x: 4.40, y: 3.60, z: 1.80, wall_location: 'North-East Wall', status: 'STANDBY' },
      { anchor_id: 'Anchor C', device_id: null, mac_address: '', x: 2.40, y: 0.40, z: 1.80, wall_location: 'South Wall', status: 'STANDBY' }
    ]
  }
};

/**
 * Retrieve complete ward configuration from MySQL
 */
async function getWardConfig(wardId = 'WARD-001') {
  const pool = getPool();

  // 1. Fetch Room Metadata
  const [rooms] = await pool.query('SELECT * FROM ward_rooms WHERE ward_id = ?', [wardId]);
  if (!rooms || rooms.length === 0) {
    return null;
  }
  const room = rooms[0];

  // 2. Fetch Obstacles (Toilets, pillars, cupboards, tables)
  const [obstacles] = await pool.query(
    'SELECT obstacle_id, obstacle_type, label, x, y, width, length, height FROM ward_obstacles WHERE ward_id = ?',
    [wardId]
  );

  // 3. Fetch Beds
  const [beds] = await pool.query(
    'SELECT bed_id, bed_code, x, y, width, length, rotation_deg, status FROM ward_beds WHERE ward_id = ? ORDER BY bed_code ASC',
    [wardId]
  );

  // 4. Fetch Stationary Anchors with live device telemetry status
  const [anchors] = await pool.query(
    `SELECT 
       wa.anchor_id, wa.device_id, wa.mac_address, wa.x, wa.y, wa.z, wa.wall_location, wa.status,
       d.status AS live_device_status, d.mac_address AS dev_mac
     FROM ward_anchors wa
     LEFT JOIN devices d ON wa.device_id = d.device_id
     WHERE wa.ward_id = ? 
     ORDER BY wa.anchor_id ASC`,
    [wardId]
  );

  // Assemble clean response
  return {
    ward_id: room.ward_id,
    room_title: room.room_title,
    length_x: parseFloat(room.length_x),
    width_y: parseFloat(room.width_y),
    height_z: parseFloat(room.height_z),
    door: {
      wall: room.door_wall,
      x: parseFloat(room.door_x),
      y: parseFloat(room.door_y),
      width: parseFloat(room.door_width || 0.90)
    },
    spatial_anchor_uuid: room.spatial_anchor_uuid || '',
    layout_type: room.layout_type,
    updated_at: room.updated_at,
    obstacles: obstacles.map(o => ({
      id: o.obstacle_id,
      type: o.obstacle_type,
      label: o.label,
      x: parseFloat(o.x),
      y: parseFloat(o.y),
      width: parseFloat(o.width),
      length: parseFloat(o.length),
      height: parseFloat(o.height !== null && o.height !== undefined ? o.height : (o.obstacle_type === 'TABLE' ? 0.75 : 2.00))
    })),
    beds: beds.map(b => ({
      bed_id: b.bed_id,
      bed_code: b.bed_code,
      x: parseFloat(b.x),
      y: parseFloat(b.y),
      width: parseFloat(b.width),
      length: parseFloat(b.length),
      rotation_deg: parseInt(b.rotation_deg, 10) || 0,
      status: b.status === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'AVAILABLE'
    })),
    anchors: anchors.map(a => ({
      anchor_id: a.anchor_id,
      device_id: a.device_id || null,
      mac_address: a.mac_address || a.dev_mac || '',
      x: parseFloat(a.x),
      y: parseFloat(a.y),
      z: parseFloat(a.z),
      wall_location: a.wall_location || '',
      status: a.device_id ? (a.live_device_status || a.status || 'OFFLINE') : 'STANDBY'
    }))
  };
}

/**
 * Save / Replace complete ward configuration in MySQL atomically using a transaction
 */
async function saveWardConfig(data) {
  const pool = getPool();
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const wardId = data.ward_id || 'WARD-001';
    const title = data.room_title || 'Acute Care Ward 001';
    const lenX = parseFloat(data.length_x) || 6.40;
    const widY = parseFloat(data.width_y) || 4.80;
    const heiZ = parseFloat(data.height_z) || 2.60;
    const doorWall = data.door?.wall || 'SOUTH';
    const doorX = parseFloat(data.door?.x ?? 2.80);
    const doorY = parseFloat(data.door?.y ?? 0.00);
    const doorW = parseFloat(data.door?.width ?? 0.90);
    const uuid = data.spatial_anchor_uuid || '';
    const layoutType = data.layout_type || 'L_SHAPED';

    // 1. Upsert ward_rooms
    const roomSql = `
      INSERT INTO ward_rooms (ward_id, room_title, length_x, width_y, height_z, door_x, door_y, door_wall, door_width, spatial_anchor_uuid, layout_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        room_title = VALUES(room_title),
        length_x = VALUES(length_x),
        width_y = VALUES(width_y),
        height_z = VALUES(height_z),
        door_x = VALUES(door_x),
        door_y = VALUES(door_y),
        door_wall = VALUES(door_wall),
        door_width = VALUES(door_width),
        spatial_anchor_uuid = VALUES(spatial_anchor_uuid),
        layout_type = VALUES(layout_type),
        updated_at = CURRENT_TIMESTAMP
    `;
    await conn.query(roomSql, [wardId, title, lenX, widY, heiZ, doorX, doorY, doorWall, doorW, uuid, layoutType]);

    // 2. Replace Obstacles
    await conn.query('DELETE FROM ward_obstacles WHERE ward_id = ?', [wardId]);
    if (Array.isArray(data.obstacles) && data.obstacles.length > 0) {
      for (let i = 0; i < data.obstacles.length; i++) {
        const obs = data.obstacles[i];
        const obsId = obs.id || `OBS-${wardId}-${i + 1}`;
        const obsType = obs.type || 'TOILET';
        const defaultH = obsType === 'TABLE' ? 0.75 : (obsType === 'TOILET' ? 2.60 : 2.00);
        const obsHeight = obs.height !== undefined ? parseFloat(obs.height) : defaultH;
        await conn.query(
          'INSERT INTO ward_obstacles (obstacle_id, ward_id, obstacle_type, label, x, y, width, length, height) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [obsId, wardId, obsType, obs.label || 'Obstacle', obs.x || 0, obs.y || 0, obs.width || 1, obs.length || 1, obsHeight]
        );
      }
    }

    // 3. Replace Beds (using bottom-left coordinates)
    await conn.query('DELETE FROM ward_beds WHERE ward_id = ?', [wardId]);
    if (Array.isArray(data.beds) && data.beds.length > 0) {
      for (let i = 0; i < data.beds.length; i++) {
        const b = data.beds[i];
        const bId = b.bed_id || `BED-${wardId}-${String(i + 1).padStart(2, '0')}`;
        const bCode = b.bed_code || `Bed ${i + 1}`;
        const bStatus = b.status === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'AVAILABLE';
        await conn.query(
          'INSERT INTO ward_beds (bed_id, ward_id, bed_code, x, y, width, length, rotation_deg, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [bId, wardId, bCode, b.x || 0, b.y || 0, b.width || 0.90, b.length || 2.00, b.rotation_deg || 0, bStatus]
        );
      }
    }

    // 4. Replace Anchors
    // First, unbind any existing devices previously assigned to this ward
    await conn.query("UPDATE devices SET assigned_ward_id = NULL, availability_status = 'AVAILABLE' WHERE assigned_ward_id = ?", [wardId]);

    await conn.query('DELETE FROM ward_anchors WHERE ward_id = ?', [wardId]);
    if (Array.isArray(data.anchors) && data.anchors.length > 0) {
      for (let i = 0; i < data.anchors.length; i++) {
        const a = data.anchors[i];
        const aId = a.anchor_id || `Anchor ${String.fromCharCode(65 + i)}`;
        const devId = a.device_id && typeof a.device_id === 'string' && a.device_id.trim() !== '' ? a.device_id.trim() : null;
        let mac = a.mac_address || '';
        let status = 'STANDBY';

        if (devId) {
          // If assigned to a device, query its current MAC and live status
          const [devRows] = await conn.query('SELECT mac_address, status FROM devices WHERE device_id = ?', [devId]);
          if (devRows && devRows.length > 0) {
            mac = devRows[0].mac_address || mac;
            status = devRows[0].status || 'OFFLINE';
          }
          // Mark this device as IN_USE and bound to this ward
          await conn.query(
            "UPDATE devices SET assigned_ward_id = ?, availability_status = 'IN_USE' WHERE device_id = ?",
            [wardId, devId]
          );
        }

        await conn.query(
          'INSERT INTO ward_anchors (anchor_id, ward_id, device_id, mac_address, x, y, z, wall_location, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [aId, wardId, devId, mac, a.x || 0, a.y || 0, a.z || 1.80, a.wall_location || '', status]
        );
      }
    }

    await conn.commit();
    // Refresh IPS engine anchor coordinates cache
    ipsService.reloadWardAnchorsCache().catch(err => {
      console.warn('[WARD SERVICE] Error refreshing IPS cache:', err.message);
    });
    return { success: true, ward_id: wardId };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Retrieve list of all wards in MySQL with aggregated statistics
 */
async function getAllWards() {
  const pool = getPool();
  const sql = `
    SELECT 
      r.ward_id, r.room_title, r.length_x, r.width_y, r.height_z,
      r.door_wall, r.door_x, r.door_width, r.spatial_anchor_uuid, r.layout_type, r.updated_at,
      (SELECT COUNT(*) FROM ward_beds b WHERE b.ward_id = r.ward_id) AS bed_count,
      (SELECT COUNT(*) FROM ward_anchors a WHERE a.ward_id = r.ward_id) AS anchor_count,
      (SELECT COUNT(*) FROM ward_anchors a WHERE a.ward_id = r.ward_id AND a.device_id IS NOT NULL AND a.device_id != '') AS assigned_anchor_count,
      (SELECT COUNT(*) FROM ward_obstacles o WHERE o.ward_id = r.ward_id) AS obstacle_count
    FROM ward_rooms r
    ORDER BY r.ward_id ASC;
  `;
  const [rows] = await pool.query(sql);
  return rows.map(r => ({
    ward_id: r.ward_id,
    room_title: r.room_title,
    length_x: parseFloat(r.length_x),
    width_y: parseFloat(r.width_y),
    height_z: parseFloat(r.height_z),
    door_wall: r.door_wall,
    door_x: parseFloat(r.door_x),
    door_width: parseFloat(r.door_width),
    spatial_anchor_uuid: r.spatial_anchor_uuid || '',
    layout_type: r.layout_type,
    updated_at: r.updated_at,
    bed_count: parseInt(r.bed_count, 10) || 0,
    anchor_count: parseInt(r.anchor_count, 10) || 0,
    assigned_anchor_count: parseInt(r.assigned_anchor_count, 10) || 0,
    obstacle_count: parseInt(r.obstacle_count, 10) || 0
  }));
}

/**
 * Delete a ward and its associated beds, obstacles, anchors (cascades)
 * Also releases any devices assigned to this ward back to AVAILABLE status.
 */
async function deleteWard(wardId) {
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("UPDATE devices SET assigned_ward_id = NULL, availability_status = 'AVAILABLE' WHERE assigned_ward_id = ?", [wardId]);
    await conn.query('DELETE FROM ward_rooms WHERE ward_id = ?', [wardId]);
    await conn.commit();
    return { success: true, ward_id: wardId };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Reset ward to default initial SQL script state
 */
async function resetDefaultWard() {
  const pool = getPool();
  const sqlPath = path.join(__dirname, '..', 'database', 'init_ward_config.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  await pool.query(sql);
  return getWardConfig('WARD-001');
}

/**
 * Retrieve complete data needed to initialize the Live 2D IPS Map:
 * - Ward geometry, obstacles, beds, and assigned wall anchors with coordinates
 * - Active patient bindings and devices in this ward
 * - Active calibration parameters
 */
async function getWardIpsData(wardId) {
  const ward = await getWardConfig(wardId);
  if (!ward) return null;

  const pool = getPool();
  // Fetch all active bindings with joined patient and device telemetry details
  const [bindings] = await pool.query(`
    SELECT 
      pb.binding_id, pb.patient_id, pb.device_id, pb.status AS binding_status,
      p.full_name, p.nric_passport, p.gender, p.dob, p.assigned_bed_id, p.assigned_ward_id,
      p.medical_history, p.photo_url, p.status AS patient_status,
      d.mac_address, d.device_type, d.status AS device_status, d.battery_level, d.firmware_version
    FROM patient_bindings pb
    JOIN patients p ON pb.patient_id = p.patient_id
    JOIN devices d ON pb.device_id = d.device_id
    WHERE pb.status = 'ACTIVE'
  `);

  return {
    ward,
    tracked_subjects: bindings.map(b => ({
      binding_id: b.binding_id,
      patient_id: b.patient_id,
      full_name: b.full_name,
      nric_passport: b.nric_passport,
      gender: b.gender,
      dob: b.dob,
      assigned_bed_id: b.assigned_bed_id,
      assigned_ward_id: b.assigned_ward_id,
      is_ward_resident: (b.assigned_ward_id === wardId),
      medical_history: b.medical_history,
      photo_url: b.photo_url,
      patient_status: b.patient_status,
      device_id: b.device_id,
      mac_address: b.mac_address,
      device_status: b.device_status,
      battery_level: b.battery_level,
      firmware_version: b.firmware_version
    })),
    calibration: getCalibration()
  };
}

module.exports = {
  getAllWards,
  getWardConfig,
  saveWardConfig,
  deleteWard,
  resetDefaultWard,
  getWardIpsData,
  WARD_TEMPLATES
};

