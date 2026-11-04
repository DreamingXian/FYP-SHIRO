-- =============================================================================
-- SHIRO Central Hospital Database Initialization Script
-- Module: Ward Geometry, Room Boundaries, Obstacles, Beds & Wall Anchors
-- =============================================================================

CREATE DATABASE IF NOT EXISTS `shiro_db` 
CHARACTER SET utf8mb4 
COLLATE utf8mb4_unicode_ci;

USE `shiro_db`;

-- 1. Ward Rooms Table
CREATE TABLE IF NOT EXISTS `ward_rooms` (
    `ward_id` VARCHAR(32) NOT NULL PRIMARY KEY,
    `room_title` VARCHAR(128) NOT NULL,
    `length_x` DECIMAL(6,2) NOT NULL DEFAULT 6.40,
    `width_y` DECIMAL(6,2) NOT NULL DEFAULT 4.80,
    `height_z` DECIMAL(6,2) NOT NULL DEFAULT 2.60,
    `door_x` DECIMAL(6,2) NOT NULL DEFAULT 2.80,
    `door_y` DECIMAL(6,2) NOT NULL DEFAULT 0.00,
    `door_wall` ENUM('SOUTH', 'NORTH', 'EAST', 'WEST') NOT NULL DEFAULT 'SOUTH',
    `door_width` DECIMAL(4,2) NOT NULL DEFAULT 0.90,
    `spatial_anchor_uuid` VARCHAR(64) NULL,
    `layout_type` ENUM('RECTANGLE', 'L_SHAPED', 'POLYGON', 'ISOLATION') NOT NULL DEFAULT 'L_SHAPED',
    `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- 2. Ward Boundary Points Table (for freeform polygon wall contours)
CREATE TABLE IF NOT EXISTS `ward_boundary_points` (
    `point_id` INT AUTO_INCREMENT PRIMARY KEY,
    `ward_id` VARCHAR(32) NOT NULL,
    `vertex_order` INT NOT NULL,
    `x` DECIMAL(6,2) NOT NULL,
    `y` DECIMAL(6,2) NOT NULL,
    FOREIGN KEY (`ward_id`) REFERENCES `ward_rooms`(`ward_id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 3. Ward Obstacles & Cutout Zones Table (Toilets, structural pillars, cupboards, tables)
CREATE TABLE IF NOT EXISTS `ward_obstacles` (
    `obstacle_id` VARCHAR(32) NOT NULL,
    `ward_id` VARCHAR(32) NOT NULL,
    `obstacle_type` ENUM('TOILET', 'PILLAR', 'STORAGE', 'PARTITION', 'CUPBOARD', 'TABLE') NOT NULL DEFAULT 'TOILET',
    `label` VARCHAR(64) NOT NULL,
    `x` DECIMAL(6,2) NOT NULL,
    `y` DECIMAL(6,2) NOT NULL,
    `width` DECIMAL(6,2) NOT NULL,
    `length` DECIMAL(6,2) NOT NULL,
    `height` DECIMAL(4,2) NOT NULL DEFAULT 2.00,
    PRIMARY KEY (`ward_id`, `obstacle_id`),
    FOREIGN KEY (`ward_id`) REFERENCES `ward_rooms`(`ward_id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 4. Ward Hospital Beds Table
-- Note: In Ward Configuration, beds are marked AVAILABLE (in service) or UNAVAILABLE (out of service).
CREATE TABLE IF NOT EXISTS `ward_beds` (
    `bed_id` VARCHAR(32) NOT NULL,
    `ward_id` VARCHAR(32) NOT NULL,
    `bed_code` VARCHAR(32) NOT NULL,
    `x` DECIMAL(6,2) NOT NULL,
    `y` DECIMAL(6,2) NOT NULL,
    `width` DECIMAL(4,2) NOT NULL DEFAULT 0.90,
    `length` DECIMAL(4,2) NOT NULL DEFAULT 2.00,
    `rotation_deg` INT NOT NULL DEFAULT 0,
    `status` ENUM('AVAILABLE', 'UNAVAILABLE', 'OCCUPIED') NOT NULL DEFAULT 'AVAILABLE',
    PRIMARY KEY (`ward_id`, `bed_id`),
    FOREIGN KEY (`ward_id`) REFERENCES `ward_rooms`(`ward_id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 5. Ward Stationary BLE Anchors Table
CREATE TABLE IF NOT EXISTS `ward_anchors` (
    `anchor_id` VARCHAR(32) NOT NULL,
    `ward_id` VARCHAR(32) NOT NULL,
    `device_id` VARCHAR(32) NULL,
    `mac_address` VARCHAR(32) NULL DEFAULT '',
    `x` DECIMAL(6,2) NOT NULL,
    `y` DECIMAL(6,2) NOT NULL,
    `z` DECIMAL(4,2) NOT NULL DEFAULT 1.80,
    `wall_location` VARCHAR(64) NULL,
    `status` ENUM('ONLINE', 'STANDBY', 'OFFLINE') NOT NULL DEFAULT 'STANDBY',
    `last_seen` TIMESTAMP NULL DEFAULT NULL,
    PRIMARY KEY (`ward_id`, `anchor_id`),
    FOREIGN KEY (`ward_id`) REFERENCES `ward_rooms`(`ward_id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- =============================================================================
-- SEED INITIAL SAMPLE DATA (Standardized IDs: WARD-001, WARD-002, WARD-003)
-- =============================================================================

-- Room WARD-001 (Acute Care Ward with Ensuite Bathroom)
INSERT INTO `ward_rooms` (`ward_id`, `room_title`, `length_x`, `width_y`, `height_z`, `door_x`, `door_y`, `door_wall`, `door_width`, `spatial_anchor_uuid`, `layout_type`)
VALUES ('WARD-001', 'Acute Care Ward 001', 6.40, 4.80, 2.60, 2.80, 0.00, 'SOUTH', 0.90, 'a1b2c3d4-e5f6-7890-abcd-ef0123456789', 'L_SHAPED')
ON DUPLICATE KEY UPDATE `room_title`=VALUES(`room_title`), `length_x`=VALUES(`length_x`), `width_y`=VALUES(`width_y`), `door_x`=VALUES(`door_x`);

-- Ensuite Toilet Cutout in WARD-001
INSERT INTO `ward_obstacles` (`obstacle_id`, `ward_id`, `obstacle_type`, `label`, `x`, `y`, `width`, `length`)
VALUES ('OBS-001-01', 'WARD-001', 'TOILET', 'Ensuite Bathroom 001', 0.00, 3.20, 1.80, 1.60)
ON DUPLICATE KEY UPDATE `label`=VALUES(`label`), `x`=VALUES(`x`), `y`=VALUES(`y`), `width`=VALUES(`width`), `length`=VALUES(`length`);

-- Beds in WARD-001 (Coordinates measured from bottom-left corner of each bed)
INSERT INTO `ward_beds` (`bed_id`, `ward_id`, `bed_code`, `x`, `y`, `width`, `length`, `status`)
VALUES 
    ('BED-001-01', 'WARD-001', 'Bed 1', 0.80, 2.20, 0.90, 2.00, 'AVAILABLE'),
    ('BED-001-02', 'WARD-001', 'Bed 2', 0.80, 0.40, 0.90, 2.00, 'AVAILABLE'),
    ('BED-001-03', 'WARD-001', 'Bed 3', 4.70, 2.20, 0.90, 2.00, 'AVAILABLE'),
    ('BED-001-04', 'WARD-001', 'Bed 4', 4.70, 0.40, 0.90, 2.00, 'UNAVAILABLE')
ON DUPLICATE KEY UPDATE `x`=VALUES(`x`), `y`=VALUES(`y`), `status`=VALUES(`status`);

-- Anchors in WARD-001
INSERT INTO `ward_anchors` (`anchor_id`, `ward_id`, `mac_address`, `x`, `y`, `z`, `wall_location`, `status`)
VALUES 
    ('anchor-A', 'WARD-001', 'C4:DE:E2:10:01:AB', 0.50, 4.30, 1.80, 'North-West Wall', 'ONLINE'),
    ('anchor-B', 'WARD-001', 'C4:DE:E2:10:01:AC', 5.90, 4.30, 1.80, 'North-East Wall', 'STANDBY'),
    ('anchor-C', 'WARD-001', 'C4:DE:E2:10:01:AD', 3.20, 0.50, 1.80, 'South Entrance Wall', 'STANDBY')
ON DUPLICATE KEY UPDATE `x`=VALUES(`x`), `y`=VALUES(`y`), `z`=VALUES(`z`), `status`=VALUES(`status`);

-- Room WARD-002 (Standard 4-Bed Open Bay Ward)
INSERT INTO `ward_rooms` (`ward_id`, `room_title`, `length_x`, `width_y`, `height_z`, `door_x`, `door_y`, `door_wall`, `door_width`, `spatial_anchor_uuid`, `layout_type`)
VALUES ('WARD-002', 'Standard Open Bay Ward 002', 7.20, 5.00, 2.60, 3.20, 0.00, 'SOUTH', 1.00, 'c3d4e5f6-a7b8-9012-cdef-ab0123456789', 'RECTANGLE')
ON DUPLICATE KEY UPDATE `room_title`=VALUES(`room_title`), `length_x`=VALUES(`length_x`), `width_y`=VALUES(`width_y`);

-- Beds in WARD-002
INSERT INTO `ward_beds` (`bed_id`, `ward_id`, `bed_code`, `x`, `y`, `width`, `length`, `status`)
VALUES 
    ('BED-002-01', 'WARD-002', 'Bed 1', 1.00, 2.60, 0.90, 2.00, 'AVAILABLE'),
    ('BED-002-02', 'WARD-002', 'Bed 2', 1.00, 0.40, 0.90, 2.00, 'AVAILABLE'),
    ('BED-002-03', 'WARD-002', 'Bed 3', 5.30, 2.60, 0.90, 2.00, 'AVAILABLE'),
    ('BED-002-04', 'WARD-002', 'Bed 4', 5.30, 0.40, 0.90, 2.00, 'AVAILABLE')
ON DUPLICATE KEY UPDATE `x`=VALUES(`x`), `y`=VALUES(`y`), `status`=VALUES(`status`);

-- Anchors in WARD-002
INSERT INTO `ward_anchors` (`anchor_id`, `ward_id`, `mac_address`, `x`, `y`, `z`, `wall_location`, `status`)
VALUES 
    ('anchor-A', 'WARD-002', 'C4:DE:E2:10:02:BA', 0.50, 4.50, 1.80, 'North-West Wall', 'ONLINE'),
    ('anchor-B', 'WARD-002', 'C4:DE:E2:10:02:BB', 6.70, 4.50, 1.80, 'North-East Wall', 'STANDBY'),
    ('anchor-C', 'WARD-002', 'C4:DE:E2:10:02:BC', 3.60, 0.50, 1.80, 'South Wall', 'STANDBY')
ON DUPLICATE KEY UPDATE `x`=VALUES(`x`), `y`=VALUES(`y`), `z`=VALUES(`z`), `status`=VALUES(`status`);

-- Room WARD-003 (2-Bed Isolation Room)
INSERT INTO `ward_rooms` (`ward_id`, `room_title`, `length_x`, `width_y`, `height_z`, `door_x`, `door_y`, `door_wall`, `door_width`, `spatial_anchor_uuid`, `layout_type`)
VALUES ('WARD-003', 'Isolation Ward 003', 4.80, 4.00, 2.60, 2.00, 0.00, 'SOUTH', 0.90, 'b2c3d4e5-f6a7-8901-bcde-fa0123456789', 'ISOLATION')
ON DUPLICATE KEY UPDATE `room_title`=VALUES(`room_title`), `length_x`=VALUES(`length_x`), `width_y`=VALUES(`width_y`);

-- Ensuite Airlock in WARD-003
INSERT INTO `ward_obstacles` (`obstacle_id`, `ward_id`, `obstacle_type`, `label`, `x`, `y`, `width`, `length`)
VALUES ('OBS-003-01', 'WARD-003', 'TOILET', 'Ensuite Sanitization Airlock', 0.00, 2.40, 1.60, 1.60)
ON DUPLICATE KEY UPDATE `label`=VALUES(`label`), `x`=VALUES(`x`), `y`=VALUES(`y`), `width`=VALUES(`width`), `length`=VALUES(`length`);

-- Beds in WARD-003
INSERT INTO `ward_beds` (`bed_id`, `ward_id`, `bed_code`, `x`, `y`, `width`, `length`, `status`)
VALUES 
    ('BED-003-01', 'WARD-003', 'Bed 1', 0.80, 0.50, 0.90, 2.00, 'AVAILABLE'),
    ('BED-003-02', 'WARD-003', 'Bed 2', 3.10, 1.50, 0.90, 2.00, 'AVAILABLE')
ON DUPLICATE KEY UPDATE `x`=VALUES(`x`), `y`=VALUES(`y`), `status`=VALUES(`status`);

-- Anchors in WARD-003
INSERT INTO `ward_anchors` (`anchor_id`, `ward_id`, `mac_address`, `x`, `y`, `z`, `wall_location`, `status`)
VALUES 
    ('anchor-A', 'WARD-003', 'C4:DE:E2:10:03:AA', 0.40, 3.60, 1.80, 'North-West Wall', 'ONLINE'),
    ('anchor-B', 'WARD-003', 'C4:DE:E2:10:03:AB', 4.40, 3.60, 1.80, 'North-East Wall', 'STANDBY'),
    ('anchor-C', 'WARD-003', 'C4:DE:E2:10:03:AC', 2.40, 0.40, 1.80, 'South Entrance Wall', 'STANDBY')
ON DUPLICATE KEY UPDATE `x`=VALUES(`x`), `y`=VALUES(`y`), `z`=VALUES(`z`), `status`=VALUES(`status`);
