-- Rename branded items to avoid trademark issues
UPDATE shop_items SET name = 'Sport Shades', name_ko = 'Sport Shades' WHERE id = 'glasses-oakley';
UPDATE shop_items SET name = 'Retro Round', name_ko = 'Retro Round' WHERE id = 'glasses-moscot';
UPDATE shop_items SET name = 'Aviator Shades', name_ko = 'Aviator Shades' WHERE id = 'glasses-rayben';
UPDATE shop_items SET name = 'Alien Specs', name_ko = 'Alien Specs' WHERE id = 'glasses-et';

-- Also set all name_ko = name (use English everywhere)
UPDATE shop_items SET name_ko = name WHERE name_ko != name;
