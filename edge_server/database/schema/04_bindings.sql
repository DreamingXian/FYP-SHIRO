-- =============================================================================
-- SHIRO Edge Server - Schema 04: Patient-to-Wristband Bindings (thesis Table 4.8)
-- Requires the patients and devices tables.
--
-- One row per binding, kept after the binding ends: unbinding marks it UNBOUND,
-- discharging marks it DISCHARGED, with the time and the clinician. This is the
-- binding history (who wore which wristband, and when).
-- Only one ACTIVE binding per patient and per wristband: the two virtual columns
-- hold the patient and the wristband only while the binding is ACTIVE (NULL
-- otherwise), and they are unique. (VIRTUAL, not STORED: MariaDB 10.4 does not
-- update a stored generated column when a foreign key sets device_id to NULL.)
-- Deleting a wristband from the registry keeps its history: device_id becomes
-- NULL and the copied MAC address remains.
-- =============================================================================

CREATE TABLE IF NOT EXISTS `patient_bindings` (
  `binding_id` INT AUTO_INCREMENT PRIMARY KEY,
  `patient_id` VARCHAR(32) NOT NULL,
  `device_id` VARCHAR(32) NULL,
  `wristband_mac` VARCHAR(32) NULL,
  `bound_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `bound_by` VARCHAR(64) NULL DEFAULT NULL,
  `stream_rate` VARCHAR(32) DEFAULT '5 Hz Live Stream',
  `status` ENUM('ACTIVE', 'UNBOUND', 'DISCHARGED') NOT NULL DEFAULT 'ACTIVE',
  `unbound_at` TIMESTAMP NULL DEFAULT NULL,
  `unbound_by` VARCHAR(64) NULL DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `active_patient_id` VARCHAR(32) GENERATED ALWAYS AS (IF(`status` = 'ACTIVE', `patient_id`, NULL)) VIRTUAL,
  `active_device_id` VARCHAR(32) GENERATED ALWAYS AS (IF(`status` = 'ACTIVE', `device_id`, NULL)) VIRTUAL,
  UNIQUE KEY `uk_active_patient` (`active_patient_id`),
  UNIQUE KEY `uk_active_device` (`active_device_id`),
  KEY `idx_binding_patient` (`patient_id`),
  KEY `idx_binding_device` (`device_id`),
  KEY `idx_binding_bound_at` (`bound_at`),
  CONSTRAINT `fk_binding_patient` FOREIGN KEY (`patient_id`) REFERENCES `patients` (`patient_id`) ON DELETE CASCADE,
  CONSTRAINT `fk_binding_device` FOREIGN KEY (`device_id`) REFERENCES `devices` (`device_id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
