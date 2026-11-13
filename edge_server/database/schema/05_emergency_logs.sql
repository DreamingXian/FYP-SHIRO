-- =============================================================================
-- SHIRO Edge Server - Schema 05: Emergency Incident and Fall Audit Log (Table 4.13)
-- Requires the patients table.
-- =============================================================================

CREATE TABLE IF NOT EXISTS `emergency_incident_logs` (
    `incident_id` VARCHAR(50) NOT NULL,
    `patient_id` VARCHAR(32) NULL,
    `patient_name` VARCHAR(128) NULL,
    `wristband_mac` VARCHAR(32) NULL,
    `ward_id` VARCHAR(32) NULL,
    `bed_id` VARCHAR(32) NULL,
    `incident_category` ENUM('FALL_ACCIDENT', 'CRITICAL_VITALS', 'GEOFENCE_BREACH') NOT NULL,
    `trigger_timestamp` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    `pos_x` FLOAT NULL,
    `pos_y` FLOAT NULL,
    `kinematic_impact_force` FLOAT NULL,
    `post_impact_stillness` FLOAT NULL,
    `heart_rate` INT NULL,
    `spo2` FLOAT NULL,
    `alert_message` TEXT NULL,
    `is_simulated` TINYINT(1) NOT NULL DEFAULT 0,
    `acknowledgment_time` TIMESTAMP NULL,
    `response_latency_seconds` FLOAT NULL,
    `attending_clinician` VARCHAR(64) NULL,
    `resolution_status` ENUM('PENDING', 'ACKNOWLEDGED', 'RESOLVED', 'FALSE_ALARM') DEFAULT 'PENDING',
    `notes` TEXT NULL,
    PRIMARY KEY (`incident_id`),
    INDEX `idx_incident_status` (`resolution_status`),
    INDEX `idx_incident_patient` (`patient_id`),
    INDEX `idx_incident_timestamp` (`trigger_timestamp`),
    CONSTRAINT `fk_incident_patient` FOREIGN KEY (`patient_id`) 
        REFERENCES `patients`(`patient_id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
