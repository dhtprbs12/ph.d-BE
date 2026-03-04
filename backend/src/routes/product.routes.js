const express = require('express');
const router = express.Router();
const { query } = require('../database/connection');
const { authenticateToken, optionalAuth } = require('../middleware/auth');
const productService = require('../services/productService');
const ingredientAnalyzer = require('../services/ingredientAnalyzer');
const imageService = require('../services/imageService');
const { 
  getSingleConditionHash, 
  safeJsonParse, 
  gradeToNumber, 
  numberToGrade 
} = require('../utils/cacheHelpers');

// Debug middleware to log all product route requests
router.use((req, res, next) => {
  console.log(`📦 [Products] ${req.method} ${req.originalUrl}`);
  next();
});

/**
 * GET /api/products/search
 * Search products with optional text query
 */
router.get('/search', optionalAuth, async (req, res, next) => {
  try {
    const { q, petType, limit = 20, offset = 0 } = req.query;

    if (!q || q.length < 2) {
      return res.status(400).json({ error: 'Search query must be at least 2 characters' });
    }

    const products = await productService.search(q, {
      targetPetType: petType,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });

    res.json({ products });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/products/filter
 * Filter products by multiple criteria (for product discovery)
 * Now also computes personalized scores and fetches images inline.
 */
router.get('/filter', optionalAuth, async (req, res, next) => {
  try {
    const {
      petType,
      productType,
      lifeStage,
      noGrains,
      withGrains,
      withChicken,
      withBeef,
      withFish,
      withLamb,
      withTurkey,
      withDuck,
      minScore,
      q,
      healthConditions: healthConditionsRaw,
      limit = 20,
      offset = 0
    } = req.query;

    console.log('🔍 Filter request:', { petType, productType, lifeStage, q, limit });

    // Parse health conditions early — used for both DB filtering and scoring
    let healthConditions = [];
    try {
      healthConditions = healthConditionsRaw ? JSON.parse(healthConditionsRaw) : [];
    } catch (e) { /* ignore parse errors */ }

    const pet_type = petType || 'dog';

    const products = await productService.filterProducts({
      petType,
      productType,
      lifeStage,
      allergenExclusions: {
        grains: noGrains === 'true'
      },
      ingredientInclusions: {
        grains: withGrains === 'true',
        chicken: withChicken === 'true',
        beef: withBeef === 'true',
        fish: withFish === 'true',
        lamb: withLamb === 'true',
        turkey: withTurkey === 'true',
        duck: withDuck === 'true'
      },
      healthConditions,
      minScore: minScore ? parseInt(minScore) : undefined,
      searchTerm: q,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });

    // =============================================
    // SCORE LOOKUP (Tier 1 + Tier 2, no AI calls)
    // Skip scoring entirely when no pet info was provided (e.g. dog owner browsing cat products)
    // =============================================
    const scores = {};
    const skipScoring = !healthConditionsRaw;

    if (skipScoring) {
      console.log(`📊 [FILTER] Skipping scoring — no pet conditions provided`);
    }

    const hasConditions = healthConditions && healthConditions.length > 0;
    const conditionsToCheck = hasConditions
      ? healthConditions.map(c => c.condition_type || c.conditionType || c)
      : ['healthy'];

    if (!skipScoring) {
      console.log(`📊 [FILTER] Scoring ${products.length} products, conditions: ${conditionsToCheck.join(', ')}`);
    }

    !skipScoring && await Promise.all(products.map(async (product) => {
      try {
        if (!product.ingredient_hash && !product.raw_ingredients_text) return;

        const ingredientsList = ingredientAnalyzer.parseIngredientText(product.raw_ingredients_text);
        if (!ingredientsList || ingredientsList.length === 0) return;

        const ingredientHash = product.ingredient_hash || productService.generateIngredientHash(ingredientsList);
        if (!ingredientHash) return;

        const isTreatProduct = product.product_type === 'treats' || product.product_type === 'supplement' || ingredientsList.length <= 6;
        const productTypeForHash = isTreatProduct ? 'treats' : 'food';
        const actualProductType = product.product_type || (isTreatProduct ? 'treats' : 'food');

        let worstScore = 100;
        let worstGradeNum = 5;
        let worstRecommendation = 'highly_recommended';
        let allConditionsScored = true;

        for (const condition of conditionsToCheck) {
          const conditionHash = getSingleConditionHash(condition, productTypeForHash);
          let review = null;

          // ── Tier 1: product_review_cache ──
          try {
            const cached = await query(
              `SELECT final_score, grade, recommendation FROM product_review_cache 
               WHERE ingredient_hash = ? AND conditions_hash = ? AND pet_type = ? LIMIT 1`,
              [ingredientHash, conditionHash, pet_type]
            );
            if (cached.length > 0) {
              review = { finalScore: cached[0].final_score, grade: cached[0].grade, recommendation: cached[0].recommendation };
            }
          } catch (err) { /* continue to Tier 2 */ }

          // ── Tier 2: compute from ai_assessment_cache (DB reads + math, no AI) ──
          // ONLY use score if ALL ingredients are cached — no partial scores
          if (!review) {
            try {
              const computed = await ingredientAnalyzer.computeScoreFromCache(ingredientsList, conditionHash, pet_type, actualProductType);
              if (computed.finalScore !== undefined && computed.allCached) {
                review = { finalScore: computed.finalScore, grade: computed.grade, recommendation: computed.recommendation };
                // Save to product_review_cache → next time it's a Tier 1 hit
                try {
                  const { v4: uuidv4 } = require('uuid');
                  await query(
                    `INSERT INTO product_review_cache 
                     (id, ingredient_hash, conditions_hash, pet_type, product_type, final_score, grade, recommendation,
                      key_issues, positives, ai_summary, protein_quality, has_artificial_additives, primary_ingredient_type)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE 
                      final_score = VALUES(final_score), grade = VALUES(grade), recommendation = VALUES(recommendation),
                      hit_count = hit_count + 1`,
                    [
                      uuidv4(), ingredientHash, conditionHash, pet_type,
                      product.product_type || 'dry_food',
                      computed.finalScore, computed.grade, computed.recommendation || 'consider',
                      JSON.stringify(computed.keyIssues || []),
                      JSON.stringify(computed.positives || []),
                      computed.aiSummary || '', computed.proteinQuality || null,
                      computed.hasArtificialAdditives ? 1 : 0, computed.primaryIngredientType || null
                    ]
                  );
                } catch (err) { /* cache save failed, continue */ }
              }
            } catch (err) { /* continue */ }
          }

          if (review) {
            const gNum = gradeToNumber(review.grade);
            if (review.finalScore < worstScore) {
              worstScore = review.finalScore;
              worstRecommendation = review.recommendation;
            }
            if (gNum < worstGradeNum) worstGradeNum = gNum;
          } else {
            allConditionsScored = false;
          }
        }

        if (allConditionsScored && worstScore < 100) {
          scores[product.id] = {
            score: worstScore,
            grade: numberToGrade(worstGradeNum),
            recommendation: worstRecommendation || 'consider'
          };
        }
      } catch (err) {
        // skip scoring for this product
      }
    }));

    console.log(`✅ [FILTER] Scored ${Object.keys(scores).length}/${products.length} products (Tier 1 + Tier 2, no AI)`);

    // =============================================
    // SORT: scored products first (score desc), then unscored alphabetically
    // =============================================
    products.sort((a, b) => {
      const sA = scores[a.id]?.score;
      const sB = scores[b.id]?.score;
      if (sA !== undefined && sB !== undefined) return sB - sA;
      if (sA !== undefined) return -1;
      if (sB !== undefined) return 1;
      return (a.name || '').localeCompare(b.name || '');
    });

    res.json({ 
      products,
      scores,
      filters: {
        petType,
        productType,
        lifeStage,
        ingredientInclusions: Object.entries({
          withGrains, withChicken, withBeef, withFish, withLamb, withTurkey, withDuck
        }).filter(([_, v]) => v === 'true').map(([k]) => k)
      },
      pagination: {
        limit: parseInt(limit),
        offset: parseInt(offset),
        count: products.length
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/products/:id/image
 * Lightweight endpoint to fetch a product image on demand.
 * Returns existing image_url if available, otherwise fetches via SerpAPI, saves, and returns.
 */
router.get('/:id/image', async (req, res, next) => {
  try {
    const { id } = req.params;
    const product = await productService.findById(id);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    // Already has an image — return immediately
    if (product.image_url) {
      return res.json({ imageUrl: product.image_url });
    }

    // Fetch, save, and return
    try {
      const imageUrl = await imageService.fetchAndSaveProductImage(product.id, product.name, product.brand);
      if (imageUrl) {
        return res.json({ imageUrl });
      }
    } catch (err) {
      console.log('⚠️ [Image] Fetch failed for', product.name, err.message);
    }

    // No image found
    res.json({ imageUrl: null });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/products/batch-scores
 * Get cached personalized scores for multiple products
 * Uses PER-CONDITION caching: checks each individual condition and takes WORST score
 * Returns scores only if ALL conditions are cached for that product
 */
router.post('/batch-scores', optionalAuth, async (req, res, next) => {
  try {
    const { productIds, petType, healthConditions = [] } = req.body;
    
    if (!productIds || !Array.isArray(productIds) || productIds.length === 0) {
      return res.json({ scores: {} });
    }
    
    const pet_type = petType || 'dog';
    const hasConditions = healthConditions && healthConditions.length > 0;
    const conditionsToCheck = hasConditions 
      ? healthConditions.map(c => c.condition_type || c.conditionType || c)
      : ['healthy'];
    
    console.log(`🔍 [BATCH] Checking scores for ${productIds.length} products, pet: ${pet_type}, conditions: ${conditionsToCheck.join(', ')}`);
    
    // Get products with their ingredient hashes and product types
    const placeholders = productIds.map(() => '?').join(',');
    const products = await query(
      `SELECT id, ingredient_hash, product_type, raw_ingredients_text FROM products WHERE id IN (${placeholders})`,
      productIds
    );
    
    if (products.length === 0) {
      return res.json({ scores: {} });
    }
    
    const scores = {};
    
    for (const product of products) {
      if (!product.ingredient_hash) continue;
      
      // Determine product type (treats vs food)
      let productTypeForHash = 'food';
      if (product.product_type === 'treats') {
        productTypeForHash = 'treats';
      } else if (product.raw_ingredients_text) {
        const ingredientCount = product.raw_ingredients_text.split(',').length;
        if (ingredientCount <= 6) productTypeForHash = 'treats';
      }
      
      // Check cache for EACH individual condition
      const conditionScores = [];
      let allConditionsCached = true;
      
      for (const condition of conditionsToCheck) {
        const conditionHash = getSingleConditionHash(condition, productTypeForHash);
        
        const cached = await query(
          `SELECT final_score, grade, recommendation
           FROM product_review_cache 
           WHERE ingredient_hash = ? AND conditions_hash = ? AND pet_type = ?
           LIMIT 1`,
          [product.ingredient_hash, conditionHash, pet_type]
        );
        
        if (cached.length > 0) {
          conditionScores.push({
            score: cached[0].final_score,
            grade: cached[0].grade,
            gradeNum: gradeToNumber(cached[0].grade),
            recommendation: cached[0].recommendation
          });
        } else {
          // If any condition is not cached, we don't have a complete score
          allConditionsCached = false;
          break;
        }
      }
      
      // Only return a score if ALL conditions are cached
      if (allConditionsCached && conditionScores.length > 0) {
        // Take the WORST score and grade
        const worstScore = Math.min(...conditionScores.map(c => c.score));
        const worstGradeNum = Math.min(...conditionScores.map(c => c.gradeNum));
        
        // Use the recommendation from the worst scoring condition
        const worstCondition = conditionScores.find(c => c.score === worstScore);
        
        scores[product.id] = {
          score: worstScore,
          grade: numberToGrade(worstGradeNum),
          recommendation: worstCondition?.recommendation || 'unknown'
        };
      }
    }
    
    console.log(`✅ [BATCH] Found ${Object.keys(scores).length}/${productIds.length} fully cached scores`);
    
    res.json({ scores });
  } catch (error) {
    console.error('[BATCH] Error:', error);
    next(error);
  }
});

/**
 * GET /api/products/:id
 * Get product details
 */
router.get('/:id', optionalAuth, async (req, res, next) => {
  try {
    const product = await productService.findById(req.params.id);

    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    // Get review stats
    const { stats } = await productService.getReviews(req.params.id, { limit: 0 });

    res.json({ 
      product,
      reviewStats: stats
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/products/:id/analyze
 * Analyze product for a specific pet with AI-enhanced holistic review
 * Uses PER-CONDITION caching: checks each individual condition and takes WORST score
 */
router.get('/:id/analyze', optionalAuth, async (req, res, next) => {
  try {
    console.log('🔍 [ANALYZE] Product ID:', req.params.id);
    
    const { 
      petId,
      petName,
      petType,
      petBreed,
      petAge,
      petAgeMonths,
      petWeight,
      healthConditions
    } = req.query;

    // Build pet object from query params
    const pet = {
      id: petId || 'local',
      name: petName || 'Pet',
      pet_type: petType || 'dog',
      breed: petBreed || null,
      age_years: petAge ? parseFloat(petAge) : (petAgeMonths ? parseFloat(petAgeMonths) / 12 : null),
      weight_kg: petWeight ? parseFloat(petWeight) : null,
      healthConditions: healthConditions ? JSON.parse(healthConditions) : []
    };
    
    console.log('🐕 [ANALYZE] Pet:', pet.name, pet.pet_type);

    // Get product from database
    const product = await productService.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }
    console.log('✅ [ANALYZE] Found product:', product.name);

    // Parse ingredients
    const ingredientsList = ingredientAnalyzer.parseIngredientText(product.raw_ingredients_text);
    if (!ingredientsList || ingredientsList.length === 0) {
      return res.status(400).json({ error: 'Product has no ingredients to analyze' });
    }
    console.log(`📝 [ANALYZE] ${ingredientsList.length} ingredients found`);

    // Use DB-stored hash if available, otherwise generate
    const ingredientHash = product.ingredient_hash || productService.generateIngredientHash(ingredientsList);
    const geminiService = require('../services/geminiService');
    const isTreatProduct = product.product_type === 'treats' || product.product_type === 'supplement' || ingredientsList.length <= 6;
    const productTypeForHash = isTreatProduct ? 'treats' : 'food';
    // For AI prompt context: pass actual product_type so AI knows supplement vs treat vs food
    const productTypeForAI = product.product_type || (isTreatProduct ? 'treats' : 'food');
    
    // Get list of individual conditions to evaluate (including "healthy" as a baseline)
    const hasConditions = pet.healthConditions && pet.healthConditions.length > 0;
    const conditionsToEvaluate = hasConditions 
      ? pet.healthConditions.map(c => c.condition_type || c)
      : ['healthy'];
    
    console.log('🏥 [ANALYZE] Evaluating conditions:', conditionsToEvaluate.join(', '));

    // =============================================
    // PHASE 1: PER-INGREDIENT AI ASSESSMENT
    // Run FIRST so ai_assessment_cache is fully populated
    // before Tier 2 holistic scoring tries to compute from it
    // =============================================
    console.log('🧪 [ANALYZE] Running ingredient-level analysis...');
    const ingredientAnalysis = await ingredientAnalyzer.analyzeIngredients(ingredientsList, pet);

    const ingredientsToAssess = ingredientAnalysis.ingredients.filter(i => i.needsAIAssessment);
    const allConditionAssessments = {}; // { ingredientName: { condition: assessment } }
    
    if (ingredientsToAssess.length > 0) {
      console.log(`🤖 [ANALYZE] Checking cache for ${ingredientsToAssess.length} ingredients x ${conditionsToEvaluate.length} conditions...`);
        
        const uncachedByCondition = {}; // { condition: { conditionHash, ingredients: [] } }
        const ingCacheInserts = [];
        
        // STEP 1: Check cache for ALL conditions x ALL ingredients
        for (const condition of conditionsToEvaluate) {
          const conditionHash = getSingleConditionHash(condition, productTypeForHash);
          uncachedByCondition[condition] = { conditionHash, ingredients: [] };
          
          for (const ing of ingredientsToAssess) {
            try {
              const cached = await ingredientAnalyzer.cacheLookup(
                ing.normalizedName, conditionHash, pet.pet_type
              );
              
              if (cached.length > 0) {
                if (!allConditionAssessments[ing.name]) allConditionAssessments[ing.name] = {};
                allConditionAssessments[ing.name][condition] = {
                  riskScore: cached[0].risk_score,
                  explanation: cached[0].explanation,
                  benefit: cached[0].benefit,
                  fromCache: true
                };
                console.log(`💾 [ANALYZE] Cache hit: ${ing.name} + ${condition}`);
              } else {
                uncachedByCondition[condition].ingredients.push(ing);
              }
            } catch (err) {
              uncachedByCondition[condition].ingredients.push(ing);
            }
          }
        }
        
        // STEP 2: Call AI for uncached ingredients (parallel per condition)
        const conditionsNeedingAI = Object.entries(uncachedByCondition).filter(([_, data]) => data.ingredients.length > 0);
        
        if (conditionsNeedingAI.length > 0) {
          console.log(`🚀 [ANALYZE] AI assessing ${conditionsNeedingAI.length} condition(s)...`);
          
          const aiPromises = conditionsNeedingAI.map(async ([condition, { conditionHash, ingredients }]) => {
            const singleCondition = condition === 'healthy' ? [] : [{ condition_type: condition }];
            try {
              const aiAssessments = await geminiService.assessIngredientsForPet(
                ingredients,
                pet.pet_type,
                pet.name,
                singleCondition,
                productTypeForAI
              );
              return { condition, conditionHash, ingredients, aiAssessments, success: true };
            } catch (err) {
              console.error(`[ANALYZE] AI failed for ${condition}:`, err.message);
              return { condition, conditionHash, ingredients, aiAssessments: {}, success: false };
            }
          });
          
          const aiResults = await Promise.all(aiPromises);
          
          // Process AI results and prepare cache inserts
          for (const { condition, conditionHash, ingredients, aiAssessments, success } of aiResults) {
            if (!success) continue;
            
            for (const ing of ingredients) {
              let assessment = aiAssessments[ing.name];
              // Try fuzzy match
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
                if (ing.normalizedName) {
                  ingCacheInserts.push([
                    ing.normalizedName, conditionHash, pet.pet_type,
                    assessment.riskScore || 0, assessment.explanation || '', assessment.benefit || ''
                  ]);
                }
              }
            }
          }
          
          // STEP 3: Batch save to ai_assessment_cache
          if (ingCacheInserts.length > 0) {
            try {
              const placeholders = ingCacheInserts.map(() => '(UUID(), ?, ?, ?, ?, ?, ?)').join(', ');
              await query(
                `INSERT INTO ai_assessment_cache (id, ingredient_normalized, conditions_hash, pet_type, risk_score, explanation, benefit)
                 VALUES ${placeholders}
                 ON DUPLICATE KEY UPDATE risk_score = VALUES(risk_score), explanation = VALUES(explanation), benefit = VALUES(benefit), hit_count = hit_count + 1`,
                ingCacheInserts.flat()
              );
              console.log(`💾 [ANALYZE] Cached ${ingCacheInserts.length} ingredient assessments`);
            } catch (err) {
              console.warn('[ANALYZE] Cache save failed:', err.message);
            }
          }
        }
        
        // STEP 4: Update ingredients with WORST score across conditions
        for (const ing of ingredientAnalysis.ingredients) {
          const conditionScores = allConditionAssessments[ing.name] || {};
          
          if (Object.keys(conditionScores).length > 0) {
            let worstScore = -100;
            let worstExplanation = '';
            let worstBenefit = '';
            
            for (const [cond, assessment] of Object.entries(conditionScores)) {
              if (assessment.riskScore > worstScore) {
                worstScore = assessment.riskScore;
                worstExplanation = assessment.explanation;
                worstBenefit = assessment.benefit || '';
              }
            }
            
            // Don't show benefits for dangerous ingredients (score > 30)
            if (worstScore > 30) {
              worstBenefit = '';
            }
            
            ing.explanation = worstExplanation || ing.explanation;
            ing.positiveBenefit = worstBenefit || ing.positiveBenefit;
            ing.adjustedRiskScore = worstScore * (ing.positionWeight || 1);
            
            // Set risk level based on worst score
            if (worstScore <= -10) ing.riskLevel = 'safe';
            else if (worstScore <= 0) ing.riskLevel = 'low';
            else if (worstScore <= 15) ing.riskLevel = 'moderate';
            else if (worstScore <= 30) ing.riskLevel = 'high';
            else ing.riskLevel = 'danger';
            
            console.log(`🎯 [ANALYZE] ${ing.name}: score=${worstScore}, level=${ing.riskLevel}`);
          }
        }
    }

    // =============================================
    // PHASE 2: PER-CONDITION HOLISTIC REVIEW
    // Now ai_assessment_cache is fully populated, so Tier 2
    // can compute accurate scores from ALL ingredients
    // =============================================
    const conditionReviews = {};
    const cacheInserts = [];
    
    for (const condition of conditionsToEvaluate) {
      const conditionHash = getSingleConditionHash(condition, productTypeForHash);
      
      // ── Tier 1: product_review_cache (instant DB read) ──
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
            hasArtificialAdditives: Boolean(cached[0].has_artificial_additives),
            primaryIngredientType: cached[0].primary_ingredient_type,
            fromCache: true
          };
          console.log(`⚡ [ANALYZE] Cache hit for ${condition}: score=${cached[0].final_score}`);
          
          await query('UPDATE product_review_cache SET hit_count = hit_count + 1 WHERE id = ?', [cached[0].id]);
        }
      } catch (err) {
        console.warn(`[ANALYZE] Cache check failed for ${condition}:`, err.message);
      }
      
      // ── Tier 2: Compute from ai_assessment_cache (all ingredients now cached) ──
      // ONLY use score if ALL ingredients are cached — no partial scores
      if (!conditionReviews[condition]) {
        try {
          const computed = await ingredientAnalyzer.computeScoreFromCache(ingredientsList, conditionHash, pet.pet_type, productTypeForAI);
          
          if (computed.finalScore !== undefined && computed.allCached) {
            conditionReviews[condition] = { ...computed, fromCache: false };
            console.log(`🧮 [ANALYZE-T2] Computed from ingredients: ${condition} = ${computed.finalScore} (${ingredientsList.length}/${ingredientsList.length} cached)`);
            
            // Save to product_review_cache for future Tier 1 hits
            cacheInserts.push({
              ingredientHash,
              conditionHash,
              petType: pet.pet_type,
              productType: product.product_type || 'dry_food',
              review: computed
            });
          }
        } catch (err) {
          console.warn(`[ANALYZE-T2] Compute failed for ${condition}:`, err.message);
        }
      }

      // ── Tier 3: AI holistic fallback (last resort) ──
      if (!conditionReviews[condition]) {
        console.log(`🤖 [ANALYZE-T3] AI fallback for condition: ${condition}`);
        const singleConditionList = condition === 'healthy' ? [] : [condition];
        
        try {
          const review = await geminiService.reviewProductHolistically({
            ingredients: ingredientsList,
            petType: pet.pet_type,
            healthConditions: singleConditionList,
            productType: productTypeForAI,
            petName: pet.name
          });
          
          conditionReviews[condition] = { ...review, fromCache: false };
          console.log(`🤖 [ANALYZE-T3] AI review for ${condition}: score=${review.finalScore}, grade=${review.grade}`);
          
          cacheInserts.push({
            ingredientHash,
            conditionHash,
            petType: pet.pet_type,
            productType: product.product_type || 'dry_food',
            review
          });
        } catch (err) {
          console.error(`[ANALYZE-T3] AI review failed for ${condition}:`, err.message);
        }
      }
    }
    
    // Batch insert new cache entries to product_review_cache
    for (const insert of cacheInserts) {
      try {
        await query(
          `INSERT INTO product_review_cache 
           (id, ingredient_hash, conditions_hash, pet_type, product_type, final_score, grade, recommendation,
            key_issues, positives, ai_summary, protein_quality, has_artificial_additives, primary_ingredient_type)
           VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE hit_count = hit_count + 1`,
          [
            insert.ingredientHash,
            insert.conditionHash,
            insert.petType,
            insert.productType,
            insert.review.finalScore,
            insert.review.grade,
            insert.review.recommendation || 'consider',
            JSON.stringify(insert.review.keyIssues || []),
            JSON.stringify(insert.review.positives || []),
            insert.review.aiSummary || '',
            insert.review.proteinQuality || 'unknown',
            insert.review.hasArtificialAdditives ? 1 : 0,
            insert.review.primaryIngredientType || 'unknown'
          ]
        );
        console.log(`💾 [ANALYZE] Cached review for condition: ${insert.conditionHash}`);
      } catch (cacheErr) {
        console.warn('[ANALYZE] Failed to cache review:', cacheErr.message);
      }
    }
    
    // =============================================
    // COMBINE REVIEWS: Take WORST score/grade
    // =============================================
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
      
      console.log(`📊 [ANALYZE] Combined review: score=${worstScore}, grade=${numberToGrade(worstGradeNum)} (worst of ${reviewValues.length} conditions)`);
    } else {
      console.error('[ANALYZE] No condition reviews available');
      return res.status(500).json({ error: 'Analysis failed' });
    }

    // Build analysis response - use holistic score but ingredient-level details
    const analysis = {
      finalScore: holisticReview.finalScore,
      grade: holisticReview.grade,
      recommendation: holisticReview.recommendation || 'consider',
      ingredients: ingredientAnalysis.ingredients,
      warnings: (holisticReview.keyIssues || []).map(issue => ({
        ingredient: 'General',
        level: 'medium',
        reason: issue
      })),
      positives: holisticReview.positives || [],
      summary: holisticReview.aiSummary || '',
      keyIssues: holisticReview.keyIssues || [],
      proteinQuality: holisticReview.proteinQuality,
      hasArtificialAdditives: holisticReview.hasArtificialAdditives
    };

    // Build aiInsights from holistic review (no extra AI call needed)
    const aiInsights = {
      topBenefits: holisticReview.positives || [],
      topConcerns: holisticReview.keyIssues || [],
      aiGenerated: true
    };

    // Fetch product image if missing (await so it's included in the response)
    if (!product.image_url) {
      try {
        const imageUrl = await imageService.fetchAndSaveProductImage(product.id, product.name, product.brand);
        if (imageUrl) {
          product.image_url = imageUrl;
        }
      } catch (err) {
        console.log('⚠️ [Image] Fetch failed:', err.message);
      }
    }

    res.json({
      product,
      analysis,
      aiInsights,
      pet: {
        id: pet.id,
        name: pet.name,
        petType: pet.pet_type
      }
    });
  } catch (error) {
    console.error('[ANALYZE] Error:', error);
    next(error);
  }
});

/**
 * POST /api/products/:id/alternatives
 * Get safer alternative products with personalized scores
 * Uses cache + AI fallback (same pattern as analyze endpoint)
 */
router.post('/:id/alternatives', optionalAuth, async (req, res, next) => {
  try {
    const { petType = 'dog', healthConditions = [], petName = 'your pet', limit = 5 } = req.body;
    const productId = req.params.id;

    console.log(`🔄 [ALTERNATIVES] Finding alternatives for product ${productId}, pet: ${petType}, conditions: ${healthConditions.map(c => c.condition_type || c).join(', ') || 'healthy'}`);

    // Extract allergen keywords from conditions (e.g., allergy_chicken → chicken, allergy_beef → beef)
    const allergens = healthConditions
      .map(c => (c.condition_type || c))
      .filter(c => c.startsWith('allergy_'))
      .map(c => c.replace('allergy_', ''));
    
    if (allergens.length > 0) {
      console.log(`🚫 [ALTERNATIVES] Excluding products containing: ${allergens.join(', ')}`);
    }

    // Step 1: Get candidate products (bigger pool + allergen filtering)
    const { product: sourceProduct, candidates } = await productService.getCandidateAlternatives(productId, petType, Math.max(limit * 4, 30), allergens);
    
    if (!sourceProduct || candidates.length === 0) {
      return res.json({ alternatives: [] });
    }

    console.log(`📦 [ALTERNATIVES] Found ${candidates.length} candidates`);

    // Prepare condition info
    const hasConditions = healthConditions && healthConditions.length > 0;
    const conditionsToEvaluate = hasConditions
      ? healthConditions.map(c => c.condition_type || c)
      : ['healthy'];

    const geminiService = require('../services/geminiService');
    const scoredAlternatives = [];

    // Step 2 & 3: Score each candidate using 3-tier approach:
    //   Tier 1: product_review_cache (holistic product score) → instant
    //   Tier 2: ai_assessment_cache (individual ingredients) → compute & cache → no AI call
    //   Tier 3: AI fallback (only if ingredients also missing from cache) → slow, last resort
    await Promise.all(candidates.map(async (candidate) => {
      try {
        const ingredientsList = ingredientAnalyzer.parseIngredientText(candidate.raw_ingredients_text);
        if (!ingredientsList || ingredientsList.length === 0) return;

        const ingredientHash = candidate.ingredient_hash || productService.generateIngredientHash(ingredientsList);
        if (!ingredientHash) return;

        const isTreatProduct = candidate.product_type === 'treats' || candidate.product_type === 'supplement' || ingredientsList.length <= 6;
        const productTypeForHash = isTreatProduct ? 'treats' : 'food';
        const actualCandidateType = candidate.product_type || (isTreatProduct ? 'treats' : 'food');

        // Check/score each condition
        let worstScore = 100;
        let worstGradeNum = 5; // A=5, B=4, C=3, D=2, F=1
        let worstRecommendation = 'highly_recommended';

        for (const condition of conditionsToEvaluate) {
          const conditionHash = getSingleConditionHash(condition, productTypeForHash);
          let review = null;

          // ── Tier 1: Check product_review_cache ──
          try {
            const cached = await query(
              `SELECT final_score, grade, recommendation FROM product_review_cache 
               WHERE ingredient_hash = ? AND conditions_hash = ? AND pet_type = ? LIMIT 1`,
              [ingredientHash, conditionHash, petType]
            );

            if (cached.length > 0) {
              review = {
                finalScore: cached[0].final_score,
                grade: cached[0].grade,
                recommendation: cached[0].recommendation
              };
              console.log(`⚡ [ALT-T1] Product cache hit: ${candidate.name} / ${condition} = ${review.finalScore}`);
              await query('UPDATE product_review_cache SET hit_count = hit_count + 1 WHERE ingredient_hash = ? AND conditions_hash = ? AND pet_type = ?', 
                [ingredientHash, conditionHash, petType]);
            }
          } catch (err) {
            // Cache table might not exist, continue
          }

          // ── Tier 2: Compute from ai_assessment_cache (individual ingredients) ──
          if (!review) {
            try {
              const computed = await ingredientAnalyzer.computeScoreFromCache(ingredientsList, conditionHash, petType, actualCandidateType);
              
              if (computed.allCached || computed.finalScore !== undefined) {
                review = {
                  finalScore: computed.finalScore,
                  grade: computed.grade,
                  recommendation: computed.recommendation
                };
                const tier = computed.allCached ? 'T2-full' : 'T2-partial';
                console.log(`🧮 [ALT-${tier}] Computed from ingredients: ${candidate.name} / ${condition} = ${review.finalScore} (${ingredientsList.length - (computed.missingIngredients?.length || 0)}/${ingredientsList.length} cached)`);

                // Save computed score to product_review_cache for future Tier 1 hits
                try {
                  const { v4: uuidv4 } = require('uuid');
                  await query(
                    `INSERT INTO product_review_cache 
                     (id, ingredient_hash, conditions_hash, pet_type, product_type, final_score, grade, recommendation,
                      key_issues, positives, ai_summary, protein_quality, has_artificial_additives, primary_ingredient_type)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE 
                      final_score = VALUES(final_score), grade = VALUES(grade), recommendation = VALUES(recommendation),
                      key_issues = VALUES(key_issues), positives = VALUES(positives), ai_summary = VALUES(ai_summary),
                      hit_count = hit_count + 1`,
                    [
                      uuidv4(), ingredientHash, conditionHash, petType,
                      candidate.product_type || 'dry_food',
                      computed.finalScore, computed.grade, computed.recommendation || 'consider',
                      JSON.stringify(computed.keyIssues || []),
                      JSON.stringify(computed.positives || []),
                      computed.aiSummary || '',
                      computed.proteinQuality || null,
                      computed.hasArtificialAdditives ? 1 : 0,
                      computed.primaryIngredientType || null
                    ]
                  );
                  console.log(`💾 [ALT-T2] Saved to product cache: ${candidate.name} / ${condition} = ${computed.finalScore}`);
                } catch (err) {
                  console.warn(`[ALT-T2] Cache save failed:`, err.message);
                }
              }
            } catch (err) {
              console.warn(`[ALT-T2] Compute failed for ${candidate.name}/${condition}:`, err.message);
            }
          }

          // ── Tier 3: AI fallback (last resort) ──
          if (!review) {
            console.log(`🤖 [ALT-T3] AI fallback: ${candidate.name} / ${condition}`);
            const singleConditionList = condition === 'healthy' ? [] : [condition];

            try {
              const aiReview = await geminiService.reviewProductHolistically({
                ingredients: ingredientsList,
                petType: petType,
                healthConditions: singleConditionList,
                productType: productTypeForHash,
                petName: petName
              });

              review = {
                finalScore: aiReview.finalScore,
                grade: aiReview.grade,
                recommendation: aiReview.recommendation
              };

              // Save to product_review_cache
              try {
                const { v4: uuidv4 } = require('uuid');
                await query(
                  `INSERT INTO product_review_cache 
                   (id, ingredient_hash, conditions_hash, pet_type, product_type, final_score, grade, recommendation,
                    key_issues, positives, ai_summary, protein_quality, has_artificial_additives, primary_ingredient_type)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON DUPLICATE KEY UPDATE 
                    final_score = VALUES(final_score), grade = VALUES(grade), recommendation = VALUES(recommendation),
                    key_issues = VALUES(key_issues), positives = VALUES(positives), ai_summary = VALUES(ai_summary),
                    hit_count = hit_count + 1`,
                  [
                    uuidv4(), ingredientHash, conditionHash, petType,
                    candidate.product_type || 'dry_food',
                    aiReview.finalScore, aiReview.grade, aiReview.recommendation || 'consider',
                    JSON.stringify(aiReview.keyIssues || []),
                    JSON.stringify(aiReview.positives || []),
                    aiReview.aiSummary || '',
                    aiReview.proteinQuality || null,
                    aiReview.hasArtificialAdditives ? 1 : 0,
                    aiReview.primaryIngredientType || null
                  ]
                );
                console.log(`💾 [ALT-T3] Cached: ${candidate.name} / ${condition} = ${aiReview.finalScore}`);
              } catch (err) {
                console.warn(`[ALT-T3] Cache save failed:`, err.message);
              }
            } catch (err) {
              console.error(`[ALT-T3] AI review failed for ${candidate.name}/${condition}:`, err.message);
              return; // Skip this candidate
            }
          }

          // Track worst score across conditions
          const gNum = gradeToNumber(review.grade);
          if (review.finalScore < worstScore) {
            worstScore = review.finalScore;
            worstRecommendation = review.recommendation;
          }
          if (gNum < worstGradeNum) {
            worstGradeNum = gNum;
          }
        }

        scoredAlternatives.push({
          product: candidate,
          score: worstScore,
          grade: numberToGrade(worstGradeNum)
        });
      } catch (err) {
        console.error(`[ALT] Error scoring ${candidate.name}:`, err.message);
      }
    }));

    // Sort all scored alternatives by score descending
    const sorted = scoredAlternatives.sort((a, b) => b.score - a.score);
    
    // Prefer alternatives with score >= 80
    let result = sorted.filter(a => a.score >= 80).slice(0, limit);
    
    // If none pass 80, show the best available above 60
    if (result.length === 0) {
      result = sorted.filter(a => a.score >= 60).slice(0, limit);
      if (result.length > 0) {
        console.log(`⚠️ [ALTERNATIVES] No alternatives ≥80, showing best ≥60`);
      }
    }
    
    // Last resort: show top alternatives above 50
    if (result.length === 0) {
      result = sorted.filter(a => a.score >= 50).slice(0, limit);
      if (result.length > 0) {
        console.log(`⚠️ [ALTERNATIVES] No alternatives ≥60, showing best ≥50`);
      }
    }

    // Fetch images for alternatives that don't have one (await before responding)
    const imageFetches = result
      .filter(alt => !alt.product.image_url)
      .map(async (alt) => {
        try {
          const url = await imageService.fetchAndSaveProductImage(alt.product.id, alt.product.name, alt.product.brand);
          if (url) {
            alt.product.image_url = url;
            console.log(`📸 [ALT] Image ready: ${alt.product.name}`);
          }
        } catch (err) {
          console.log(`⚠️ [ALT Image] ${alt.product.name}: ${err.message}`);
        }
      });

    // Wait for all image fetches (with 8s timeout so we don't block forever)
    if (imageFetches.length > 0) {
      console.log(`📸 [ALT] Fetching images for ${imageFetches.length} products...`);
      await Promise.race([
        Promise.all(imageFetches),
        new Promise(resolve => setTimeout(resolve, 8000))
      ]);
    }

    console.log(`✅ [ALTERNATIVES] Returning ${result.length} alternatives (scores: ${result.map(a => a.score).join(', ')})`);
    res.json({ alternatives: result });
  } catch (error) {
    console.error('[ALTERNATIVES] Error:', error);
    next(error);
  }
});

/**
 * GET /api/products/:id/reviews
 * Get product reviews with filtering
 */
router.get('/:id/reviews', optionalAuth, async (req, res, next) => {
  try {
    const { petType, petSize, petAgeGroup, hasAllergies, limit = 20, offset = 0 } = req.query;

    const { reviews, stats } = await productService.getReviews(req.params.id, {
      petType,
      petSize,
      petAgeGroup,
      hasAllergies: hasAllergies === 'true' ? true : hasAllergies === 'false' ? false : undefined,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });

    res.json({ reviews, stats });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/products/:id/reviews
 * Add a review
 */
router.post('/:id/reviews', authenticateToken, async (req, res, next) => {
  try {
    const { petId, rating, title, content } = req.body;

    if (!petId || !rating || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'petId and rating (1-5) are required' });
    }

    const review = await productService.addReview(req.params.id, req.user.id, petId, {
      rating,
      title,
      content
    });

    res.status(201).json({ review });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/products/barcode/:barcode
 * Get product by barcode
 */
router.get('/barcode/:barcode', optionalAuth, async (req, res, next) => {
  try {
    const product = await productService.findByBarcode(req.params.barcode);

    if (!product) {
      return res.status(404).json({ error: 'Product not found for this barcode' });
    }

    res.json({ product });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

