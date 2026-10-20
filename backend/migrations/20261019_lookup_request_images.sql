-- Photo lookups keep the three label images for a later batch pass.
-- Run this once on the database that already has lookup_requests.

ALTER TABLE lookup_requests
  ADD COLUMN front_image_url VARCHAR(500) NULL AFTER barcode,
  ADD COLUMN ingredient_image_url VARCHAR(500) NULL AFTER front_image_url,
  ADD COLUMN barcode_image_url VARCHAR(500) NULL AFTER ingredient_image_url;
