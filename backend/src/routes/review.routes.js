const express = require('express');
const router = express.Router();
const { query } = require('../database/connection');
const { authenticateToken, optionalAuth } = require('../middleware/auth');

/**
 * GET /api/reviews/my
 * Get current user's reviews
 */
router.get('/my', authenticateToken, async (req, res, next) => {
  try {
    const reviews = await query(
      `SELECT r.*, p.name as product_name, p.brand as product_brand, p.image_url as product_image
       FROM product_reviews r
       JOIN products p ON r.product_id = p.id
       WHERE r.user_id = ?
       ORDER BY r.created_at DESC`,
      [req.user.id]
    );

    res.json({ reviews });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/reviews/:id
 * Delete a review
 */
router.delete('/:id', authenticateToken, async (req, res, next) => {
  try {
    const result = await query(
      'DELETE FROM product_reviews WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Review not found' });
    }

    res.json({ message: 'Review deleted' });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/reviews/:id/helpful
 * Mark review as helpful
 */
router.post('/:id/helpful', optionalAuth, async (req, res, next) => {
  try {
    await query(
      'UPDATE product_reviews SET helpful_count = helpful_count + 1 WHERE id = ?',
      [req.params.id]
    );

    res.json({ message: 'Marked as helpful' });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/reviews/similar-pets/:productId
 * Get reviews from pets similar to user's pet
 */
router.get('/similar-pets/:productId', authenticateToken, async (req, res, next) => {
  try {
    const { petId } = req.query;

    if (!petId) {
      return res.status(400).json({ error: 'petId query parameter required' });
    }

    // Get user's pet info
    const [pet] = await query('SELECT * FROM pets WHERE id = ? AND user_id = ?', [petId, req.user.id]);
    if (!pet) {
      return res.status(404).json({ error: 'Pet not found' });
    }

    // Get pet's conditions
    const conditions = await query(
      'SELECT condition_type FROM pet_health_conditions WHERE pet_id = ?',
      [petId]
    );
    const hasAllergies = conditions.some(c => c.condition_type.startsWith('allergy_'));

    // Determine size category
    let petSize;
    if (pet.pet_type === 'dog') {
      if (pet.weight_kg < 5) petSize = 'tiny';
      else if (pet.weight_kg < 10) petSize = 'small';
      else if (pet.weight_kg < 25) petSize = 'medium';
      else if (pet.weight_kg < 45) petSize = 'large';
      else petSize = 'giant';
    } else {
      if (pet.weight_kg < 3) petSize = 'small';
      else if (pet.weight_kg < 5) petSize = 'medium';
      else petSize = 'large';
    }

    // Find reviews from similar pets
    const reviews = await query(
      `SELECT r.*, 
        (CASE WHEN r.pet_type = ? THEN 3 ELSE 0 END +
         CASE WHEN r.pet_size = ? THEN 2 ELSE 0 END +
         CASE WHEN r.pet_breed = ? THEN 5 ELSE 0 END +
         CASE WHEN r.has_allergies = ? THEN 2 ELSE 0 END) as similarity_score
       FROM product_reviews r
       WHERE r.product_id = ? AND r.pet_type = ?
       ORDER BY similarity_score DESC, r.helpful_count DESC
       LIMIT 10`,
      [pet.pet_type, petSize, pet.breed, hasAllergies, req.params.productId, pet.pet_type]
    );

    res.json({ 
      reviews,
      yourPet: {
        petType: pet.pet_type,
        petSize,
        breed: pet.breed,
        hasAllergies
      }
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

