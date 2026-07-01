-- food_check_cache (Food Check feature)
-- Idempotent: CREATE TABLE IF NOT EXISTS

CREATE TABLE IF NOT EXISTS food_check_cache (
    id VARCHAR(36) PRIMARY KEY,
    food_normalized VARCHAR(200) NOT NULL,
    conditions_hash VARCHAR(64) NOT NULL,
    pet_type ENUM('dog', 'cat') NOT NULL,
    safety_level ENUM('safe', 'caution', 'danger', 'unknown') NOT NULL,
    category VARCHAR(50),
    explanation TEXT NOT NULL,
    tip TEXT,
    hit_count INT DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY unique_food_check (food_normalized, conditions_hash, pet_type),
    INDEX idx_food_name (food_normalized),
    INDEX idx_conditions (conditions_hash),
    INDEX idx_hit_count (hit_count DESC)
);

SELECT 'food_check_cache OK' AS status;
