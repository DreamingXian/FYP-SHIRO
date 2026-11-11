-- =============================================================================
-- SHIRO Central Hospital Database Initialization Script
-- Module: Hardware Device Registry (Wristbands, Anchors, Headsets)
-- =============================================================================

USE `shiro_db`;

-- 1. Create Devices Table
CREATE TABLE IF NOT EXISTS `devices` (
    `device_id` VARCHAR(32) NOT NULL PRIMARY KEY,
    `mac_address` VARCHAR(32) NOT NULL UNIQUE,
    `device_type` ENUM('WRISTBAND', 'ANCHOR', 'HEADSET') NOT NULL,
    `hardware_model` VARCHAR(64) NOT NULL DEFAULT 'ESP32',
    `firmware_version` VARCHAR(32) DEFAULT 'v1.0.0',
    `ip_address` VARCHAR(45) NULL,
    `assigned_ward_id` VARCHAR(32) NULL,
    `battery_level` INT NULL,
    `status` ENUM('ONLINE', 'STANDBY', 'OFFLINE', 'CHARGING') DEFAULT 'STANDBY',
    `availability_status` ENUM('AVAILABLE', 'IN_USE', 'UNAVAILABLE', 'MAINTENANCE') DEFAULT 'AVAILABLE',
    `last_seen` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX `idx_device_type` (`device_type`),
    INDEX `idx_device_status` (`status`),
    INDEX `idx_device_ward` (`assigned_ward_id`),
    CONSTRAINT `fk_device_ward` FOREIGN KEY (`assigned_ward_id`) 
        REFERENCES `ward_rooms`(`ward_id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- (No mock seed data: hardware nodes are discovered live via MQTT / BLE radar)

