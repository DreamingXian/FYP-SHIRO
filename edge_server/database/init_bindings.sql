-- =============================================================================
-- SHIRO Edge Server - Patient-to-Wristband Bindings Schema
-- =============================================================================

CREATE TABLE IF NOT EXISTS `patient_bindings` (
  `binding_id` INT AUTO_INCREMENT PRIMARY KEY,
  `patient_id` VARCHAR(32) NOT NULL,
  `device_id` VARCHAR(32) NOT NULL,
  `bound_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `bound_by` VARCHAR(64) DEFAULT 'DOC-8821',
  `stream_rate` VARCHAR(32) DEFAULT '5 Hz Live Stream',
  `status` ENUM('ACTIVE', 'UNBOUND') NOT NULL DEFAULT 'ACTIVE',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_active_patient` (`patient_id`),
  UNIQUE KEY `uk_active_device` (`device_id`),
  CONSTRAINT `fk_binding_patient` FOREIGN KEY (`patient_id`) REFERENCES `patients` (`patient_id`) ON DELETE CASCADE,
  CONSTRAINT `fk_binding_device` FOREIGN KEY (`device_id`) REFERENCES `devices` (`device_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

