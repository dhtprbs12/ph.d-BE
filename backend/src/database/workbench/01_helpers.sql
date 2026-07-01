-- Creates idempotent helpers (safe to re-run).
-- Must run before 02–05 if those files use the procedures.

DROP PROCEDURE IF EXISTS add_column_if_missing;
DROP PROCEDURE IF EXISTS add_index_if_missing;

DELIMITER //

CREATE PROCEDURE add_column_if_missing(
  IN p_table VARCHAR(64),
  IN p_column VARCHAR(64),
  IN p_definition TEXT
)
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = p_table
      AND COLUMN_NAME = p_column
  ) THEN
    SET @ddl = CONCAT(
      'ALTER TABLE `', p_table, '` ADD COLUMN `', p_column, '` ', p_definition
    );
    PREPARE s FROM @ddl;
    EXECUTE s;
    DEALLOCATE PREPARE s;
    SELECT CONCAT('Added column ', p_table, '.', p_column) AS migration_log;
  ELSE
    SELECT CONCAT('Skip (exists): ', p_table, '.', p_column) AS migration_log;
  END IF;
END//

CREATE PROCEDURE add_index_if_missing(
  IN p_table VARCHAR(64),
  IN p_index VARCHAR(64),
  IN p_index_ddl TEXT
)
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = p_table
      AND INDEX_NAME = p_index
  ) THEN
    SET @ddl = CONCAT('ALTER TABLE `', p_table, '` ADD ', p_index_ddl);
    PREPARE s FROM @ddl;
    EXECUTE s;
    DEALLOCATE PREPARE s;
    SELECT CONCAT('Added index ', p_index, ' on ', p_table) AS migration_log;
  ELSE
    SELECT CONCAT('Skip (exists): index ', p_index) AS migration_log;
  END IF;
END//

DELIMITER ;

SELECT 'Helpers ready — run 02+ migrations' AS status;
