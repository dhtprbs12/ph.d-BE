-- Add 'barcode' to scan_type ENUM in scan_history
ALTER TABLE scan_history
  MODIFY COLUMN scan_type ENUM('label_photo', 'manual_input', 'product_search', 'barcode') NOT NULL;
