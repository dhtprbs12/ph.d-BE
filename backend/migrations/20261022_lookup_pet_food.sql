-- Run this yourself before the new current-food lookup flow.
-- Links an analysis request to the pet_foods row created when that request is sent.
-- product_id on that row stays empty until the request is approved.

ALTER TABLE lookup_requests
  ADD COLUMN pet_food_id VARCHAR(36) NULL AFTER pet_id;
