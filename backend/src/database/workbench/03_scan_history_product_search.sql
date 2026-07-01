-- Allow scan_type = 'product_search' in scan_history
-- Safe to re-run (same ENUM definition).

ALTER TABLE scan_history
  MODIFY COLUMN scan_type ENUM('label_photo', 'manual_input', 'product_search') NOT NULL;

SELECT 'scan_history.scan_type updated' AS status;
