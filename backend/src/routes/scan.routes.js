const express = require('express');
const router = express.Router();
const multer = require('multer');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../database/connection');
const ingredientAnalyzer = require('../services/ingredientAnalyzer');
const geminiService = require('../services/geminiService');
const productService = require('../services/productService');
const { 
  getSingleConditionHash, 
  safeJsonParse, 
  gradeToNumber, 
  numberToGrade 
} = require('../utils/cacheHelpers');
const imageService = require('../services/imageService');

// Helper: Get recommendation from grade if AI didn't provide one
function getRecommendationFromGrade(grade) {
  const recommendations = {
    'A': 'highly_recommended',
    'B': 'recommended',
    'C': 'acceptable',
    'D': 'not_recommended',
    'F': 'avoid'
  };
  return recommendations[grade] || 'unknown';
}

// ============================================
// IN-MEMORY STORE FOR PENDING ANALYSES
// ============================================
const analysisStore = new Map();

// ============================================
// IN-MEMORY STORE FOR PENDING FRONT LABELS
// ============================================
const pendingFrontLabels = new Map();

// Clean up old entries every 5 minutes (keep for 30 min max)
setInterval(() => {
  const thirtyMinAgo = Date.now() - 30 * 60 * 1000;
  for (const [scanId, data] of analysisStore.entries()) {
    if (data.createdAt < thirtyMinAgo) {
      analysisStore.delete(scanId);
    }
  }
  for (const [scanId, data] of pendingFrontLabels.entries()) {
    if (data.createdAt < thirtyMinAgo) {
      pendingFrontLabels.delete(scanId);
    }
  }
}, 5 * 60 * 1000);

// ============================================
// PUBLIC COMMUNITY STATS (for trust indicators)
// ============================================
router.get('/stats', async (req, res, next) => {
  try {
    const [scanResult] = await query('SELECT COUNT(*) as count FROM scan_history');
    const [productResult] = await query('SELECT COUNT(*) as count FROM products');
    const [cacheResult] = await query('SELECT COUNT(*) as count FROM ai_assessment_cache');
    
    res.json({
      totalScans: scanResult.count || 0,
      totalProducts: productResult.count || 0,
      ingredientsAnalyzed: cacheResult.count || 0,
      lastUpdated: new Date().toISOString()
    });
  } catch (error) {
    // Return safe defaults on error
    res.json({
      totalScans: 1000,
      totalProducts: 50,
      ingredientsAnalyzed: 500,
      lastUpdated: new Date().toISOString()
    });
  }
});

// ============================================
// USER STATS & BADGE (for gamification)
// ============================================
function getUserBadge(scanCount) {
  if (scanCount >= 100) {
    return { title: 'Pet Guardian', level: 5, icon: '🏆', nextAt: null, color: '#FFD700' };
  } else if (scanCount >= 50) {
    return { title: 'Food Expert', level: 4, icon: '⭐', nextAt: 100, color: '#9C27B0' };
  } else if (scanCount >= 20) {
    return { title: 'Health Advocate', level: 3, icon: '🛡️', nextAt: 50, color: '#2196F3' };
  } else if (scanCount >= 5) {
    return { title: 'Pet Parent', level: 2, icon: '🐾', nextAt: 20, color: '#4CAF50' };
  } else {
    return { title: 'Newcomer', level: 1, icon: '🌱', nextAt: 5, color: '#607D8B' };
  }
}

router.get('/user-stats', async (req, res, next) => {
  try {
    const deviceId = req.headers['x-device-id'] || req.query.deviceId;
    
    if (!deviceId) {
      return res.json({
        scanCount: 0,
        badge: getUserBadge(0),
        message: 'No device ID provided'
      });
    }
    
    // Get user's scan count
    const [countResult] = await query(
      'SELECT COUNT(*) as count FROM scan_history WHERE device_id = ?',
      [deviceId]
    );
    
    const scanCount = countResult?.count || 0;
    const badge = getUserBadge(scanCount);
    
    // Calculate progress to next badge
    let progress = 0;
    if (badge.nextAt) {
      const previousThreshold = badge.level === 2 ? 5 : badge.level === 3 ? 20 : badge.level === 4 ? 50 : 0;
      progress = ((scanCount - previousThreshold) / (badge.nextAt - previousThreshold)) * 100;
    } else {
      progress = 100; // Max level
    }
    
    res.json({
      scanCount,
      badge: {
        ...badge,
        progress: Math.min(Math.round(progress), 100)
      }
    });
  } catch (error) {
    console.error('Error fetching user stats:', error);
    res.json({
      scanCount: 0,
      badge: getUserBadge(0)
    });
  }
});

// ============================================
// BACKGROUND ANALYSIS PROCESSOR
// ============================================
async function processAnalysisInBackground(scanId, ingredientsList, pet, extracted, product, deviceId) {
  const startTime = Date.now();
  
  try {
    // Update status to processing
    analysisStore.set(scanId, {
      ...analysisStore.get(scanId),
      status: 'processing',
      progress: 'Analyzing ingredients...'
    });
    
    // Analyze ingredients (rule-based) - now parallelized
    console.log('🧪 [BG] Analyzing', ingredientsList.length, 'ingredients for', pet.name);
    let analysis = await ingredientAnalyzer.analyzeIngredients(ingredientsList, pet);
    
    // UNIVERSAL SCORING — always score as "healthy" baseline
    // Pet-specific concerns are handled via rule-based warnings (no AI needed)
    const healthConditions = pet.healthConditions || [];
    const hasConditions = healthConditions.length > 0;
    const productType = extracted.productType || product?.product_type || 
      (ingredientsList.length <= 6 ? 'treats' : 'food');
    
    // Always evaluate as "healthy" — one universal score per product
    const conditionsToEvaluate = ['healthy'];
    
    console.log(`🏥 [BG] Universal scoring (healthy baseline)${hasConditions ? ` + ${healthConditions.length} condition warning(s)` : ''}`);
    
    // Update progress
    analysisStore.set(scanId, {
      ...analysisStore.get(scanId),
      progress: 'Checking ingredient database...'
    });
    
    // Determine which ingredients need AI assessment (only those not yet cached)
    let ingredientsToAssess = analysis.ingredients.filter(i => i.needsAIAssessment || !i.found);
    
    // Pre-compute ingredient hash for cache lookups
    const productServiceLocal = require('../services/productService');
    const ingredientHash = productServiceLocal.generateIngredientHash(ingredientsList);
    const holisticCacheResults = {};
    const uncachedHolisticConditions = new Set();
    
    // ============================================
    // TIER 1: Check product_review_cache FIRST (always, regardless of ingredient state)
    // ============================================
    const holisticCachePromises = conditionsToEvaluate.map(async (condition) => {
      const conditionHash = getSingleConditionHash(condition, productType);
      try {
        const cached = await query(
          `SELECT * FROM product_review_cache WHERE ingredient_hash = ? AND conditions_hash = ? AND pet_type = ?`,
          [ingredientHash, conditionHash, pet.pet_type]
        );
        return { condition, conditionHash, cached };
      } catch (err) {
        return { condition, conditionHash, cached: [] };
      }
    });
    
    const holisticResults = await Promise.all(holisticCachePromises);
    for (const { condition, conditionHash, cached } of holisticResults) {
      if (cached.length > 0) {
        holisticCacheResults[condition] = { cached: cached[0], conditionHash };
      } else {
        uncachedHolisticConditions.add(condition);
      }
    }
    
    // ============================================
    // PER-CONDITION INGREDIENT CACHING - OPTIMIZED
    // PARALLEL cache checks + MERGED AI calls
    // Then combine by taking the WORST score across all conditions
    // ============================================
    if (ingredientsToAssess.length > 0) {
      const allConditionAssessments = {}; // { ingredientName: { condition: assessment } }
      const allCacheInserts = [];
      const cacheHitIds = [];
      
      // STEP 1: Check cache for ALL conditions x ALL ingredients in PARALLEL
      console.log(`🔍 [BG] Checking ingredient cache for ${ingredientsToAssess.length} ingredients x ${conditionsToEvaluate.length} conditions...`);
      
      const allCacheLookups = [];
      for (const condition of conditionsToEvaluate) {
        const conditionHash = getSingleConditionHash(condition, productType);
        for (const ing of ingredientsToAssess) {
          allCacheLookups.push({ condition, conditionHash, ing });
        }
      }
      
      const cacheLookupPromises = allCacheLookups.map(async ({ condition, conditionHash, ing }) => {
        try {
          const cached = await ingredientAnalyzer.cacheLookup(
            ing.normalizedName, conditionHash, pet.pet_type
          );
          return { condition, conditionHash, ing, cached };
        } catch (err) {
          return { condition, conditionHash, ing, cached: [] };
        }
      });
      
      const allCacheResults = await Promise.all(cacheLookupPromises);
      
      // Process cache results and identify uncached (condition, ingredients) pairs
      const uncachedByCondition = {}; // { condition: { conditionHash, ingredients: [] } }
      
      for (const { condition, conditionHash, ing, cached } of allCacheResults) {
        if (!allConditionAssessments[ing.name]) {
          allConditionAssessments[ing.name] = {};
        }
        
        if (cached.length > 0) {
          allConditionAssessments[ing.name][condition] = {
            riskScore: cached[0].risk_score,
            explanation: cached[0].explanation,
            benefit: cached[0].benefit,
            fromCache: true
          };
          cacheHitIds.push(cached[0].id);
        } else {
          if (!uncachedByCondition[condition]) {
            uncachedByCondition[condition] = { conditionHash, ingredients: [] };
          }
          // Avoid duplicates
          if (!uncachedByCondition[condition].ingredients.find(i => i.name === ing.name)) {
            uncachedByCondition[condition].ingredients.push(ing);
          }
        }
      }

      // STEP 3: Run AI calls - MERGED for fully uncached, STANDALONE for partial
      const conditionsNeedingAI = Object.entries(uncachedByCondition).filter(([_, data]) => data.ingredients.length > 0);
      
      if (conditionsNeedingAI.length > 0) {
        // Determine which conditions can use merged call (ingredients + holistic both uncached)
        const mergedConditions = conditionsNeedingAI.filter(([cond]) => uncachedHolisticConditions.has(cond));
        const ingredientOnlyConditions = conditionsNeedingAI.filter(([cond]) => !uncachedHolisticConditions.has(cond));
        
        const totalAICalls = mergedConditions.length + ingredientOnlyConditions.length;
        analysisStore.set(scanId, {
          ...analysisStore.get(scanId),
          progress: `Analyzing ${totalAICalls} condition(s)...`
        });
        
        console.log(`🚀 [BG] ${mergedConditions.length} merged calls + ${ingredientOnlyConditions.length} ingredient-only calls`);
        
        const allAIPromises = [];
        
        // MERGED calls: get ingredients + holistic in one shot
        for (const [condition, { conditionHash, ingredients }] of mergedConditions) {
          allAIPromises.push((async () => {
            console.log(`🤖 [BG-MERGED] ${ingredients.length}/${ingredientsList.length} ingredients + holistic for: ${condition}`);
            try {
              const singleCondition = condition === 'healthy' ? [] : [{ condition_type: condition }];
              const { assessments, holistic } = await geminiService.assessAndReviewProduct({
                uncachedIngredients: ingredients,
                allIngredients: ingredientsList,
                petType: pet.pet_type,
                petName: pet.name,
                healthConditions: singleCondition,
                productType
              });
              return { condition, conditionHash, ingredients, aiAssessments: assessments, holistic, merged: true, success: true };
            } catch (err) {
              console.error(`[BG-MERGED] Failed for ${condition}:`, err.message);
              return { condition, conditionHash, ingredients, aiAssessments: {}, holistic: null, merged: true, success: false };
            }
          })());
        }
        
        // INGREDIENT-ONLY calls: holistic already cached
        for (const [condition, { conditionHash, ingredients }] of ingredientOnlyConditions) {
          allAIPromises.push((async () => {
            console.log(`🤖 [BG-ING] ${ingredients.length} ingredients for: ${condition}`);
            try {
              const singleCondition = condition === 'healthy' ? [] : [{ condition_type: condition }];
              const aiAssessments = await geminiService.assessIngredientsForPet(
                ingredients, pet.pet_type, pet.name, singleCondition, productType
              );
              return { condition, conditionHash, ingredients, aiAssessments, holistic: null, merged: false, success: true };
            } catch (err) {
              console.error(`[BG-ING] Failed for ${condition}:`, err.message);
              return { condition, conditionHash, ingredients, aiAssessments: {}, holistic: null, merged: false, success: false };
            }
          })());
        }
        
        const aiResults = await Promise.all(allAIPromises);
        
        // Process AI results
        for (const { condition, conditionHash, ingredients, aiAssessments, holistic, merged, success } of aiResults) {
          if (!success) continue;
          
          // Process ingredient assessments
          for (const ing of ingredients) {
            let assessment = aiAssessments[ing.name];
            if (!assessment) {
              const lowerName = ing.name.toLowerCase();
              for (const [key, value] of Object.entries(aiAssessments)) {
                if (key.toLowerCase() === lowerName || 
                    key.toLowerCase().includes(lowerName) ||
                    lowerName.includes(key.toLowerCase())) {
                  assessment = value;
                  break;
                }
              }
            }
            
            if (assessment) {
              if (!allConditionAssessments[ing.name]) {
                allConditionAssessments[ing.name] = {};
              }
              allConditionAssessments[ing.name][condition] = {
                riskScore: assessment.riskScore || 0,
                explanation: assessment.explanation || '',
                benefit: assessment.benefit || '',
                fromCache: false,
                category: assessment.category
              };
              
              if (ing.normalizedName) {
                allCacheInserts.push([
                  ing.normalizedName, conditionHash, pet.pet_type,
                  assessment.riskScore || 0, assessment.explanation || '', assessment.benefit || ''
                ]);
              }
            }
          }
          
          // Store holistic result from merged call
          if (merged && holistic) {
            holisticCacheResults[condition] = { fromMerged: true, review: holistic, conditionHash };
            uncachedHolisticConditions.delete(condition);
          }
        }
      } else {
        console.log(`⚡ [BG] All ingredient assessments served from cache!`);
      }
      
      // Batch update hit counts
      if (cacheHitIds.length > 0) {
        try {
          const uniqueHitIds = [...new Set(cacheHitIds)];
          const placeholders = uniqueHitIds.map(() => '?').join(',');
          await query(
            `UPDATE ai_assessment_cache SET hit_count = hit_count + 1 WHERE id IN (${placeholders})`,
            uniqueHitIds
          );
        } catch (err) {}
      }
      
      // ============================================
      // COMBINE ASSESSMENTS: Take WORST score for each ingredient
      // ============================================
      for (const ing of analysis.ingredients) {
        const conditionScores = allConditionAssessments[ing.name] || {};
        
        if (Object.keys(conditionScores).length > 0) {
          // Take the WORST (highest) risk score across all conditions
          let worstScore = -100;
          let worstExplanation = '';
          let worstBenefit = '';
          
          for (const [cond, assessment] of Object.entries(conditionScores)) {
            const score = assessment.riskScore || 0;
            if (score > worstScore) {
              worstScore = score;
              worstExplanation = assessment.explanation || '';
              // Take benefit from the SAME condition as worst score
              worstBenefit = assessment.benefit || '';
            }
          }
          
          // Don't show benefits for dangerous ingredients (score > 30)
          if (worstScore > 30) {
            worstBenefit = '';
          }
          
          ing.explanation = worstExplanation || ing.explanation;
          ing.positiveBenefit = worstBenefit || ing.positiveBenefit;
          
          if (hasConditions || ing.needsAIAssessment) {
            ing.adjustedRiskScore = worstScore * ing.positionWeight;
          }
          
          // Set risk level based on worst score
          if (worstScore <= -10) ing.riskLevel = 'safe';
          else if (worstScore <= 0) ing.riskLevel = 'low';
          else if (worstScore <= 15) ing.riskLevel = 'moderate';
          else if (worstScore <= 30) ing.riskLevel = 'high';
          else ing.riskLevel = 'danger';
        }
      }
      
      // BATCH INSERT cache entries to ai_assessment_cache
      if (allCacheInserts.length > 0) {
        try {
          const placeholders = allCacheInserts.map(() => '(UUID(), ?, ?, ?, ?, ?, ?)').join(', ');
          await query(
            `INSERT INTO ai_assessment_cache (id, ingredient_normalized, conditions_hash, pet_type, risk_score, explanation, benefit)
             VALUES ${placeholders}
             ON DUPLICATE KEY UPDATE risk_score = VALUES(risk_score), explanation = VALUES(explanation), benefit = VALUES(benefit), hit_count = hit_count + 1`,
            allCacheInserts.flat()
          );
          console.log(`💾 [BG] Batch cached: ${allCacheInserts.length} ingredient-condition pairs`);
        } catch (err) {}
      }
    }
    
    // Update progress
    analysisStore.set(scanId, {
      ...analysisStore.get(scanId),
      progress: 'Calculating score...'
    });
    
    // =============================================
    // HOLISTIC REVIEW - Use pre-collected cache + merged results
    // Only make standalone AI calls for conditions still uncached
    // =============================================
    const conditionReviews = {};
    const productCacheInserts = [];
    const productCacheHitIds = [];
    
    // Process holistic results already gathered during ingredient phase
    for (const [condition, data] of Object.entries(holisticCacheResults)) {
      if (data.fromMerged && data.review) {
        conditionReviews[condition] = { ...data.review, fromCache: false };
        console.log(`🤖 [BG-MERGED] Holistic for ${condition}: score=${data.review.finalScore}, grade=${data.review.grade}`);
        productCacheInserts.push({
          ingredientHash,
          conditionHash: data.conditionHash,
          petType: pet.pet_type,
          productType,
          review: data.review
        });
      } else if (data.cached) {
        conditionReviews[condition] = {
          finalScore: data.cached.final_score,
          grade: data.cached.grade,
          recommendation: data.cached.recommendation,
          keyIssues: safeJsonParse(data.cached.key_issues),
          positives: safeJsonParse(data.cached.positives),
          aiSummary: data.cached.ai_summary,
          proteinQuality: data.cached.protein_quality,
          hasArtificialAdditives: !!data.cached.has_artificial_additives,
          primaryIngredientType: data.cached.primary_ingredient_type,
          fromCache: true
        };
        productCacheHitIds.push(data.cached.id);
        console.log(`⚡ [BG] Holistic cache hit for ${condition}: score=${data.cached.final_score}`);
      }
    }
    
    // Tier 2: Compute from ai_assessment_cache for conditions still uncached
    // All ingredient gaps were just filled by AI above, so computeScoreFromCache should find everything
    const afterMergeUncached = conditionsToEvaluate.filter(c => !conditionReviews[c]);
    
    if (afterMergeUncached.length > 0) {
      console.log(`🧮 [BG-T2] Attempting compute-from-cache for ${afterMergeUncached.length} conditions: ${afterMergeUncached.join(', ')}`);
      
      for (const condition of afterMergeUncached) {
        const conditionHash = getSingleConditionHash(condition, productType);
        try {
          const computed = await ingredientAnalyzer.computeScoreFromCache(ingredientsList, conditionHash, pet.pet_type, productType);
          
          if (computed.allCached && computed.finalScore !== undefined) {
            conditionReviews[condition] = { ...computed, fromCache: false };
            console.log(`🧮 [BG-T2] Computed from ingredients: ${condition} = ${computed.finalScore} (${ingredientsList.length}/${ingredientsList.length} cached)`);
            productCacheInserts.push({
              ingredientHash,
              conditionHash,
              petType: pet.pet_type,
              productType,
              review: computed
            });
          }
        } catch (err) {
          console.warn(`[BG-T2] Compute failed for ${condition}:`, err.message);
        }
      }
    }
    
    // Tier 3: AI holistic fallback for any conditions STILL uncached
    const stillUncachedConditions = conditionsToEvaluate.filter(c => !conditionReviews[c]);
    
    if (stillUncachedConditions.length > 0) {
      console.log(`🚀 [BG-T3] AI holistic fallback for ${stillUncachedConditions.length} remaining conditions: ${stillUncachedConditions.join(', ')}`);
      
      const aiReviewPromises = stillUncachedConditions.map(async (condition) => {
        const conditionHash = getSingleConditionHash(condition, productType);
        const singleConditionList = condition === 'healthy' ? [] : [condition];
        try {
          const review = await geminiService.reviewProductHolistically({
            ingredients: ingredientsList,
            petType: pet.pet_type,
            healthConditions: singleConditionList,
            productType: productType,
            petName: pet.name
          });
          return { condition, conditionHash, review, success: true };
        } catch (err) {
          console.error(`[BG-T3] AI review failed for ${condition}:`, err.message);
          return { condition, conditionHash, review: null, success: false };
        }
      });
      
      const aiResults = await Promise.all(aiReviewPromises);
      
      for (const { condition, conditionHash, review, success } of aiResults) {
        if (success && review) {
          conditionReviews[condition] = { ...review, fromCache: false };
          console.log(`🤖 [BG-T3] AI review for ${condition}: score=${review.finalScore}, grade=${review.grade}`);
          productCacheInserts.push({
            ingredientHash,
            conditionHash,
            petType: pet.pet_type,
            productType,
            review
          });
        }
      }
    } else {
      console.log(`⚡ [BG] All ${conditionsToEvaluate.length} condition reviews resolved (cache + T2 compute)!`);
    }
    
    // Batch update hit counts for product cache
    if (productCacheHitIds.length > 0) {
      try {
        const placeholders = productCacheHitIds.map(() => '?').join(',');
        await query(
          `UPDATE product_review_cache SET hit_count = hit_count + 1 WHERE id IN (${placeholders})`,
          productCacheHitIds
        );
      } catch (err) {}
    }
    
    // Batch insert new product cache entries
    for (const insert of productCacheInserts) {
      try {
        await query(
          `INSERT INTO product_review_cache 
           (id, ingredient_hash, conditions_hash, pet_type, product_type, final_score, grade, recommendation,
            key_issues, positives, ai_summary, protein_quality, has_artificial_additives, primary_ingredient_type)
           VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE 
             final_score = VALUES(final_score),
             grade = VALUES(grade),
             recommendation = VALUES(recommendation),
             key_issues = VALUES(key_issues),
             positives = VALUES(positives),
             ai_summary = VALUES(ai_summary),
             hit_count = hit_count + 1,
             updated_at = CURRENT_TIMESTAMP`,
          [
            insert.ingredientHash,
            insert.conditionHash,
            insert.petType,
            insert.productType,
            insert.review.finalScore,
            insert.review.grade,
            insert.review.recommendation,
            JSON.stringify(insert.review.keyIssues),
            JSON.stringify(insert.review.positives),
            insert.review.aiSummary,
            insert.review.proteinQuality,
            insert.review.hasArtificialAdditives ? 1 : 0,
            insert.review.primaryIngredientType
          ]
        );
        console.log(`💾 [BG] Cached product review for condition: ${insert.conditionHash}`);
      } catch (err) {
        console.warn(`[BG] Failed to cache product review:`, err.message);
      }
    }
    
    // =============================================
    // COMBINE REVIEWS: Take WORST score/grade
    // =============================================
    let holisticReview = null;
    const reviewValues = Object.values(conditionReviews);
    
    if (reviewValues.length > 0) {
      // Take the worst score
      let worstScore = 100;
      let worstGradeNum = 4; // A=4
      let allKeyIssues = [];
      let allPositives = [];
      let primaryReview = null;
      
      for (const [condition, review] of Object.entries(conditionReviews)) {
        if (review.finalScore < worstScore) {
          worstScore = review.finalScore;
          primaryReview = review;
        }
        const gradeNum = gradeToNumber(review.grade);
        if (gradeNum < worstGradeNum) {
          worstGradeNum = gradeNum;
        }
        // Collect all key issues and positives
        if (review.keyIssues) allKeyIssues.push(...review.keyIssues);
        if (review.positives) allPositives.push(...review.positives);
      }
      
      // Use the primary (worst) review as base, but with combined issues/positives
      holisticReview = {
        ...primaryReview,
        finalScore: worstScore,
        grade: numberToGrade(worstGradeNum),
        keyIssues: [...new Set(allKeyIssues)], // Dedupe
        positives: [...new Set(allPositives)]  // Dedupe
      };
      
      console.log(`📊 [BG] Combined review: score=${worstScore}, grade=${numberToGrade(worstGradeNum)} (worst of ${reviewValues.length} conditions)`);
    } else {
      // Fallback if no reviews (shouldn't happen)
      console.error('[BG] No condition reviews available, using fallback');
      holisticReview = await geminiService.reviewProductHolistically({
        ingredients: ingredientsList,
        petType: pet.pet_type,
        healthConditions: healthConditions.map(c => c.condition_type || c),
        productType: productType,
        petName: pet.name
      });
      
      // Cache with legacy combined hash as fallback
      const fallbackHash = hasConditions 
        ? require('crypto').createHash('md5').update(healthConditions.map(c => c.condition_type || c).sort().join(',') + '_' + productType).digest('hex').substring(0, 16)
        : `healthy_${productType}`;
        
      try {
        await query(
          `INSERT INTO product_review_cache 
           (id, ingredient_hash, conditions_hash, pet_type, product_type, final_score, grade, recommendation,
            key_issues, positives, ai_summary, protein_quality, has_artificial_additives, primary_ingredient_type)
           VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE 
             final_score = VALUES(final_score),
             grade = VALUES(grade),
             recommendation = VALUES(recommendation),
             key_issues = VALUES(key_issues),
             positives = VALUES(positives),
             ai_summary = VALUES(ai_summary),
             hit_count = hit_count + 1,
             updated_at = CURRENT_TIMESTAMP`,
          [
            ingredientHash,
            fallbackHash,
            pet.pet_type,
            productType,
            holisticReview.finalScore,
            holisticReview.grade,
            holisticReview.recommendation,
            JSON.stringify(holisticReview.keyIssues),
            JSON.stringify(holisticReview.positives),
            holisticReview.aiSummary,
            holisticReview.proteinQuality,
            holisticReview.hasArtificialAdditives ? 1 : 0,
            holisticReview.primaryIngredientType
          ]
        );
        console.log('💾 [BG] Cached holistic review (fallback)');
      } catch (cacheErr) {
        console.warn('[BG] Failed to cache holistic review:', cacheErr.message);
      }
    }
    
    // Apply holistic review results to analysis
    analysis.finalScore = Math.round(holisticReview.finalScore);
    analysis.grade = holisticReview.grade || 'C';
    analysis.recommendation = holisticReview.recommendation || 'unknown';
    analysis.keyIssues = Array.isArray(holisticReview.keyIssues) ? holisticReview.keyIssues : [];
    analysis.positives = Array.isArray(holisticReview.positives) ? holisticReview.positives.filter(p => typeof p === 'string') : [];
    analysis.proteinQuality = holisticReview.proteinQuality || null;
    analysis.hasArtificialAdditives = !!holisticReview.hasArtificialAdditives;
    
    const summaryEmoji = analysis.grade === 'A' ? '✅' : analysis.grade === 'B' ? '👍' : analysis.grade === 'C' ? '⚠️' : '❌';
    analysis.summary = holisticReview.aiSummary || `${summaryEmoji} ${['A', 'B'].includes(analysis.grade) ? 'Good' : analysis.grade === 'C' ? 'Acceptable' : 'Concerning'} choice for ${pet.name}. Score: ${analysis.finalScore}/100.`;
    
    console.log(`✅ [BG] Analysis complete: score=${analysis.finalScore}, grade=${analysis.grade}`);
    
    // Generate condition warnings (rule-based, no AI)
    const conditionWarnings = ingredientAnalyzer.generateConditionWarnings(ingredientsList, healthConditions);
    if (conditionWarnings.length > 0) {
      console.log(`⚠️ [BG] ${conditionWarnings.length} condition warning(s) for ${pet.name}`);
    }
    
    // Build aiInsights from holistic review (no extra AI call needed)
    const aiInsights = {
      topBenefits: holisticReview.positives || [],
      topConcerns: holisticReview.keyIssues || [],
      conditionWarnings,
      aiGenerated: true
    };
    
    // Save to scan history
    try {
      await query(
        `INSERT INTO scan_history (id, device_id, pet_name, pet_type, product_id, scan_type, final_score, grade, recommendation, ocr_extracted_text, analysis_json)
         VALUES (?, ?, ?, ?, ?, 'label_photo', ?, ?, ?, ?, ?)`,
        [scanId, deviceId || null, pet.name, pet.pet_type, product?.id || null, analysis.finalScore, analysis.grade, analysis.recommendation || getRecommendationFromGrade(analysis.grade), extracted.rawIngredientsText, JSON.stringify(analysis)]
      );
    } catch (err) {}
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`✅ [BG] Complete in ${duration}s`);
    
    // Store final result
    analysisStore.set(scanId, {
      status: 'complete',
      createdAt: analysisStore.get(scanId).createdAt,
      duration: parseFloat(duration),
      result: {
        scanId,
        scanType: 'label_photo',
        imageType: extracted.imageType,
        extracted: {
          productName: extracted.productName || product?.name,
          brand: extracted.brand || product?.brand,
          targetPet: extracted.targetPet,
          ingredientCount: ingredientsList.length,
          confidence: extracted.confidence
        },
        product: product ? { id: product.id, name: product.name, brand: product.brand } : null,
        analysis,
        aiInsights,
        pet: { id: pet.id || 'local', name: pet.name, petType: pet.pet_type }
      }
    });
    
  } catch (error) {
    console.error('❌ [BG] Analysis failed:', error);
    analysisStore.set(scanId, {
      ...analysisStore.get(scanId),
      status: 'error',
      error: error.message
    });
  }
}

// Configure multer for image uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

// No authentication required - pets are stored locally on device

// ============================================
// TWO-STEP SCANNING FLOW
// ============================================

/**
 * POST /api/scan/front
 * Step 1: Scan front label to get product name, brand, etc.
 * Returns a pendingScanId to use with /scan/back
 */
router.post('/front', upload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Image is required' });
    }

    // Optimize image for OCR
    const optimizedBuffer = await sharp(req.file.buffer)
      .resize(1500, 1500, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

    // Extract info from front label
    console.log('📸 [FRONT] Processing front label...');
    const extracted = await geminiService.extractFromImage(optimizedBuffer, 'image/jpeg');
    
    // Validate it's actually a front label
    if (extracted.ingredientsList && extracted.ingredientsList.length > 3) {
      // This looks like a back label with ingredients - redirect to full flow
      return res.status(422).json({
        error: 'back_label_detected',
        message: 'This appears to be the ingredients label. Please scan the front of the package first, or use the regular scan.',
        suggestion: 'Flip to the front of the package, or tap "Skip to Ingredients" if you only have the back.'
      });
    }

    if (!extracted.productName && !extracted.brand) {
      return res.status(422).json({
        error: 'no_product_info',
        message: 'Could not detect product name or brand. Please try again with a clearer photo of the front label.',
        suggestion: 'Make sure the product name is visible and well-lit.'
      });
    }

    // Generate pending scan ID
    const pendingScanId = uuidv4();
    
    // Store front label data
    pendingFrontLabels.set(pendingScanId, {
      productName: extracted.productName,
      brand: extracted.brand,
      targetPet: extracted.targetPet,
      productType: extracted.productType,
      texture: extracted.texture,
      lifeStage: extracted.lifeStage,
      imageType: extracted.imageType,
      imageUrl: null, // Will be filled by background search
      createdAt: Date.now()
    });

    console.log(`✅ [FRONT] Captured: "${extracted.brand || ''} ${extracted.productName || ''}" (pendingId: ${pendingScanId})`);

    // Search DB for matching products (candidates for quick selection)
    let candidates = [];
    if (extracted.productName || extracted.brand) {
      try {
        const brandTerm = (extracted.brand || '').trim();
        const nameTerm = (extracted.productName || '').trim();
        const fullText = `${brandTerm} ${nameTerm}`.trim();
        
        console.log(`🔍 [FRONT] Searching candidates: brand="${brandTerm}", name="${nameTerm}"`);
        
        let candidateRows = [];
        
        // Strategy 1: Search by brand
        if (brandTerm) {
          candidateRows = await query(
            `SELECT id, name, brand, image_url, product_type, target_pet_type 
             FROM products 
             WHERE brand LIKE ? AND raw_ingredients_text IS NOT NULL AND raw_ingredients_text != ''
             ORDER BY scan_count DESC
             LIMIT 10`,
            [`%${brandTerm}%`]
          );
        }
        
        // Strategy 2: Search by name keywords
        if (candidateRows.length === 0 && nameTerm) {
          const keywords = nameTerm.split(/\s+/).filter(w => w.length > 2);
          if (keywords.length > 0) {
            const likeConditions = keywords.map(() => 'name LIKE ?').join(' AND ');
            const likeParams = keywords.map(k => `%${k}%`);
            candidateRows = await query(
              `SELECT id, name, brand, image_url, product_type, target_pet_type 
               FROM products 
               WHERE (${likeConditions}) AND raw_ingredients_text IS NOT NULL AND raw_ingredients_text != ''
               ORDER BY scan_count DESC
               LIMIT 10`,
              likeParams
            );
          }
        }
        
        // Strategy 3: Search brand+name keywords across both columns
        if (candidateRows.length === 0 && fullText) {
          const keywords = fullText.split(/\s+/).filter(w => w.length > 2);
          if (keywords.length > 0) {
            const likeConditions = keywords.map(() => '(name LIKE ? OR brand LIKE ?)').join(' AND ');
            const likeParams = keywords.flatMap(k => [`%${k}%`, `%${k}%`]);
            candidateRows = await query(
              `SELECT id, name, brand, image_url, product_type, target_pet_type 
               FROM products 
               WHERE (${likeConditions}) AND raw_ingredients_text IS NOT NULL AND raw_ingredients_text != ''
               ORDER BY scan_count DESC
               LIMIT 10`,
              likeParams
            );
          }
        }
        
        if (candidateRows.length > 0) {
          candidates = candidateRows.map(r => ({
            id: r.id,
            name: r.name,
            brand: r.brand,
            imageUrl: r.image_url,
            productType: r.product_type,
            targetPetType: r.target_pet_type
          }));
          console.log(`🔍 [FRONT] Found ${candidates.length} candidate(s) for "${fullText}"`);
        } else {
          console.log(`🔍 [FRONT] No candidates found for "${fullText}"`);
        }
      } catch (err) {
        console.log('⚠️ [FRONT] Candidate search failed:', err.message);
      }
    }

    // Background: search for product image (non-blocking)
    if (extracted.productName || extracted.brand) {
      (async () => {
        try {
          const existing = await query(
            `SELECT image_url FROM products 
             WHERE (name LIKE ? OR brand LIKE ?) AND image_url IS NOT NULL AND image_url != ''
             LIMIT 1`,
            [`%${extracted.productName || ''}%`, `%${extracted.brand || ''}%`]
          );

          const pending = pendingFrontLabels.get(pendingScanId);
          if (!pending) return;

          if (existing.length > 0 && existing[0].image_url) {
            pending.imageUrl = existing[0].image_url;
          } else {
            const externalUrl = await imageService.searchProductImage(extracted.productName, extracted.brand);
            if (externalUrl && pendingFrontLabels.has(pendingScanId)) {
              pendingFrontLabels.get(pendingScanId).externalImageUrl = externalUrl;
            }
          }
        } catch (err) {
          console.log('⚠️ [FRONT] Image lookup failed:', err.message);
        }
      })();
    }

    res.json({
      success: true,
      pendingScanId,
      captured: {
        productName: extracted.productName,
        brand: extracted.brand,
        targetPet: extracted.targetPet,
        productType: extracted.productType
      },
      candidates,
      nextStep: candidates.length > 0 
        ? 'We found matching products. Select yours or scan the back label.'
        : 'Now scan the back of the package to see the ingredients list.'
    });

  } catch (error) {
    console.error('[FRONT] Error:', error);
    next(error);
  }
});

/**
 * POST /api/scan/back/:pendingScanId
 * Step 2: Scan back label (ingredients) and combine with front label data
 */
router.post('/back/:pendingScanId', upload.single('image'), async (req, res, next) => {
  try {
    const { pendingScanId } = req.params;
    const { petName, petType, petBreed, petAgeMonths, petWeightKg, petAllergies, petHealthConditions, deviceId } = req.body;

    // Validate pending scan exists
    const frontData = pendingFrontLabels.get(pendingScanId);
    if (!frontData) {
      return res.status(404).json({ 
        error: 'pending_scan_not_found',
        message: 'Front label scan expired or not found. Please start over by scanning the front label.',
        suggestion: 'Front label data expires after 30 minutes.'
      });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Image is required' });
    }

    if (!petType || !['dog', 'cat'].includes(petType)) {
      return res.status(400).json({ error: 'petType is required (dog or cat)' });
    }

    // Build pet object
    const pet = {
      id: deviceId || 'local',
      name: petName || 'Pet',
      pet_type: petType,
      breed: petBreed || null,
      age_months: petAgeMonths ? parseInt(petAgeMonths) : null,
      weight_kg: petWeightKg ? parseFloat(petWeightKg) : null,
      healthConditions: []
    };

    // Parse health conditions
    if (petHealthConditions) {
      try {
        pet.healthConditions = JSON.parse(petHealthConditions);
      } catch (e) {
        pet.healthConditions = [];
      }
    }
    if (petAllergies) {
      try {
        const allergies = JSON.parse(petAllergies);
        allergies.forEach(a => {
          pet.healthConditions.push({ condition_type: `allergy_${a}`, severity: 'moderate' });
        });
      } catch (e) {}
    }

    // Optimize image for OCR
    const optimizedBuffer = await sharp(req.file.buffer)
      .resize(1500, 1500, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

    // Extract ingredients from back label
    console.log('📸 [BACK] Processing back label...');
    const extracted = await geminiService.extractFromImage(optimizedBuffer, 'image/jpeg');
    
    // Parse ingredients
    let ingredientsList = extracted.ingredientsList || [];
    if (ingredientsList.length === 0 && extracted.rawIngredientsText) {
      ingredientsList = ingredientAnalyzer.parseIngredientText(extracted.rawIngredientsText);
    }

    if (ingredientsList.length === 0) {
      return res.status(422).json({
        error: 'no_ingredients_found',
        message: 'Could not detect ingredients list. Please try again with a clearer photo.',
        suggestion: 'Make sure the ingredients text is visible and in focus.'
      });
    }

    // Merge front label data with back label data
    const mergedExtracted = {
      ...extracted,
      productName: frontData.productName || extracted.productName,
      brand: frontData.brand || extracted.brand,
      targetPet: frontData.targetPet || extracted.targetPet,
      productType: frontData.productType || extracted.productType,
      texture: frontData.texture || extracted.texture,
      lifeStage: frontData.lifeStage || extracted.lifeStage
    };

    console.log(`✅ [BACK] Merged: "${mergedExtracted.brand || ''} ${mergedExtracted.productName || ''}" with ${ingredientsList.length} ingredients`);

    // Grab image data from front label scan
    const existingLocalImage = frontData.imageUrl || null; // Already in our DB (local path)
    const externalImageUrl = frontData.externalImageUrl || null; // From Google (needs download)

    // Clean up pending front label
    pendingFrontLabels.delete(pendingScanId);

    // Generate scan ID for async processing
    const scanId = uuidv4();

    // Initialize analysis store
    analysisStore.set(scanId, {
      status: 'pending',
      createdAt: Date.now(),
      extracted: mergedExtracted,
      ingredientCount: ingredientsList.length
    });

    // Find or create product
    const ingredientHash = productService.generateIngredientHash(ingredientsList);
    let product = await productService.findByIngredientHash(ingredientHash);
    
    if (!product) {
      product = await productService.createFromScan({
        name: mergedExtracted.productName || 'Unknown Product',
        brand: mergedExtracted.brand,
        productType: mergedExtracted.productType || 'dry_food',
        texture: mergedExtracted.texture,
        targetPetType: mergedExtracted.targetPet || petType,
        lifeStage: mergedExtracted.lifeStage || 'all',
        rawIngredientsText: mergedExtracted.rawIngredientsText || ingredientsList.join(', '),
        ingredientsList,
        imageUrl: existingLocalImage || null // Only set if we already had a local image
      });
    }

    // Download and save product image if needed (non-blocking)
    if (!product.image_url) {
      if (existingLocalImage) {
        // Already have a local image from a previous scan of this product
        await query('UPDATE products SET image_url = ? WHERE id = ?', [existingLocalImage, product.id]);
        product.image_url = existingLocalImage;
        console.log(`⚡ [BACK] Reused existing local image: ${existingLocalImage}`);
      } else if (externalImageUrl) {
        // Download from Google and save locally (non-blocking)
        imageService.downloadAndSave(externalImageUrl, product.id)
          .then(async (localUrl) => {
            if (localUrl) {
              await imageService.updateProductImageUrl(product.id, localUrl);
              console.log(`🖼️ [BACK] Downloaded & saved image: ${localUrl}`);
            }
          })
          .catch(err => console.log('⚠️ [BACK] Image download failed:', err.message));
      }
    } else {
      console.log(`⚡ [BACK] Product already has image: ${product.image_url}`);
    }

    // Start background analysis
    processAnalysisInBackground(scanId, ingredientsList, pet, mergedExtracted, product, deviceId);

    // Return immediately with scanId for polling
    res.json({
      scanId,
      status: 'processing',
      scanType: 'two_step_scan',
      extracted: {
        imageType: 'merged',
        productName: mergedExtracted.productName,
        brand: mergedExtracted.brand,
        targetPet: mergedExtracted.targetPet,
        ingredientCount: ingredientsList.length,
        confidence: mergedExtracted.confidence || 0.95
      },
      product: product ? {
        id: product.id,
        name: product.name,
        brand: product.brand,
        isNew: !product.scan_count || product.scan_count === 0
      } : null,
      pollUrl: `/api/scan/${scanId}/result`,
      message: 'Analysis started. Poll for results.'
    });

  } catch (error) {
    console.error('[BACK] Error:', error);
    next(error);
  }
});

/**
 * POST /api/scan/quick-analyze
 * Skip back label scan — analyze a known product from the DB for a specific pet
 */
router.post('/quick-analyze', async (req, res, next) => {
  try {
    const { productId, petName, petType, petBreed, petAgeMonths, petWeightKg, petAllergies, petHealthConditions, deviceId } = req.body;

    if (!productId) {
      return res.status(400).json({ error: 'productId is required' });
    }

    const product = await productService.findById(productId);
    if (!product || !product.raw_ingredients_text) {
      return res.status(404).json({ error: 'Product not found or has no ingredient data' });
    }

    const ingredientsList = ingredientAnalyzer.parseIngredientText(product.raw_ingredients_text);
    if (ingredientsList.length === 0) {
      return res.status(422).json({ error: 'Could not parse ingredients for this product' });
    }

    // Build pet object
    let parsedConditions = [];
    if (petHealthConditions) {
      parsedConditions = typeof petHealthConditions === 'string'
        ? safeJsonParse(petHealthConditions, [])
        : petHealthConditions;
    }

    const pet = {
      name: petName || 'Pet',
      type: petType || product.target_pet_type || 'dog',
      breed: petBreed || null,
      ageMonths: petAgeMonths ? parseInt(petAgeMonths) : null,
      weightKg: petWeightKg ? parseFloat(petWeightKg) : null,
      allergies: petAllergies ? (typeof petAllergies === 'string' ? safeJsonParse(petAllergies, []) : petAllergies) : [],
      healthConditions: parsedConditions
    };

    const scanId = uuidv4();
    const extracted = {
      productName: product.name,
      brand: product.brand,
      targetPet: product.target_pet_type,
      productType: product.product_type,
      rawIngredientsText: product.raw_ingredients_text,
      ingredientsList,
      confidence: 1.0,
      imageType: 'quick_analyze'
    };

    // Store initial state for polling
    analysisStore.set(scanId, {
      status: 'processing',
      progress: 'Analyzing ingredients...',
      extracted,
      product: { id: product.id, name: product.name, brand: product.brand, image_url: product.image_url },
      pet,
      startTime: Date.now()
    });

    // Increment scan count
    await query('UPDATE products SET scan_count = scan_count + 1 WHERE id = ?', [product.id]);

    console.log(`⚡ [QUICK] Starting analysis for "${product.brand || ''} ${product.name}" (${ingredientsList.length} ingredients) for ${pet.name}`);

    // Trigger background analysis (same as back label flow)
    processAnalysisInBackground(scanId, ingredientsList, pet, extracted, product, deviceId || 'unknown');

    res.json({
      scanId,
      status: 'processing',
      scanType: 'quick_analyze',
      extracted: {
        productName: product.name,
        brand: product.brand,
        targetPet: product.target_pet_type,
        ingredientCount: ingredientsList.length,
        confidence: 1.0
      },
      product: {
        id: product.id,
        name: product.name,
        brand: product.brand,
        image_url: product.image_url,
        isNew: false
      },
      pollUrl: `/api/scan/${scanId}/result`,
      message: 'Quick analysis started. Poll for results.'
    });

  } catch (error) {
    console.error('[QUICK-ANALYZE] Error:', error);
    next(error);
  }
});

/**
 * GET /api/scan/pending/:pendingScanId
 * Check status of pending front label scan
 */
router.get('/pending/:pendingScanId', async (req, res) => {
  const { pendingScanId } = req.params;
  const frontData = pendingFrontLabels.get(pendingScanId);
  
  if (!frontData) {
    return res.status(404).json({
      error: 'not_found',
      message: 'Pending scan not found or expired.'
    });
  }

  res.json({
    exists: true,
    captured: {
      productName: frontData.productName,
      brand: frontData.brand,
      targetPet: frontData.targetPet,
      productType: frontData.productType
    },
    expiresIn: Math.max(0, 30 * 60 * 1000 - (Date.now() - frontData.createdAt))
  });
});

// ============================================
// SINGLE-STEP SCANNING (ORIGINAL)
// ============================================

/**
 * POST /api/scan/label
 * Smart scan - handles both front label (product name) and back label (ingredients)
 * Pet info is sent directly from device (no server-side pet storage)
 */
router.post('/label', upload.single('image'), async (req, res, next) => {
  try {
    // Pet info comes directly from the device
    const { petName, petType, petBreed, petAgeMonths, petWeightKg, petAllergies, petHealthConditions, deviceId } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: 'Image is required' });
    }

    if (!petType || !['dog', 'cat'].includes(petType)) {
      return res.status(400).json({ error: 'petType is required (dog or cat)' });
    }

    // Build pet object from request (pets are stored locally on device)
    const pet = {
      id: 'local',
      name: petName || 'My Pet',
      pet_type: petType,
      breed: petBreed || null,
      age_months: petAgeMonths ? parseInt(petAgeMonths) : null,
      weight_kg: petWeightKg ? parseFloat(petWeightKg) : null,
      allergies: petAllergies ? JSON.parse(petAllergies) : [],
      healthConditions: petHealthConditions ? JSON.parse(petHealthConditions) : []
    };

    // Process image (resize for API)
    const processedImage = await sharp(req.file.buffer)
      .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

    // Extract info via Gemini OCR (now detects image type)
    const extracted = await geminiService.extractFromImage(processedImage, 'image/jpeg');

    // Debug logging
    console.log('📸 OCR Result:', {
      imageType: extracted.imageType,
      productName: extracted.productName,
      brand: extracted.brand,
      ingredientsCount: extracted.ingredientsList?.length || 0,
      confidence: extracted.confidence,
      notes: extracted.notes
    });

    let ingredientsList = extracted.ingredientsList || [];
    let product = null;
    let usedStoredIngredients = false;

    // Detect if this is a front label (no ingredients)
    const isFrontLabel = extracted.imageType === 'front_label' || 
      (ingredientsList.length === 0 && (extracted.productName || extracted.brand));

    // SMART DETECTION: Handle front label vs ingredients label
    console.log('🔍 Front label check:', { ingredientsCount: ingredientsList.length, isFrontLabel });
    
    if (ingredientsList.length === 0 && isFrontLabel) {
      // Front label detected - try to find product in database using SMART SEARCH
      if (extracted.productName || extracted.brand) {
        const extractedBrand = extracted.brand || '';
        const extractedName = extracted.productName || '';
        
        console.log('🔍 Smart search - Brand:', extractedBrand, 'Name:', extractedName);
        
        // Strategy 1: Search by brand first (most reliable)
        let searchResults = [];
        if (extractedBrand) {
          searchResults = await productService.search(extractedBrand, { limit: 10 });
          console.log('🔍 Brand search results:', searchResults.length);
        }
        
        // Strategy 2: If no brand results, search by name words
        if (searchResults.length === 0 && extractedName) {
          // Split name into words and search for each
          const nameWords = extractedName.split(/\s+/).filter(w => w.length > 2);
          for (const word of nameWords) {
            const wordResults = await productService.search(word, { limit: 10 });
            searchResults.push(...wordResults);
          }
          // Remove duplicates
          searchResults = [...new Map(searchResults.map(r => [r.id, r])).values()];
          console.log('🔍 Name word search results:', searchResults.length);
        }
        
        // Rank results by similarity - require BOTH brand AND name match for safety
        if (searchResults.length > 0) {
          const extractedWords = extractedName.toLowerCase().split(/\s+/).filter(w => w.length > 2);
          
          const rankedResults = searchResults
            .filter(r => r.raw_ingredients_text) // Only products with ingredients
            .map(result => {
              const resultName = (result.name || '').toLowerCase();
              const resultBrand = (result.brand || '').toLowerCase();
              
              // Calculate separate scores for brand and name
              let brandScore = 0;
              let nameScore = 0;
              
              // Brand match check
              if (extractedBrand && resultBrand.includes(extractedBrand.toLowerCase())) {
                brandScore = 10;
              }
              if (extractedBrand && extractedBrand.toLowerCase().includes(resultBrand)) {
                brandScore = 10;
              }
              
              // Name similarity - count matching words
              for (const word of extractedWords) {
                if (resultName.includes(word)) nameScore += 3;
              }
              
              // Also check if result name words appear in extracted name
              const resultWords = resultName.split(/\s+/).filter(w => w.length > 2);
              for (const word of resultWords) {
                if (extractedName.toLowerCase().includes(word)) nameScore += 2;
              }
              
              return { 
                ...result, 
                brandScore, 
                nameScore, 
                totalScore: brandScore + nameScore 
              };
            })
            .sort((a, b) => b.totalScore - a.totalScore); // Best match first
          
          console.log('🏆 Ranked results:', rankedResults.map(r => ({ 
            name: r.name, 
            brand: r.brand, 
            brandScore: r.brandScore,
            nameScore: r.nameScore,
            total: r.totalScore 
          })));
          
          // SAFETY: Only use if we have BOTH brand match AND some name similarity
          // Brand match alone is NOT enough (same brand can have many different products)
          const bestMatch = rankedResults[0];
          if (bestMatch && bestMatch.brandScore >= 10 && bestMatch.nameScore >= 3) {
            product = bestMatch;
            ingredientsList = ingredientAnalyzer.parseIngredientText(product.raw_ingredients_text);
            usedStoredIngredients = true;
            console.log('✅ Confident match:', product.name, '(brand:', bestMatch.brandScore, 'name:', bestMatch.nameScore, ')');
          } else if (bestMatch) {
            console.log('⚠️ Weak match - brand OK but name mismatch. Asking for back label.');
          }
        }
        
        if (!usedStoredIngredients) {
          // Product not found in database - prompt user to scan ingredients
          console.log('📸 Returning front_label_detected error');
          return res.status(422).json({
            error: 'front_label_detected',
            message: 'We detected the front of the package. Please scan the ingredients list on the back for analysis.',
            detected: {
              imageType: 'front_label',
              productName: extracted.productName,
              brand: extracted.brand,
              targetPet: extracted.targetPet
            },
            suggestion: 'Flip the package and take a photo of the ingredients list.'
          });
        }
      } else {
        // Couldn't extract product name either
        return res.status(422).json({
          error: 'no_ingredients_found',
          message: 'Could not find ingredients or product information. Please scan the ingredients list on the back of the package.',
          suggestion: 'Make sure the ingredients list is clearly visible in the photo.'
        });
      }
    }
    
    // Still no ingredients after all attempts
    if (ingredientsList.length === 0) {
      return res.status(422).json({
        error: 'Could not extract ingredients',
        message: 'Unable to read ingredients from the image. Please ensure the ingredient list is clearly visible.',
        rawText: extracted.rawIngredientsText
      });
    }

    // Try to find or create product using INGREDIENT HASH
    // Same ingredients = Same product (regardless of name variations)
    if (!product && ingredientsList.length > 0) {
      const ingredientHash = productService.generateIngredientHash(ingredientsList);
      const existingProduct = await productService.findByIngredientHash(ingredientHash);
      
      if (existingProduct) {
        product = existingProduct;
        // Increment scan count for existing product
        await query('UPDATE products SET scan_count = scan_count + 1 WHERE id = ?', [product.id]);
      } else if (extracted.productName) {
        // Create new product from scan (only if we have a name)
        product = await productService.createFromScan({
          name: extracted.productName,
          brand: extracted.brand,
          productType: extracted.productType || 'dry_food',
          texture: extracted.texture || null,  // AI-inferred texture
          targetPetType: extracted.targetPet || 'both',
          lifeStage: extracted.lifeStage,
          rawIngredientsText: extracted.rawIngredientsText,
          ingredientsList: ingredientsList  // Pass for hash generation
        });
      }
    }

    // ============================================
    // ASYNC MODE: Return immediately, process in background
    // ============================================
    const asyncMode = req.query.async === 'true';

    if (asyncMode) {
    const scanId = uuidv4();
      console.log(`⚡ [ASYNC] Returning immediately, processing in background (scanId: ${scanId})`);
      
      // Store initial state
      analysisStore.set(scanId, {
        status: 'pending',
        createdAt: Date.now(),
        progress: 'Starting analysis...'
      });
      
      // Start background processing (don't await!)
      processAnalysisInBackground(scanId, ingredientsList, pet, extracted, product, deviceId);
      
      // Return immediately with initial data
      return res.json({
        scanId,
        status: 'analyzing',
        message: 'Analysis started. Poll /api/scan/{scanId}/result for full results.',
        // Immediate data (no wait)
        extracted: {
          productName: extracted.productName || product?.name,
          brand: extracted.brand || product?.brand,
          targetPet: extracted.targetPet,
          ingredientCount: ingredientsList.length,
          confidence: extracted.confidence,
          imageType: extracted.imageType
        },
        ingredients: ingredientsList.map((name, i) => ({
          name,
          position: i + 1,
          status: 'analyzing'
        })),
        product: product ? { id: product.id, name: product.name, brand: product.brand } : null,
        pet: { id: pet.id || 'local', name: pet.name, petType: pet.pet_type }
      });
    }
    
    // ============================================
    // SYNC MODE: Original behavior (wait for everything)
    // ============================================

    // Analyze ingredients (rule-based)
    console.log('🧪 Analyzing', ingredientsList.length, 'ingredients for', pet.name);
    let analysis = await ingredientAnalyzer.analyzeIngredients(ingredientsList, pet);
    
    // UNIVERSAL SCORING — always score as "healthy" baseline
    const healthConditions = pet.healthConditions || [];
    const hasConditions = healthConditions.length > 0;
    const productType = extracted.productType || product?.product_type || 
      (ingredientsList.length <= 6 ? 'treats' : 'food');
    
    // Always evaluate as "healthy" — universal score
    const conditionsToEvaluateSync = ['healthy'];
    
    console.log(`🏥 [SYNC] Universal scoring${hasConditions ? ` + ${healthConditions.length} condition warning(s)` : ''}`);
    
    // Determine which ingredients need AI assessment (only uncached)
    let ingredientsToAssess = analysis.ingredients.filter(i => i.needsAIAssessment || !i.found);
    
    // Always use healthy hash for universal scoring
    const syncConditionsHash = `healthy_${productType}`;
    
    let scoreAdjustment = 0;
    
    if (ingredientsToAssess.length > 0) {
      // PARALLEL cache lookup for all ingredients
      const uncachedIngredients = [];
      const cachedAssessments = {};
      const cacheHitIds = []; // Track IDs for batch hit count update
      
      // Create parallel cache lookup promises (with fallback matching)
      const cacheLookupPromises = ingredientsToAssess.map(async (ing) => {
        try {
          const cached = await ingredientAnalyzer.cacheLookup(
            ing.normalizedName, syncConditionsHash, pet.pet_type
          );
          return { ing, cached };
        } catch (err) {
          return { ing, cached: [] };
        }
      });
      
      // Execute all cache lookups in parallel
      const cacheResults = await Promise.all(cacheLookupPromises);
      
      // Process cache results
      for (const { ing, cached } of cacheResults) {
        if (cached.length > 0) {
          cachedAssessments[ing.name] = {
            riskScore: cached[0].risk_score,
            explanation: cached[0].explanation,
            benefit: cached[0].benefit
          };
          cacheHitIds.push(cached[0].id);
          console.log(`💾 Cache hit: ${ing.name}`);
        } else {
          uncachedIngredients.push(ing);
        }
      }
      
      // Batch update hit counts (single query)
      if (cacheHitIds.length > 0) {
        try {
          const placeholders = cacheHitIds.map(() => '?').join(',');
          await query(
            `UPDATE ai_assessment_cache SET hit_count = hit_count + 1 WHERE id IN (${placeholders})`,
            cacheHitIds
          );
        } catch (err) {
          // Non-critical
        }
      }
      
      // Get AI assessments for uncached ingredients
      let aiAssessments = {};
      if (uncachedIngredients.length > 0) {
        console.log('🤖 AI assessing', uncachedIngredients.length, 'ingredients (type:', productType, ', conditions:', syncConditionsHash, ')...');
        try {
          aiAssessments = await geminiService.assessIngredientsForPet(
            uncachedIngredients,
            pet.pet_type,
            pet.name,
            healthConditions,  // Pass health conditions for personalized assessment
            productType        // Pass product type for context-aware scoring
          );
          console.log('🤖 AI returned assessments for:', Object.keys(aiAssessments));
        } catch (aiError) {
          console.error('AI assessment error:', aiError.message);
        }
      }
      
      // Merge cached and AI assessments
      const allAssessments = { ...cachedAssessments, ...aiAssessments };
        
      // Collect data for cache inserts
      const cacheInserts = [];

      for (const ing of analysis.ingredients) {
        // Try exact match first, then case-insensitive match
        let assessment = allAssessments[ing.name];
        if (!assessment) {
          // Try case-insensitive match
          const lowerName = ing.name.toLowerCase();
          for (const [key, value] of Object.entries(allAssessments)) {
            if (key.toLowerCase() === lowerName || 
                key.toLowerCase().includes(lowerName) ||
                lowerName.includes(key.toLowerCase())) {
              assessment = value;
              console.log(`🔗 Matched "${ing.name}" to AI key "${key}"`);
              break;
            }
          }
        }
        
        if (assessment) {
          // Update ingredient with personalized assessment
          ing.explanation = assessment.explanation || ing.explanation;
          ing.positiveBenefit = assessment.benefit || ing.positiveBenefit;
          
          // Track risk for scoring (negative = beneficial, positive = penalty)
          const riskScore = assessment.riskScore || 0;
          
          // For pets with conditions, use AI score directly
          if (hasConditions || ing.needsAIAssessment) {
            ing.adjustedRiskScore = riskScore * ing.positionWeight;
          }
          
          // Update risk level based on assessment
          if (riskScore <= -10) {
            ing.riskLevel = 'safe';
          } else if (riskScore <= 0) {
            ing.riskLevel = 'low';
          } else if (riskScore <= 15) {
            ing.riskLevel = 'moderate';
          } else if (riskScore <= 30) {
            ing.riskLevel = 'high';
          } else {
            ing.riskLevel = 'danger';
          }
          
          // Collect cache insert data (only for fresh AI assessments)
          const isFromAI = Object.values(aiAssessments).includes(assessment);
          if (isFromAI && ing.normalizedName) {
            cacheInserts.push([
              ing.normalizedName,
              syncConditionsHash,
              pet.pet_type,
              riskScore,
              assessment.explanation || '',
              assessment.benefit || ''
            ]);
          }
        } else if (ing.needsAIAssessment || hasConditions) {
          console.warn('⚠️ No assessment found for:', ing.name);
        }
      }
      
      // BATCH INSERT: Cache (all at once)
      if (cacheInserts.length > 0) {
        try {
          const placeholders = cacheInserts.map(() => '(UUID(), ?, ?, ?, ?, ?, ?)').join(', ');
          const flatParams = cacheInserts.flat();
          await query(
            `INSERT INTO ai_assessment_cache 
             (id, ingredient_normalized, conditions_hash, pet_type, risk_score, explanation, benefit)
             VALUES ${placeholders}
             ON DUPLICATE KEY UPDATE 
               risk_score = VALUES(risk_score),
               explanation = VALUES(explanation),
               benefit = VALUES(benefit),
               hit_count = hit_count + 1,
               updated_at = CURRENT_TIMESTAMP`,
            flatParams
          );
          console.log(`💾 Batch cached: ${cacheInserts.length} ingredients`);
        } catch (cacheError) {
          console.warn('Batch cache failed:', cacheError.message);
        }
      }
      
      console.log('✅ AI assessments applied');
    }
    
    // =============================================
    // HOLISTIC AI REVIEW (replaces position-weighted scoring)
    // Checks cache first for deterministic results
    // =============================================
    const ingredientHash = productService.generateIngredientHash(ingredientsList);
    const isTreatProduct = productType === 'treats' || productType === 'treat';
    
    // Check product_review_cache first (SYNC mode uses combined hash)
    let holisticReview = null;
    try {
      const cached = await query(
        `SELECT * FROM product_review_cache 
         WHERE ingredient_hash = ? AND conditions_hash = ? AND pet_type = ?`,
        [ingredientHash, syncConditionsHash, pet.pet_type]
      );
      
      if (cached.length > 0) {
        // Safe JSON parsing helper
        const safeJsonParse = (str, fallback = []) => {
          if (!str) return fallback;
          try {
            const parsed = JSON.parse(str);
            return Array.isArray(parsed) ? parsed : fallback;
          } catch {
            // If it's a plain string, wrap it in an array
            if (typeof str === 'string' && str.length > 0) {
              return [str];
            }
            return fallback;
          }
        };
        
        holisticReview = {
          finalScore: cached[0].final_score,
          grade: cached[0].grade,
          recommendation: cached[0].recommendation,
          keyIssues: safeJsonParse(cached[0].key_issues),
          positives: safeJsonParse(cached[0].positives),
          aiSummary: cached[0].ai_summary,
          proteinQuality: cached[0].protein_quality,
          hasArtificialAdditives: !!cached[0].has_artificial_additives,
          primaryIngredientType: cached[0].primary_ingredient_type
        };
        console.log(`⚡ Using cached holistic review: score=${holisticReview.finalScore}`);
        
        // Update hit count
        await query(
          'UPDATE product_review_cache SET hit_count = hit_count + 1 WHERE id = ?',
          [cached[0].id]
        );
      }
    } catch (err) {
      console.warn('Cache check failed:', err.message);
    }
    
    // If not cached, get AI holistic review (universal — no conditions)
    if (!holisticReview) {
      console.log('🤖 Getting AI holistic review (universal)...');
      holisticReview = await geminiService.reviewProductHolistically({
        ingredients: ingredientsList,
        petType: pet.pet_type,
        healthConditions: [],
        productType: productType,
        petName: pet.name
      });
      
      console.log(`🤖 AI holistic review: score=${holisticReview.finalScore}, grade=${holisticReview.grade}`);
      console.log(`   Key issues: ${holisticReview.keyIssues.join(', ') || 'None'}`);
      console.log(`   Positives: ${holisticReview.positives.join(', ') || 'None'}`);
      
      // Cache the holistic review for future (deterministic) results
      try {
        await query(
          `INSERT INTO product_review_cache 
           (id, ingredient_hash, conditions_hash, pet_type, product_type, final_score, grade, recommendation,
            key_issues, positives, ai_summary, protein_quality, has_artificial_additives, primary_ingredient_type)
           VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE 
             final_score = VALUES(final_score),
             grade = VALUES(grade),
             recommendation = VALUES(recommendation),
             key_issues = VALUES(key_issues),
             positives = VALUES(positives),
             ai_summary = VALUES(ai_summary),
             hit_count = hit_count + 1,
             updated_at = CURRENT_TIMESTAMP`,
          [
            ingredientHash,
            syncConditionsHash,
            pet.pet_type,
            productType,
            holisticReview.finalScore,
            holisticReview.grade,
            holisticReview.recommendation,
            JSON.stringify(holisticReview.keyIssues),
            JSON.stringify(holisticReview.positives),
            holisticReview.aiSummary,
            holisticReview.proteinQuality,
            holisticReview.hasArtificialAdditives ? 1 : 0,
            holisticReview.primaryIngredientType
          ]
        );
        console.log('💾 [SYNC] Cached holistic review');
      } catch (cacheErr) {
        console.warn('Failed to cache holistic review:', cacheErr.message);
      }
    }
    
    // Apply holistic review results to analysis
    analysis.finalScore = Math.round(holisticReview.finalScore);
    analysis.grade = holisticReview.grade || 'C';
    analysis.recommendation = holisticReview.recommendation || 'unknown';
    analysis.keyIssues = Array.isArray(holisticReview.keyIssues) ? holisticReview.keyIssues : [];
    analysis.positives = Array.isArray(holisticReview.positives) ? holisticReview.positives.filter(p => typeof p === 'string') : [];
    analysis.proteinQuality = holisticReview.proteinQuality || null;
    analysis.hasArtificialAdditives = !!holisticReview.hasArtificialAdditives;
    
    const summaryEmoji = analysis.grade === 'A' ? '✅' : analysis.grade === 'B' ? '👍' : analysis.grade === 'C' ? '⚠️' : '❌';
    analysis.summary = holisticReview.aiSummary || `${summaryEmoji} ${['A', 'B'].includes(analysis.grade) ? 'Good' : analysis.grade === 'C' ? 'Acceptable' : 'Concerning'} choice for ${pet.name}. Score: ${analysis.finalScore}/100.`;
    
    console.log(`✅ [SYNC] Analysis complete: score=${analysis.finalScore}, grade=${analysis.grade}`);

    // Generate condition warnings (rule-based, no AI)
    const conditionWarnings = ingredientAnalyzer.generateConditionWarnings(ingredientsList, healthConditions);
    if (conditionWarnings.length > 0) {
      console.log(`⚠️ [SYNC] ${conditionWarnings.length} condition warning(s) for ${pet.name}`);
    }

    const aiInsights = {
      topBenefits: holisticReview.positives || [],
      topConcerns: holisticReview.keyIssues || [],
      conditionWarnings,
      aiGenerated: true
    };

    // Save scan history (optional - for analytics)
    const scanId = uuidv4();
    try {
    await query(
      `INSERT INTO scan_history 
         (id, device_id, pet_name, pet_type, product_id, scan_type, final_score, grade, recommendation, ocr_extracted_text, analysis_json)
         VALUES (?, ?, ?, ?, ?, 'label_photo', ?, ?, ?, ?, ?)`,
        [scanId, deviceId || null, pet.name, pet.pet_type, product?.id || null, analysis.finalScore, analysis.grade, analysis.recommendation || getRecommendationFromGrade(analysis.grade), extracted.rawIngredientsText || product?.raw_ingredients_text, JSON.stringify(analysis)]
    );
    } catch (historyError) {
      console.error('Failed to save scan history:', historyError.message);
      // Don't fail the request if history save fails
    }

    const response = {
      scanId,
      scanType: 'label_photo',
      imageType: extracted.imageType,
      usedStoredIngredients, // Let frontend know if we used DB ingredients
      extracted: {
        productName: extracted.productName || product?.name,
        brand: extracted.brand || product?.brand,
        targetPet: extracted.targetPet || product?.target_pet_type,
        ingredientCount: ingredientsList.length,
        confidence: extracted.confidence
      },
      product: product ? {
        id: product.id,
        name: product.name,
        brand: product.brand
      } : null,
      analysis,
      aiInsights,
      pet: {
        id: pet.id || 'local',
        name: pet.name,
        petType: pet.pet_type
      }
    };
    
    console.log('📤 Sending response:', JSON.stringify(response, null, 2));
    res.json(response);

  } catch (error) {
    console.error('❌ Scan error:', error);
    next(error);
  }
});

/**
 * GET /api/scan/:scanId/result
 * Poll for analysis result (used with async mode)
 */
router.get('/:scanId/result', (req, res) => {
  const { scanId } = req.params;
  
  const data = analysisStore.get(scanId);
  
  if (!data) {
    return res.status(404).json({
      error: 'not_found',
      message: 'Scan not found. It may have expired or never existed.'
    });
  }
  
  const elapsedSeconds = Math.round((Date.now() - data.createdAt) / 1000);

  if (data.status === 'complete') {
    return res.json({
      status: 'complete',
      duration: data.duration,
      elapsedSeconds,
      ...data.result
    });
  }
  
  if (data.status === 'error') {
    return res.json({
      status: 'error',
      error: data.error,
      elapsedSeconds
    });
  }
  
  // Still processing
  return res.json({
    status: data.status,
    progress: data.progress,
    elapsedSeconds: Math.round((Date.now() - data.createdAt) / 1000)
  });
});

/**
 * POST /api/scan/food-check
 * Take a photo of food and check if it's safe for your pet
 * Uses per-single-condition caching (same pattern as Label Scan)
 */
router.post('/food-check', upload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image provided' });
    }

    const { petName, petType, petHealthConditions, deviceId } = req.body;

    if (!petType || !['dog', 'cat'].includes(petType)) {
      return res.status(400).json({ error: 'petType is required (dog or cat)' });
    }

    // Prepare image for Gemini
    let imageBuffer;
    try {
      imageBuffer = await sharp(req.file.buffer)
        .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
    } catch (e) {
      imageBuffer = req.file.buffer;
    }

    // Parse health conditions
    let healthConditions = [];
    if (petHealthConditions) {
      try {
        healthConditions = JSON.parse(petHealthConditions);
      } catch (e) {
        console.warn('Could not parse health conditions:', petHealthConditions);
      }
    }

    // Get list of individual conditions to evaluate (always include "healthy" as baseline)
    const hasConditions = healthConditions.length > 0;
    // Universal scoring — always evaluate as "healthy"
    const conditionsToEvaluate = ['healthy'];

    // STEP 1: Identify what food this is (always needs AI for image recognition)
    const identificationResult = await geminiService.identifyFoodFromImage(
      imageBuffer,
      'image/jpeg'
    );

    if (!identificationResult.identified || !identificationResult.foodName) {
      return res.json({
        foodName: 'Unknown',
        category: null,
        safetyLevel: 'unknown',
        explanation: 'Could not identify a food item in this photo. Please take a clear photo of the food.',
        tip: null
      });
    }

    const foodNormalized = identificationResult.foodName.toLowerCase().trim().replace(/\s+/g, '_');
    const foodType = identificationResult.foodType || 'simple';
    const isPreparedDish = foodType === 'prepared' || identificationResult.category === 'PreparedDish';
    
    console.log(`🔍 [Food Check] Identified: "${identificationResult.foodName}" (${foodType}) for ${petType}`);
    console.log(`🏥 [Food Check] Universal scoring${hasConditions ? ` + ${healthConditions.length} condition warning(s)` : ''}`);

    // STEP 2: Check cache for EACH condition (per-single-condition pattern)
    const cachedResults = {};
    const conditionsNeedingAI = [];

    for (const condition of conditionsToEvaluate) {
      try {
        const [cached] = await query(
          `SELECT * FROM food_check_cache 
           WHERE food_normalized = ? AND conditions_hash = ? AND pet_type = ?`,
          [foodNormalized, condition, petType]
        );

        if (cached) {
          console.log(`📦 [Food Check] CACHE HIT: "${foodNormalized}" + ${condition}`);
          cachedResults[condition] = {
            safetyLevel: cached.safety_level,
            category: cached.category,
            explanation: cached.explanation,
            tip: cached.tip
          };
          // Update hit count
          await query('UPDATE food_check_cache SET hit_count = hit_count + 1 WHERE id = ?', [cached.id]);
        } else {
          conditionsNeedingAI.push(condition);
        }
      } catch (dbError) {
        conditionsNeedingAI.push(condition);
      }
    }

    // STEP 3: Call AI for uncached conditions (in parallel)
    if (conditionsNeedingAI.length > 0) {
      console.log(`🤖 [Food Check] CACHE MISS for conditions: ${conditionsNeedingAI.join(', ')}`);
      
      const aiPromises = conditionsNeedingAI.map(async (condition) => {
        const conditionList = condition === 'healthy' ? [] : [{ condition_type: condition }];
        
        const aiResult = await geminiService.assessFoodSafety(
          identificationResult.foodName,
          identificationResult.category,
          {
            petName: petName || 'your pet',
            petType,
            healthConditions: conditionList,
            foodType: foodType // Pass whether it's simple or prepared
          }
        );

        // Save to cache
        try {
          await query(
            `INSERT INTO food_check_cache 
             (id, food_normalized, conditions_hash, pet_type, safety_level, category, explanation, tip, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
             ON DUPLICATE KEY UPDATE hit_count = hit_count + 1, updated_at = NOW()`,
            [
              uuidv4(),
              foodNormalized,
              condition,
              petType,
              aiResult.safetyLevel,
              aiResult.category || identificationResult.category,
              aiResult.explanation,
              aiResult.tip
            ]
          );
          console.log(`💾 [Food Check] Cached: "${foodNormalized}" + ${condition}`);
        } catch (dbError) {
          console.log('Cache save skipped:', dbError.message);
        }

        return { condition, result: aiResult };
      });

      const aiResults = await Promise.all(aiPromises);
      for (const { condition, result } of aiResults) {
        cachedResults[condition] = result;
      }
    }

    // STEP 4: Combine results - take WORST safety level, combine explanations for concerns
    const safetyPriority = { 'danger': 3, 'caution': 2, 'safe': 1, 'unknown': 0 };
    let worstSafetyLevel = 'safe';
    let worstPriority = 0;
    let category = identificationResult.category;
    const concerns = []; // Collect all concerns (caution or danger)
    const tips = [];

    for (const condition of conditionsToEvaluate) {
      const result = cachedResults[condition];
      if (result) {
        const priority = safetyPriority[result.safetyLevel] || 0;
        
        // Track worst safety level
        if (priority > worstPriority) {
          worstPriority = priority;
          worstSafetyLevel = result.safetyLevel;
          category = result.category || category;
        }
        
        // Collect concerns (anything that's not "safe")
        if (result.safetyLevel === 'danger' || result.safetyLevel === 'caution') {
          const conditionLabel = condition === 'healthy' 
            ? 'General' 
            : condition.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
          
          concerns.push({
            condition: conditionLabel,
            level: result.safetyLevel,
            explanation: result.explanation
          });
        }
        
        // Collect tips (avoid duplicates)
        if (result.tip && !tips.includes(result.tip)) {
          tips.push(result.tip);
        }
      }
    }

    // Build combined explanation (short bullet points)
    let finalExplanation;
    if (concerns.length === 0) {
      // All safe - use the healthy baseline explanation
      finalExplanation = cachedResults['healthy']?.explanation 
        || cachedResults[conditionsToEvaluate[0]]?.explanation 
        || 'This food appears to be safe for your pet.';
    } else if (concerns.length === 1) {
      // Single concern - use its explanation directly
      finalExplanation = concerns[0].explanation;
    } else {
      // Multiple concerns - combine as bullet points
      finalExplanation = concerns.map(c => `• ${c.condition}: ${c.explanation}`).join('\n');
    }

    // Build final response
    const finalResult = {
      foodName: identificationResult.foodName,
      category: category,
      safetyLevel: worstSafetyLevel,
      explanation: finalExplanation,
      tip: tips.length > 0 ? tips[0] : null // Use first tip (most relevant to worst condition)
    };

    console.log(`✅ [Food Check] Final: ${finalResult.safetyLevel} (${concerns.length} concerns from ${conditionsToEvaluate.length} conditions)`);

    res.json(finalResult);
  } catch (error) {
    console.error('Food check error:', error);
    res.status(500).json({
      foodName: 'Error',
      category: null,
      safetyLevel: 'unknown',
      explanation: 'Unable to process the image. Please try again.',
      tip: null
    });
  }
});

/**
 * POST /api/scan/manual
 * Manually input ingredients text and analyze
 */
router.post('/manual', async (req, res, next) => {
  try {
    const { ingredientsText, productName, petName, petType, petAllergies, petHealthConditions, deviceId } = req.body;

    if (!ingredientsText) {
      return res.status(400).json({ error: 'ingredientsText is required' });
    }

    if (!petType || !['dog', 'cat'].includes(petType)) {
      return res.status(400).json({ error: 'petType is required (dog or cat)' });
    }

    // Build pet object from request
    const pet = {
      id: 'local',
      name: petName || 'My Pet',
      pet_type: petType,
      allergies: petAllergies ? JSON.parse(petAllergies) : [],
      healthConditions: petHealthConditions ? JSON.parse(petHealthConditions) : []
    };

    // Normalize ingredients using Gemini if available
    let ingredientsList;
    try {
      ingredientsList = await geminiService.normalizeIngredients(ingredientsText);
    } catch (e) {
      ingredientsList = ingredientAnalyzer.parseIngredientText(ingredientsText);
    }

    if (ingredientsList.length === 0) {
      return res.status(400).json({
        error: 'No ingredients found',
        message: 'Could not parse any ingredients from the provided text.'
      });
    }

    // Analyze ingredients (basic per-ingredient assessment)
    let analysis = await ingredientAnalyzer.analyzeIngredients(ingredientsList, pet);

    // =============================================
    // PER-CONDITION AI INGREDIENT ASSESSMENT
    // Same as label scan: get AI descriptions for each ingredient
    // =============================================
    const healthConditions = pet.healthConditions || [];
    const hasConditions = healthConditions.length > 0;
    const productType = ingredientsList.length <= 6 ? 'treats' : 'food';
    
    // Universal scoring — always evaluate as "healthy"
    const conditionsToEvaluate = ['healthy'];
    
    console.log(`🏥 [Manual] Universal scoring${hasConditions ? ` + ${healthConditions.length} condition warning(s)` : ''}`);
    
    // Get AI assessments for ingredients (per condition)
    const allConditionAssessments = {}; // { ingredientName: { condition: assessment } }
    const ingredientCacheInserts = [];
    
    for (const condition of conditionsToEvaluate) {
      const conditionHash = getSingleConditionHash(condition, productType);
      const uncachedIngredients = [];
      
      // Check cache for each ingredient for this condition
      for (const ing of analysis.ingredients) {
        const normalizedName = ing.normalizedName || ingredientAnalyzer.normalizeIngredientName(ing.name);
        
        try {
          const cached = await ingredientAnalyzer.cacheLookup(
            normalizedName, conditionHash, pet.pet_type
          );
          
          if (cached.length > 0) {
            if (!allConditionAssessments[ing.name]) allConditionAssessments[ing.name] = {};
            allConditionAssessments[ing.name][condition] = {
              riskScore: cached[0].risk_score,
              explanation: cached[0].explanation,
              benefit: cached[0].benefit,
              fromCache: true
            };
          } else {
            uncachedIngredients.push(ing);
          }
        } catch (err) {
          uncachedIngredients.push(ing);
        }
      }
      
      // Get AI assessments for uncached ingredients
      if (uncachedIngredients.length > 0) {
        console.log(`🤖 [Manual] AI assessing ${uncachedIngredients.length} ingredients for condition: ${condition}`);
        try {
          const singleCondition = condition === 'healthy' ? [] : [{ condition_type: condition }];
          const aiAssessments = await geminiService.assessIngredientsForPet(
            uncachedIngredients,
            pet.pet_type,
            pet.name,
            singleCondition,
            productType
          );
          
          // Process AI results
          for (const ing of uncachedIngredients) {
            const normalizedName = ing.normalizedName || ingredientAnalyzer.normalizeIngredientName(ing.name);
            let assessment = aiAssessments[ing.name];
            
            // Try fuzzy match if exact match fails
            if (!assessment) {
              const lowerName = ing.name.toLowerCase();
              for (const [key, value] of Object.entries(aiAssessments)) {
                if (key.toLowerCase() === lowerName || 
                    key.toLowerCase().includes(lowerName) ||
                    lowerName.includes(key.toLowerCase())) {
                  assessment = value;
                  break;
                }
              }
            }
            
            if (assessment) {
              if (!allConditionAssessments[ing.name]) allConditionAssessments[ing.name] = {};
              allConditionAssessments[ing.name][condition] = {
                riskScore: assessment.riskScore || 0,
                explanation: assessment.explanation || '',
                benefit: assessment.benefit || '',
                fromCache: false
              };
              
              // Prepare cache insert
              ingredientCacheInserts.push([
                normalizedName, conditionHash, pet.pet_type,
                assessment.riskScore || 0, assessment.explanation || '', assessment.benefit || ''
              ]);
            }
          }
        } catch (aiError) {
          console.error(`[Manual] AI assessment failed for ${condition}:`, aiError.message);
        }
      }
    }
    
    // Cache new AI assessments
    for (const insert of ingredientCacheInserts) {
      try {
        await query(
          `INSERT INTO ai_assessment_cache (id, ingredient_normalized, conditions_hash, pet_type, risk_score, explanation, benefit)
           VALUES (UUID(), ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE risk_score = VALUES(risk_score), explanation = VALUES(explanation), benefit = VALUES(benefit), hit_count = hit_count + 1`,
          insert
        );
      } catch (err) {}
    }
    
    // Update analysis.ingredients with AI descriptions (take worst score per ingredient)
    for (const ing of analysis.ingredients) {
      const conditionScores = allConditionAssessments[ing.name] || {};
      
      if (Object.keys(conditionScores).length > 0) {
        let worstScore = -100;
        let worstExplanation = '';
        let bestBenefit = '';
        
        for (const [cond, assessment] of Object.entries(conditionScores)) {
          const score = assessment.riskScore || 0;
          if (score > worstScore) {
            worstScore = score;
            worstExplanation = assessment.explanation || '';
          }
          if (assessment.benefit && assessment.benefit.length > bestBenefit.length) {
            bestBenefit = assessment.benefit;
          }
        }
        
        // Update ingredient with AI data
        ing.adjustedRiskScore = worstScore;
        ing.explanation = worstExplanation;
        ing.positiveBenefit = bestBenefit;
        
        // Convert score to risk level
        if (worstScore > 30) ing.riskLevel = 'danger';
        else if (worstScore > 15) ing.riskLevel = 'high';
        else if (worstScore > 0) ing.riskLevel = 'moderate';
        else if (worstScore > -10) ing.riskLevel = 'low';
        else ing.riskLevel = 'safe';
      }
    }
    
    // =============================================
    // HOLISTIC AI REVIEW - PER CONDITION CACHING
    // =============================================
    
    const ingredientHash = productService.generateIngredientHash(ingredientsList);
    
    // Store reviews per condition
    const conditionReviews = {};
    const productCacheInserts = [];
    
    for (const condition of conditionsToEvaluate) {
      const conditionHash = getSingleConditionHash(condition, productType);
      
      // Check cache for this condition
      try {
        const cached = await query(
          `SELECT * FROM product_review_cache 
           WHERE ingredient_hash = ? AND conditions_hash = ? AND pet_type = ?`,
          [ingredientHash, conditionHash, pet.pet_type]
        );
        
        if (cached.length > 0) {
          conditionReviews[condition] = {
            finalScore: cached[0].final_score,
            grade: cached[0].grade,
            recommendation: cached[0].recommendation,
            keyIssues: safeJsonParse(cached[0].key_issues),
            positives: safeJsonParse(cached[0].positives),
            aiSummary: cached[0].ai_summary,
            proteinQuality: cached[0].protein_quality,
            hasArtificialAdditives: !!cached[0].has_artificial_additives,
            primaryIngredientType: cached[0].primary_ingredient_type,
            fromCache: true
          };
          console.log(`⚡ [Manual] Cache hit for ${condition}: score=${cached[0].final_score}`);
          
          await query('UPDATE product_review_cache SET hit_count = hit_count + 1 WHERE id = ?', [cached[0].id]);
        }
      } catch (err) {
        console.warn(`[Manual] Cache check failed for ${condition}:`, err.message);
      }
      
      // If not cached, get AI holistic review for this condition
      if (!conditionReviews[condition]) {
        console.log(`🤖 [Manual] Getting AI holistic review for condition: ${condition}`);
        const singleConditionList = condition === 'healthy' ? [] : [condition];
        
        try {
          const review = await geminiService.reviewProductHolistically({
            ingredients: ingredientsList,
            petType: pet.pet_type,
            healthConditions: singleConditionList,
            productType: productType,
            petName: pet.name
          });
          
          conditionReviews[condition] = { ...review, fromCache: false };
          console.log(`🤖 [Manual] AI review for ${condition}: score=${review.finalScore}, grade=${review.grade}`);
          
          // Prepare cache insert
          productCacheInserts.push({
            ingredientHash,
            conditionHash,
            petType: pet.pet_type,
            productType,
            review
          });
        } catch (err) {
          console.error(`[Manual] AI review failed for ${condition}:`, err.message);
        }
      }
    }
    
    // Batch insert new cache entries
    for (const insert of productCacheInserts) {
      try {
        await query(
          `INSERT INTO product_review_cache 
           (id, ingredient_hash, conditions_hash, pet_type, product_type, final_score, grade, recommendation,
            key_issues, positives, ai_summary, protein_quality, has_artificial_additives, primary_ingredient_type)
           VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE hit_count = hit_count + 1, updated_at = CURRENT_TIMESTAMP`,
          [
            insert.ingredientHash, insert.conditionHash, insert.petType, insert.productType,
            insert.review.finalScore, insert.review.grade, insert.review.recommendation,
            JSON.stringify(insert.review.keyIssues), JSON.stringify(insert.review.positives),
            insert.review.aiSummary, insert.review.proteinQuality,
            insert.review.hasArtificialAdditives ? 1 : 0, insert.review.primaryIngredientType
          ]
        );
        console.log(`💾 [Manual] Cached review for condition: ${insert.conditionHash}`);
      } catch (cacheErr) {
        console.warn('[Manual] Failed to cache:', cacheErr.message);
      }
    }
    
    // Combine reviews: Take WORST score/grade
    let holisticReview = null;
    const reviewValues = Object.values(conditionReviews);
    
    if (reviewValues.length > 0) {
      let worstScore = 100;
      let worstGradeNum = 4;
      let allKeyIssues = [];
      let allPositives = [];
      let primaryReview = null;
      
      for (const [condition, review] of Object.entries(conditionReviews)) {
        if (review.finalScore < worstScore) {
          worstScore = review.finalScore;
          primaryReview = review;
        }
        const gradeNum = gradeToNumber(review.grade);
        if (gradeNum < worstGradeNum) {
          worstGradeNum = gradeNum;
        }
        if (review.keyIssues) allKeyIssues.push(...review.keyIssues);
        if (review.positives) allPositives.push(...review.positives);
      }
      
      holisticReview = {
        ...primaryReview,
        finalScore: worstScore,
        grade: numberToGrade(worstGradeNum),
        keyIssues: [...new Set(allKeyIssues)],
        positives: [...new Set(allPositives)]
      };
      
      console.log(`📊 [Manual] Combined review: score=${worstScore}, grade=${numberToGrade(worstGradeNum)} (worst of ${reviewValues.length} conditions)`);
    } else {
      // Fallback
      console.error('[Manual] No condition reviews available, using fallback');
      holisticReview = await geminiService.reviewProductHolistically({
        ingredients: ingredientsList,
        petType: pet.pet_type,
        healthConditions: healthConditions.map(c => c.condition_type || c),
        productType: productType,
        petName: pet.name
      });
    }
    
    // Apply holistic review to analysis
    analysis.finalScore = Math.round(holisticReview.finalScore);
    analysis.grade = holisticReview.grade || 'C';
    analysis.recommendation = holisticReview.recommendation || 'unknown';
    analysis.keyIssues = Array.isArray(holisticReview.keyIssues) ? holisticReview.keyIssues : [];
    analysis.positives = Array.isArray(holisticReview.positives) ? holisticReview.positives.filter(p => typeof p === 'string') : [];
    analysis.proteinQuality = holisticReview.proteinQuality || null;
    analysis.hasArtificialAdditives = !!holisticReview.hasArtificialAdditives;
    
    const summaryEmoji = analysis.grade === 'A' ? '✅' : analysis.grade === 'B' ? '👍' : analysis.grade === 'C' ? '⚠️' : '❌';
    analysis.summary = holisticReview.aiSummary || `${summaryEmoji} Score: ${analysis.finalScore}/100 for ${pet.name}.`;

    // Generate condition warnings (rule-based, no AI)
    const conditionWarnings = ingredientAnalyzer.generateConditionWarnings(ingredientsList, healthConditions);
    if (conditionWarnings.length > 0) {
      console.log(`⚠️ [Manual] ${conditionWarnings.length} condition warning(s) for ${pet.name}`);
    }

    const aiInsights = {
      topBenefits: holisticReview.positives || [],
      topConcerns: holisticReview.keyIssues || [],
      conditionWarnings,
      aiGenerated: true
    };

    // Save scan history
    const scanId = uuidv4();
    try {
    await query(
      `INSERT INTO scan_history 
         (id, device_id, pet_name, pet_type, scan_type, final_score, grade, recommendation, raw_text_input, analysis_json)
         VALUES (?, ?, ?, ?, 'manual_input', ?, ?, ?, ?, ?)`,
        [scanId, deviceId || null, pet.name, pet.pet_type, analysis.finalScore, analysis.grade, analysis.recommendation || getRecommendationFromGrade(analysis.grade), ingredientsText, JSON.stringify(analysis)]
    );
    } catch (historyError) {
      console.error('Failed to save scan history:', historyError.message);
    }

    // Ensure all required fields are present
    const response = {
      scanId,
      scanType: 'manual_input',
      extracted: {
        productName: productName || 'Manual Input',
        brand: null,
        targetPet: petType,
        ingredientCount: ingredientsList.length,
        confidence: 1.0
      },
      product: null,
      parsedIngredients: ingredientsList,
      analysis: {
        ...analysis,
        recommendation: analysis.recommendation || getRecommendationFromGrade(analysis.grade),
        warnings: analysis.warnings || [],
        positives: analysis.positives || [],
        summary: analysis.summary || `Score: ${analysis.finalScore}/100`
      },
      aiInsights: aiInsights || null,
      pet: {
        id: pet.id || 'local',
        name: pet.name,
        petType: pet.pet_type
      }
    };
    
    console.log('📤 [Manual] Response:', JSON.stringify(response, null, 2));
    res.json(response);

  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/scan/history
 * Get device's scan history
 */
router.get('/history', async (req, res, next) => {
  try {
    const { deviceId, limit = 20, offset = 0 } = req.query;

    if (!deviceId) {
      return res.status(400).json({ error: 'deviceId is required' });
    }

    const { petName, petType } = req.query;
    
    let sql = `
      SELECT sh.*, p.name as product_name, p.brand as product_brand, p.image_url as product_image
      FROM scan_history sh
      LEFT JOIN products p ON sh.product_id = p.id
      WHERE sh.device_id = ?
    `;
    const params = [deviceId];

    if (petName) {
      sql += ' AND sh.pet_name = ?';
      params.push(petName);
    }
    if (petType) {
      sql += ' AND sh.pet_type = ?';
      params.push(petType);
    }

    sql += ' ORDER BY sh.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const history = await query(sql, params);

    res.json({ history });
  } catch (error) {
    next(error);
  }
});


/**
 * GET /api/scan/:id
 * Get specific scan details
 */
router.get('/:id', async (req, res, next) => {
  try {
    const { deviceId } = req.query;
    
    if (!deviceId) {
      return res.status(400).json({ error: 'deviceId is required' });
    }

    const [scan] = await query(
      `SELECT sh.*, p.name as product_name, p.brand as product_brand
       FROM scan_history sh
       LEFT JOIN products p ON sh.product_id = p.id
       WHERE sh.id = ? AND sh.device_id = ?`,
      [req.params.id, deviceId]
    );

    if (!scan) {
      return res.status(404).json({ error: 'Scan not found' });
    }

    // Parse stored analysis JSON
    scan.analysis = JSON.parse(scan.analysis_json || '{}');

    res.json({ scan });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

