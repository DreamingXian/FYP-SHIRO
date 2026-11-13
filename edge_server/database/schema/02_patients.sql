-- =============================================================================
-- SHIRO Edge Server - Schema 02: Inpatient Registry
-- Patients table. Tables only, no data.
-- =============================================================================

-- 1. Create Patients Table
CREATE TABLE IF NOT EXISTS `patients` (
    `patient_id` VARCHAR(32) NOT NULL,
    `full_name` VARCHAR(128) NOT NULL,
    `nric_passport` VARCHAR(32) NOT NULL UNIQUE,
    `dob` DATE NOT NULL,
    `gender` ENUM('MALE', 'FEMALE', 'OTHER') NOT NULL,
    `phone_number` VARCHAR(32) NOT NULL,
    `assigned_ward_id` VARCHAR(32) NULL,
    `assigned_bed_id` VARCHAR(32) NULL,
    `fall_risk_score` ENUM('LOW', 'MEDIUM', 'HIGH') DEFAULT 'LOW',
    `medical_history` TEXT NULL,
    `photo_url` VARCHAR(255) NULL,
    `admission_date` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `discharge_date` DATETIME NULL,
    `status` ENUM('ADMITTED', 'DISCHARGED') DEFAULT 'ADMITTED',
    `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`patient_id`),
    INDEX `idx_patient_status` (`status`),
    INDEX `idx_patient_bed` (`assigned_ward_id`, `assigned_bed_id`),
    CONSTRAINT `fk_patient_ward` FOREIGN KEY (`assigned_ward_id`) 
        REFERENCES `ward_rooms`(`ward_id`) ON DELETE SET NULL,
    CONSTRAINT `fk_patient_bed` FOREIGN KEY (`assigned_ward_id`, `assigned_bed_id`) 
        REFERENCES `ward_beds`(`ward_id`, `bed_id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
