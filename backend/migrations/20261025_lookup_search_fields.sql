ALTER TABLE lookup_requests
  ADD COLUMN protein VARCHAR(200) NULL AFTER query_name_norm,
  ADD COLUMN protein_norm VARCHAR(200) NULL AFTER protein,
  ADD COLUMN life_stage VARCHAR(20) NULL AFTER protein_norm,
  ADD COLUMN food_form VARCHAR(10) NULL AFTER life_stage;
