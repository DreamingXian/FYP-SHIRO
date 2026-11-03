-- =============================================================================
-- SHIRO Central Hospital Database Initialization Script
-- Module: Inpatient Registry, Admissions, Bed Occupancy & Face Photos
-- =============================================================================

USE `shiro_db`;

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

-- 2. Seed Default Benchmark Patients (if table is empty)
INSERT IGNORE INTO `patients` 
(`patient_id`, `full_name`, `nric_passport`, `dob`, `gender`, `phone_number`, `assigned_ward_id`, `assigned_bed_id`, `fall_risk_score`, `medical_history`, `photo_url`, `admission_date`, `discharge_date`, `status`)
VALUES 
('P-001', 'Tan Ah Kow', '580512-14-5543', '1958-05-12', 'MALE', '+6012-3456789', 'WARD-001', 'BED-001-01', 'HIGH', 'Hypertension, Type 2 DM, Sensitive to Penicillin, History of mild syncope.', '/uploads/patients/preset_elderly_male.svg', '2026-10-24 09:30:00', NULL, 'ADMITTED'),
('P-002', 'Siti Nurhaliza', '720310-10-5892', '1972-03-10', 'FEMALE', '+6011-8765432', 'WARD-001', 'BED-001-02', 'MEDIUM', 'Post-operative knee arthroplasty, Mild asthma.', '/uploads/patients/preset_adult_female.svg', '2026-10-25 14:15:00', NULL, 'ADMITTED'),
('P-003', 'Kavitha Mohan', '540819-08-5120', '1954-08-19', 'FEMALE', '+6017-6543210', 'WARD-001', 'BED-001-03', 'HIGH', 'Parkinson\'s disease stage 2, osteoporosis, previous fall accident in 2024.', '/uploads/patients/preset_elderly_female.svg', '2026-10-26 11:00:00', NULL, 'ADMITTED'),
('P-004', 'Wong Wai Keat', '851122-14-6101', '1985-11-22', 'MALE', '+6016-1234567', 'WARD-002', 'BED-002-01', 'LOW', 'Minor fracture observation, no known drug allergies.', '/uploads/patients/preset_adult_male.svg', '2026-10-28 08:45:00', NULL, 'ADMITTED'),
('P-005', 'Lee Chong Wei', '821021-08-5521', '1982-10-21', 'MALE', '+6019-9876543', NULL, NULL, 'LOW', 'Acute sports tendonitis, full recovery.', '/uploads/patients/preset_adult_male.svg', '2026-10-15 10:00:00', '2026-10-20 16:30:00', 'DISCHARGED');

-- 3. Synchronize Initial Bed Occupancy Status in ward_beds
UPDATE `ward_beds` SET `status` = 'OCCUPIED' WHERE `ward_id` = 'WARD-001' AND `bed_id` IN ('BED-001-01', 'BED-001-02', 'BED-001-03');
UPDATE `ward_beds` SET `status` = 'OCCUPIED' WHERE `ward_id` = 'WARD-002' AND `bed_id` = 'BED-002-01';

