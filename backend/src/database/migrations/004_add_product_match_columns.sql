-- Migration: Product match identity columns (line, proteins, breed, match_key, barcode)
-- Run against existing DB: mysql ... < 004_add_product_match_columns.sql

ALTER TABLE products
  ADD COLUMN barcode VARCHAR(20) NULL AFTER brand,
  ADD COLUMN brand_norm VARCHAR(200) NULL AFTER barcode,
  ADD COLUMN line_name VARCHAR(100) NULL AFTER brand_norm,
  ADD COLUMN primary_proteins VARCHAR(200) NULL AFTER line_name,
  ADD COLUMN breed_size ENUM('all', 'large_breed', 'small_breed') NOT NULL DEFAULT 'all' AFTER primary_proteins,
  ADD COLUMN diet_tags VARCHAR(200) NULL AFTER breed_size,
  ADD COLUMN match_key VARCHAR(255) NULL AFTER diet_tags;

ALTER TABLE products
  ADD UNIQUE INDEX idx_products_barcode (barcode),
  ADD UNIQUE INDEX idx_products_match_key (match_key),
  ADD INDEX idx_products_brand_norm (brand_norm),
  ADD INDEX idx_products_line_name (line_name);
