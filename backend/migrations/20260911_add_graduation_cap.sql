-- Add graduation cap item to shop_items
-- Run this on the production database

INSERT INTO shop_items (id, category, name, name_ko, price, asset_key, layer_type, position_x, position_y, is_seasonal, description)
VALUES (
  'hat-graduation-cap',
  'hat',
  'Graduation Cap',
  '학사모',
  30,
  'hat_graduation_cap',
  'overlay',
  0,
  -15,
  0,
  'A classic graduation cap for your Lil scholar! 🎓'
);
