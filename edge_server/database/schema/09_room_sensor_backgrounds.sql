-- =============================================================================
-- SHIRO Edge Server - Schema 09: the empty room as each LiDAR sees it (Phase 10)
-- "Learn empty room" in the ward editor records about 20 s of a LiDAR's turns
-- while nobody is in the room. Per direction (720 of them, the LiDAR's own
-- directions, so moving it in the editor does not spoil it) the usual distance,
-- the nearest distance and how often there was a return. Returns closer than
-- this are new in the room (people). Tables only, no data.
--   ward_id, device_id   the ward and the enrolled LiDAR node it was learned with
--   model                JSON: { version, bins, turns, coverage_pct, unsteady_pct,
--                                median_mm[720], near_mm[720], hit_pct[720] }
-- Kept by ward and node, not by the sensor's name in the ward, so renaming it
-- or saving the ward again keeps it.
-- =============================================================================

CREATE TABLE IF NOT EXISTS `room_sensor_backgrounds` (
  `ward_id` VARCHAR(32) NOT NULL,
  `device_id` VARCHAR(32) NOT NULL,
  `learned_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `learned_by` VARCHAR(128) NULL,
  `turns` INT NOT NULL,
  `coverage_pct` DECIMAL(4,1) NOT NULL,
  `unsteady_pct` DECIMAL(4,1) NOT NULL,
  `model` MEDIUMTEXT NOT NULL,
  PRIMARY KEY (`ward_id`, `device_id`),
  CONSTRAINT `fk_room_sensor_background_ward` FOREIGN KEY (`ward_id`) REFERENCES `ward_rooms` (`ward_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
