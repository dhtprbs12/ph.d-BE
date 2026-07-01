-- Product match identity columns on `products`
-- Requires: 01_helpers.sql (add_column_if_missing, add_index_if_missing)
--
-- Adds:
--   barcode, brand_norm, line_name, primary_proteins,
--   breed_size, diet_tags, match_key
-- Indexes:
--   idx_products_barcode (UNIQUE), idx_products_match_key (UNIQUE),
--   idx_products_brand_norm, idx_products_line_name

CALL add_column_if_missing('products', 'barcode', 'VARCHAR(20) NULL AFTER brand');
CALL add_column_if_missing('products', 'brand_norm', 'VARCHAR(200) NULL AFTER barcode');
CALL add_column_if_missing('products', 'line_name', 'VARCHAR(100) NULL AFTER brand_norm');
CALL add_column_if_missing('products', 'primary_proteins', 'VARCHAR(200) NULL AFTER line_name');
CALL add_column_if_missing('products', 'breed_size', "ENUM('all', 'large_breed', 'small_breed') NOT NULL DEFAULT 'all' AFTER primary_proteins");
CALL add_column_if_missing('products', 'diet_tags', 'VARCHAR(200) NULL AFTER breed_size');
CALL add_column_if_missing('products', 'match_key', 'VARCHAR(255) NULL AFTER diet_tags');

CALL add_index_if_missing('products', 'idx_products_barcode', 'UNIQUE INDEX idx_products_barcode (barcode)');
CALL add_index_if_missing('products', 'idx_products_match_key', 'UNIQUE INDEX idx_products_match_key (match_key)');
CALL add_index_if_missing('products', 'idx_products_brand_norm', 'INDEX idx_products_brand_norm (brand_norm)');
CALL add_index_if_missing('products', 'idx_products_line_name', 'INDEX idx_products_line_name (line_name)');

-- Backfill brand_norm from brand where empty
UPDATE products
SET brand_norm = LOWER(REGEXP_REPLACE(COALESCE(brand, ''), '[^a-zA-Z0-9]', ''))
WHERE brand_norm IS NULL AND brand IS NOT NULL AND brand != '';

SELECT 'products match columns migration complete' AS status;

-- Verify
DESCRIBE products;

SELECT
  INDEX_NAME,
  NON_UNIQUE,
  GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS columns
FROM INFORMATION_SCHEMA.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'products'
  AND INDEX_NAME IN (
    'idx_products_barcode',
    'idx_products_match_key',
    'idx_products_brand_norm',
    'idx_products_line_name'
  )
GROUP BY INDEX_NAME, NON_UNIQUE;
