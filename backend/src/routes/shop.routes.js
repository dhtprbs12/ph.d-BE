const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { query } = require('../database/connection');
const { authenticateToken } = require('../middleware/auth');
const { spendTokens, getTokenInfo } = require('../services/tokenService');

router.use(authenticateToken);

/**
 * GET /api/shop/items
 * List shop items, optionally filtered by category.
 * Marks items the user already owns.
 */
router.get('/items', async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const { category } = req.query;
    
    let sql = `
      SELECT si.*,
        (SELECT COUNT(*) FROM user_items ui WHERE ui.user_id = ? AND ui.item_id = si.id) > 0 AS is_owned
      FROM shop_items si
      WHERE 1=1
    `;
    const params = [userId];
    
    if (category) {
      sql += ' AND si.category = ?';
      params.push(category);
    }
    
    // Filter out expired seasonal items, but show upcoming ones
    sql += ` AND (si.is_seasonal = FALSE OR si.available_until IS NULL OR si.available_until >= CURDATE())`;
    sql += ' ORDER BY si.sort_order ASC, si.created_at ASC';
    
    const items = await query(sql, params);
    
    res.json({
      items: items.map(i => ({
        id: i.id,
        category: i.category,
        name: i.name,
        nameKo: i.name_ko,
        price: i.price,
        assetKey: i.asset_key,
        layerType: i.layer_type,
        positionX: i.position_x,
        positionY: i.position_y,
        isSeasonal: !!i.is_seasonal,
        availableFrom: i.available_from,
        availableUntil: i.available_until,
        isOwned: !!i.is_owned,
      })),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/shop/items/:id/purchase
 * Purchase an item with tokens.
 */
router.post('/items/:id/purchase', async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const itemId = req.params.id;
    
    console.log(`🛒 [Shop] Purchase attempt: userId=${userId}, itemId=${itemId}`);
    
    // Get item
    const [item] = await query('SELECT * FROM shop_items WHERE id = ?', [itemId]);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    
    // Check if already owned
    const [existing] = await query('SELECT id FROM user_items WHERE user_id = ? AND item_id = ?', [userId, itemId]);
    if (existing) return res.status(409).json({ error: 'already_owned', message: 'You already own this item' });
    
    // Check seasonal availability
    if (item.is_seasonal) {
      const now = new Date().toISOString().split('T')[0];
      if (item.available_from && now < item.available_from) {
        return res.status(400).json({ error: 'not_available_yet', message: 'This item is not available yet' });
      }
      if (item.available_until && now > item.available_until) {
        return res.status(400).json({ error: 'no_longer_available', message: 'This item is no longer available' });
      }
    }
    
    // Spend tokens
    const success = await spendTokens(userId, item.price, 'purchase', `Purchased ${item.name}`, itemId);
    if (!success) {
      return res.status(400).json({ error: 'insufficient_tokens', message: 'Not enough tokens' });
    }
    
    // Add to user_items
    await query(
      'INSERT INTO user_items (id, user_id, item_id, purchased_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)',
      [uuidv4(), userId, itemId]
    );
    
    const tokenInfo = await getTokenInfo(userId);
    
    console.log(`🛒 [Shop] user=${userId} purchased "${item.name}" for 🦴${item.price}`);
    
    res.json({
      success: true,
      item: {
        id: item.id,
        category: item.category,
        name: item.name,
        nameKo: item.name_ko,
        price: item.price,
        assetKey: item.asset_key,
      },
      newBalance: tokenInfo.balance,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/shop/character
 * Get user's character state: type, equipped items, owned items.
 */
router.get('/character', async (req, res, next) => {
  try {
    const userId = req.user.userId;
    
    // Get equipped state
    const [equipped] = await query('SELECT * FROM user_equipped WHERE user_id = ?', [userId]);
    
    // Get details for each equipped item
    const slots = ['hat', 'glasses', 'accessory', 'clothes', 'background', 'effect'];
    const equippedItems = {};
    
    for (const slot of slots) {
      const itemId = equipped?.[`${slot}_item_id`];
      if (itemId) {
        const [item] = await query('SELECT id, asset_key, layer_type, position_x, position_y, name, name_ko FROM shop_items WHERE id = ?', [itemId]);
        equippedItems[slot] = item ? {
          id: item.id,
          assetKey: item.asset_key,
          layerType: item.layer_type,
          positionX: item.position_x,
          positionY: item.position_y,
          name: item.name,
          nameKo: item.name_ko,
        } : null;
      } else {
        equippedItems[slot] = null;
      }
    }
    
    // Get owned item IDs
    const ownedRows = await query('SELECT item_id FROM user_items WHERE user_id = ?', [userId]);
    const ownedItemIds = ownedRows.map(r => r.item_id);
    
    res.json({
      characterType: equipped?.character_type || 'dog',
      equipped: equippedItems,
      ownedItems: ownedItemIds,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/shop/character/equip
 * Equip or unequip an item in a slot.
 * Body: { slot: 'hat'|'glasses'|..., itemId: 'xxx' | null }
 */
router.put('/character/equip', async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const { slot, itemId } = req.body;
    
    const validSlots = ['hat', 'glasses', 'accessory', 'clothes', 'background', 'effect'];
    if (!validSlots.includes(slot)) {
      return res.status(400).json({ error: 'Invalid slot. Must be one of: ' + validSlots.join(', ') });
    }
    
    if (itemId) {
      // Verify ownership
      const [owned] = await query('SELECT id FROM user_items WHERE user_id = ? AND item_id = ?', [userId, itemId]);
      if (!owned) return res.status(403).json({ error: 'You do not own this item' });
      
      // Verify item category matches slot
      const [item] = await query('SELECT category FROM shop_items WHERE id = ?', [itemId]);
      if (!item) return res.status(404).json({ error: 'Item not found' });
      if (item.category !== slot) {
        return res.status(400).json({ error: `This item is a ${item.category}, not a ${slot}` });
      }
    }
    
    const column = `${slot}_item_id`;
    await query(
      `UPDATE user_equipped SET ${column} = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`,
      [itemId || null, userId]
    );
    
    console.log(`👔 [Equip] user=${userId} slot=${slot} item=${itemId || 'none'}`);
    
    res.json({ success: true, slot, itemId: itemId || null });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/shop/character/type
 * Switch character type (dog/cat).
 * Body: { characterType: 'dog' | 'cat' }
 */
router.put('/character/type', async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const { characterType } = req.body;
    
    if (!['dog', 'cat'].includes(characterType)) {
      return res.status(400).json({ error: 'characterType must be "dog" or "cat"' });
    }
    
    await query(
      'UPDATE user_equipped SET character_type = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?',
      [characterType, userId]
    );
    
    res.json({ success: true, characterType });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
