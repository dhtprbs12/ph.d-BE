-- Migrate from user_equipped (user-level) to pet_equipped (pet-level)

CREATE TABLE IF NOT EXISTS pet_equipped (
  pet_id VARCHAR(36) PRIMARY KEY,
  character_type VARCHAR(20) NOT NULL DEFAULT 'dog',
  hat_item_id VARCHAR(50) DEFAULT NULL,
  glasses_item_id VARCHAR(50) DEFAULT NULL,
  accessory_item_id VARCHAR(50) DEFAULT NULL,
  clothes_item_id VARCHAR(50) DEFAULT NULL,
  background_item_id VARCHAR(50) DEFAULT NULL,
  effect_item_id VARCHAR(50) DEFAULT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (pet_id) REFERENCES pets(id) ON DELETE CASCADE
);

-- Migrate existing data: copy user_equipped to each user's pets
INSERT INTO pet_equipped (pet_id, character_type, hat_item_id, glasses_item_id, accessory_item_id, clothes_item_id, background_item_id, effect_item_id)
SELECT p.id, ue.character_type, ue.hat_item_id, ue.glasses_item_id, ue.accessory_item_id, ue.clothes_item_id, ue.background_item_id, ue.effect_item_id
FROM pets p
JOIN user_equipped ue ON ue.user_id = p.user_id
ON DUPLICATE KEY UPDATE pet_id = pet_id;

-- Insert pet_equipped for any pets that don't have a row yet (e.g. user had no user_equipped)
INSERT IGNORE INTO pet_equipped (pet_id, character_type)
SELECT p.id, 'dog' FROM pets p WHERE p.id NOT IN (SELECT pet_id FROM pet_equipped);
