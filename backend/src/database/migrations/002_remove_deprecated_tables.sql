-- =============================================
-- MIGRATION: Remove deprecated ingredient tables
-- 
-- These tables are no longer used as AI assessments are now
-- cached in ai_assessment_cache table which provides personalized
-- assessments per pet health condition.
-- =============================================

-- Step 1: Remove foreign key constraints that reference ingredients table
ALTER TABLE product_ingredients DROP FOREIGN KEY product_ingredients_ibfk_2;

-- Step 2: Drop the ingredient_id column from product_ingredients
ALTER TABLE product_ingredients DROP COLUMN ingredient_id;

-- Step 3: Drop deprecated tables (in order due to FK constraints)
DROP TABLE IF EXISTS ingredient_health_risks;
DROP TABLE IF EXISTS ingredient_species_warnings;
DROP TABLE IF EXISTS ingredient_tags;
DROP TABLE IF EXISTS ingredients;
DROP TABLE IF EXISTS unknown_ingredients;

-- Step 4: Remove ingredient_id from scan_ingredient_analysis if it exists
-- This column may or may not exist depending on your schema version
-- ALTER TABLE scan_ingredient_analysis DROP COLUMN ingredient_id;

-- Verify cleanup
SELECT 'Migration complete - deprecated tables removed' as status;

