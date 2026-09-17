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
        MAX(p.id) as id,
        p.name,
        p.brand,
        MAX(p.product_type) as product_type,
        MAX(p.image_url) as image_url,
        MAX(p.target_pet_type) as target_pet_type,
        MAX(COALESCE(p.base_dog_score, p.base_cat_score)) as score,
        COUNT(sh.id) as weekly_scans
      FROM scan_history sh
      JOIN products p ON sh.product_id = p.id
      WHERE sh.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
        ${productTypeFilter}
        ${petTypeFilter}
      GROUP BY p.name, p.brand
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

// GET /api/community/recent-activity?petType=dog|cat
// Returns recent scan activity with nickname for community feed
router.get('/recent-activity', async (req, res, next) => {
  try {
    const { petType } = req.query;
    let petFilter = '';
    if (petType === 'dog' || petType === 'cat') {
      petFilter = `AND sh.pet_type = '${petType}'`;
    }

    const rows = await query(`
      SELECT 
        u.nickname,
        sh.pet_name,
        sh.pet_type,
        p.name as product_name,
        p.brand as product_brand,
        p.image_url as product_image,
        sh.grade,
        sh.final_score,
        sh.created_at
      FROM scan_history sh
      JOIN products p ON sh.product_id = p.id
      LEFT JOIN users u ON sh.user_id = u.id
      WHERE sh.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
        AND p.name IS NOT NULL
        ${petFilter}
      ORDER BY sh.created_at DESC
      LIMIT 20
    `);

    const activity = rows.map(r => ({
      nickname: r.nickname || 'Anonymous',
      petName: r.pet_name,
      productName: r.product_name,
      brand: r.product_brand,
      productImage: r.product_image,
      grade: r.grade,
      score: r.final_score,
      petType: r.pet_type,
      timeAgo: getTimeAgo(r.created_at),
    }));

    res.json({ activity });
  } catch (error) {
    next(error);
  }
});

// GET /api/community/pet-of-the-week?petType=dog|cat
// Top 3 pets by number of owned items
router.get('/pet-of-the-week', async (req, res, next) => {
  try {
    const { petType } = req.query;
    let petFilter = '';
    if (petType === 'dog' || petType === 'cat') {
      petFilter = `AND p.pet_type = '${petType}'`;
    }

    const rows = await query(`
      SELECT
        p.id as pet_id,
        p.name as pet_name,
        p.pet_type,
        p.breed,
        u.nickname,
        pe.character_type,
        pe.hat_item_id,
        pe.glasses_item_id,
        pe.accessory_item_id,
        pe.clothes_item_id,
        pe.background_item_id,
        pe.effect_item_id,
        COUNT(ui.id) as item_count
      FROM pets p
      JOIN users u ON p.user_id = u.id
      JOIN pet_equipped pe ON pe.pet_id = p.id
      JOIN user_items ui ON ui.user_id = u.id
      WHERE u.nickname IS NOT NULL
        ${petFilter}
      GROUP BY p.id, p.name, p.pet_type, p.breed, u.nickname,
               pe.character_type, pe.hat_item_id, pe.glasses_item_id,
               pe.accessory_item_id, pe.clothes_item_id,
               pe.background_item_id, pe.effect_item_id
      ORDER BY item_count DESC
      LIMIT 3
    `);

    const pets = rows.map((r, i) => ({
      rank: i + 1,
      petId: r.pet_id,
      petName: r.pet_name,
      petType: r.pet_type,
      breed: r.breed,
      nickname: r.nickname,
      characterType: r.character_type,
      equipped: {
        hat: r.hat_item_id,
        glasses: r.glasses_item_id,
        accessory: r.accessory_item_id,
        clothes: r.clothes_item_id,
        background: r.background_item_id,
        effect: r.effect_item_id,
      },
      itemCount: r.item_count,
    }));

    res.json({ pets });
  } catch (error) {
    next(error);
  }
});

// GET /api/community/breed-popular?petType=dog|cat&breed=Golden+Retriever
// Popular foods for a specific breed, or overall petType if no breed
router.get('/breed-popular', async (req, res, next) => {
  try {
    const { petType, breed } = req.query;
    const petTypeVal = petType === 'cat' ? 'cat' : 'dog';

    let breedFilter = '';
    let breedLabel = '';
    const params = [];

    if (breed && breed.trim()) {
      breedFilter = 'AND pets_sub.breed = ?';
      params.push(breed.trim());
      breedLabel = breed.trim();
    }

    // Find top foods scanned by users who own pets of this breed/type
    const rows = await query(`
      SELECT
        p.id as product_id,
        p.name,
        p.brand,
        p.image_url,
        COALESCE(p.base_dog_score, p.base_cat_score) as score,
        COUNT(DISTINCT sh.user_id) as user_count
      FROM scan_history sh
      JOIN products p ON sh.product_id = p.id
      JOIN users u ON sh.user_id = u.id
      JOIN pets pets_sub ON pets_sub.user_id = u.id
        AND pets_sub.pet_type = '${petTypeVal}'
        ${breedFilter}
      WHERE p.product_type IN ('dry_food', 'wet_food')
        AND p.target_pet_type IN ('${petTypeVal}', 'both')
        AND p.name IS NOT NULL
      GROUP BY p.id, p.name, p.brand, p.image_url
      ORDER BY user_count DESC
      LIMIT 5
    `, params);

    // Count how many parents (distinct users) have this breed/type
    const countParams = [];
    let countBreedFilter = '';
    if (breed && breed.trim()) {
      countBreedFilter = 'AND breed = ?';
      countParams.push(breed.trim());
    }
    const [countRow] = await query(`
      SELECT COUNT(DISTINCT user_id) as parent_count
      FROM pets
      WHERE pet_type = '${petTypeVal}'
        ${countBreedFilter}
    `, countParams);

    const foods = rows.map(r => ({
      productId: r.product_id,
      name: r.name,
      brand: r.brand,
      imageUrl: r.image_url,
      score: r.score,
      userCount: r.user_count,
    }));

    res.json({
      breed: breedLabel || `All ${petTypeVal === 'cat' ? 'Cats' : 'Dogs'}`,
      petType: petTypeVal,
      parentCount: countRow?.parent_count || 0,
      foods,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/community/top-scanners?petType=dog|cat
// Top 5 scanners this week
router.get('/top-scanners', async (req, res, next) => {
  try {
    const { petType } = req.query;
    let petFilter = '';
    if (petType === 'dog' || petType === 'cat') {
      petFilter = `AND sh.pet_type = '${petType}'`;
    }

    const rows = await query(`
      SELECT
        u.id as user_id,
        u.nickname,
        COUNT(sh.id) as weekly_scans,
        COALESCE(us.current_streak, 0) as streak,
        COALESCE(usl.current_level, 1) as level,
        COALESCE(usl.total_scans, 0) as total_scans
      FROM scan_history sh
      JOIN users u ON sh.user_id = u.id
      LEFT JOIN user_streaks us ON us.user_id = u.id
      LEFT JOIN user_scan_level usl ON usl.user_id = u.id
      WHERE sh.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
        AND u.nickname IS NOT NULL
        ${petFilter}
      GROUP BY u.id, u.nickname, us.current_streak, usl.current_level, usl.total_scans
      ORDER BY weekly_scans DESC
      LIMIT 5
    `);

    const scanners = rows.map((r, i) => ({
      rank: i + 1,
      nickname: r.nickname,
      weeklyScans: r.weekly_scans,
      streak: r.streak,
      level: r.level,
      totalScans: r.total_scans,
      badge: getBadgeFromLevel(r.level),
    }));

    res.json({ scanners });
  } catch (error) {
    next(error);
  }
});

function getBadgeFromLevel(level) {
  if (level >= 10) return 'Master';
  if (level >= 7) return 'Expert';
  if (level >= 4) return 'Advanced';
  if (level >= 2) return 'Intermediate';
  return 'Beginner';
}

function getTimeAgo(date) {
  const now = Date.now();
  const then = new Date(date).getTime();
  const diffMin = Math.floor((now - then) / 60000);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

module.exports = router;
