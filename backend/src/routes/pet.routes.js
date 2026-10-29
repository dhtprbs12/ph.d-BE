const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const { query } = require('../database/connection');
const { authenticateToken } = require('../middleware/auth');
const { grantTokens } = require('../services/tokenService');
const ingredientAnalyzer = require('../services/ingredientAnalyzer');

// Ingredient categories worth correlating with symptoms. Vitamins, minerals and
// "other" (fats, flavors, preservatives) are near-identical across foods.
const INSIGHT_CATEGORIES = new Set(['protein', 'grain', 'vegetable', 'fruit']);

// A symptom only splits foods when the spread is this wide.
const ITCH_SPREAD = 15;   // percentage points of flagged check-ins
const VOMIT_SPREAD = 15;
const STOOL_SPREAD = 0.5; // average 1-5 stool score

const MEAL_SLOTS = new Set(['morning', 'lunch', 'evening', 'snack']);
const APPETITES = new Set(['low', 'normal', 'high']);
const ITCH_VALUES = new Set(['scratching', 'licking', 'none']);
const VOMIT_VALUES = new Set(['food', 'yellow', 'none']);

function calendarDate(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d = String(value.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

function previousDate(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

function mapLog(row) {
  return {
    id: row.id,
    date: calendarDate(row.date),
    loggedAt: row.logged_at instanceof Date ? row.logged_at.toISOString() : (row.logged_at || null),
    logType: row.log_type || 'health',
    mealSlot: row.meal_slot || null,
    stoolScore: row.stool_score == null ? null : Number(row.stool_score),
    appetite: row.appetite || null,
    vomiting: row.vomiting || null,
    itching: row.itching || null,
    notes: row.notes || null,
    petFoodId: row.pet_food_id || null,
    foodName: row.food_name || null,
    foodImageUrl: row.food_image_url || null,
  };
}

function summarizeHealth(rows) {
  const health = rows.filter(row => (row.log_type || 'health') === 'health');
  const scored = health.filter(row => row.stool_score != null && Number(row.stool_score) > 0);
  const avgStool = scored.length
    ? Math.round((scored.reduce((sum, row) => sum + Number(row.stool_score), 0) / scored.length) * 10) / 10
    : null;
  const itchDays = new Set(
    health.filter(row => row.itching === 'scratching' || row.itching === 'licking').map(row => calendarDate(row.date))
  ).size;
  const foodVomitDays = new Set(
    health.filter(row => row.vomiting === 'food').map(row => calendarDate(row.date))
  ).size;
  const vomitDays = new Set(
    health.filter(row => row.vomiting === 'food' || row.vomiting === 'yellow').map(row => calendarDate(row.date))
  ).size;
  const dayCount = new Set(health.map(row => calendarDate(row.date))).size;
  return { count: health.length, avgStool, itchDays, foodVomitDays, vomitDays, dayCount };
}

// Two foods can differ in a dozen ingredients. Naming all of them is noise, so
// keep the ones listed earliest (ingredient lists are ordered by weight).
const MAX_SUSPECTS = 3;

/** "sweet potato" -> "Sweet Potato". Sources are stored lowercase. */
function titleCaseSource(source) {
  return String(source || '')
    .split(' ')
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** ["a", "b", "c"] -> "a, b and c" */
function joinPhrases(parts) {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * Split foods into a worse-off group and a better-off group for one symptom.
 * @param {Array} foods - food stats
 * @param {(food: object) => number} valueOf
 * @param {number} spread - minimum max-min difference to bother splitting
 * @param {boolean} higherIsWorse - true for itch/vomit rates, false for stool score
 * @returns {{ worse: Array, better: Array }|null}
 */
function splitFoodsBySymptom(foods, valueOf, spread, higherIsWorse) {
  const values = foods.map(valueOf);
  const max = Math.max(...values);
  const min = Math.min(...values);
  if (max - min <= spread) return null;

  const midpoint = (max + min) / 2;
  const worse = foods.filter(f => (higherIsWorse ? valueOf(f) > midpoint : valueOf(f) < midpoint));
  const better = foods.filter(f => (higherIsWorse ? valueOf(f) <= midpoint : valueOf(f) >= midpoint));
  if (worse.length === 0 || better.length === 0) return null;
  return { worse, better };
}

/**
 * Ingredient sources in every food of `present` and in none of `absent`, most
 * prominent first.
 */
function ingredientsUniqueTo(present, absent) {
  if (present.length === 0) return [];
  const shared = [...present[0].ingredients].filter(source =>
    present.every(f => f.ingredients.has(source))
  );
  const unique = shared.filter(source => absent.every(f => !f.ingredients.has(source)));
  const rankOf = (source) => Math.min(...present.map(f => f.positions.get(source)));
  return unique.sort((a, b) => rankOf(a) - rankOf(b));
}

function groupAverages(foods) {
  const avg = (pick) => foods.reduce((sum, f) => sum + pick(f), 0) / foods.length;
  return {
    foods: foods.map(f => ({
      name: f.productName,
      isCurrent: f.isCurrent,
      imageUrl: f.imageUrl || null,
    })),
    avgItchRate: Math.round(avg(f => f.itchRate)),
    avgVomitRate: Math.round(avg(f => f.vomitRate)),
    avgStoolScore: (() => {
      const scored = foods.filter(food => food.avgStool != null);
      if (!scored.length) return null;
      return Math.round(scored.reduce((sum, food) => sum + food.avgStool, 0) / scored.length * 10) / 10;
    })(),
  };
}

/**
 * Build one insight card: ingredients that only the symptomatic foods share.
 * @returns {object|null}
 */
function buildInsight(foods, split, type, summaryFor) {
  if (!split) return null;
  const ranked = ingredientsUniqueTo(split.worse, split.better);
  if (ranked.length === 0) return null;

  const suspects = ranked.slice(0, MAX_SUSPECTS);
  const label = suspects.map(titleCaseSource).join(' + ');
  const withGroup = foods.filter(f => suspects.every(source => f.ingredients.has(source)));
  const withoutGroup = foods.filter(f => !suspects.every(source => f.ingredients.has(source)));
  if (withGroup.length === 0 || withoutGroup.length === 0) return null;

  let disclaimer = 'This is a correlation, not proof of causation. Consult your veterinarian.';
  if (ranked.length > suspects.length) {
    disclaimer = `These foods differ in ${ranked.length} ingredients — these are the most prominent ones. ${disclaimer}`;
  } else if (suspects.length > 1) {
    disclaimer = `These ingredients always appear together in your pet's foods, so we cannot tell them apart yet. ${disclaimer}`;
  }

  const records = [...withGroup, ...withoutGroup]
    .sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime())
    .map(food => ({
      name: food.productName,
      isCurrent: food.isCurrent,
      imageUrl: food.imageUrl || null,
      dietTags: food.dietTags || null,
      lifeStage: food.lifeStage || null,
      startedAt: food.startedAt,
      endedAt: food.endedAt,
      primaryProteins: food.primaryProteins || null,
      ingredients: food.ingredientsText || null,
      avgStool: food.avgStool,
      itchDays: food.itchDays,
      vomitDays: food.vomitDays,
    }));

  return {
    ingredient: suspects.join(','),
    label,
    type,
    summary: summaryFor(label, suspects.length),
    data: {
      withIngredient: groupAverages(withGroup),
      withoutIngredient: groupAverages(withoutGroup),
      records,
    },
    disclaimer,
  };
}

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

    // Initialize character for this pet
    await query('INSERT INTO pet_equipped (pet_id, character_type) VALUES (?, ?)', [petId, petType === 'cat' ? 'cat' : 'dog']);

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
      `SELECT pf.*, p.name as product_display_name, p.brand, p.manufacturer, p.image_url, p.barcode
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

    const [pendingLookup] = await query(
      `SELECT id FROM lookup_requests
       WHERE pet_food_id = ? AND status IN ('queued', 'searching', 'needs_choice')
       LIMIT 1`,
      [food.id],
    );

    res.json({
      currentFood: {
        id: food.id,
        productId: food.product_id,
        scanId: food.scan_id,
        productName: food.product_name,
        brand: food.brand || null,
        manufacturer: food.manufacturer || null,
        imageUrl: food.image_url || null,
        barcode: food.barcode || null,
        startedAt: food.started_at,
        daysOnFood,
        analysisPending: !!pendingLookup,
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

    await query(
      'UPDATE pet_foods SET is_current = FALSE, ended_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE pet_id = ? AND is_current = TRUE',
      [req.params.id]
    );

    const foodId = uuidv4();
    await query(
      `INSERT INTO pet_foods (id, pet_id, product_id, scan_id, product_name, is_current, started_at)
       VALUES (?, ?, ?, ?, ?, TRUE, CURRENT_TIMESTAMP)`,
      [foodId, req.params.id, productId || null, scanId || null, productName]
    );
    const [savedFood] = await query('SELECT started_at FROM pet_foods WHERE id = ?', [foodId]);

    res.status(201).json({
      currentFood: {
        id: foodId,
        productId: productId || null,
        scanId: scanId || null,
        productName,
        brand: brand || null,
        startedAt: savedFood?.started_at || null,
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

    await query(
      'UPDATE pet_foods SET is_current = FALSE, ended_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE pet_id = ? AND is_current = TRUE',
      [req.params.id]
    );

    const foodId = uuidv4();
    await query(
      `INSERT INTO pet_foods (id, pet_id, product_id, scan_id, product_name, is_current, started_at)
       VALUES (?, ?, ?, ?, ?, TRUE, CURRENT_TIMESTAMP)`,
      [foodId, req.params.id, productId || null, scanId || null, productName]
    );
    const [savedFood] = await query('SELECT started_at FROM pet_foods WHERE id = ?', [foodId]);

    res.status(200).json({
      currentFood: {
        id: foodId,
        productId: productId || null,
        scanId: scanId || null,
        productName,
        brand: brand || null,
        startedAt: savedFood?.started_at || null,
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
      'SELECT date, log_type, stool_score, appetite, vomiting, itching FROM daily_checkins WHERE pet_id = ? AND date >= ?',
      [req.params.id, fromDate]
    );
    const health = summarizeHealth(checkins);

    if (health.count === 0) {
      return res.json({ summary: null, checkinCount: 0 });
    }

    res.json({
      summary: {
        avgStoolScore: health.avgStool,
        vomitCount: health.vomitDays,
        itchCount: health.itchDays,
        totalCheckins: health.count,
        period: '7d',
      },
      checkinCount: health.count,
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

    const recent = Math.min(Math.max(parseInt(req.query.recent, 10) || 0, 0), 20);
    let checkins;
    if (recent) {
      checkins = await query(
        `SELECT dc.*, pf.product_name as food_name, p.image_url as food_image_url
         FROM daily_checkins dc
         LEFT JOIN pet_foods pf ON dc.pet_food_id = pf.id
         LEFT JOIN products p ON pf.product_id = p.id
         WHERE dc.pet_id = ?
         ORDER BY dc.logged_at DESC
         LIMIT ${recent}`,
        [req.params.id]
      );
    } else {
      const to = req.query.to || new Date().toISOString().split('T')[0];
      const fromDefault = new Date();
      fromDefault.setDate(fromDefault.getDate() - 30);
      const from = req.query.from || fromDefault.toISOString().split('T')[0];
      checkins = await query(
        `SELECT dc.*, pf.product_name as food_name, p.image_url as food_image_url
         FROM daily_checkins dc
         LEFT JOIN pet_foods pf ON dc.pet_food_id = pf.id
         LEFT JOIN products p ON pf.product_id = p.id
         WHERE dc.pet_id = ? AND dc.date BETWEEN ? AND ?
         ORDER BY dc.logged_at ASC`,
        [req.params.id, from, to]
      );
    }

    res.json({ checkins: checkins.map(mapLog) });
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

    const { localDate, logType } = req.body;
    if (!localDate || !/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
      return res.status(400).json({ error: 'localDate is required' });
    }
    if (logType !== 'meal' && logType !== 'health') {
      return res.status(400).json({ error: 'logType must be meal or health' });
    }

    const [currentFood] = await query(
      'SELECT id, product_name FROM pet_foods WHERE pet_id = ? AND is_current = TRUE LIMIT 1',
      [petId]
    );
    if (!currentFood) return res.status(400).json({ error: 'Set a current food first' });

    let mealSlot = null;
    let appetite = null;
    let stoolScore = null;
    let itching = null;
    let vomiting = null;
    let notes = null;

    if (logType === 'meal') {
      if (req.body.mealSlot) {
        if (!MEAL_SLOTS.has(req.body.mealSlot)) return res.status(400).json({ error: 'Invalid meal slot' });
        mealSlot = req.body.mealSlot;
      }
      if (req.body.appetite) {
        if (!APPETITES.has(req.body.appetite)) return res.status(400).json({ error: 'Invalid appetite' });
        appetite = req.body.appetite;
      }
    } else {
      if (req.body.stoolScore != null && req.body.stoolScore !== '') {
        const score = Number(req.body.stoolScore);
        if (!Number.isInteger(score) || score < 1 || score > 5) {
          return res.status(400).json({ error: 'stoolScore must be 1-5' });
        }
        stoolScore = score;
      }
      if (req.body.itching) {
        if (!ITCH_VALUES.has(req.body.itching)) return res.status(400).json({ error: 'Invalid itching' });
        itching = req.body.itching;
      }
      if (req.body.vomiting) {
        if (!VOMIT_VALUES.has(req.body.vomiting)) return res.status(400).json({ error: 'Invalid vomiting' });
        vomiting = req.body.vomiting;
      }
      notes = req.body.notes ? String(req.body.notes).trim().slice(0, 500) : null;
      const hasSymptom = (itching && itching !== 'none') || (vomiting && vomiting !== 'none');
      if (stoolScore == null && !hasSymptom && !notes) {
        return res.status(400).json({ error: 'Add a stool score, symptom, or note' });
      }
    }

    const checkinId = uuidv4();
    await query(
      `INSERT INTO daily_checkins
        (id, pet_id, pet_food_id, date, logged_at, log_type, meal_slot, stool_score, appetite, vomiting, itching, notes)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?)`,
      [checkinId, petId, currentFood.id, localDate, logType, mealSlot, stoolScore, appetite, vomiting, itching, notes]
    );

    // ── Token + Streak logic ──

    // Once per pet per phone-local day. Match the check-in date, not the server clock
    // on token_transactions.created_at (evening local check-ins fall on the next UTC date).
    // Welcome-bonus rows are also type 'checkin' but have no check-in reference, so they do not count.
    let tokensAwarded = 0;
    const [existingTx] = await query(
      `SELECT tt.id
       FROM token_transactions tt
       INNER JOIN daily_checkins dc ON dc.id = tt.reference_id
       WHERE tt.user_id = ? AND tt.type = 'checkin' AND dc.date = ? AND dc.pet_id = ?
       LIMIT 1`,
      [userId, localDate, petId]
    );
    if (!existingTx) {
      await grantTokens(userId, 5, 'checkin', 'Daily log 🦴×5', checkinId);
      tokensAwarded = 5;
    }

    // Update streak
    let streakInfo = { currentStreak: 0, longestStreak: 0, streakBonus: 0 };
    const [streakRow] = await query('SELECT current_streak, longest_streak, last_checkin_date FROM user_streaks WHERE user_id = ?', [userId]);

    if (streakRow) {
      const lastDate = calendarDate(streakRow.last_checkin_date);
      const localDateStr = localDate;

      let newStreak = streakRow.current_streak;

      if (lastDate === localDateStr) {
        // Same phone day — no change
      } else {
        const yesterdayStr = previousDate(localDateStr);

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

    const [saved] = await query(
      `SELECT dc.*, pf.product_name as food_name, p.image_url as food_image_url
       FROM daily_checkins dc
       LEFT JOIN pet_foods pf ON dc.pet_food_id = pf.id
       LEFT JOIN products p ON pf.product_id = p.id
       WHERE dc.id = ?`,
      [checkinId]
    );

    res.status(201).json({
      checkin: mapLog(saved),
      tokensAwarded,
      streakInfo,
    });
  } catch (error) {
    next(error);
  }
});

// ══════════════════════════════════════════════
// Nom Nom Notes (pet_notes) + Streak
// ══════════════════════════════════════════════

/**
 * GET /api/pets/:id/streak
 * Get current streak info for the pet's owner
 */
router.get('/:id/streak', authenticateToken, async (req, res, next) => {
  try {
    const [pet] = await query('SELECT id FROM pets WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!pet) return res.status(404).json({ error: 'Pet not found' });

    const [streakRow] = await query(
      'SELECT current_streak, longest_streak, last_checkin_date FROM user_streaks WHERE user_id = ?',
      [req.user.id]
    );

    res.json({
      currentStreak: streakRow?.current_streak || 0,
      longestStreak: streakRow?.longest_streak || 0,
      lastCheckinDate: streakRow?.last_checkin_date || null,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/pets/:id/notes?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Get notes for a date range
 */
router.get('/:id/notes', authenticateToken, async (req, res, next) => {
  try {
    const [pet] = await query('SELECT id FROM pets WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!pet) return res.status(404).json({ error: 'Pet not found' });

    const to = req.query.to || new Date().toISOString().split('T')[0];
    const fromDefault = new Date();
    fromDefault.setDate(fromDefault.getDate() - 30);
    const from = req.query.from || fromDefault.toISOString().split('T')[0];

    const notes = await query(
      'SELECT date, note FROM pet_notes WHERE pet_id = ? AND date BETWEEN ? AND ? ORDER BY date DESC',
      [req.params.id, from, to]
    );

    res.json({
      notes: notes.map(n => ({
        date: typeof n.date === 'string' ? n.date : new Date(n.date).toISOString().split('T')[0],
        note: n.note,
      })),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/pets/:id/notes/:date
 * Upsert a note for a specific date
 */
router.put('/:id/notes/:date', authenticateToken, async (req, res, next) => {
  try {
    const [pet] = await query('SELECT id FROM pets WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!pet) return res.status(404).json({ error: 'Pet not found' });

    const { note } = req.body;
    const dateStr = req.params.date;

    if (!note || !note.trim()) {
      await query('DELETE FROM pet_notes WHERE pet_id = ? AND date = ?', [req.params.id, dateStr]);
      return res.json({ success: true, deleted: true });
    }

    const { v4: uuidv4 } = require('uuid');
    await query(
      `INSERT INTO pet_notes (id, pet_id, date, note) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE note = VALUES(note), updated_at = CURRENT_TIMESTAMP`,
      [uuidv4(), req.params.id, dateStr, note.trim()]
    );

    res.json({ success: true });
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
        'SELECT date, log_type, stool_score, vomiting, itching FROM daily_checkins WHERE pet_id = ? AND pet_food_id = ?',
        [req.params.id, food.id]
      );
      const health = summarizeHealth(checkins);

      timeline.push({
        id: food.id,
        productName: food.product_name,
        brand: food.brand || null,
        imageUrl: food.image_url || null,
        isCurrent: !!food.is_current,
        startedAt: food.started_at,
        endedAt: food.ended_at,
        daysOnFood: Math.max(1, Math.floor((new Date(toDate) - new Date(fromDate)) / (1000 * 60 * 60 * 24)) + 1),
        stats: {
          checkinCount: health.count,
          avgStoolScore: health.avgStool,
          vomitCount: health.vomitDays,
          itchCount: health.itchDays,
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
    const existing = await query('SELECT id, name, pet_type FROM pets WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (existing.length === 0) return res.status(404).json({ error: 'Pet not found' });

    // Get all foods with ingredients
    const foods = await query(
      `SELECT pf.id, pf.product_name, pf.started_at, pf.ended_at, pf.is_current,
              p.raw_ingredients_text, p.brand, p.diet_tags, p.target_life_stage, p.primary_proteins, p.image_url
       FROM pet_foods pf
       LEFT JOIN products p ON pf.product_id = p.id
       WHERE pf.pet_id = ? AND p.raw_ingredients_text IS NOT NULL
       ORDER BY pf.started_at ASC`,
      [req.params.id]
    );

    // Build food period stats. Ingredient lines are parsed the same way the
    // analysis view parses them, so names match ai_assessment_cache keys.
    const foodStats = [];
    const allNames = new Set();
    for (const food of foods) {
      const checkins = await query(
        'SELECT date, log_type, stool_score, vomiting, itching FROM daily_checkins WHERE pet_id = ? AND pet_food_id = ?',
        [req.params.id, food.id]
      );
      const health = summarizeHealth(checkins);
      if (health.count < 3) continue;

      let parsed = [];
      try {
        parsed = ingredientAnalyzer.parseIngredientText(food.raw_ingredients_text);
      } catch {
        continue;
      }
      const positions = new Map();
      parsed.forEach((line, index) => {
        const name = ingredientAnalyzer.normalizeIngredientName(String(line || ''));
        if (!name || positions.has(name)) return;
        positions.set(name, index);
        allNames.add(name);
      });
      if (positions.size === 0) continue;

      const dayCount = health.dayCount || 1;
      foodStats.push({
        foodId: food.id,
        productName: food.product_name,
        isCurrent: !!food.is_current,
        imageUrl: food.image_url || null,
        brand: food.brand,
        dietTags: food.diet_tags,
        lifeStage: food.target_life_stage,
        primaryProteins: food.primary_proteins,
        ingredientsText: food.raw_ingredients_text,
        startedAt: food.started_at,
        endedAt: food.ended_at,
        checkinCount: health.count,
        avgStool: health.avgStool,
        itchDays: health.itchDays,
        foodVomitDays: health.foodVomitDays,
        vomitDays: health.vomitDays,
        itchRate: Math.round((health.itchDays / dayCount) * 100),
        foodVomitRate: Math.round((health.foodVomitDays / dayCount) * 100),
        vomitRate: Math.round((health.vomitDays / dayCount) * 100),
        positions,
      });
    }

    // Category and source come from ai_assessment_cache and are the same for
    // every condition/pet row, so look them up by name only. Foods are compared
    // by source, not by ingredient name: "chicken", "deboned chicken" and
    // "chicken meal" all mean the pet ate chicken.
    const names = [...allNames];
    const metaByName = new Map();
    if (names.length > 0) {
      const placeholders = names.map(() => '?').join(',');
      const rows = await query(
        `SELECT DISTINCT REPLACE(ingredient_normalized, '-', ' ') AS name, category, ingredient_source
         FROM ai_assessment_cache
         WHERE category IS NOT NULL AND REPLACE(ingredient_normalized, '-', ' ') IN (${placeholders})`,
        names
      );
      for (const row of rows) metaByName.set(row.name, row);
    }

    const metaOf = (name) => {
      if (metaByName.has(name)) return metaByName.get(name);
      const singular = ingredientAnalyzer.depluralize(name);
      return singular !== name ? metaByName.get(singular) : undefined;
    };

    for (const food of foodStats) {
      const sourcePositions = new Map();
      const sourceMeta = new Map();
      for (const [name, index] of food.positions) {
        const meta = metaOf(name);
        if (!meta || !INSIGHT_CATEGORIES.has(meta.category) || !meta.ingredient_source) continue;
        const seen = sourcePositions.get(meta.ingredient_source);
        if (seen === undefined || index < seen) {
          sourcePositions.set(meta.ingredient_source, index);
          sourceMeta.set(meta.ingredient_source, meta.category);
        }
      }
      food.ingredients = new Set(sourcePositions.keys());
      food.positions = sourcePositions;
      food.sourceMeta = sourceMeta;
    }

    if (foodStats.length === 0) {
      return res.json({ insights: [], message: 'Need more check-in data', petName: existing[0].name, petType: existing[0].pet_type });
    }

    const { isPlus } = require('../services/billingService');
    const [userRow] = await query('SELECT plus_expires_at FROM users WHERE id = ?', [req.user.id]);
    const userIsPlus = userRow && isPlus(userRow);

    // ── Single-food insight ──
    if (foodStats.length === 1) {
      const food = foodStats[0];
      const dayCount = food.itchRate > 0 || food.foodVomitRate > 0 || food.avgStool != null ? (food.itchDays + food.foodVomitDays > 0 ? 1 : 0) : 0;
      const hasItch = food.itchRate >= ITCH_SPREAD;
      const hasFoodVomit = food.foodVomitRate >= VOMIT_SPREAD;
      const hasBadStool = food.avgStool != null && food.avgStool < 2.5;
      const hasSymptom = hasItch || hasFoodVomit || hasBadStool;

      const phrases = [];
      if (hasItch) phrases.push('itching');
      if (hasFoodVomit) phrases.push('vomiting');
      if (hasBadStool) phrases.push('poor stool');

      // Top 3 sources by weight from protein/grain/vegetable/fruit
      const sorted = [...food.positions.entries()].sort((a, b) => a[1] - b[1]);
      const topSources = sorted.slice(0, 3).map(([source]) => ({
        source,
        category: food.sourceMeta.get(source) || 'other',
      }));

      const label = topSources.map(s => titleCaseSource(s.source)).join(', ');
      const symptomPhrase = joinPhrases(phrases);
      const summary = hasSymptom
        ? `${label} may be linked to ${symptomPhrase}`
        : null;

      const foodRecord = {
        name: food.productName,
        isCurrent: food.isCurrent,
        imageUrl: food.imageUrl || null,
        dietTags: food.dietTags,
        lifeStage: food.lifeStage,
        startedAt: food.startedAt,
        endedAt: food.endedAt,
        primaryProteins: food.primaryProteins,
        ingredients: food.ingredientsText,
        avgStool: food.avgStool,
        itchDays: food.itchDays,
        vomitDays: food.vomitDays,
        checkinCount: food.checkinCount,
      };
      const singleInsight = {
        ingredient: topSources.map(s => s.source).join(','),
        label,
        type: hasSymptom ? (hasItch ? 'itch_correlation' : hasFoodVomit ? 'vomit_correlation' : 'stool_negative') : 'single_food',
        summary: summary || `Health record for ${food.productName}`,
        singleFood: true,
        data: {
          food: foodRecord,
          records: [foodRecord],
          topSources,
          hasSymptom,
          suspectSources: hasSymptom ? topSources.map(s => s.source) : [],
        },
        disclaimer: 'This is a correlation, not proof of causation. Consult your veterinarian.',
      };

      const safeInsight = userIsPlus ? singleInsight : (() => {
        const { data, ...rest } = singleInsight;
        return rest;
      })();

      return res.json({
        insights: hasSymptom ? [safeInsight] : [],
        singleFoodInsight: safeInsight,
        plus: !!userIsPlus,
        petName: existing[0].name,
        petType: existing[0].pet_type,
        foodCount: 1,
      });
    }

    // ── Multi-food insights ──

    // Every symptom that clears its threshold becomes a candidate finding.
    const candidates = [];

    const itchSplit = splitFoodsBySymptom(foodStats, f => f.itchRate, ITCH_SPREAD, true);
    if (itchSplit) {
      candidates.push({ split: itchSplit, type: 'itch_correlation', phrase: 'increased itching' });
    }

    const vomitSplit = splitFoodsBySymptom(foodStats, f => f.vomitRate, VOMIT_SPREAD, true);
    if (vomitSplit) {
      candidates.push({ split: vomitSplit, type: 'vomit_correlation', phrase: 'more vomiting' });
    }

    const stoolFoods = foodStats.filter(food => food.avgStool != null);
    const stoolSplit = stoolFoods.length >= 2
      ? splitFoodsBySymptom(stoolFoods, f => f.avgStool, STOOL_SPREAD, false)
      : null;
    if (stoolSplit) {
      if (ingredientsUniqueTo(stoolSplit.worse, stoolSplit.better).length > 0) {
        candidates.push({ split: stoolSplit, type: 'stool_negative', phrase: 'worse stool quality' });
      } else {
        candidates.push({
          split: { worse: stoolSplit.better, better: stoolSplit.worse },
          type: 'stool_positive',
          phrase: 'better stool quality',
        });
      }
    }

    const groups = new Map();
    for (const candidate of candidates) {
      const sameDivision = candidate.split.worse.map(f => f.foodId).sort().join('|');
      const key = candidate.type === 'stool_positive' ? `improves:${sameDivision}` : sameDivision;
      if (groups.has(key)) groups.get(key).push(candidate);
      else groups.set(key, [candidate]);
    }

    const insights = [];
    for (const group of groups.values()) {
      const phrases = joinPhrases(group.map(c => c.phrase));
      const type = group.length > 1 ? 'mixed' : group[0].type;
      const insight = buildInsight(foodStats, group[0].split, type,
        label => (group[0].type === 'stool_positive'
          ? `${label} appears to be linked to ${phrases}`
          : `${label} may be linked to ${phrases}`));
      if (insight) insights.push(insight);
    }

    const safeInsights = insights.map(ins => {
      if (userIsPlus) return ins;
      const { data, ...rest } = ins;
      return rest;
    });

    res.json({
      insights: safeInsights,
      plus: !!userIsPlus,
      petName: existing[0].name,
      petType: existing[0].pet_type,
      foodCount: foodStats.length,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/pets/:id/insights/alternatives?sources=chicken,peas
 * Top 3 products for this pet whose ingredient text does not contain the sources,
 * ordered by that pet's base score.
 */
router.get('/:id/insights/alternatives', async (req, res, next) => {
  try {
    const existing = await query(
      'SELECT id, pet_type, age_months, weight_kg FROM pets WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Pet not found' });

    const sources = (req.query.sources || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (sources.length === 0) return res.json({ alternatives: [] });

    const pet = existing[0];
    const petType = pet.pet_type === 'cat' ? 'cat' : 'dog';
    const scoreColumn = petType === 'cat' ? 'base_cat_score' : 'base_dog_score';
    const where = [
      'p.raw_ingredients_text IS NOT NULL',
      "p.raw_ingredients_text != ''",
      `p.${scoreColumn} IS NOT NULL`,
      "p.target_pet_type IN (?, 'both')",
    ];
    const params = [petType];

    if (pet.age_months != null) {
      const months = Number(pet.age_months);
      const lifeStage = months < 12
        ? (petType === 'cat' ? 'kitten' : 'puppy')
        : months > 84
          ? 'senior'
          : 'adult';
      where.push("p.target_life_stage IN (?, 'all')");
      params.push(lifeStage);
    }

    if (petType === 'dog' && pet.weight_kg != null) {
      const kg = Number(pet.weight_kg);
      if (kg < 10) where.push("p.breed_size IN ('all', 'small_breed')");
      else if (kg >= 25) where.push("p.breed_size IN ('all', 'large_breed')");
      else where.push("p.breed_size = 'all'");
    }

    const excluded = sources.map(() => 'p.raw_ingredients_text NOT LIKE ?').join(' AND ');
    const patterns = sources.map(source => `%${source.replace(/[\\%_]/g, '\\$&')}%`);
    where.push(excluded);
    params.push(...patterns);

    const rows = await query(
      `SELECT p.id, p.name, p.brand, p.image_url, p.${scoreColumn} AS score
       FROM products p
       WHERE ${where.join(' AND ')}
       ORDER BY p.${scoreColumn} DESC
       LIMIT 3`,
      params
    );

    res.json({
      alternatives: rows.map(row => ({
        id: row.id,
        name: row.name,
        brand: row.brand,
        image_url: row.image_url,
        avoids: 'all',
      })),
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

