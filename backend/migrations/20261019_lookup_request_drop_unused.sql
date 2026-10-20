ALTER TABLE lookup_requests
  DROP COLUMN filter_hints_json,
  DROP COLUMN chosen_url,
  DROP COLUMN candidates_json,
  DROP COLUMN extracted_json;
