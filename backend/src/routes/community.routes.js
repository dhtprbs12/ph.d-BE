const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../database/connection');
const { authenticateToken, optionalAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/community/trending?type=food|treats&petType=dog|cat
router.get('/trending', async (req, res, next) => {
  try {
    const { type, petType } = req.query;

    let productTypeFilter = '';
    if (type === 'treats') {
      productTypeFilter = "AND p.product_type = 'treats'";
    } else {
      productTypeFilter = "AND p.product_type IN ('dry_food', 'wet_food')";
    }

    let petTypeFilter = '';
    if (petType === 'dog' || petType === 'cat') {
      petTypeFilter = `AND p.target_pet_type IN ('${petType}', 'both')`;
    }

    const rows = await query(`
      SELECT 
        p.id,
        p.name,
        p.brand,
        p.product_type,
        p.image_url,
        p.target_pet_type,
        COALESCE(p.base_dog_score, p.base_cat_score) as score,
        COUNT(sh.id) as weekly_scans
      FROM scan_history sh
      JOIN products p ON sh.product_id = p.id
      WHERE sh.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
        ${productTypeFilter}
        ${petTypeFilter}
      GROUP BY p.id
      HAVING weekly_scans >= 1
      ORDER BY weekly_scans DESC
      LIMIT 10
    `);

    res.json({ trending: rows });
  } catch (error) {
    next(error);
  }
});

// GET /api/community/feed?cursor=&limit=20
router.get('/feed', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const offset = parseInt(req.query.offset) || 0;

    const rows = await query(`
      SELECT 
        sp.id as save_id,
        sp.saved_at,
        u.nickname,
        pet.photo_url as pet_photo,
        pet.pet_type,
        pet.breed,
        pet.name as pet_name,
        p.id as product_id,
        p.name as product_name,
        p.brand as product_brand,
        p.image_url as product_image,
        p.product_type,
        COALESCE(p.base_dog_score, p.base_cat_score) as score
      FROM saved_products sp
      JOIN users u ON sp.user_id = u.id
      JOIN products p ON sp.product_id = p.id
      LEFT JOIN pets pet ON pet.user_id = sp.user_id
      WHERE u.nickname IS NOT NULL
      ORDER BY sp.saved_at DESC
      LIMIT ? OFFSET ?
    `, [limit, offset]);

    // Deduplicate: one row per save (pets JOIN may produce duplicates if user has multiple pets)
    const seen = new Set();
    const feed = [];
    for (const row of rows) {
      if (seen.has(row.save_id)) continue;
      seen.add(row.save_id);
      feed.push(row);
    }

    res.json({ feed, hasMore: rows.length === limit });
  } catch (error) {
    next(error);
  }
});

// POST /api/community/save/:productId
router.post('/save/:productId', authenticateToken, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { productId } = req.params;

    if (userId === 'anonymous') {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const existing = await query(
      'SELECT id FROM saved_products WHERE user_id = ? AND product_id = ?',
      [userId, productId]
    );

    if (existing.length > 0) {
      return res.json({ saved: true, message: 'Already saved' });
    }

    await query(
      'INSERT INTO saved_products (id, user_id, product_id) VALUES (?, ?, ?)',
      [uuidv4(), userId, productId]
    );

    res.json({ saved: true });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/community/save/:productId
router.delete('/save/:productId', authenticateToken, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { productId } = req.params;

    if (userId === 'anonymous') {
      return res.status(401).json({ error: 'Authentication required' });
    }

    await query(
      'DELETE FROM saved_products WHERE user_id = ? AND product_id = ?',
      [userId, productId]
    );

    res.json({ saved: false });
  } catch (error) {
    next(error);
  }
});

// GET /api/community/save/check/:productId
router.get('/save/check/:productId', optionalAuth, async (req, res, next) => {
  try {
    const userId = req.user?.id;
    if (!userId || userId === 'anonymous') {
      return res.json({ saved: false });
    }

    const rows = await query(
      'SELECT id FROM saved_products WHERE user_id = ? AND product_id = ?',
      [userId, req.params.productId]
    );

    res.json({ saved: rows.length > 0 });
  } catch (error) {
    next(error);
  }
});

// GET /api/community/my-saved
router.get('/my-saved', authenticateToken, async (req, res, next) => {
  try {
    const userId = req.user.id;

    if (userId === 'anonymous') {
      return res.json({ saved: [] });
    }

    const rows = await query(`
      SELECT 
        sp.id,
        sp.saved_at,
        p.id as product_id,
        p.name as product_name,
        p.brand as product_brand,
        p.image_url as product_image,
        p.product_type,
        COALESCE(p.base_dog_score, p.base_cat_score) as score
      FROM saved_products sp
      JOIN products p ON sp.product_id = p.id
      WHERE sp.user_id = ?
      ORDER BY sp.saved_at DESC
    `, [userId]);

    res.json({ saved: rows });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
