-- =============================================================================
-- SHIRO Edge Server - Schema 06: Clinician accounts, sessions, headset pairing
-- and the audit log of important actions.
-- =============================================================================

-- Clinician accounts. Passwords are stored only as salted scrypt hashes.
CREATE TABLE IF NOT EXISTS `clinicians` (
  `clinician_id` VARCHAR(16) NOT NULL PRIMARY KEY,
  `username` VARCHAR(64) NOT NULL,
  `full_name` VARCHAR(120) NOT NULL,
  `role` ENUM('ADMIN', 'CLINICIAN') NOT NULL DEFAULT 'CLINICIAN',
  `password_hash` VARCHAR(255) NOT NULL,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `created_by` VARCHAR(16) NULL,
  `last_login_at` DATETIME NULL,
  UNIQUE KEY `uk_clinician_username` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Signed-in dashboard sessions. Only a SHA-256 hash of the session token is
-- stored, so a copy of this table cannot be used to sign in.
CREATE TABLE IF NOT EXISTS `auth_sessions` (
  `token_hash` CHAR(64) NOT NULL PRIMARY KEY,
  `clinician_id` VARCHAR(16) NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `expires_at` DATETIME NOT NULL,
  `ip_address` VARCHAR(45) NULL,
  `revoked_at` DATETIME NULL,
  KEY `idx_session_clinician` (`clinician_id`),
  CONSTRAINT `fk_session_clinician` FOREIGN KEY (`clinician_id`) REFERENCES `clinicians` (`clinician_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Paired headsets: one row per headset, with the hash of its access token.
-- assigned_clinician_id: the clinician an admin assigned the headset to; what
-- the headset does is recorded in that clinician's name. NULL = nobody.
CREATE TABLE IF NOT EXISTS `headset_pairings` (
  `device_id` VARCHAR(32) NOT NULL PRIMARY KEY,
  `token_hash` CHAR(64) NOT NULL,
  `paired_by` VARCHAR(16) NOT NULL,
  `paired_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `revoked_at` DATETIME NULL,
  `revoked_by` VARCHAR(16) NULL,
  `assigned_clinician_id` VARCHAR(16) NULL,
  `assigned_at` DATETIME NULL,
  `assigned_by` VARCHAR(16) NULL,
  UNIQUE KEY `uk_headset_token` (`token_hash`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Who did what and when. Rows are only ever added.
CREATE TABLE IF NOT EXISTS `audit_log` (
  `audit_id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `actor_type` ENUM('CLINICIAN', 'HEADSET', 'ANONYMOUS') NOT NULL,
  `actor_id` VARCHAR(32) NULL,
  `actor_label` VARCHAR(160) NULL,
  `action` VARCHAR(48) NOT NULL,
  `target_type` VARCHAR(24) NULL,
  `target_id` VARCHAR(64) NULL,
  `details` VARCHAR(1000) NULL,
  `ip_address` VARCHAR(45) NULL,
  KEY `idx_audit_time` (`created_at`),
  KEY `idx_audit_actor` (`actor_id`),
  KEY `idx_audit_action` (`action`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
