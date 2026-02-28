-- =============================================
-- CLEANUP: Remove old combined MD5 hash cache entries
-- 
-- Old format: 16-character hex string (MD5 hash of combined conditions)
-- New format: "{condition}_{productType}" e.g., "healthy_food", "diabetes_treats"
--
-- This migration removes cache entries that won't be used anymore
-- =============================================

-- Preview: Count entries to be deleted (run this first to verify)
-- SELECT 'ai_assessment_cache' as table_name, COUNT(*) as old_entries 
-- FROM ai_assessment_cache 
-- WHERE conditions_hash REGEXP '^[0-9a-f]{16}$';

-- SELECT 'product_review_cache' as table_name, COUNT(*) as old_entries 
-- FROM product_review_cache 
-- WHERE conditions_hash REGEXP '^[0-9a-f]{16}$';

-- Delete old MD5-format entries from ai_assessment_cache
-- These are entries where conditions_hash is a 16-char hex string
DELETE FROM ai_assessment_cache 
WHERE conditions_hash REGEXP '^[0-9a-f]{16}$';

-- Delete old MD5-format entries from product_review_cache
DELETE FROM product_review_cache 
WHERE conditions_hash REGEXP '^[0-9a-f]{16}$';

-- Show remaining entries to verify new format is intact
SELECT 'ai_assessment_cache' as table_name, COUNT(*) as remaining_entries 
FROM ai_assessment_cache;

SELECT 'product_review_cache' as table_name, COUNT(*) as remaining_entries 
FROM product_review_cache;

-- Show sample of new-format entries
SELECT 'Sample new format entries' as info, conditions_hash 
FROM product_review_cache 
LIMIT 5;

