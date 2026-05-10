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

/**
 * DELETE /api/admin/cache/poisoned
 *
 * One-shot cleanup for product_review_cache rows that were saved when the
 * holistic-review Gemini call returned malformed JSON. The old code path
 * silently swallowed the parse error and stored a placeholder row
 * (score=50, grade=C, key_issues='["Unable to complete AI analysis"]').
 * Once stored, every future scan of any product with the same
 * ingredient_hash served that placeholder forever.
 *
 * This deletes those rows so the next scan recomputes them through the
 * fixed pipeline (responseMimeType=application/json + retry + throw).
 */
router.delete('/cache/poisoned', async (req, res, next) => {
  try {
    const result = await query(
      `DELETE FROM product_review_cache
       WHERE JSON_CONTAINS(key_issues, JSON_QUOTE('Unable to complete AI analysis'))
          OR ai_summary LIKE 'Analysis could not be completed%'`
    );
    const deleted = result?.affectedRows ?? 0;
    console.log(`🧹 [Admin] Purged ${deleted} poisoned product_review_cache row(s)`);
    res.json({ deleted });
  } catch (error) {
    console.error('[Admin] cache/poisoned error:', error);
    next(error);
  }
});

module.exports = router;
