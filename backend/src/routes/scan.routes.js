const express = require('express');
const router = express.Router();
const multer = require('multer');
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
const imagePreprocess = require('../services/imagePreprocessService');
const productMatchKey = require('../services/productMatchKey');
const { authenticateToken } = require('../middleware/auth');

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

const VALID_HISTORY_RECS = new Set([
  'highly_recommended',
  'recommended',
  'acceptable',
  'caution',
  'not_recommended',
]);

/** Map analysis recommendation to scan_history ENUM (avoids silent INSERT failures). */
function toHistoryRecommendation(grade, rec) {
  if (rec && VALID_HISTORY_RECS.has(rec)) return rec;
  const fromGrade = getRecommendationFromGrade(grade);
  return fromGrade === 'unknown' ? 'acceptable' : fromGrade;
}

/**
 * Insert scan_history with success/failure logging.
 * @param {object} entry
 */
async function saveScanHistoryEntry(entry) {
  const {
    scanId,
    userId = null,
    deviceId,
    petName,
    petType,
    productId = null,
    scanType,
    finalScore,
    grade,
    recommendation,
    ocrExtractedText = null,
    rawTextInput = null,
    analysisJson,
  } = entry;

  const rec = toHistoryRecommendation(grade, recommendation);
  const deviceLabel = deviceId || 'null';
  const productLabel = productId || '—';

  try {
    if (scanType === 'manual_input') {
      await query(
        `INSERT INTO scan_history 
         (id, user_id, device_id, pet_name, pet_type, product_id, scan_type, final_score, grade, recommendation, raw_text_input, analysis_json)
         VALUES (?, ?, ?, ?, ?, NULL, 'manual_input', ?, ?, ?, ?, ?)`,
        [
          scanId,
          userId,
          deviceId || null,
          petName,
          petType,
          finalScore,
          grade,
          rec,
          rawTextInput,
          analysisJson,
        ]
      );
    } else if (userId && productId) {
      // Upsert: same user + same product + same pet → update existing row
      const petNameKey = String(petName || '').trim();
      const petTypeKey = petType === 'cat' ? 'cat' : 'dog';
      const existing = await query(
        `SELECT id FROM scan_history
         WHERE user_id = ? AND product_id = ? AND pet_name = ? AND pet_type = ?
         LIMIT 1`,
        [userId, productId, petNameKey, petTypeKey]
      );
      if (existing.length > 0) {
        await query(
          `UPDATE scan_history SET final_score = ?, grade = ?, recommendation = ?, ocr_extracted_text = ?, analysis_json = ?, scan_type = ?, pet_name = ?, pet_type = ?, created_at = CURRENT_TIMESTAMP WHERE id = ?`,
          [finalScore, grade, rec, ocrExtractedText, analysisJson, scanType, petNameKey, petTypeKey, existing[0].id]
        );
        console.log(
          `📜 [scan_history] UPDATED existing id=${existing[0].id} for product=${productLabel} pet=${petNameKey} (${petTypeKey})`
        );
      } else {
        await query(
          `INSERT INTO scan_history (id, user_id, device_id, pet_name, pet_type, product_id, scan_type, final_score, grade, recommendation, ocr_extracted_text, analysis_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [scanId, userId, deviceId || null, petNameKey, petTypeKey, productId, scanType, finalScore, grade, rec, ocrExtractedText, analysisJson]
        );
      }
    } else {
      await query(
        `INSERT INTO scan_history (id, user_id, device_id, pet_name, pet_type, product_id, scan_type, final_score, grade, recommendation, ocr_extracted_text, analysis_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [scanId, userId, deviceId || null, petName, petType, productId, scanType, finalScore, grade, rec, ocrExtractedText, analysisJson]
      );
    }
    console.log(
      `📜 [scan_history] OK id=${scanId} type=${scanType} product=${productLabel} user=${userId || deviceLabel} grade=${grade} score=${finalScore} rec=${rec}`
    );
  } catch (err) {
    console.error(
      `❌ [scan_history] FAIL id=${scanId} type=${scanType} product=${productLabel} user=${userId || deviceLabel} grade=${grade} rec=${rec} rawRec=${recommendation || '—'} — ${err.message}`
    );
  }
}

/** Analysis ingredient list from OCR raw text only (ignores vision JSON ingredientsList). */
function ingredientsListFromOcrText(rawText) {
  return ingredientAnalyzer.parseIngredientText(String(rawText || '').trim());
}

/** 422 when OCR parse looks like marketing or too few real ingredients. */
function weakIngredientListResponse(res, ingredientsList, productType) {
  const validation = ingredientAnalyzer.validateParsedIngredientList(ingredientsList, {
    productType,
  });
  if (validation.ok) return null;

  const messages = {
    too_few:
      'We could not read enough ingredients from the label. Please scan the full ingredients list more closely.',
    marketing:
      'We picked up marketing text instead of the ingredient list. Center the INGREDIENTS panel in the photo.',
    empty:
      'Could not detect ingredients list. Please try again with a clearer photo.',
  };

  return res.status(422).json({
    error: 'ingredients_parse_low_quality',
    reason: validation.reason,
    message: messages[validation.reason] || messages.empty,
    suggestion:
      'Fill the frame with the ingredients list (under the INGREDIENTS heading), good lighting, and minimal blur.',
    ingredientCount: ingredientsList?.length || 0,
  });
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

/** Escape %, _, \ for SQL LIKE patterns (MySQL ESCAPE '\\'). */
function escapeSqlLikePattern(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * GET /api/scan/ingredient-suggest?q=...&limit=15
 * Distinct ingredient_normalized from ai_assessment_cache: prefix matches first, then substring.
 */
router.get('/ingredient-suggest', async (req, res, next) => {
  try {
    const raw = String(req.query.q || '').trim();
    const limit = Math.min(40, Math.max(1, parseInt(String(req.query.limit || '15'), 10) || 15));
    if (raw.length < 1) {
      return res.json({ suggestions: [] });
    }
    const qLower = raw.toLowerCase();
    const esc = escapeSqlLikePattern(qLower);
    const prefixPat = `${esc}%`;
    const containPat = `%${esc}%`;

    const prefixRows = await query(
      `SELECT DISTINCT ingredient_normalized AS n
       FROM ai_assessment_cache
       WHERE ingredient_normalized LIKE ? ESCAPE '\\\\'
       ORDER BY n ASC
       LIMIT ?`,
      [prefixPat, limit]
    );
    const out = prefixRows.map((r) => r.n);
    const seen = new Set(out.map((x) => x.toLowerCase()));

    if (out.length < limit) {
      const need = limit - out.length;
      const containRows = await query(
        `SELECT DISTINCT ingredient_normalized AS n
         FROM ai_assessment_cache
         WHERE ingredient_normalized LIKE ? ESCAPE '\\\\'
           AND NOT (ingredient_normalized LIKE ? ESCAPE '\\\\')
         ORDER BY n ASC
         LIMIT ?`,
        [containPat, prefixPat, need]
      );
      for (const r of containRows) {
        const k = r.n.toLowerCase();
        if (!seen.has(k)) {
          seen.add(k);
          out.push(r.n);
          if (out.length >= limit) break;
        }
      }
    }

    res.json({ suggestions: out.slice(0, limit) });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/scan/barcode-lookup?barcode=...&petType=dog
 * Quick lookup: barcode → product → cached review → return result
 */
router.get('/barcode-lookup', authenticateToken, async (req, res, next) => {
  try {
    const barcode = String(req.query.barcode || '').trim();
    const petType = String(req.query.petType || 'dog');
    console.log(`[QuickScan] barcode received: "${barcode}"`);
    if (!barcode) return res.status(400).json({ error: 'barcode is required' });

    const product = await productService.findByBarcode(barcode);
    console.log(`[QuickScan] DB lookup result:`, product ? `found id=${product.id} name="${product.name}"` : 'NOT FOUND');
    if (!product) {
      return res.status(404).json({ error: 'Product not found for this barcode' });
    }

    // Try to get cached review
    const ingredientHash = product.ingredient_hash;
    let analysis = null;
    if (ingredientHash) {
      const cacheRows = await query(
        `SELECT * FROM product_review_cache WHERE ingredient_hash = ? AND product_type LIKE ? LIMIT 1`,
        [ingredientHash, `healthy_%`]
      );
      if (cacheRows.length > 0) {
        try { analysis = JSON.parse(cacheRows[0].review_json); } catch {}
      }
    }

    res.json({
      product: {
        id: product.id,
        name: product.name,
        manufacturer: product.manufacturer,
        brand: product.brand,
        image_url: product.image_url,
        barcode: product.barcode,
      },
      score: analysis?.score ?? null,
      grade: analysis?.grade ?? null,
      analysis: analysis || null,
      scanType: 'barcode_lookup',
    });
  } catch (e) {
    next(e);
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

router.get('/user-stats', authenticateToken, async (req, res, next) => {
  try {
    const userId = req.user?.id || null;
    
    if (!userId) {
      return res.json({
        scanCount: 0,
        badge: getUserBadge(0),
        message: 'Not authenticated'
      });
    }
    
    // Get user's scan count
    const [countResult] = await query(
      'SELECT COUNT(*) as count FROM scan_history WHERE user_id = ?',
      [userId]
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
async function processAnalysisInBackground(scanId, ingredientsList, pet, extracted, product, deviceId, userId) {
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
    const rawProductType = extracted.productType || product?.product_type || 'food';
    const isTreatProduct = rawProductType === 'treats' || rawProductType === 'treat' || rawProductType === 'supplement';
    const productType = isTreatProduct ? 'treats' : 'food';
    
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
                ingredients, pet.pet_type, pet.name, singleCondition, productType,
                {
                  fullIngredientLines: ingredientsList.map((s) => String(s || '').trim()).filter(Boolean),
                }
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
          
          // Keep rule-based allergen/toxic overrides; AI is always healthy-baseline text
          if (!ing.isAllergenMatch && !ing.isToxic) {
            ing.explanation = worstExplanation || ing.explanation;
            ing.positiveBenefit = worstBenefit || ing.positiveBenefit;
            if (hasConditions || ing.needsAIAssessment) {
              ing.adjustedRiskScore = worstScore * ing.positionWeight;
            }
            if (worstScore <= -10) ing.riskLevel = 'safe';
            else if (worstScore <= 0) ing.riskLevel = 'low';
            else if (worstScore <= 15) ing.riskLevel = 'moderate';
            else if (worstScore <= 30) ing.riskLevel = 'high';
            else ing.riskLevel = 'danger';
          }
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
    
    // Tier 2: ensure ai_assessment_cache for this condition, then compute holistic score from cache
    const afterMergeUncached = conditionsToEvaluate.filter(c => !conditionReviews[c]);
    
    if (afterMergeUncached.length > 0) {
      console.log(`🧮 [BG-T2] Attempting compute-from-cache for ${afterMergeUncached.length} conditions: ${afterMergeUncached.join(', ')}`);
      
      for (const condition of afterMergeUncached) {
        const conditionHash = getSingleConditionHash(condition, productType);
        try {
          await ingredientAnalyzer.ensureIngredientAssessmentsInCache({
            ingredientsList,
            condition,
            productTypeForHash: productType,
            petType: pet.pet_type,
            petName: pet.name,
            productTypeForAI: extracted.productType || product?.product_type || productType
          });
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

    // Deterministic final score per condition (AI cache + position weights) before worst-of combine
    Object.assign(
      conditionReviews,
      await ingredientAnalyzer.overlayDeterministicConditionReviews(
        conditionReviews,
        ingredientsList,
        pet.pet_type,
        productType,
        productType
      )
    );
    
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

    if (reviewValues.length === 0) {
      holisticReview = await ingredientAnalyzer.overlayDeterministicHolisticScores(
        holisticReview,
        ingredientsList,
        pet.pet_type,
        productType,
        productType
      );
    }

    try {
      for (const [condition, review] of Object.entries(conditionReviews)) {
        if (!review) continue;
        const ch = getSingleConditionHash(condition, productType);
        await query(
          `UPDATE product_review_cache SET final_score = ?, grade = ?, recommendation = ?, updated_at = CURRENT_TIMESTAMP
           WHERE ingredient_hash = ? AND conditions_hash = ? AND pet_type = ?`,
          [review.finalScore, review.grade, review.recommendation || getRecommendationFromGrade(review.grade), ingredientHash, ch, pet.pet_type]
        );
      }
      if (reviewValues.length === 0 && holisticReview) {
        const ch = getSingleConditionHash('healthy', productType);
        await query(
          `UPDATE product_review_cache SET final_score = ?, grade = ?, recommendation = ?, updated_at = CURRENT_TIMESTAMP
           WHERE ingredient_hash = ? AND conditions_hash = ? AND pet_type = ?`,
          [holisticReview.finalScore, holisticReview.grade, holisticReview.recommendation || getRecommendationFromGrade(holisticReview.grade), ingredientHash, ch, pet.pet_type]
        );
      }
    } catch (e) {
      console.warn('[BG] product_review_cache score sync:', e.message);
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
    
    await saveScanHistoryEntry({
      scanId,
      userId,
      deviceId,
      petName: pet.name,
      petType: pet.pet_type,
      productId: product?.id || null,
      scanType: 'label_photo',
      finalScore: analysis.finalScore,
      grade: analysis.grade,
      recommendation: analysis.recommendation,
      ocrExtractedText: extracted.rawIngredientsText,
      analysisJson: JSON.stringify({ ...analysis, aiInsights }),
    });
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`✅ [BG] Complete in ${duration}s`);
    
    // Re-fetch product so `image_url` includes any image saved while analysis was running (async download / upload)
    let productForResult = product;
    if (product?.id) {
      try {
        const fresh = await productService.findById(product.id);
        if (fresh) productForResult = fresh;
      } catch (e) {
        console.warn('[BG] Re-fetch product for result image failed:', e.message);
      }
    }

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
          productName: extracted.productName || productForResult?.name,
          brand: extracted.brand || productForResult?.brand,
          targetPet: extracted.targetPet,
          ingredientCount: ingredientsList.length,
          confidence: extracted.confidence
        },
        product: productForResult
          ? {
              id: productForResult.id,
              name: productForResult.name,
              brand: productForResult.brand,
              image_url: productForResult.image_url,
              product_type: productForResult.product_type
            }
          : null,
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

    const optimizedBuffer = await imagePreprocess.optimizeForUpload(req.file.buffer, {
      maxDimension: 1500,
    });

    // Extract info from front label
    console.log('📸 [FRONT] Processing front label...');
    const extracted = await geminiService.extractFromImage(optimizedBuffer, 'image/jpeg');
    
    // Validate it's actually a front label (use OCR raw paragraph, not JSON array)
    if (ingredientsListFromOcrText(extracted.rawIngredientsText).length > 3) {
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

    const missingRequired = productMatchKey.getMissingRequiredFrontFields(extracted);
    if (missingRequired.length > 0) {
      return res.status(422).json({
        error: 'incomplete_front_scan',
        message: 'Please scan the front label again.',
        missingFields: missingRequired,
      });
    }

    // Fallback: infer missing slots from text when Gemini omits them
    const inferText = [extracted.productName, extracted.lineName, extracted.rawOcrText]
      .filter(Boolean).join(' ').toLowerCase();

    if (!extracted.lifeStage || extracted.lifeStage === 'all') {
      if (/\bpuppy\b/.test(inferText)) extracted.lifeStage = 'puppy';
      else if (/\bkitten\b/.test(inferText)) extracted.lifeStage = 'kitten';
      else if (/\bsenior\b|\b7\+/.test(inferText)) extracted.lifeStage = 'senior';
      else if (/\badult\b/.test(inferText)) extracted.lifeStage = 'adult';
    }

    if (!extracted.dietTags || extracted.dietTags.length === 0) {
      const tags = [];
      if (/\bgrain[\s-]?free\b/.test(inferText)) tags.push('grain_free');
      if (/\blimited[\s-]?ingredient\b/.test(inferText)) tags.push('limited_ingredient');
      if (tags.length) extracted.dietTags = tags;
    }

    if (!extracted.breedSize || extracted.breedSize === 'all') {
      if (/\blarge[\s-]?breed\b/.test(inferText)) extracted.breedSize = 'large_breed';
      else if (/\bsmall[\s-]?breed\b/.test(inferText)) extracted.breedSize = 'small_breed';
    }

    // Normalize product name (strip filler words) — fallback when slots incomplete
    const normalizedName = productService.normalizeProductName(extracted.productName);

    // ─── DB Lookup: exact match_key first, then fuzzy brand+name ───
    const { slots, displayName, candidates: dbCandidates } =
      await productService.lookupBySlotsOrFuzzy(extracted, normalizedName);

    if (dbCandidates.length > 0) {
      const top = dbCandidates[0];
      const matchLabel = top.matchType === 'exact' ? 'exact' : 'fuzzy';
      console.log(
        `✅ [FRONT] DB candidates (${matchLabel}): ${dbCandidates.length} ` +
        `(top: "${top.product.brand} ${top.product.name}")`
      );
    }

    const resolvedProductName = displayName || normalizedName || extracted.productName;

    const exactCandidate = dbCandidates.find((c) => c.matchType === 'exact') ?? null;

    // Generate pending scan ID
    const pendingScanId = uuidv4();
    
    // Store front label data
    pendingFrontLabels.set(pendingScanId, {
      productName: resolvedProductName,
      displayName: displayName || resolvedProductName,
      manufacturer: extracted.manufacturer,
      brand: extracted.brand,
      targetPet: extracted.targetPet,
      productType: extracted.productType,
      texture: extracted.texture,
      lifeStage: slots.lifeStage !== 'all' ? slots.lifeStage : extracted.lifeStage,
      lineName: slots.lineName,
      primaryProteins: slots.primaryProteins,
      breedSize: slots.breedSize,
      dietTags: slots.dietTags,
      packageShape: extracted.packageShape,
      imageType: extracted.imageType,
      imageUrl: exactCandidate?.product?.image_url || null,
      matchedProductId: exactCandidate?.product?.id || null,
      createdAt: Date.now()
    });

    console.log(
      `✅ [FRONT] Captured: "${extracted.brand || ''} ${resolvedProductName}" ` +
      `(line="${slots.lineName || '-'}", pendingId: ${pendingScanId})`
    );

    const mapProductResponse = (p) => ({
      id: p.id,
      name: p.name,
      manufacturer: p.manufacturer,
      brand: p.brand,
      imageUrl: p.image_url,
      productType: p.product_type,
      targetPetType: p.target_pet_type,
    });

    if (exactCandidate) {
      console.log(
        `⚡ [FRONT] Exact match_key — auto analyze "${exactCandidate.product.brand} ${exactCandidate.product.name}"`
      );

      if (extracted.productName || extracted.brand) {
        (async () => {
          try {
            const imgBrand = (extracted.brand || '').trim();
            const imgName = (resolvedProductName || extracted.productName || '').trim();
            const imgType = (extracted.productType || '').trim();
            if (!exactCandidate.product.image_url && (imgBrand || imgName)) {
              const pending = pendingFrontLabels.get(pendingScanId);
              if (!pending) return;
              if (exactCandidate.product.image_url) {
                pending.imageUrl = exactCandidate.product.image_url;
              } else {
                const searchName = [imgName, imgType ? imgType.replace(/_/g, ' ') : '']
                  .filter(Boolean).join(' ');
                const externalUrl = await imageService.searchProductImage(searchName, imgBrand);
                if (externalUrl && pendingFrontLabels.has(pendingScanId)) {
                  pendingFrontLabels.get(pendingScanId).externalImageUrl = externalUrl;
                }
              }
            }
          } catch (err) {
            console.log('⚠️ [FRONT] Image lookup failed:', err.message);
          }
        })();
      }

      return res.json({
        success: true,
        pendingScanId,
        matchType: 'exact',
        product: mapProductResponse(exactCandidate.product),
        captured: {
          productName: resolvedProductName,
          displayName: displayName || resolvedProductName,
          manufacturer: extracted.manufacturer,
          brand: extracted.brand,
          targetPet: extracted.targetPet,
          productType: extracted.productType,
          packageShape: extracted.packageShape,
          lineName: slots.lineName,
          lifeStage: slots.lifeStage !== 'all' ? slots.lifeStage : extracted.lifeStage,
        },
        candidates: [],
        nextStep: 'Product matched. Running analysis.',
      });
    }

    // ============================================================
    // CANDIDATE SEARCH — brand-as-hard-filter + token-exact match.
    //
    // Two earlier mistakes that this version fixes:
    //
    //  1) Brand used to be a +5 score component, so a high-keyword
    //     match from a completely different brand could clear the
    //     threshold ("Hill's Healthy Chicken & Barley" passing for a
    //     Wellness scan because "chicken" + "healthy".includes("health")
    //     piled up). Different brand = different product, period.
    //     When Gemini extracts a brand, it's now a SQL hard filter.
    //
    //  2) Keyword matching used case-insensitive substring containment,
    //     which silently matched word fragments — "health" matched
    //     "healthy", "complete" matched "completely", etc. Replaced
    //     with EXACT TOKEN match against the candidate name's
    //     tokenization. "deboned" no longer matches "debone-free", and
    //     so on.
    //
    // Scoring (post brand filter, when brand was extracted):
    //   +3 per matched name token
    //   +2 product_type match
    //   +1 target_pet_type match
    //   threshold ≥5 (i.e. 1 token + product_type, or 2 tokens)
    //
    // When brand was NOT extracted we fall back to token-only scoring
    // with a stricter threshold (≥8) to avoid cross-brand noise.
    let candidates = [];
    if (extracted.productName || extracted.brand) {
      try {
        const brandTerm = (extracted.brand || '').trim();
        const nameTerm = (resolvedProductName || extracted.productName || '').trim();
        const productType = (extracted.productType || '').trim();
        const targetPet = (extracted.targetPet || '').trim();

        console.log(
          `🔍 [FRONT] Searching candidates: brand="${brandTerm}", name="${nameTerm}", type="${productType}"`
        );

        // Stopwords are tokens that appear in nearly every product name
        // and would inflate scores without adding signal. We KEEP life-
        // stage tokens (puppy/kitten/adult/senior) since they're
        // genuinely discriminating between SKUs.
        const NAME_STOPWORDS = new Set([
          'and', 'with', 'for', 'the',
          'food', 'recipe', 'formula',
          'natural', 'premium',
          'dry', 'wet',         // captured by product_type column
          'dog', 'cat',         // captured by target_pet_type column
        ]);

        const tokenize = (text) =>
          (text || '')
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter(w => w.length > 2 && !NAME_STOPWORDS.has(w));

        const nameKeywords = tokenize(nameTerm);

        // SQL pool: brand match is REQUIRED if we have one (eliminates
        // cross-brand noise at the source). Without a brand, fall back
        // to "any name token appears in name" to keep some pool.
        const hasBrand = !!brandTerm;
        const where = [];
        const params = [];

        if (hasBrand) {
          where.push('brand LIKE ?');
          params.push(`%${brandTerm}%`);
        } else {
          for (const kw of nameKeywords) {
            where.push('LOWER(name) LIKE ?');
            params.push(`%${kw}%`);
          }
        }

        let candidateRows = [];
        if (where.length > 0) {
          // Brand path uses AND (single condition); name path uses OR
          // so that any token match brings the row into the pool.
          const joiner = hasBrand ? ' AND ' : ' OR ';
          candidateRows = await query(
            `SELECT id, name, brand, image_url, product_type, target_pet_type, target_life_stage, scan_count
             FROM products
             WHERE (${where.join(joiner)})
               AND raw_ingredients_text IS NOT NULL AND raw_ingredients_text != ''
             LIMIT 200`,
            params
          );
        }

        const MIN_SCORE = hasBrand ? 5 : 8;
        const MAX_CANDIDATES = 5;

        const scored = candidateRows.map(r => {
          let score = 0;

          // Token-exact match against the candidate name (no substring).
          const candTokens = new Set(tokenize(r.name));
          let matchedKeywordCount = 0;
          for (const kw of nameKeywords) {
            if (candTokens.has(kw)) {
              score += 3;
              matchedKeywordCount += 1;
            }
          }

          if (productType && r.product_type === productType) score += 2;
          if (
            targetPet &&
            (r.target_pet_type === targetPet || r.target_pet_type === 'both')
          ) {
            score += 1;
          }

          return { row: r, score, matchedKeywordCount };
        });

        // Drop anything that didn't match at least one name token —
        // product_type + pet_type alone isn't enough signal to suggest
        // "this might be your product".
        const passing = scored
          .filter(s => s.matchedKeywordCount > 0 && s.score >= MIN_SCORE)
          .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return (b.row.scan_count || 0) - (a.row.scan_count || 0);
          })
          .slice(0, MAX_CANDIDATES);

        candidates = passing.map(({ row: r }) => ({
          id: r.id,
          name: r.name,
          brand: r.brand,
          imageUrl: r.image_url,
          productType: r.product_type,
          targetPetType: r.target_pet_type,
          lifeStage: r.target_life_stage || null,
        }));

        console.log(
          `🔍 [FRONT] Pool ${candidateRows.length} → ${passing.length} above score ${MIN_SCORE} ` +
          `[brand=${hasBrand ? 'hard-filter' : 'no-brand-fallback'}; ` +
          `top: ${passing.slice(0, 3).map(p => `${p.score}`).join(',') || 'none'}]`
        );
      } catch (err) {
        console.log('⚠️ [FRONT] Candidate search failed:', err.message);
      }
    }

    // Merge dbCandidates (life-stage-aware) with token-based candidates.
    // dbCandidates come first (higher confidence), then token-based that aren't duplicates.
    if (dbCandidates.length > 0) {
      const dbIds = new Set(dbCandidates.map(c => c.product.id));
      const tokenOnly = candidates.filter(c => !dbIds.has(c.id));
      candidates = [
        ...dbCandidates.map(c => ({
          id: c.product.id,
          name: c.product.name,
          brand: c.product.brand,
          imageUrl: c.product.image_url,
          productType: c.product.product_type,
          targetPetType: c.product.target_pet_type,
          lifeStage: c.product.target_life_stage || null,
        })),
        ...tokenOnly,
      ].slice(0, 5);
    }

    // Background: get product image (non-blocking)
    //
    // Order of preference:
    //   1. Reuse image from a DB row whose brand + all name keywords + product
    //      type match precisely (AND, not OR — OR pulls unrelated products like
    //      Wellness CORE wet when scanning Wellness Complete Health dry)
    //   2. Same as (1) but without product type, in case type wasn't stored
    //   3. Call SerpAPI only when nothing in our own DB matches
    if (extracted.productName || extracted.brand) {
      (async () => {
        try {
          const imgBrand = (extracted.brand || '').trim();
          const imgName = (extracted.productName || '').trim();
          const imgType = (extracted.productType || '').trim();
          const imgNameKeywords = imgName.split(/\s+/).filter(w => w.length > 2);

          let existing = [];

          if (imgBrand && imgNameKeywords.length > 0 && imgType) {
            const nameWhere = imgNameKeywords.map(() => 'name LIKE ?').join(' AND ');
            existing = await query(
              `SELECT image_url FROM products 
               WHERE brand LIKE ? AND (${nameWhere}) AND product_type = ?
                 AND image_url IS NOT NULL AND image_url != ''
               LIMIT 1`,
              [`%${imgBrand}%`, ...imgNameKeywords.map(k => `%${k}%`), imgType]
            );
          }

          if (existing.length === 0 && imgBrand && imgNameKeywords.length > 0) {
            const nameWhere = imgNameKeywords.map(() => 'name LIKE ?').join(' AND ');
            existing = await query(
              `SELECT image_url FROM products 
               WHERE brand LIKE ? AND (${nameWhere})
                 AND image_url IS NOT NULL AND image_url != ''
               LIMIT 1`,
              [`%${imgBrand}%`, ...imgNameKeywords.map(k => `%${k}%`)]
            );
          }

          const pending = pendingFrontLabels.get(pendingScanId);
          if (!pending) return;

          if (existing.length > 0 && existing[0].image_url) {
            pending.imageUrl = existing[0].image_url;
            console.log(`⚡ [FRONT] Reused DB image for "${imgBrand} ${imgName}"`);
          } else {
            const searchName = [imgName, imgType ? imgType.replace(/_/g, ' ') : '']
              .filter(Boolean).join(' ');
            const externalUrl = await imageService.searchProductImage(searchName, imgBrand);
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
      matchType: dbCandidates.length > 0 ? 'fuzzy' : null,
      captured: {
        productName: resolvedProductName,
        displayName: displayName || resolvedProductName,
        manufacturer: extracted.manufacturer,
        brand: extracted.brand,
        targetPet: extracted.targetPet,
        productType: extracted.productType,
        packageShape: extracted.packageShape,
        lineName: slots.lineName,
        lifeStage: slots.lifeStage !== 'all' ? slots.lifeStage : extracted.lifeStage,
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
router.post('/back/:pendingScanId', authenticateToken, upload.single('image'), async (req, res, next) => {
  try {
    const { pendingScanId } = req.params;
    const { petName, petType, petBreed, petAgeMonths, petWeightKg, petAllergies, petHealthConditions, deviceId } = req.body;
    const userId = req.user?.id || null;

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

    const optimizedBuffer = await imagePreprocess.optimizeForUpload(req.file.buffer, {
      maxDimension: 1500,
    });

    // Extract ingredients from back label
    console.log('📸 [BACK] Processing back label...');
    const extracted = await geminiService.extractFromImage(optimizedBuffer, 'image/jpeg');
    
    const ingredientsList = ingredientsListFromOcrText(extracted.rawIngredientsText);

    if (ingredientsList.length === 0) {
      return res.status(422).json({
        error: 'no_ingredients_found',
        message: 'Could not detect ingredients list. Please try again with a clearer photo.',
        suggestion: 'Make sure the ingredients text is visible and in focus.'
      });
    }

    const productTypeForValidation = frontData.productType || extracted.productType;
    const weakList = weakIngredientListResponse(res, ingredientsList, productTypeForValidation);
    if (weakList) return weakList;

    // Merge front label data with back label data (front slots take priority)
    const mergedExtracted = {
      ...extracted,
      productName: frontData.productName || extracted.productName,
      displayName: frontData.displayName || frontData.productName || extracted.productName,
      manufacturer: frontData.manufacturer || extracted.manufacturer,
      brand: frontData.brand || extracted.brand,
      targetPet: frontData.targetPet || extracted.targetPet,
      productType: frontData.productType || extracted.productType,
      texture: frontData.texture || extracted.texture,
      lifeStage: frontData.lifeStage || extracted.lifeStage,
      lineName: frontData.lineName || extracted.lineName,
      primaryProteins: frontData.primaryProteins || extracted.primaryProteins,
      breedSize: frontData.breedSize || extracted.breedSize,
      dietTags: frontData.dietTags || extracted.dietTags,
    };

    console.log(`✅ [BACK] Merged: "${mergedExtracted.brand || ''} ${mergedExtracted.productName || ''}" with ${ingredientsList.length} ingredients`);

    // Grab image data from front label scan
    const existingLocalImage = frontData.imageUrl || null; // Already in our DB (local path)
    const externalImageUrl = frontData.externalImageUrl || null; // From Google (needs download)

    // Don't delete front label data yet — confirm-ingredients will need it
    // pendingFrontLabels.delete(pendingScanId); — moved to confirm-ingredients

    // OCR-only: return ingredients for user review/editing.
    // Product creation and analysis happen in POST /confirm-ingredients
    // after the user confirms/edits the ingredient list.
    const flatIngredients = ingredientAnalyzer.parseIngredientTextFlat(
      mergedExtracted.rawIngredientsText || ingredientsList.join(', ')
    );

    // Store front data back so confirm-ingredients can access it
    pendingFrontLabels.set(pendingScanId, {
      ...frontData,
      productName: mergedExtracted.productName,
      displayName: mergedExtracted.displayName,
      manufacturer: mergedExtracted.manufacturer,
      brand: mergedExtracted.brand,
      targetPet: mergedExtracted.targetPet,
      productType: mergedExtracted.productType,
      texture: mergedExtracted.texture,
      lifeStage: mergedExtracted.lifeStage,
      lineName: mergedExtracted.lineName,
      primaryProteins: mergedExtracted.primaryProteins,
      breedSize: mergedExtracted.breedSize,
      dietTags: mergedExtracted.dietTags,
      imageUrl: existingLocalImage || frontData?.imageUrl || null,
      externalImageUrl: externalImageUrl || frontData?.externalImageUrl || null,
    });

    res.json({
      status: 'ingredients_extracted',
      scanType: 'two_step_scan',
      extracted: {
        imageType: 'merged',
        productName: mergedExtracted.productName,
        brand: mergedExtracted.brand,
        targetPet: mergedExtracted.targetPet,
        ingredientCount: ingredientsList.length,
        confidence: mergedExtracted.confidence || 0.95
      },
      ingredientsForEditor: flatIngredients,
      message: 'Ingredients extracted. Please review and confirm.'
    });

  } catch (error) {
    console.error('[BACK] Error:', error);
    next(error);
  }
});

/**
 * POST /api/scan/confirm-ingredients
 * User has reviewed & edited the OCR-extracted ingredients in the editor.
 * Accepts the final ingredient list and triggers analysis.
 */
router.post('/confirm-ingredients', authenticateToken, async (req, res, next) => {
  try {
    const {
      pendingScanId,
      ingredients,
      petName, petType, petBreed, petAgeMonths, petWeightKg,
      petAllergies, petHealthConditions, deviceId,
      barcode
    } = req.body;
    const userId = req.user?.id || null;

    if (!ingredients || !Array.isArray(ingredients) || ingredients.length === 0) {
      return res.status(400).json({ error: 'ingredients array is required and must not be empty' });
    }
    if (!petType || !['dog', 'cat'].includes(petType)) {
      return res.status(400).json({ error: 'petType is required (dog or cat)' });
    }

    // Retrieve front label data if available
    let frontData = null;
    if (pendingScanId) {
      frontData = pendingFrontLabels.get(pendingScanId);
      pendingFrontLabels.delete(pendingScanId);
    }

    const pet = {
      id: deviceId || 'local',
      name: petName || 'Pet',
      pet_type: petType,
      breed: petBreed || null,
      age_months: petAgeMonths ? parseInt(petAgeMonths) : null,
      weight_kg: petWeightKg ? parseFloat(petWeightKg) : null,
      healthConditions: []
    };

    if (petHealthConditions) {
      try {
        pet.healthConditions = typeof petHealthConditions === 'string'
          ? JSON.parse(petHealthConditions)
          : petHealthConditions;
      } catch (e) {
        pet.healthConditions = [];
      }
    }
    if (petAllergies) {
      try {
        const allergies = typeof petAllergies === 'string' ? JSON.parse(petAllergies) : petAllergies;
        allergies.forEach(a => {
          pet.healthConditions.push({ condition_type: `allergy_${a}`, severity: 'moderate' });
        });
      } catch (e) {}
    }

    const ingredientsList = ingredients.map(s => String(s).trim()).filter(Boolean);
    const rawText = ingredientsList.join(', ');

    const productName = frontData?.productName || req.body.productName || 'Unknown Product';
    const displayName =
      frontData?.displayName ||
      productMatchKey.buildDisplayName(productMatchKey.buildSlotsFromExtracted(frontData || {})) ||
      productName;
    const manufacturer = frontData?.manufacturer || req.body.manufacturer || null;
    const brand = frontData?.brand || req.body.brand || null;
    const productType = frontData?.productType || req.body.productType || 'dry_food';
    const targetPet = frontData?.targetPet || petType;
    const texture = frontData?.texture || null;
    const lifeStage = frontData?.lifeStage || 'all';

    const slots = productMatchKey.buildSlotsFromExtracted({
      manufacturer,
      brand,
      targetPet,
      lifeStage,
      lineName: frontData?.lineName,
      primaryProteins: frontData?.primaryProteins,
      breedSize: frontData?.breedSize,
      dietTags: frontData?.dietTags,
      productName: frontData?.productName || productName,
    });

    const extracted = {
      productName: displayName,
      manufacturer,
      brand,
      targetPet,
      productType,
      rawIngredientsText: rawText,
      ingredientsList,
      confidence: 1.0,
      imageType: 'confirmed_editor'
    };

    // Find or create product (match_key → ingredient hash → create)
    // Note: barcode is NOT used for lookup here because the user explicitly
    // confirmed this product via front label + ingredients. Barcode is stored after.
    let product = await productService.findProductForConfirm({
      slots,
      ingredientsList,
      brand,
      displayName,
    });

    if (!product) {
      product = await productService.createFromScan({
        name: displayName,
        displayName,
        manufacturer,
        brand,
        lineName: slots.lineName,
        primaryProteins: slots.primaryProteins,
        breedSize: slots.breedSize,
        dietTags: slots.dietTags,
        productType,
        texture,
        targetPetType: targetPet,
        lifeStage: slots.lifeStage !== 'all' ? slots.lifeStage : lifeStage,
        rawIngredientsText: rawText,
        ingredientsList,
        imageUrl: frontData?.imageUrl || null,
        barcode: barcode || null
      });
    } else {
      product = await productService.ensureProductMatchFields(product.id, slots);
    }

    // Save barcode to product if scanned and product doesn't already have one
    if (barcode && product && !product.barcode) {
      await query('UPDATE products SET barcode = ? WHERE id = ?', [barcode, product.id]);
      product.barcode = barcode;
      console.log(`📊 [CONFIRM] Barcode saved: ${barcode} for product ${product.id}`);
    }

    // Handle product image (non-blocking)
    if (!product.image_url && frontData) {
      if (frontData.imageUrl) {
        await query('UPDATE products SET image_url = ? WHERE id = ?', [frontData.imageUrl, product.id]);
        product.image_url = frontData.imageUrl;
      } else if (frontData.externalImageUrl) {
        imageService.downloadAndSave(frontData.externalImageUrl, product.id)
          .then(async (localUrl) => {
            if (localUrl) {
              await imageService.updateProductImageUrl(product.id, localUrl);
              console.log(`🖼️ [CONFIRM] Downloaded & saved image: ${localUrl}`);
            }
          })
          .catch(err => console.log('⚠️ [CONFIRM] Image download failed:', err.message));
      }
    }

    const scanId = uuidv4();
    analysisStore.set(scanId, {
      status: 'processing',
      progress: 'Analyzing confirmed ingredients...',
      extracted,
      product: { id: product.id, name: product.name, manufacturer: product.manufacturer, brand: product.brand, image_url: product.image_url },
      pet,
      startTime: Date.now()
    });

    await query('UPDATE products SET scan_count = scan_count + 1 WHERE id = ?', [product.id]);

    console.log(`✅ [CONFIRM] Confirmed ${ingredientsList.length} ingredients for "${brand || ''} ${productName}" → analysis started`);

    processAnalysisInBackground(scanId, ingredientsList, pet, extracted, product, deviceId || 'unknown', userId);

    res.json({
      scanId,
      status: 'processing',
      scanType: 'confirmed_ingredients',
      extracted: {
        productName,
        brand,
        targetPet,
        ingredientCount: ingredientsList.length,
        confidence: 1.0
      },
      product: {
        id: product.id,
        name: product.name,
        manufacturer: product.manufacturer,
        brand: product.brand,
        image_url: product.image_url,
      },
      pollUrl: `/api/scan/${scanId}/result`,
      message: 'Analysis started with confirmed ingredients.'
    });

  } catch (error) {
    console.error('[CONFIRM] Error:', error);
    next(error);
  }
});

/**
 * POST /api/scan/quick-analyze
 * Skip back label scan — analyze a known product from the DB for a specific pet.
 * Uses product.ingredient_hash to check cache first for instant results.
 */
router.post('/quick-analyze', authenticateToken, async (req, res, next) => {
  try {
    const { productId, petName, petType, petBreed, petAgeMonths, petWeightKg, petAllergies, petHealthConditions, deviceId } = req.body;
    const userId = req.user?.id || null;

    if (!productId) {
      return res.status(400).json({ error: 'productId is required' });
    }

    const product = await productService.findById(productId);
    if (!product || !product.raw_ingredients_text) {
      return res.status(404).json({ error: 'Product not found or has no ingredient data' });
    }

    // Build pet object
    let parsedConditions = [];
    if (petHealthConditions) {
      parsedConditions = typeof petHealthConditions === 'string'
        ? safeJsonParse(petHealthConditions, [])
        : petHealthConditions;
    }

    const pet = {
      id: deviceId || 'local',
      name: petName || 'Pet',
      pet_type: petType || product.target_pet_type || 'dog',
      breed: petBreed || null,
      age_months: petAgeMonths ? parseInt(petAgeMonths) : null,
      weight_kg: petWeightKg ? parseFloat(petWeightKg) : null,
      allergies: petAllergies ? (typeof petAllergies === 'string' ? safeJsonParse(petAllergies, []) : petAllergies) : [],
      healthConditions: parsedConditions
    };

    // Use stored ingredient_hash — no re-parsing needed for cache lookup
    const ingredientHash = product.ingredient_hash;
    const isTreatProduct = product.product_type === 'treats' || product.product_type === 'treat' || product.product_type === 'supplement';
    const productType = isTreatProduct ? 'treats' : 'food';
    const conditionHash = getSingleConditionHash('healthy', productType);

    // Try instant cache hit using the product's stored hash
    if (ingredientHash) {
      try {
        const cached = await query(
          `SELECT * FROM product_review_cache WHERE ingredient_hash = ? AND conditions_hash = ? AND pet_type = ?`,
          [ingredientHash, conditionHash, pet.pet_type]
        );

        if (cached.length > 0) {
          const row = cached[0];
          await query('UPDATE product_review_cache SET hit_count = hit_count + 1 WHERE id = ?', [row.id]);
          await query('UPDATE products SET scan_count = scan_count + 1 WHERE id = ?', [product.id]);

          const ingredientsList = ingredientAnalyzer.parseIngredientText(product.raw_ingredients_text);
          const analysis = await ingredientAnalyzer.analyzeIngredients(ingredientsList, pet);

          analysis.finalScore = row.final_score;
          analysis.grade = row.grade;
          analysis.recommendation = row.recommendation;

          const aiInsights = {
            topBenefits: safeJsonParse(row.positives, []),
            topConcerns: safeJsonParse(row.key_issues, []),
            conditionWarnings: ingredientAnalyzer.generateConditionWarnings(ingredientsList, pet.healthConditions || []),
            aiGenerated: true
          };

          const scanId = uuidv4();
          const resultPayload = {
            scanId,
            scanType: 'quick_analyze',
            imageType: 'quick_analyze',
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
              manufacturer: product.manufacturer,
              brand: product.brand,
              image_url: product.image_url,
              product_type: product.product_type
            },
            analysis,
            aiInsights,
            pet: { id: pet.id || 'local', name: pet.name, petType: pet.pet_type }
          };

          // Store in analysisStore so polling works
          analysisStore.set(scanId, {
            status: 'complete',
            createdAt: Date.now(),
            duration: 0,
            result: resultPayload
          });

          await saveScanHistoryEntry({
            scanId,
            userId,
            deviceId,
            productId: product.id,
            scanType: 'label_photo',
            petName: pet.name,
            petType: pet.pet_type,
            grade: row.grade,
            finalScore: row.final_score,
            recommendation: row.recommendation,
            analysisJson: JSON.stringify({ ...analysis, aiInsights })
          });

          console.log(`⚡ [QUICK] Instant cache hit for "${product.brand || ''} ${product.name}" → score=${row.final_score}`);

          return res.json({
            scanId,
            status: 'complete',
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
              manufacturer: product.manufacturer,
              brand: product.brand,
              image_url: product.image_url,
              product_type: product.product_type
            },
            analysis,
            aiInsights,
            pet: { id: pet.id || 'local', name: pet.name, petType: pet.pet_type }
          });
        }
      } catch (err) {
        console.warn('[QUICK] Cache lookup failed, falling back to full analysis:', err.message);
      }
    }

    // Cache miss — fall back to full analysis pipeline
    const ingredientsList = ingredientAnalyzer.parseIngredientText(product.raw_ingredients_text);
    if (ingredientsList.length === 0) {
      return res.status(422).json({ error: 'Could not parse ingredients for this product' });
    }

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

    analysisStore.set(scanId, {
      status: 'processing',
      progress: 'Analyzing ingredients...',
      extracted,
      product: { id: product.id, name: product.name, manufacturer: product.manufacturer, brand: product.brand, image_url: product.image_url },
      pet,
      startTime: Date.now()
    });

    await query('UPDATE products SET scan_count = scan_count + 1 WHERE id = ?', [product.id]);

    console.log(`⚡ [QUICK] Cache miss — full analysis for "${product.brand || ''} ${product.name}" (${ingredientsList.length} ingredients) for ${pet.name}`);

    processAnalysisInBackground(scanId, ingredientsList, pet, extracted, product, deviceId || 'unknown', userId);

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
        manufacturer: product.manufacturer,
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
      manufacturer: frontData.manufacturer,
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
router.post('/label', authenticateToken, upload.single('image'), async (req, res, next) => {
  try {
    // Pet info comes directly from the device
    const { petName, petType, petBreed, petAgeMonths, petWeightKg, petAllergies, petHealthConditions, deviceId } = req.body;
    const userId = req.user?.id || null;

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
      allergies: safeJsonParse(petAllergies, []),
      healthConditions: safeJsonParse(petHealthConditions, [])
    };

    const processedImage = await imagePreprocess.optimizeForUpload(req.file.buffer, {
      maxDimension: 1024,
    });

    // Extract info via Gemini OCR (now detects image type)
    const extracted = await geminiService.extractFromImage(processedImage, 'image/jpeg');

    // Debug logging
    console.log('📸 OCR Result:', {
      imageType: extracted.imageType,
      productName: extracted.productName,
      brand: extracted.brand,
      ingredientsCount: ingredientsListFromOcrText(extracted.rawIngredientsText).length,
      confidence: extracted.confidence,
      notes: extracted.notes
    });

    let ingredientsList = ingredientsListFromOcrText(extracted.rawIngredientsText);
    let product = null;
    let usedStoredIngredients = false;

    // Detect if this is a front label (no ingredients in OCR raw paragraph)
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
            ingredientsList = ingredientsListFromOcrText(product.raw_ingredients_text);
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

    if (!usedStoredIngredients) {
      const weakList = weakIngredientListResponse(
        res,
        ingredientsList,
        extracted.productType
      );
      if (weakList) return weakList;
    }

    // Try to find or create product using INGREDIENT HASH + brand/name
    // Same ingredients alone is not enough — different SKUs can share a formula
    if (!product && ingredientsList.length > 0) {
      const ingredientHash = productService.generateIngredientHash(ingredientsList);
      const existingProduct = await productService.findByIngredientHash(
        ingredientHash,
        extracted.brand,
        extracted.productName
      );
      
      if (existingProduct) {
        product = existingProduct;
        // Increment scan count for existing product
        await query('UPDATE products SET scan_count = scan_count + 1 WHERE id = ?', [product.id]);
      } else if (extracted.productName || extracted.brand) {
        const slots = productMatchKey.buildSlotsFromExtracted(extracted);
        const displayName =
          productMatchKey.buildDisplayName(slots) || extracted.productName || 'Unknown Product';

        const byKey = productMatchKey.hasMinimumMatchSlots(slots)
          ? await productService.findByMatchSlots(slots)
          : null;
        if (byKey) {
          product = byKey;
          await query('UPDATE products SET scan_count = scan_count + 1 WHERE id = ?', [product.id]);
        } else {
          product = await productService.createFromScan({
            name: displayName,
            displayName,
            manufacturer: extracted.manufacturer,
            brand: extracted.brand,
            lineName: slots.lineName,
            primaryProteins: slots.primaryProteins,
            breedSize: slots.breedSize,
            dietTags: slots.dietTags,
            productType: extracted.productType || 'dry_food',
            texture: extracted.texture || null,
            targetPetType: extracted.targetPet || 'both',
            lifeStage: slots.lifeStage !== 'all' ? slots.lifeStage : extracted.lifeStage,
            rawIngredientsText: extracted.rawIngredientsText,
            ingredientsList: ingredientsList
          });
        }
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
      processAnalysisInBackground(scanId, ingredientsList, pet, extracted, product, deviceId, userId);
      
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
        product: product ? { id: product.id, name: product.name, manufacturer: product.manufacturer, brand: product.brand } : null,
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
    const rawProductType2 = extracted.productType || product?.product_type || 'food';
    const isTreatProduct2 = rawProductType2 === 'treats' || rawProductType2 === 'treat' || rawProductType2 === 'supplement';
    const productType = isTreatProduct2 ? 'treats' : 'food';
    
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
            healthConditions, // ignored: per-ingredient AI is universal healthy baseline
            productType,
            {
              fullIngredientLines: ingredientsList.map((s) => String(s || '').trim()).filter(Boolean),
            }
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
          const riskScore = assessment.riskScore || 0;

          // AI text/scores are healthy-pet universal; do not clobber rule-based allergen/toxic
          if (!ing.isAllergenMatch && !ing.isToxic) {
            ing.explanation = assessment.explanation || ing.explanation;
            ing.positiveBenefit = assessment.benefit || ing.positiveBenefit;
            if (hasConditions || ing.needsAIAssessment) {
              ing.adjustedRiskScore = riskScore * ing.positionWeight;
            }
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

    if (holisticReview) {
      holisticReview = await ingredientAnalyzer.overlayDeterministicHolisticScores(
        holisticReview,
        ingredientsList,
        pet.pet_type,
        productType,
        productType
      );
      try {
        await query(
          `UPDATE product_review_cache SET final_score = ?, grade = ?, recommendation = ?, updated_at = CURRENT_TIMESTAMP
           WHERE ingredient_hash = ? AND conditions_hash = ? AND pet_type = ?`,
          [holisticReview.finalScore, holisticReview.grade, holisticReview.recommendation || getRecommendationFromGrade(holisticReview.grade), ingredientHash, syncConditionsHash, pet.pet_type]
        );
      } catch (e) {
        console.warn('[SYNC] product_review_cache score sync:', e.message);
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

    const scanId = uuidv4();
    await saveScanHistoryEntry({
      scanId,
      userId,
      deviceId,
      petName: pet.name,
      petType: pet.pet_type,
      productId: product?.id || null,
      scanType: 'label_photo',
      finalScore: analysis.finalScore,
      grade: analysis.grade,
      recommendation: analysis.recommendation,
      ocrExtractedText: extracted.rawIngredientsText || product?.raw_ingredients_text,
      analysisJson: JSON.stringify({ ...analysis, aiInsights }),
    });

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
        manufacturer: product.manufacturer,
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

/** Build poll-complete payload from scan_history when in-memory store is gone. */
function buildPollCompleteFromHistoryRow(row) {
  if (!row?.analysis_json) return null;

  let parsed = row.analysis_json;
  if (typeof parsed === 'string') {
    parsed = safeJsonParse(parsed, null);
  }
  if (!parsed || typeof parsed !== 'object') return null;

  let analysis = parsed;
  let aiInsights = null;
  if (parsed.aiInsights != null) {
    aiInsights = parsed.aiInsights;
    const { aiInsights: _drop, ...rest } = parsed;
    analysis = rest;
  }

  const productName =
    row.product_name ||
    (row.scan_type === 'manual_input' ? 'Manual entry' : undefined);

  return {
    scanId: row.id,
    scanType: row.scan_type,
    extracted: {
      ...(productName ? { productName } : {}),
      ...(row.product_brand ? { brand: row.product_brand } : {}),
    },
    product: row.product_id
      ? {
          id: row.product_id,
          name: row.product_name,
          brand: row.product_brand,
          image_url: row.product_image,
          product_type: row.product_type,
        }
      : null,
    analysis,
    ...(aiInsights ? { aiInsights } : {}),
    pet: { name: row.pet_name, petType: row.pet_type },
  };
}

/**
 * GET /api/scan/:scanId/result
 * Poll for analysis result (used with async mode).
 * Falls back to scan_history when the in-memory store is missing or expired.
 */
router.get('/:scanId/result', async (req, res, next) => {
  try {
    const { scanId } = req.params;
    const data = analysisStore.get(scanId);

    if (data?.status === 'complete') {
      const elapsedSeconds = Math.round((Date.now() - data.createdAt) / 1000);
      return res.json({
        status: 'complete',
        duration: data.duration,
        elapsedSeconds,
        ...data.result,
      });
    }

    if (data?.status === 'error') {
      const elapsedSeconds = Math.round((Date.now() - data.createdAt) / 1000);
      return res.json({
        status: 'error',
        error: data.error,
        elapsedSeconds,
      });
    }

    if (data) {
      return res.json({
        status: data.status,
        progress: data.progress,
        elapsedSeconds: Math.round((Date.now() - data.createdAt) / 1000),
      });
    }

    const rows = await query(
      `SELECT sh.*, p.name AS product_name, p.brand AS product_brand,
              p.image_url AS product_image, p.product_type
       FROM scan_history sh
       LEFT JOIN products p ON sh.product_id = p.id
       WHERE sh.id = ?`,
      [scanId]
    );

    const historyPayload = rows[0] ? buildPollCompleteFromHistoryRow(rows[0]) : null;
    if (historyPayload) {
      return res.json({
        status: 'complete',
        fromHistory: true,
        ...historyPayload,
      });
    }

    return res.json({
      status: 'processing',
      progress: 'Analyzing...',
      elapsedSeconds: 0,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/scan/food-check
 * Take a photo of food and check if it's safe for your pet
 * Uses per-single-condition caching (same pattern as Label Scan)
 */
router.post('/food-check', authenticateToken, upload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image provided' });
    }

    const { petName, petType, petHealthConditions, deviceId } = req.body;
    const userId = req.user?.id || null;

    if (!petType || !['dog', 'cat'].includes(petType)) {
      return res.status(400).json({ error: 'petType is required (dog or cat)' });
    }

    const imageBuffer = await imagePreprocess.optimizeForUpload(req.file.buffer, {
      maxDimension: 1024,
    });

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
router.post('/manual', authenticateToken, async (req, res, next) => {
  try {
    const { ingredientsText, productName, petName, petType, petAllergies, petHealthConditions, deviceId } = req.body;
    const userId = req.user?.id || null;

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
      allergies: safeJsonParse(petAllergies, []),
      healthConditions: safeJsonParse(petHealthConditions, [])
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

    /** food | treats — drives conditions_hash (e.g. healthy_food vs healthy_treats) for cache alignment. */
    let productType = req.body.productType ?? req.body.product_type;
    if (productType != null && String(productType).trim() !== '') {
      const pt = String(productType).toLowerCase().trim();
      if (pt === 'treat' || pt === 'treats') {
        productType = 'treats';
      } else if (pt === 'food') {
        productType = 'food';
      } else {
        return res.status(400).json({ error: 'productType must be "food" or "treats"' });
      }
    } else {
      productType = 'food';
    }

    console.log(
      `🏷️ [Manual] productType=${productType}${
        req.body.productType || req.body.product_type ? ' (client)' : ' (default)'
      }`
    );

    // Analyze ingredients (basic per-ingredient assessment)
    let analysis = await ingredientAnalyzer.analyzeIngredients(ingredientsList, pet);

    // =============================================
    // PER-CONDITION AI INGREDIENT ASSESSMENT
    // Same as label scan: get AI descriptions for each ingredient
    // =============================================
    const healthConditions = pet.healthConditions || [];
    const hasConditions = healthConditions.length > 0;
    
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
            productType,
            {
              fullIngredientLines: ingredientsList.map((s) => String(s || '').trim()).filter(Boolean),
            }
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
        
        if (!ing.isAllergenMatch && !ing.isToxic) {
          ing.adjustedRiskScore = worstScore;
          ing.explanation = worstExplanation;
          ing.positiveBenefit = bestBenefit;
          if (worstScore > 30) ing.riskLevel = 'danger';
          else if (worstScore > 15) ing.riskLevel = 'high';
          else if (worstScore > 0) ing.riskLevel = 'moderate';
          else if (worstScore > -10) ing.riskLevel = 'low';
          else ing.riskLevel = 'safe';
        }
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

    Object.assign(
      conditionReviews,
      await ingredientAnalyzer.overlayDeterministicConditionReviews(
        conditionReviews,
        ingredientsList,
        pet.pet_type,
        productType,
        productType
      )
    );
    
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
      holisticReview = await ingredientAnalyzer.overlayDeterministicHolisticScores(
        holisticReview,
        ingredientsList,
        pet.pet_type,
        productType,
        productType
      );
    }

    try {
      for (const [condition, review] of Object.entries(conditionReviews)) {
        if (!review) continue;
        const ch = getSingleConditionHash(condition, productType);
        await query(
          `UPDATE product_review_cache SET final_score = ?, grade = ?, recommendation = ?, updated_at = CURRENT_TIMESTAMP
           WHERE ingredient_hash = ? AND conditions_hash = ? AND pet_type = ?`,
          [review.finalScore, review.grade, review.recommendation || getRecommendationFromGrade(review.grade), ingredientHash, ch, pet.pet_type]
        );
      }
      if (Object.keys(conditionReviews).length === 0 && holisticReview) {
        const ch = getSingleConditionHash('healthy', productType);
        await query(
          `UPDATE product_review_cache SET final_score = ?, grade = ?, recommendation = ?, updated_at = CURRENT_TIMESTAMP
           WHERE ingredient_hash = ? AND conditions_hash = ? AND pet_type = ?`,
          [holisticReview.finalScore, holisticReview.grade, holisticReview.recommendation || getRecommendationFromGrade(holisticReview.grade), ingredientHash, ch, pet.pet_type]
        );
      }
    } catch (e) {
      console.warn('[Manual] product_review_cache score sync:', e.message);
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
    await saveScanHistoryEntry({
      scanId,
      userId,
      deviceId,
      petName: pet.name,
      petType: pet.pet_type,
      scanType: 'manual_input',
      finalScore: analysis.finalScore,
      grade: analysis.grade,
      recommendation: analysis.recommendation,
      rawTextInput: ingredientsText,
      analysisJson: JSON.stringify({ ...analysis, aiInsights }),
    });

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
router.get('/history', authenticateToken, async (req, res, next) => {
  try {
    const { limit = 20, offset = 0 } = req.query;
    const userId = req.user?.id || null;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { petName, petType } = req.query;
    
    let sql = `
      SELECT sh.*, p.name as product_name, p.brand as product_brand, p.image_url as product_image, p.target_life_stage as product_life_stage
      FROM scan_history sh
      LEFT JOIN products p ON sh.product_id = p.id
      WHERE sh.user_id = ?
    `;
    const params = [userId];

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
router.get('/:id', authenticateToken, async (req, res, next) => {
  try {
    const userId = req.user?.id || null;
    
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const [scan] = await query(
      `SELECT sh.*, p.name as product_name, p.brand as product_brand,
              p.image_url as product_image, p.product_type
       FROM scan_history sh
       LEFT JOIN products p ON sh.product_id = p.id
       WHERE sh.id = ? AND sh.user_id = ?`,
      [req.params.id, userId]
    );

    if (!scan) {
      return res.status(404).json({ error: 'Scan not found' });
    }

    // Parse stored analysis JSON (mysql2 may auto-parse JSON columns)
    if (scan.analysis_json) {
      scan.analysis = typeof scan.analysis_json === 'string'
        ? JSON.parse(scan.analysis_json)
        : scan.analysis_json;
    } else {
      scan.analysis = {};
    }
    delete scan.analysis_json;

    res.json({ scan });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

