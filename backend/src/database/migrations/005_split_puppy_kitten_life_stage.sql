-- Migration: split puppy_kitten → puppy | kitten (pet-type aware backfill)

-- products.target_life_stage
ALTER TABLE products MODIFY COLUMN target_life_stage
  ENUM('puppy_kitten', 'puppy', 'kitten', 'adult', 'senior', 'all') DEFAULT 'all';

UPDATE products
SET target_life_stage = 'puppy'
WHERE target_life_stage = 'puppy_kitten' AND target_pet_type = 'dog';

UPDATE products
SET target_life_stage = 'kitten'
WHERE target_life_stage = 'puppy_kitten' AND target_pet_type = 'cat';

UPDATE products
SET target_life_stage = 'all'
WHERE target_life_stage = 'puppy_kitten';

UPDATE products
SET match_key = REPLACE(match_key, '|puppy_kitten|', '|puppy|')
WHERE target_life_stage = 'puppy' AND match_key LIKE '%|puppy_kitten|%';

UPDATE products
SET match_key = REPLACE(match_key, '|puppy_kitten|', '|kitten|')
WHERE target_life_stage = 'kitten' AND match_key LIKE '%|puppy_kitten|%';

ALTER TABLE products MODIFY COLUMN target_life_stage
  ENUM('puppy', 'kitten', 'adult', 'senior', 'all') DEFAULT 'all';

-- product_reviews.pet_age_group
ALTER TABLE product_reviews MODIFY COLUMN pet_age_group
  ENUM('puppy_kitten', 'puppy', 'kitten', 'young', 'adult', 'senior');

UPDATE product_reviews
SET pet_age_group = 'puppy'
WHERE pet_age_group = 'puppy_kitten' AND pet_type = 'dog';

UPDATE product_reviews
SET pet_age_group = 'kitten'
WHERE pet_age_group = 'puppy_kitten' AND pet_type = 'cat';

UPDATE product_reviews
SET pet_age_group = 'young'
WHERE pet_age_group = 'puppy_kitten';

ALTER TABLE product_reviews MODIFY COLUMN pet_age_group
  ENUM('puppy', 'kitten', 'young', 'adult', 'senior');
