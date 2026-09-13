const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const { query } = require('../database/connection');
const { authenticateToken } = require('../middleware/auth');
const { grantTokens } = require('../services/tokenService');

// All pet routes require authentication
router.use(authenticateToken);

// Normalize MySQL booleans (0/1) to true/false for JSON response
function normalizePet(pet) {
  if (pet) {
    pet.is_primary = !!pet.is_primary;
  }
  return pet;
}

// Validation
const validatePet = [
  body('name').trim().isLength({ min: 1, max: 100 }),
  body('petType').isIn(['dog', 'cat']),
  body('breed').optional().trim().isLength({ max: 100 }),
  body('ageMonths').optional().isInt({ min: 0, max: 360 }),
  body('weightKg').optional().isFloat({ min: 0.1, max: 150 }),
  body('sex').optional().isIn(['male', 'female', 'neutered_male', 'spayed_female']),
  body('activityLevel').optional().isIn(['low', 'moderate', 'high'])
];

/**
 * GET /api/pets
 * Get all pets for current user
 */
router.get('/', async (req, res, next) => {
  try {
    const pets = await query(
      `SELECT p.*, 
        (SELECT COUNT(*) FROM pet_health_conditions WHERE pet_id = p.id) as condition_count
       FROM pets p 
       WHERE p.user_id = ? 
       ORDER BY p.is_primary DESC, p.created_at DESC`,
      [req.user.id]
    );

    // Get conditions for each pet
    for (const pet of pets) {
      normalizePet(pet);
      pet.healthConditions = await query(
        'SELECT id, condition_type, severity, notes FROM pet_health_conditions WHERE pet_id = ?',
        [pet.id]
      );
    }

    res.json({ pets });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/pets/:id
 * Get specific pet
 */
router.get('/:id', async (req, res, next) => {
  try {
    const pets = await query(
      'SELECT * FROM pets WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );

    if (pets.length === 0) {
      return res.status(404).json({ error: 'Pet not found' });
    }

    const pet = normalizePet(pets[0]);

    // Get health conditions
    pet.healthConditions = await query(
      'SELECT id, condition_type, severity, notes FROM pet_health_conditions WHERE pet_id = ?',
      [pet.id]
    );

    res.json({ pet });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/pets
 * Create new pet
 */
router.post('/', validatePet, async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, petType, breed, ageMonths, weightKg, sex, activityLevel, healthConditions } = req.body;
    const petId = uuidv4();

    // If no other pet is currently primary, this one becomes primary
    const primaryExists = await query('SELECT id FROM pets WHERE user_id = ? AND is_primary = TRUE LIMIT 1', [req.user.id]);
    const isPrimary = primaryExists.length === 0;

    // Create pet
    await query(
      `INSERT INTO pets (id, user_id, name, pet_type, breed, age_months, weight_kg, sex, activity_level, is_primary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [petId, req.user.id, name, petType, breed || null, ageMonths || null, weightKg || null, sex || null, activityLevel || 'moderate', isPrimary]
    );

    // Add health conditions if provided
    if (healthConditions && Array.isArray(healthConditions)) {
      for (const condition of healthConditions) {
        await query(
          'INSERT INTO pet_health_conditions (id, pet_id, condition_type, severity, notes) VALUES (?, ?, ?, ?, ?)',
          [uuidv4(), petId, condition.type, condition.severity || 'moderate', condition.notes || null]
        );
      }
    }

    // Fetch created pet
    const [pet] = await query('SELECT * FROM pets WHERE id = ?', [petId]);
    normalizePet(pet);
    pet.healthConditions = await query(
      'SELECT id, condition_type, severity, notes FROM pet_health_conditions WHERE pet_id = ?',
      [petId]
    );

    res.status(201).json({ pet });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/pets/:id
 * Update pet
 */
router.put('/:id', validatePet, async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    // Verify ownership
    const existing = await query('SELECT id FROM pets WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Pet not found' });
    }

    const { name, petType, breed, ageMonths, weightKg, sex, activityLevel, healthConditions } = req.body;

    await query(
      `UPDATE pets SET name = ?, pet_type = ?, breed = ?, age_months = ?, weight_kg = ?, sex = ?, activity_level = ?
       WHERE id = ?`,
      [name, petType, breed || null, ageMonths || null, weightKg || null, sex || null, activityLevel || 'moderate', req.params.id]
    );

    // Sync health conditions if provided (replace all)
    if (healthConditions && Array.isArray(healthConditions)) {
      await query('DELETE FROM pet_health_conditions WHERE pet_id = ?', [req.params.id]);
      for (const condition of healthConditions) {
        const condType = condition.conditionType || condition.type;
        await query(
          'INSERT INTO pet_health_conditions (id, pet_id, condition_type, severity, notes) VALUES (?, ?, ?, ?, ?)',
          [uuidv4(), req.params.id, condType, condition.severity || 'moderate', condition.notes || null]
        );
      }
    }

    // Fetch updated pet
    const [pet] = await query('SELECT * FROM pets WHERE id = ?', [req.params.id]);
    normalizePet(pet);
    pet.healthConditions = await query(
      'SELECT id, condition_type, severity, notes FROM pet_health_conditions WHERE pet_id = ?',
      [req.params.id]
    );

    res.json({ pet });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/pets/:id
 * Delete pet
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const [pet] = await query('SELECT is_primary FROM pets WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!pet) {
      return res.status(404).json({ error: 'Pet not found' });
    }

    await query('DELETE FROM pets WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);

    if (pet.is_primary) {
      await query(
        'UPDATE pets SET is_primary = TRUE WHERE user_id = ? AND is_primary = FALSE ORDER BY created_at ASC LIMIT 1',
        [req.user.id]
      );
    }

    res.json({ message: 'Pet deleted successfully' });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/pets/:id/primary
 * Set pet as primary
 */
router.post('/:id/primary', async (req, res, next) => {
  try {
    // Verify ownership
    const existing = await query('SELECT id FROM pets WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Pet not found' });
    }

    // Remove primary from all user's pets
    await query('UPDATE pets SET is_primary = FALSE WHERE user_id = ?', [req.user.id]);
    
    // Set this pet as primary
    await query('UPDATE pets SET is_primary = TRUE WHERE id = ?', [req.params.id]);

    res.json({ message: 'Primary pet updated' });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/pets/:id/conditions
 * Add health condition to pet
 */
router.post('/:id/conditions', async (req, res, next) => {
  try {
    const { conditionType, severity, notes } = req.body;

    // Verify ownership
    const existing = await query('SELECT id FROM pets WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Pet not found' });
    }

    const conditionId = uuidv4();
    await query(
      'INSERT INTO pet_health_conditions (id, pet_id, condition_type, severity, notes) VALUES (?, ?, ?, ?, ?)',
      [conditionId, req.params.id, conditionType, severity || 'moderate', notes || null]
    );

    const [condition] = await query('SELECT * FROM pet_health_conditions WHERE id = ?', [conditionId]);

    res.status(201).json({ condition });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Condition already added' });
    }
    next(error);
  }
});

/**
 * DELETE /api/pets/:id/conditions/:conditionId
 * Remove health condition from pet
 */
router.delete('/:id/conditions/:conditionId', async (req, res, next) => {
  try {
    // Verify ownership via pet
    const existing = await query('SELECT id FROM pets WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Pet not found' });
    }

    await query('DELETE FROM pet_health_conditions WHERE id = ? AND pet_id = ?', [req.params.conditionId, req.params.id]);

    res.json({ message: 'Condition removed' });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/pets/:id/photo
 * Upload pet photo to R2
 */
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const imageService = require('../services/imageService');

router.post('/:id/photo', upload.single('photo'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No photo file provided' });
    }

    const pets = await query('SELECT id FROM pets WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (pets.length === 0) {
      return res.status(404).json({ error: 'Pet not found' });
    }

    const key = `pets/${req.params.id}.jpg`;
    const photoUrl = await imageService.uploadToR2(req.file.buffer, key, req.file.mimetype);

    await query('UPDATE pets SET photo_url = ? WHERE id = ?', [photoUrl, req.params.id]);

    res.json({ photo_url: photoUrl });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/pets/:id/current-food
 * Get the current food for a pet
 */
router.get('/:id/current-food', async (req, res, next) => {
  try {
    const existing = await query('SELECT id FROM pets WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Pet not found' });
    }

    const [food] = await query(
      `SELECT pf.*, p.name as product_display_name, p.brand, p.image_url, p.barcode
       FROM pet_foods pf
       LEFT JOIN products p ON pf.product_id = p.id
       WHERE pf.pet_id = ? AND pf.is_current = TRUE
       LIMIT 1`,
      [req.params.id]
    );

    if (!food) {
      return res.json({ currentFood: null });
    }

    // Calculate days on this food
    const startedAt = new Date(food.started_at);
    const now = new Date();
    const daysOnFood = Math.floor((now - startedAt) / (1000 * 60 * 60 * 24)) + 1;

    res.json({
      currentFood: {
        id: food.id,
        productId: food.product_id,
        scanId: food.scan_id,
        productName: food.product_name,
        brand: food.brand || null,
        imageUrl: food.image_url || null,
        barcode: food.barcode || null,
        startedAt: food.started_at,
        daysOnFood,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/pets/:id/current-food
 * Set the current food for a pet
 * Body: { productId?, scanId?, productName, brand? }
 */
router.post('/:id/current-food', async (req, res, next) => {
  try {
    const existing = await query('SELECT id FROM pets WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Pet not found' });
    }

    const { productId, scanId, productName, brand } = req.body;
    if (!productName) {
      return res.status(400).json({ error: 'productName is required' });
    }

    // End any current food
    await query(
      'UPDATE pet_foods SET is_current = FALSE, ended_at = CURDATE(), updated_at = CURRENT_TIMESTAMP WHERE pet_id = ? AND is_current = TRUE',
      [req.params.id]
    );

    // Insert new current food
    const foodId = uuidv4();
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    await query(
      `INSERT INTO pet_foods (id, pet_id, product_id, scan_id, product_name, is_current, started_at)
       VALUES (?, ?, ?, ?, ?, TRUE, ?)`,
      [foodId, req.params.id, productId || null, scanId || null, productName, today]
    );

    console.log(`🍽️  [Pet Food] Set current food for pet=${req.params.id}: "${productName}" (food_id=${foodId})`);

    res.status(201).json({
      currentFood: {
        id: foodId,
        productId: productId || null,
        scanId: scanId || null,
        productName,
        brand: brand || null,
        startedAt: today,
        daysOnFood: 1,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/pets/:id/current-food
 * Change to a different food (ends previous, starts new)
 * Body: { productId?, scanId?, productName, brand? }
 */
router.put('/:id/current-food', async (req, res, next) => {
  try {
    const existing = await query('SELECT id FROM pets WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Pet not found' });
    }

    const { productId, scanId, productName, brand } = req.body;
    if (!productName) {
      return res.status(400).json({ error: 'productName is required' });
    }

    // End current food
    await query(
      'UPDATE pet_foods SET is_current = FALSE, ended_at = CURDATE(), updated_at = CURRENT_TIMESTAMP WHERE pet_id = ? AND is_current = TRUE',
      [req.params.id]
    );

    // Insert new
    const foodId = uuidv4();
    const today = new Date().toISOString().split('T')[0];
    await query(
      `INSERT INTO pet_foods (id, pet_id, product_id, scan_id, product_name, is_current, started_at)
       VALUES (?, ?, ?, ?, ?, TRUE, ?)`,
      [foodId, req.params.id, productId || null, scanId || null, productName, today]
    );

    console.log(`🍽️  [Pet Food] Changed food for pet=${req.params.id}: "${productName}" (food_id=${foodId})`);

    res.status(200).json({
      currentFood: {
        id: foodId,
        productId: productId || null,
        scanId: scanId || null,
        productName,
        brand: brand || null,
        startedAt: today,
        daysOnFood: 1,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/pets/:id/food-history
 * Get full food history for a pet
 */
router.get('/:id/food-history', async (req, res, next) => {
  try {
    const existing = await query('SELECT id FROM pets WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Pet not found' });
    }

    const foods = await query(
      `SELECT pf.*, p.name as product_display_name, p.brand, p.image_url, p.barcode
       FROM pet_foods pf
       LEFT JOIN products p ON pf.product_id = p.id
       WHERE pf.pet_id = ?
       ORDER BY pf.is_current DESC, pf.started_at DESC`,
      [req.params.id]
    );

    const history = foods.map(f => {
      const startedAt = new Date(f.started_at);
      const endedAt = f.ended_at ? new Date(f.ended_at) : new Date();
      const days = Math.floor((endedAt - startedAt) / (1000 * 60 * 60 * 24));
      return {
        id: f.id,
        productId: f.product_id,
        scanId: f.scan_id,
        productName: f.product_name,
        brand: f.brand || null,
        imageUrl: f.image_url || null,
        isCurrent: !!f.is_current,
        startedAt: f.started_at,
        endedAt: f.ended_at,
        days,
      };
    });

    res.json({ history });
  } catch (error) {
    next(error);
  }
});

// ══════════════════════════════════════════════
// Daily Check-in Endpoints
// ══════════════════════════════════════════════

/**
 * GET /api/pets/:id/checkins/summary
 * Get check-in summary (this week)
 */
router.get('/:id/checkins/summary', async (req, res, next) => {
  try {
    const existing = await query('SELECT id FROM pets WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (existing.length === 0) return res.status(404).json({ error: 'Pet not found' });

    // Last 7 days
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const fromDate = sevenDaysAgo.toISOString().split('T')[0];

    const checkins = await query(
      'SELECT stool_score, appetite, vomiting, itching FROM daily_checkins WHERE pet_id = ? AND date >= ?',
      [req.params.id, fromDate]
    );

    if (checkins.length === 0) {
      return res.json({ summary: null, checkinCount: 0 });
    }

    const avgStool = checkins.reduce((sum, c) => sum + (c.stool_score || 0), 0) / checkins.length;
    const vomitCount = checkins.filter(c => c.vomiting).length;
    const itchCount = checkins.filter(c => c.itching).length;

    res.json({
      summary: {
        avgStoolScore: Math.round(avgStool * 10) / 10,
        vomitCount,
        itchCount,
        totalCheckins: checkins.length,
        period: '7d',
      },
      checkinCount: checkins.length,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/pets/:id/checkins?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Get check-ins for a date range (default: last 30 days)
 */
router.get('/:id/checkins', async (req, res, next) => {
  try {
    const existing = await query('SELECT id FROM pets WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (existing.length === 0) return res.status(404).json({ error: 'Pet not found' });

    const to = req.query.to || new Date().toISOString().split('T')[0];
    const fromDefault = new Date();
    fromDefault.setDate(fromDefault.getDate() - 30);
    const from = req.query.from || fromDefault.toISOString().split('T')[0];

    const checkins = await query(
      `SELECT dc.*, pf.product_name as food_name
       FROM daily_checkins dc
       LEFT JOIN pet_foods pf ON dc.pet_food_id = pf.id
       WHERE dc.pet_id = ? AND dc.date BETWEEN ? AND ?
       ORDER BY dc.date DESC`,
      [req.params.id, from, to]
    );

    res.json({
      checkins: checkins.map(c => ({
        id: c.id,
        date: c.date,
        stoolScore: c.stool_score,
        appetite: c.appetite,
        vomiting: !!c.vomiting,
        itching: !!c.itching,
        notes: c.notes,
        foodName: c.food_name,
      })),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/pets/:id/checkins
 * Save a daily health check-in + award tokens + update streak
 */
router.post('/:id/checkins', async (req, res, next) => {
  try {
    const petId = req.params.id;
    const userId = req.user.id;

    // Verify ownership
    const [pet] = await query('SELECT id, name FROM pets WHERE id = ? AND user_id = ?', [petId, userId]);
    if (!pet) return res.status(404).json({ error: 'Pet not found' });

    const { stoolScore, appetite, vomiting, itching, notes, localDate } = req.body;
    if (!localDate) return res.status(400).json({ error: 'localDate is required' });
    if (!stoolScore || stoolScore < 1 || stoolScore > 5) {
      return res.status(400).json({ error: 'stoolScore (1-5) is required' });
    }

    // Get current food if any (for linking)
    const [currentFood] = await query(
      'SELECT id FROM pet_foods WHERE pet_id = ? AND is_current = TRUE LIMIT 1',
      [petId]
    );

    const checkinId = uuidv4();
    try {
      await query(
        `INSERT INTO daily_checkins (id, pet_id, pet_food_id, date, stool_score, appetite, vomiting, itching, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [checkinId, petId, currentFood?.id || null, localDate, stoolScore, appetite || 'normal', vomiting ? 1 : 0, itching ? 1 : 0, notes || null]
      );
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'already_checked_in', message: 'Already checked in for this date' });
      }
      throw e;
    }

    // ── Token + Streak logic ──

    // Check if token already awarded for this localDate
    let tokensAwarded = 0;
    const [existingTx] = await query(
      `SELECT id FROM token_transactions WHERE user_id = ? AND type = 'checkin' AND DATE(created_at) = ? LIMIT 1`,
      [userId, localDate]
    );
    if (!existingTx) {
      await grantTokens(userId, 5, 'checkin', 'Health check-in 🦴×5', checkinId);
      tokensAwarded = 5;
    }

    // Update streak
    let streakInfo = { currentStreak: 0, longestStreak: 0, streakBonus: 0 };
    const [streakRow] = await query('SELECT current_streak, longest_streak, last_checkin_date FROM user_streaks WHERE user_id = ?', [userId]);

    if (streakRow) {
      const lastDate = streakRow.last_checkin_date ? new Date(streakRow.last_checkin_date).toISOString().split('T')[0] : null;
      const localDateStr = localDate; // YYYY-MM-DD from client

      let newStreak = streakRow.current_streak;

      if (lastDate === localDateStr) {
        // Same day — no change
      } else {
        // Check if yesterday
        const yesterday = new Date(localDateStr);
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = yesterday.toISOString().split('T')[0];

        if (lastDate === yesterdayStr) {
          newStreak = streakRow.current_streak + 1;
        } else {
          newStreak = 1; // Reset
        }
      }

      const newLongest = Math.max(newStreak, streakRow.longest_streak);

      await query(
        'UPDATE user_streaks SET current_streak = ?, longest_streak = ?, last_checkin_date = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?',
        [newStreak, newLongest, localDateStr, userId]
      );

      // Check streak milestones
      let streakBonus = 0;
      const milestones = [
        { days: 7, reward: 10 },
        { days: 30, reward: 30 },
        { days: 100, reward: 50 },
      ];

      for (const m of milestones) {
        if (newStreak === m.days) {
          // Only award if we haven't already (check by reference_id)
          const [existing] = await query(
            `SELECT id FROM token_transactions WHERE user_id = ? AND type = 'streak' AND reference_id = ? LIMIT 1`,
            [userId, `streak_${m.days}`]
          );
          if (!existing) {
            await grantTokens(userId, m.reward, 'streak', `${m.days}-day streak! 🔥 🦴×${m.reward}`, `streak_${m.days}`);
            streakBonus = m.reward;
          }
        }
      }

      streakInfo = { currentStreak: newStreak, longestStreak: newLongest, streakBonus };
    }

    console.log(`📝 [CheckIn] pet=${petId} stool=${stoolScore} appetite=${appetite} streak=${streakInfo.currentStreak}`);

    res.status(201).json({
      checkin: {
        id: checkinId,
        petId,
        date: localDate,
        stoolScore,
        appetite: appetite || 'normal',
        vomiting: !!vomiting,
        itching: !!itching,
        notes: notes || null,
      },
      tokensAwarded,
      streakInfo,
    });
  } catch (error) {
    next(error);
  }
});

// ══════════════════════════════════════════════
// Nutrition Passport & Insights Endpoints
// ══════════════════════════════════════════════

/**
 * GET /api/pets/:id/passport
 * Nutrition Passport: food timeline with health stats per food period
 */
router.get('/:id/passport', async (req, res, next) => {
  try {
    const existing = await query('SELECT id FROM pets WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (existing.length === 0) return res.status(404).json({ error: 'Pet not found' });

    // Get all foods for this pet, ordered by started_at
    const foods = await query(
      `SELECT pf.*, p.brand, p.image_url, p.raw_ingredients_text
       FROM pet_foods pf
       LEFT JOIN products p ON pf.product_id = p.id
       WHERE pf.pet_id = ?
       ORDER BY pf.started_at ASC`,
      [req.params.id]
    );

    // For each food period, get check-in stats
    const timeline = [];
    for (const food of foods) {
      const fromDate = food.started_at;
      const toDate = food.ended_at || new Date().toISOString().split('T')[0];
      
      const checkins = await query(
        'SELECT stool_score, vomiting, itching FROM daily_checkins WHERE pet_id = ? AND date BETWEEN ? AND ?',
        [req.params.id, fromDate, toDate]
      );
      
      const avgStool = checkins.length > 0
        ? Math.round((checkins.reduce((s, c) => s + (c.stool_score || 0), 0) / checkins.length) * 10) / 10
        : null;
      const vomitCount = checkins.filter(c => c.vomiting).length;
      const itchCount = checkins.filter(c => c.itching).length;

      timeline.push({
        id: food.id,
        productName: food.product_name,
        brand: food.brand || null,
        imageUrl: food.image_url || null,
        isCurrent: !!food.is_current,
        startedAt: food.started_at,
        endedAt: food.ended_at,
        daysOnFood: Math.floor((new Date(toDate) - new Date(fromDate)) / (1000 * 60 * 60 * 24)),
        stats: {
          checkinCount: checkins.length,
          avgStoolScore: avgStool,
          vomitCount,
          itchCount,
        },
        hasIngredients: !!food.raw_ingredients_text,
      });
    }

    res.json({ timeline });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/pets/:id/insights
 * Ingredient-symptom correlation analysis across food periods
 */
router.get('/:id/insights', async (req, res, next) => {
  try {
    const existing = await query('SELECT id FROM pets WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (existing.length === 0) return res.status(404).json({ error: 'Pet not found' });

    // Get all foods with ingredients
    const foods = await query(
      `SELECT pf.id, pf.product_name, pf.started_at, pf.ended_at, pf.is_current, p.raw_ingredients_text, p.brand
       FROM pet_foods pf
       LEFT JOIN products p ON pf.product_id = p.id
       WHERE pf.pet_id = ? AND p.raw_ingredients_text IS NOT NULL
       ORDER BY pf.started_at ASC`,
      [req.params.id]
    );

    if (foods.length < 2) {
      return res.json({ insights: [], message: 'Need at least 2 food periods with ingredients for insights' });
    }

    // Build food period stats
    const foodStats = [];
    for (const food of foods) {
      const fromDate = food.started_at;
      const toDate = food.ended_at || new Date().toISOString().split('T')[0];
      
      const checkins = await query(
        'SELECT stool_score, vomiting, itching FROM daily_checkins WHERE pet_id = ? AND date BETWEEN ? AND ?',
        [req.params.id, fromDate, toDate]
      );

      if (checkins.length < 3) continue;

      const ingredients = food.raw_ingredients_text
        .split(',')
        .map(i => i.trim().toLowerCase())
        .filter(Boolean);

      const hasChicken = ingredients.some(i => i.includes('chicken'));
      const hasBeef = ingredients.some(i => i.includes('beef'));
      const hasFish = ingredients.some(i => i.includes('fish') || i.includes('salmon') || i.includes('tuna'));
      const hasLamb = ingredients.some(i => i.includes('lamb'));
      const hasGrain = ingredients.some(i => i.includes('corn') || i.includes('wheat') || i.includes('soy'));
      
      const avgStool = checkins.reduce((s, c) => s + (c.stool_score || 0), 0) / checkins.length;
      const itchRate = checkins.filter(c => c.itching).length / checkins.length;
      const vomitRate = checkins.filter(c => c.vomiting).length / checkins.length;

      foodStats.push({
        foodId: food.id,
        productName: food.product_name,
        brand: food.brand,
        checkinCount: checkins.length,
        avgStool: Math.round(avgStool * 10) / 10,
        itchRate: Math.round(itchRate * 100),
        vomitRate: Math.round(vomitRate * 100),
        tags: {
          chicken: hasChicken,
          beef: hasBeef,
          fish: hasFish,
          lamb: hasLamb,
          grain: hasGrain,
        },
      });
    }

    if (foodStats.length < 2) {
      return res.json({ insights: [], message: 'Need more check-in data across food periods' });
    }

    // Generate insights by comparing foods with/without each ingredient tag
    const insights = [];
    const tagNames = { chicken: '🍗 Chicken', beef: '🥩 Beef', fish: '🐟 Fish', lamb: '🐑 Lamb', grain: '🌾 Grains' };
    
    for (const [tag, label] of Object.entries(tagNames)) {
      const withTag = foodStats.filter(f => f.tags[tag]);
      const withoutTag = foodStats.filter(f => !f.tags[tag]);
      
      if (withTag.length === 0 || withoutTag.length === 0) continue;
      
      const avgItchWith = withTag.reduce((s, f) => s + f.itchRate, 0) / withTag.length;
      const avgItchWithout = withoutTag.reduce((s, f) => s + f.itchRate, 0) / withoutTag.length;
      const avgStoolWith = withTag.reduce((s, f) => s + f.avgStool, 0) / withTag.length;
      const avgStoolWithout = withoutTag.reduce((s, f) => s + f.avgStool, 0) / withoutTag.length;
      
      const itchDiff = avgItchWith - avgItchWithout;
      const stoolDiff = avgStoolWith - avgStoolWithout;
      
      if (Math.abs(itchDiff) > 15 || Math.abs(stoolDiff) > 0.5) {
        insights.push({
          ingredient: tag,
          label,
          type: itchDiff > 15 ? 'itch_correlation' : stoolDiff < -0.5 ? 'stool_negative' : stoolDiff > 0.5 ? 'stool_positive' : 'mixed',
          summary: itchDiff > 15
            ? `${label} may be linked to increased itching`
            : stoolDiff < -0.5
            ? `${label} may be linked to worse stool quality`
            : stoolDiff > 0.5
            ? `${label} appears to improve stool quality`
            : `Mixed results with ${label}`,
          data: {
            withIngredient: {
              foods: withTag.map(f => f.productName),
              avgItchRate: Math.round(avgItchWith),
              avgStoolScore: Math.round(avgStoolWith * 10) / 10,
            },
            withoutIngredient: {
              foods: withoutTag.map(f => f.productName),
              avgItchRate: Math.round(avgItchWithout),
              avgStoolScore: Math.round(avgStoolWithout * 10) / 10,
            },
          },
          disclaimer: 'This is a correlation, not proof of causation. Consult your veterinarian.',
        });
      }
    }

    res.json({ insights });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

