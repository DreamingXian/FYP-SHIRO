-- =============================================================================
-- SHIRO Edge Server - Schema 01: Ward Geometry
-- Rooms, boundary points, obstacles, beds and wall anchors. Tables only, no data.
-- =============================================================================

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
    `calibrated_a` DECIMAL(5,2) NULL DEFAULT NULL,
    `calibrated_n` DECIMAL(4,2) NULL DEFAULT NULL,
    `last_calibrated_at` TIMESTAMP NULL DEFAULT NULL,
    `wall_location` VARCHAR(64) NULL,
    `status` ENUM('ONLINE', 'STANDBY', 'OFFLINE') NOT NULL DEFAULT 'STANDBY',
    `last_seen` TIMESTAMP NULL DEFAULT NULL,
    PRIMARY KEY (`ward_id`, `anchor_id`),
    FOREIGN KEY (`ward_id`) REFERENCES `ward_rooms`(`ward_id`) ON DELETE CASCADE
) ENGINE=InnoDB;
