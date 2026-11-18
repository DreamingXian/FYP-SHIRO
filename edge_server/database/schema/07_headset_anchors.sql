-- =============================================================================
-- SHIRO Edge Server - Schema 07: Spatial anchors per headset and ward
-- A spatial anchor is stored inside the headset that created it; another
-- headset cannot load it. So each headset keeps its own anchor reference for
-- each ward it was calibrated in. Tables only, no data.
-- =============================================================================

CREATE TABLE IF NOT EXISTS `headset_ward_anchors` (
  `device_id` VARCHAR(32) NOT NULL,     -- the headset (headset_pairings.device_id)
  `ward_id` VARCHAR(32) NOT NULL,
  `anchor_uuid` VARCHAR(64) NOT NULL,
  `saved_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`device_id`, `ward_id`),
  CONSTRAINT `fk_headset_anchor_ward` FOREIGN KEY (`ward_id`) REFERENCES `ward_rooms` (`ward_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
