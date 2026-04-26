-- Run once on existing MySQL (Railway) before relying on product_search history rows.
ALTER TABLE scan_history
  MODIFY COLUMN scan_type ENUM('label_photo', 'manual_input', 'product_search') NOT NULL;
