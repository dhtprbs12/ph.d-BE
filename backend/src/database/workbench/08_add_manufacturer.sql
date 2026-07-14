-- =============================================================================
-- 08: Add manufacturer column + reset data for new match_key structure
-- =============================================================================
-- New match_key format: manufacturer|brand|lineName|lifeStage|proteins|breedSize|dietTags|
-- Existing data must be reset since match_key structure changed.

-- 1. Add manufacturer column
ALTER TABLE products ADD COLUMN manufacturer VARCHAR(200) NULL AFTER brand;

-- 2. Drop old FULLTEXT index and recreate with manufacturer
ALTER TABLE products DROP INDEX ft_product_search;
ALTER TABLE products ADD FULLTEXT INDEX ft_product_search (name, brand, manufacturer);

-- 3. Reset product-related data (match_key structure changed)
DELETE FROM product_review_cache;
DELETE FROM product_ingredients;
DELETE FROM scan_history;
DELETE FROM products;

SELECT 'Done: manufacturer column added, data reset for new match_key structure' AS result;
