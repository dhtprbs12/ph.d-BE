-- Migration: Add food_check_cache table for single food item safety checks
-- Run this to add caching for the "Food Check" feature

CREATE TABLE IF NOT EXISTS food_check_cache (
    id VARCHAR(36) PRIMARY KEY,
    food_normalized VARCHAR(200) NOT NULL,        -- Normalized food name (e.g., "apple", "chocolate")
    conditions_hash VARCHAR(64) NOT NULL,         -- "healthy" or specific condition
    pet_type ENUM('dog', 'cat') NOT NULL,
    -- AI assessment results
    safety_level ENUM('safe', 'caution', 'danger', 'unknown') NOT NULL,
    category VARCHAR(50),                         -- Fruit, Vegetable, Meat, etc.
    explanation TEXT NOT NULL,
    tip TEXT,
    -- Metadata
    hit_count INT DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY unique_food_check (food_normalized, conditions_hash, pet_type),
    INDEX idx_food_name (food_normalized),
    INDEX idx_conditions (conditions_hash),
    INDEX idx_hit_count (hit_count DESC)
);

-- Verify table was created
SELECT 'food_check_cache table created successfully' AS status;

