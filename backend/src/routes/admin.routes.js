const express = require('express');
const router = express.Router();
const { query } = require('../database/connection');

/**
 * GET /api/admin/stats
 * Get database stats
 */
router.get('/stats', async (req, res, next) => {
  try {
    const [aiCache] = await query('SELECT COUNT(*) as count FROM ai_assessment_cache');
    const [productCache] = await query('SELECT COUNT(*) as count FROM product_review_cache');
    const [products] = await query('SELECT COUNT(*) as count FROM products');
    const [scans] = await query('SELECT COUNT(*) as count FROM scan_history');
    const [users] = await query('SELECT COUNT(*) as count FROM users');
    const [pets] = await query('SELECT COUNT(*) as count FROM pets');

    res.json({
      aiAssessmentsCached: aiCache.count,
      productReviewsCached: productCache.count,
      products: products.count,
      totalScans: scans.count,
      users: users.count,
      pets: pets.count
    });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/admin/cache/clear
 * Clear all AI caches (for debugging/testing)
 */
router.delete('/cache/clear', async (req, res, next) => {
  try {
    await query('DELETE FROM ai_assessment_cache');
    await query('DELETE FROM product_review_cache');
    
    res.json({ message: 'All caches cleared' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
