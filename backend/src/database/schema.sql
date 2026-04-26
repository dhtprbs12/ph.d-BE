-- PetFood Analyzer Database Schema
-- Supports both Dogs and Cats with species-specific rules

-- =============================================
-- USERS & AUTHENTICATION
-- =============================================

CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(36) PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_email (email)
);

-- =============================================
-- PET PROFILES (Dogs & Cats)
-- =============================================

CREATE TABLE IF NOT EXISTS pets (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL,
    name VARCHAR(100) NOT NULL,
    pet_type ENUM('dog', 'cat') NOT NULL,
    breed VARCHAR(100),
    age_months INT,
    weight_kg DECIMAL(5,2),
    sex ENUM('male', 'female', 'neutered_male', 'spayed_female'),
    activity_level ENUM('low', 'moderate', 'high') DEFAULT 'moderate',
    is_primary BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_user_pets (user_id),
    INDEX idx_pet_type (pet_type)
);

-- Pet health conditions
CREATE TABLE IF NOT EXISTS pet_health_conditions (
    id VARCHAR(36) PRIMARY KEY,
    pet_id VARCHAR(36) NOT NULL,
    condition_type ENUM(
        'allergy_chicken', 'allergy_beef', 'allergy_fish', 'allergy_dairy',
        'allergy_grains', 'allergy_eggs', 'allergy_soy', 'allergy_lamb',
        'digestive_sensitivity', 'skin_issues', 'joint_issues',
        'kidney_disease', 'liver_disease', 'heart_disease',
        'diabetes', 'obesity', 'urinary_issues', 'thyroid_issues',
        'pancreatitis', 'ibd'
    ) NOT NULL,
    severity ENUM('mild', 'moderate', 'severe') DEFAULT 'moderate',
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (pet_id) REFERENCES pets(id) ON DELETE CASCADE,
    UNIQUE KEY unique_pet_condition (pet_id, condition_type),
    INDEX idx_pet_conditions (pet_id)
);

-- =============================================
-- PRODUCTS DATABASE
-- =============================================

CREATE TABLE IF NOT EXISTS products (
    id VARCHAR(36) PRIMARY KEY,
    name VARCHAR(300) NOT NULL,
    brand VARCHAR(200),
    product_type ENUM('dry_food', 'wet_food', 'treats', 'supplement', 'other') DEFAULT 'dry_food',
    texture ENUM('dry', 'wet', 'semi_moist', 'freeze_dried') DEFAULT NULL,
    target_pet_type ENUM('dog', 'cat', 'both') NOT NULL,
    target_life_stage ENUM('puppy_kitten', 'adult', 'senior', 'all') DEFAULT 'all',
    image_url VARCHAR(500),
    -- Raw data
    raw_ingredients_text TEXT,
    -- Ingredient hash for deduplication (MD5 of normalized, sorted ingredients)
    ingredient_hash VARCHAR(32) UNIQUE,
    guaranteed_analysis TEXT,
    -- Calculated scores (cached)
    base_dog_score INT,
    base_cat_score INT,
    -- Metadata
    source ENUM('database', 'user_scan', 'api') DEFAULT 'database',
    scan_count INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_ingredient_hash (ingredient_hash),
    INDEX idx_target_pet (target_pet_type),
    FULLTEXT INDEX ft_product_search (name, brand)
);

-- Product ingredients (parsed)
CREATE TABLE IF NOT EXISTS product_ingredients (
    id VARCHAR(36) PRIMARY KEY,
    product_id VARCHAR(36) NOT NULL,
    raw_name VARCHAR(200) NOT NULL,  -- Original text from label
    position INT NOT NULL,  -- Order in ingredient list (1 = first/most)
    percentage DECIMAL(5,2),  -- If listed on label
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
    INDEX idx_product_ingredients (product_id),
    INDEX idx_position (position)
);

-- =============================================
-- SCAN HISTORY & ANALYSIS RESULTS
-- =============================================

CREATE TABLE IF NOT EXISTS scan_history (
    id VARCHAR(36) PRIMARY KEY,
    device_id VARCHAR(100),  -- Optional device identifier (no user accounts)
    pet_name VARCHAR(100),   -- Store pet info directly (pets are local on device)
    pet_type ENUM('dog', 'cat'),
    product_id VARCHAR(36),
    scan_type ENUM('label_photo', 'manual_input', 'product_search') NOT NULL,
    -- Analysis results
    final_score INT NOT NULL,  -- 0-100
    grade ENUM('A', 'B', 'C', 'D', 'F') NOT NULL,
    recommendation ENUM('highly_recommended', 'recommended', 'acceptable', 'caution', 'not_recommended') NOT NULL,
    -- Raw input data
    image_url VARCHAR(500),
    raw_text_input TEXT,
    -- Parsed results
    ocr_extracted_text TEXT,
    analysis_json JSON,  -- Full analysis breakdown
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL,
    INDEX idx_device_scans (device_id, created_at DESC),
    INDEX idx_product_scans (product_id)
);

-- Detailed ingredient analysis per scan
CREATE TABLE IF NOT EXISTS scan_ingredient_analysis (
    id VARCHAR(36) PRIMARY KEY,
    scan_id VARCHAR(36) NOT NULL,
    ingredient_name VARCHAR(200) NOT NULL,
    risk_level ENUM('safe', 'low', 'moderate', 'high', 'danger') NOT NULL,
    risk_score INT NOT NULL,
    is_allergen_match BOOLEAN DEFAULT FALSE,
    is_health_concern BOOLEAN DEFAULT FALSE,
    explanation TEXT,
    FOREIGN KEY (scan_id) REFERENCES scan_history(id) ON DELETE CASCADE,
    INDEX idx_scan_ingredients (scan_id)
);

-- =============================================
-- REVIEWS & COMMUNITY
-- =============================================

CREATE TABLE IF NOT EXISTS product_reviews (
    id VARCHAR(36) PRIMARY KEY,
    product_id VARCHAR(36) NOT NULL,
    user_id VARCHAR(36) NOT NULL,
    pet_id VARCHAR(36),  -- Nullable so review persists if pet is deleted
    rating INT NOT NULL CHECK (rating >= 1 AND rating <= 5),
    title VARCHAR(200),
    content TEXT,
    -- Pet context at time of review (denormalized for filtering)
    pet_type ENUM('dog', 'cat') NOT NULL,
    pet_breed VARCHAR(100),
    pet_size ENUM('tiny', 'small', 'medium', 'large', 'giant'),
    pet_age_group ENUM('puppy_kitten', 'young', 'adult', 'senior'),
    has_allergies BOOLEAN DEFAULT FALSE,
    has_health_conditions BOOLEAN DEFAULT FALSE,
    -- Engagement
    helpful_count INT DEFAULT 0,
    verified_purchase BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (pet_id) REFERENCES pets(id) ON DELETE SET NULL,
    UNIQUE KEY unique_user_product_review (user_id, product_id),
    INDEX idx_product_reviews (product_id, rating),
    INDEX idx_pet_type_reviews (product_id, pet_type),
    INDEX idx_review_filters (product_id, pet_type, pet_size, pet_age_group)
);

-- =============================================
-- PRODUCT ALTERNATIVES & RECOMMENDATIONS
-- =============================================

CREATE TABLE IF NOT EXISTS product_alternatives (
    id VARCHAR(36) PRIMARY KEY,
    product_id VARCHAR(36) NOT NULL,
    alternative_product_id VARCHAR(36) NOT NULL,
    pet_type ENUM('dog', 'cat') NOT NULL,
    similarity_score DECIMAL(5,2),  -- How similar the products are
    price_comparison ENUM('cheaper', 'similar', 'more_expensive'),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
    FOREIGN KEY (alternative_product_id) REFERENCES products(id) ON DELETE CASCADE,
    UNIQUE KEY unique_alternative (product_id, alternative_product_id, pet_type),
    INDEX idx_alternatives (product_id, pet_type)
);

-- =============================================
-- CACHING TABLE FOR GEMINI API RESPONSES
-- =============================================

CREATE TABLE IF NOT EXISTS ocr_cache (
    id VARCHAR(36) PRIMARY KEY,
    image_hash VARCHAR(64) UNIQUE NOT NULL,  -- SHA-256 of image
    extracted_text TEXT NOT NULL,
    parsed_ingredients JSON,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP,
    INDEX idx_image_hash (image_hash),
    INDEX idx_expires (expires_at)
);

-- =============================================
-- AI ASSESSMENT CACHE (Per-Condition Caching)
-- Caches AI assessments for each ingredient + single condition combination
-- Format: conditions_hash = "{condition}_{productType}" e.g., "healthy_food", "diabetes_treats"
-- When pet has multiple conditions, we combine scores at query time (take worst)
-- =============================================

CREATE TABLE IF NOT EXISTS ai_assessment_cache (
    id VARCHAR(36) PRIMARY KEY,
    ingredient_normalized VARCHAR(200) NOT NULL,  -- Normalized ingredient name
    conditions_hash VARCHAR(64) NOT NULL,         -- Single condition hash: "healthy_food", "diabetes_treats", etc.
    pet_type ENUM('dog', 'cat') NOT NULL,
    -- AI assessment results
    risk_score INT NOT NULL,                      -- -50 to +100 (negative = beneficial)
    explanation TEXT,
    benefit TEXT,
    -- Metadata
    hit_count INT DEFAULT 1,                      -- How many times this cache was used
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY unique_assessment (ingredient_normalized, conditions_hash, pet_type),
    INDEX idx_ingredient (ingredient_normalized),
    INDEX idx_conditions (conditions_hash),
    INDEX idx_hit_count (hit_count DESC)
);

-- =============================================
-- PRODUCT REVIEW CACHE (Per-Condition Holistic AI Review)
-- Caches product scores for each single condition separately
-- Format: conditions_hash = "{condition}_{productType}" e.g., "healthy_food", "obesity_treats"
-- When pet has multiple conditions, we combine scores at query time (take worst)
-- Key: ingredient_hash + conditions_hash + pet_type
-- =============================================

CREATE TABLE IF NOT EXISTS product_review_cache (
    id VARCHAR(36) PRIMARY KEY,
    ingredient_hash VARCHAR(64) NOT NULL,         -- Hash of sorted ingredients
    conditions_hash VARCHAR(64) NOT NULL,         -- Single condition: "healthy_food", "diabetes_treats", etc.
    pet_type ENUM('dog', 'cat') NOT NULL,
    product_type VARCHAR(50) DEFAULT 'food',      -- treats, food, supplement
    -- AI holistic review results
    final_score INT NOT NULL,                     -- 0-100
    grade VARCHAR(1) NOT NULL,                    -- A, B, C, D, F
    recommendation VARCHAR(50),                   -- highly_recommended, recommended, acceptable, caution, not_recommended
    -- Detailed assessment
    key_issues JSON,                              -- ["No real protein", "Artificial colors"]
    positives JSON,                               -- ["Natural preservative", "Good herbs"]
    ai_summary TEXT,                              -- "This treat lacks protein..."
    protein_quality VARCHAR(20),                  -- none, low, medium, high
    has_artificial_additives BOOLEAN DEFAULT FALSE,
    primary_ingredient_type VARCHAR(50),          -- protein, carb, filler, fat
    -- Metadata
    hit_count INT DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY unique_review (ingredient_hash, conditions_hash, pet_type),
    INDEX idx_ingredient_hash (ingredient_hash),
    INDEX idx_conditions_hash (conditions_hash),
    INDEX idx_score (final_score DESC),
    INDEX idx_hit_count (hit_count DESC)
);

-- =============================================
-- FOOD CHECK CACHE (Single Food Item Safety)
-- Caches AI assessments for "Can my pet eat this?" queries
-- Key: food_normalized + conditions_hash + pet_type
-- =============================================

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

