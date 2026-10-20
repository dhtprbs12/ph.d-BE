-- Private on-demand food lookups. Not part of the public products catalog.

CREATE TABLE IF NOT EXISTS lookup_requests (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  pet_id VARCHAR(36) NULL,
  pet_name VARCHAR(100) NULL,
  pet_type ENUM('dog', 'cat') NOT NULL DEFAULT 'dog',
  brand VARCHAR(200) NULL,
  query_name VARCHAR(300) NULL,
  brand_norm VARCHAR(200) NULL,
  query_name_norm VARCHAR(300) NULL,
  filter_hints_json JSON NULL,
  barcode VARCHAR(32) NULL,
  pasted_url VARCHAR(500) NULL,
  chosen_url VARCHAR(500) NULL,
  status ENUM('queued', 'searching', 'needs_choice', 'ready', 'failed') NOT NULL DEFAULT 'queued',
  failure_reason VARCHAR(40) NULL,
  candidates_json JSON NULL,
  extracted_json JSON NULL,
  scan_id VARCHAR(36) NULL,
  entry ENUM('name', 'photo') NOT NULL,
  notify_push TINYINT(1) NOT NULL DEFAULT 1,
  email_to VARCHAR(255) NULL,
  tokens_awarded INT NOT NULL DEFAULT 0,
  client_acked_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_lookup_user (user_id, created_at),
  INDEX idx_lookup_barcode (user_id, barcode)
);

ALTER TABLE scan_history
  MODIFY COLUMN scan_type ENUM(
    'label_photo', 'manual_input', 'product_search', 'barcode', 'on_demand_lookup'
  ) NOT NULL;

ALTER TABLE users
  ADD COLUMN expo_push_token VARCHAR(255) NULL;
