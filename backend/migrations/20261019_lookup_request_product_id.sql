-- Existing lookup_requests tables were created with scan_id.
-- That column now stores the products.id written by Approve & Save.

ALTER TABLE lookup_requests
  CHANGE COLUMN scan_id product_id VARCHAR(36) NULL;
