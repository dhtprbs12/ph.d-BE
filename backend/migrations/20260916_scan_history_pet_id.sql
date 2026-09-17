-- Add pet_id column to scan_history for direct FK to pets table
ALTER TABLE scan_history
  ADD COLUMN pet_id VARCHAR(36) DEFAULT NULL AFTER pet_type,
  ADD INDEX idx_scan_history_pet_id (pet_id);

-- Backfill pet_id from existing pet_name + pet_type + user_id
UPDATE scan_history sh
  JOIN pets p ON p.user_id = sh.user_id
    AND p.name = sh.pet_name
    AND p.pet_type = sh.pet_type
SET sh.pet_id = p.id
WHERE sh.pet_id IS NULL AND sh.user_id IS NOT NULL;
