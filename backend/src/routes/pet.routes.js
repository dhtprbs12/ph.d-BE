const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const { query } = require('../database/connection');
const { authenticateToken } = require('../middleware/auth');

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

    // Check if this is the first pet (make it primary)
    const existingPets = await query('SELECT COUNT(*) as count FROM pets WHERE user_id = ?', [req.user.id]);
    const isPrimary = existingPets[0].count === 0;

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
    const result = await query('DELETE FROM pets WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Pet not found' });
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

module.exports = router;

