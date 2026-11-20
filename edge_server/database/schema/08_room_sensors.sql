-- =============================================================================
-- SHIRO Edge Server - Schema 08: Room sensors (LiDAR) per ward (Phase 10)
-- Where a LiDAR room sensor stands in a ward and which way it points, so its
-- scans can be turned into ward coordinates. Tables only, no data.
--   x, y         centre of the LiDAR, metres from the ward's south-west corner
--   base_height  height of its base above the floor (the laser is 3 cm higher)
--   heading_deg  the direction the triangle on its top points: 0 = north, 90 = east
-- =============================================================================

CREATE TABLE IF NOT EXISTS `ward_room_sensors` (
  `sensor_id` VARCHAR(32) NOT NULL,     -- name in the ward, for example "LiDAR 1"
  `ward_id` VARCHAR(32) NOT NULL,
  `device_id` VARCHAR(32) NULL,         -- the enrolled node (devices.device_id, type ROOM_SENSOR)
  `x` DECIMAL(6,2) NOT NULL,
  `y` DECIMAL(6,2) NOT NULL,
  `base_height` DECIMAL(4,2) NOT NULL DEFAULT 0.92,
  `heading_deg` DECIMAL(5,1) NOT NULL DEFAULT 0.0,
  `wall_location` VARCHAR(64) NULL,
  PRIMARY KEY (`ward_id`, `sensor_id`),
  CONSTRAINT `fk_room_sensor_ward` FOREIGN KEY (`ward_id`) REFERENCES `ward_rooms` (`ward_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
