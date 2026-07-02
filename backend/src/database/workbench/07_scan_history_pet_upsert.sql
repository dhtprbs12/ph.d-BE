-- scan_history upsert key: user + product + pet (not user + product alone)
-- Requires: 01_helpers.sql (add_index_if_missing)
--
-- Enables one history row per pet per product per user.
-- Re-scan same product for a different pet → INSERT (new row).
-- Re-scan same product for the same pet → UPDATE (existing row).

CALL add_index_if_missing(
  'scan_history',
  'idx_scan_history_user_product_pet',
  'UNIQUE INDEX idx_scan_history_user_product_pet (user_id, product_id, pet_name, pet_type)'
);

SELECT 'scan_history pet upsert index migration complete' AS status;

SELECT
  INDEX_NAME,
  NON_UNIQUE,
  GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS columns
FROM INFORMATION_SCHEMA.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'scan_history'
  AND INDEX_NAME = 'idx_scan_history_user_product_pet'
GROUP BY INDEX_NAME, NON_UNIQUE;
