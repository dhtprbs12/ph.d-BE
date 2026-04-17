const { query } = require('../database/connection');

/**
 * INGREDIENT ANALYSIS ENGINE
 * 
 * Personalized scoring algorithm that accounts for:
 * - Pet type (dog vs cat) - fundamentally different nutritional needs
 * - Pet's specific allergies
 * - Pet's health conditions
 * - Pet's age (puppy/kitten, adult, senior)
 * - Pet's size (affects ingredient tolerance)
 * 
 * Scoring Model:
 * - Start from 100 points
 * - Subtract ingredient risks (weighted by position in list)
 * - Apply species-specific penalties
 * - Apply health condition penalties
 * - Add bonuses for beneficial ingredients
 * - Clamp to 0-100
 */

class IngredientAnalyzer {
  constructor() {
    // AI assessments are cached in ai_assessment_cache table
  }

  /**
   * Main analysis entry point
   */
  async analyzeIngredients(ingredientsList, pet) {
    const analysis = {
      finalScore: 100,
      grade: 'A',
      recommendation: 'highly_recommended',
      ingredients: [],
      warnings: [],
      positives: [],
      summary: ''
    };

    // Validate inputs
    if (!ingredientsList || ingredientsList.length === 0) {
      return {
        ...analysis,
        finalScore: 0,
        grade: 'F',
        recommendation: 'not_recommended',
        summary: 'No ingredients found to analyze.'
      };
    }

    // Get pet's health conditions - use passed data first, fallback to DB lookup
    const petConditions = pet.healthConditions && pet.healthConditions.length > 0
      ? pet.healthConditions
      : await this.getPetConditions(pet.id);
    
    // Analyze all ingredients IN PARALLEL for speed
    let totalRiskScore = 0;
    let totalNutritionalBonus = 0;
    let hasTaurine = false;
    let toxicIngredients = [];
    let allergenMatches = [];
    let healthConcerns = [];

    // Create analysis promises for all ingredients
    const analysisPromises = ingredientsList.map((ingredientName, i) => {
      const trimmedName = ingredientName.trim();
      if (!trimmedName) return Promise.resolve(null);
      
      return this.analyzeIngredient(
        trimmedName,
        i + 1, // position (1-indexed)
        pet,
        petConditions
      );
    });

    // Execute all lookups in parallel
    const ingredientResults = await Promise.all(analysisPromises);

    // Process results
    for (const ingredientAnalysis of ingredientResults) {
      if (!ingredientAnalysis) continue;

      analysis.ingredients.push(ingredientAnalysis);

      // Track taurine for cats
      if (ingredientAnalysis.hasTaurine) {
        hasTaurine = true;
      }

      // Accumulate scores
      totalRiskScore += ingredientAnalysis.adjustedRiskScore;
      totalNutritionalBonus += ingredientAnalysis.nutritionalBonus;

      // Track critical issues
      if (ingredientAnalysis.isToxic) {
        toxicIngredients.push(ingredientAnalysis);
      }
      if (ingredientAnalysis.isAllergenMatch) {
        allergenMatches.push(ingredientAnalysis);
      }
      if (ingredientAnalysis.isHealthConcern) {
        healthConcerns.push(ingredientAnalysis);
      }

      // Build warnings and positives
      if (ingredientAnalysis.riskLevel === 'danger' || ingredientAnalysis.riskLevel === 'high') {
        analysis.warnings.push({
          ingredient: ingredientAnalysis.name,
          level: ingredientAnalysis.riskLevel,
          reason: ingredientAnalysis.explanation
        });
      }
      if (ingredientAnalysis.nutritionalBonus > 5) {
        analysis.positives.push({
          ingredient: ingredientAnalysis.name,
          benefit: ingredientAnalysis.positiveBenefit
        });
      }
    }

    // Calculate final score
    let finalScore = 100 - totalRiskScore + totalNutritionalBonus;

    // CRITICAL: Taurine check for cats
    if (pet.pet_type === 'cat' && !hasTaurine) {
      finalScore -= 25;
      analysis.warnings.push({
        ingredient: 'Taurine',
        level: 'danger',
        reason: 'CRITICAL: No taurine detected. Cats require taurine to prevent serious health issues including heart disease and blindness.'
      });
    }

    // Toxic ingredient penalty (instant fail)
    if (toxicIngredients.length > 0) {
      finalScore = Math.min(finalScore, 15);
      analysis.warnings.unshift({
        ingredient: toxicIngredients.map(t => t.name).join(', '),
        level: 'danger',
        reason: `TOXIC INGREDIENTS DETECTED. This food is dangerous for your ${pet.pet_type}.`
      });
    }

    // Allergen match severe penalty
    if (allergenMatches.length > 0) {
      finalScore -= allergenMatches.length * 15;
    }

    // Clamp score
    finalScore = Math.max(0, Math.min(100, Math.round(finalScore)));

    // Determine grade and recommendation
    const { grade, recommendation } = this.getGradeAndRecommendation(finalScore, toxicIngredients.length > 0);

    // Build summary
    const summary = this.buildSummary(pet, finalScore, grade, toxicIngredients, allergenMatches, healthConcerns, hasTaurine);

    return {
      ...analysis,
      finalScore,
      grade,
      recommendation,
      summary,
      hasTaurine,
      toxicCount: toxicIngredients.length,
      allergenCount: allergenMatches.length,
      healthConcernCount: healthConcerns.length
    };
  }

  /**
   * Analyze a single ingredient
   */
  async analyzeIngredient(name, position, pet, petConditions) {
    const normalizedName = this.normalizeIngredientName(name);
    
    // Position weight: first ingredients matter more
    // Position 1-3: 100% weight, Position 4-6: 75%, Position 7-10: 50%, 11+: 25%
    let positionWeight = 1.0;
    if (position > 10) positionWeight = 0.25;
    else if (position > 6) positionWeight = 0.5;
    else if (position > 3) positionWeight = 0.75;

    let result = {
      name,
      normalizedName,
      position,
      positionWeight,
      found: false,
      riskLevel: 'safe',
      baseRiskScore: 0,
      speciesModifier: 0,
      healthModifier: 0,
      allergyModifier: 0,
      adjustedRiskScore: 0,
      nutritionalBonus: 0,
      isToxic: false,
      isAllergenMatch: false,
      isHealthConcern: false,
      hasTaurine: false,
      explanation: '',
      positiveBenefit: ''
    };

    // FIRST: Check AI assessment cache — always use "healthy" baseline
    // Condition-specific warnings are handled separately via generateConditionWarnings()
    console.log(`🔍 [AI Cache] Looking up: "${normalizedName}" for pet_type="${pet.pet_type}"`);
    try {
      const cached = await this.cacheLookup(normalizedName, null, pet.pet_type, {
        sql: `conditions_hash LIKE 'healthy_%'`,
        params: []
      });
      
      if (cached.length > 0) {
        const aiData = cached[0];
        const riskScore = aiData.risk_score || 0;
        
        let riskLevel = 'safe';
        if (riskScore > 30) riskLevel = 'danger';
        else if (riskScore > 15) riskLevel = 'high';
        else if (riskScore > 0) riskLevel = 'moderate';
        else if (riskScore > -10) riskLevel = 'low';
        
        result.found = true;
        result.baseRiskScore = riskScore;
        result.adjustedRiskScore = parseFloat((riskScore * positionWeight).toFixed(2));
        result.riskLevel = riskLevel;
        result.explanation = aiData.explanation || '';
        result.positiveBenefit = aiData.benefit || '';
        result.isToxic = riskLevel === 'danger' && riskScore > 40;
        result.isAllergenMatch = false;
        result.isHealthConcern = riskLevel === 'high' || riskLevel === 'danger';
        
        console.log(`✅ [AI Cache] HIT "${name}": risk=${riskScore}, level=${riskLevel}`);
        return result;
      }
      console.log(`🔍 [AI Cache] MISS for "${normalizedName}"`);
    } catch (err) {
      console.log(`❌ [AI Cache] Error: ${err.message}`);
    }

    // Not in AI cache - mark for AI assessment
    // The caller will call AI to get personalized assessment
    console.log(`⚠️ "${normalizedName}" not in AI cache - needs AI assessment`);
    result.baseRiskScore = 0;
    result.adjustedRiskScore = 0;
    result.riskLevel = 'safe';  // Default until AI assesses
    result.explanation = '';
    result.needsAIAssessment = true;

    // Check for known toxic ingredients (safety net)
    const toxicIngredients = ['xylitol', 'chocolate', 'grapes', 'raisins', 'onion', 'garlic', 'avocado', 'macadamia'];
    if (toxicIngredients.some(toxic => normalizedName.includes(toxic))) {
      result.isToxic = true;
      result.riskLevel = 'danger';
      result.adjustedRiskScore = 100;
      result.explanation = `⚠️ TOXIC: This ingredient is known to be toxic to pets!`;
    }

    // Check for taurine (important for cats)
    if (normalizedName === 'taurine' || normalizedName.includes('taurine')) {
      result.hasTaurine = true;
      if (pet.pet_type === 'cat') {
        result.nutritionalBonus += 10;
        result.positiveBenefit = 'Excellent taurine source - essential for cats!';
      }
    }

    // Allergy check (safety net - AI will provide better assessment)
    const allergyConditions = petConditions.filter(c => c.condition_type?.startsWith('allergy_'));
    for (const allergy of allergyConditions) {
      const allergenType = allergy.condition_type.replace('allergy_', '');
      if (this.isAllergenMatch(normalizedName, allergenType)) {
        result.allergyModifier += 50;
        result.isAllergenMatch = true;
        result.riskLevel = 'danger';
        result.adjustedRiskScore = 50;
        result.explanation = `⚠️ ALLERGEN: Your pet is allergic to ${allergenType}!`;
      }
    }

    return result;
  }

  /**
   * Compute a product score from ai_assessment_cache (no AI call needed)
   * Uses pre-cached individual ingredient scores to derive a holistic product score.
   * 
   * Scoring model aligned with AI (Tier 3) prompts:
   *  - Supplements: base 85
   *  - Treats: base 75, with bonuses for protein/#1, clean list, natural preservatives
   *  - Food:   base 100
   *  - Both:   condition-aware profile penalties (fat combo, sugar, etc.)
   * 
   * @param {string[]} ingredientsList - List of ingredient names
   * @param {string} conditionHash - e.g., "allergy_chicken_treats", "healthy_food"
   * @param {string} petType - 'dog' or 'cat'
   * @param {string} [productType] - optional: 'food', 'treats', or 'supplement'
   * @returns {Object} { allCached, missingIngredients, finalScore, grade, recommendation, keyIssues, positives, aiSummary }
   */
  async computeScoreFromCache(ingredientsList, conditionHash, petType, productType) {
    let totalRiskScore = 0;
    const missingIngredients = [];
    const keyIssues = [];
    const positives = [];
    let hasTaurine = false;
    let hasToxic = false;

    // Detect treat/supplement vs food from conditionHash (e.g., "allergy_chicken_treats" vs "healthy_food")
    const isTreat = conditionHash.endsWith('_treats');
    const isSupplement = productType === 'supplement';

    // Normalize all ingredient names upfront for profile analysis
    const normalizedNames = ingredientsList.map(n => this.normalizeIngredientName(n.trim()));

    // Extract condition name early (used for supplement exceptions and profile penalty)
    const condition = conditionHash.replace(/_treats$/, '').replace(/_food$/, '');

    const penalties = []; // collect individual penalties for diminishing returns

    // Standard vitamin/mineral supplement ingredients — always trace additives in pet food
    // Their cached risk scores can be inflated by AI context (e.g., product with many zinc forms)
    // Cap at 5 for most conditions; exceptions: copper for liver_disease, salt for heart_disease/kidney_disease
    const supplementIngredients = [
      'zinc', 'zinc sulfate', 'zinc proteinate', 'zinc oxide', 'zinc amino acid',
      'iron', 'iron sulfate', 'iron proteinate', 'ferrous sulfate',
      'copper', 'copper sulfate', 'copper proteinate', 'copper amino acid',
      'manganese', 'manganese sulfate', 'manganese proteinate',
      'selenium', 'sodium selenite', 'selenium yeast',
      'iodine', 'calcium iodate', 'potassium iodide',
      'cobalt', 'cobalt carbonate',
      'vitamins', 'minerals',
      'vitamin a', 'vitamin b', 'vitamin b12', 'vitamin c', 'vitamin d', 'vitamin d3', 'vitamin e', 'vitamin k',
      'folic acid', 'biotin', 'niacin', 'riboflavin', 'thiamine', 'pantothenic acid', 'pyridoxine',
      'calcium', 'calcium carbonate', 'potassium chloride', 'magnesium'
    ];
    // Conditions where specific minerals ARE legitimately concerning — don't cap these
    const supplementExceptions = {
      'liver_disease': ['copper', 'copper sulfate', 'copper proteinate', 'copper amino acid'],
      'heart_disease': ['salt', 'sodium selenite'],
      'kidney_disease': ['salt'],
      'thyroid_issues': ['iodine', 'calcium iodate', 'potassium iodide'],
      'urinary_issues': ['calcium', 'calcium carbonate', 'magnesium']
    };

    for (let i = 0; i < ingredientsList.length; i++) {
      const name = ingredientsList[i].trim();
      if (!name) continue;

      const normalizedName = normalizedNames[i];
      const position = i + 1;

      // Position weight — with minimum floors for high-risk ingredients
      let positionWeight = 1.0;
      if (position > 10) positionWeight = 0.25;
      else if (position > 6) positionWeight = 0.5;
      else if (position > 3) positionWeight = 0.75;

      // Look up in ai_assessment_cache for this specific condition (with fallbacks)
      try {
        const cached = await this.cacheLookup(normalizedName, conditionHash, petType);

        if (cached.length > 0) {
          let riskScore = cached[0].risk_score || 0;

          // Fix 3: Cap risk for standard vitamin/mineral supplements (unless exception applies)
          if (riskScore > 5 && supplementIngredients.some(si => normalizedName === si || normalizedName.includes(si))) {
            const exceptionList = supplementExceptions[condition] || [];
            if (!exceptionList.some(ex => normalizedName === ex || normalizedName.includes(ex))) {
              riskScore = Math.min(riskScore, 5);
            }
          }

          // Fix 1: Amplify HIGH/DANGER ingredients — position doesn't soften them
          // DANGER (risk > 30): × 1.5 multiplier (ignores position)
          // HIGH (risk > 15): × 1.25 multiplier (ignores position)
          // LOW/MODERATE: normal position weight
          let effectiveWeight;
          if (riskScore > 30) {
            effectiveWeight = 1.5;
          } else if (riskScore > 15) {
            effectiveWeight = 1.25;
          } else {
            effectiveWeight = positionWeight;
          }

          const adjusted = parseFloat((riskScore * effectiveWeight).toFixed(2));
          // Only count penalties (positive risk) — beneficial ingredients are the expected baseline
          if (riskScore > 0) {
            penalties.push(adjusted);
          }

          // Track toxic
          if (riskScore > 40) {
            hasToxic = true;
            keyIssues.push(cached[0].explanation || `${name}: dangerous`);
          } else if (riskScore > 5) {
            keyIssues.push(cached[0].explanation || `${name}: moderate concern`);
          }

          // Track positives
          if (riskScore < -5 && cached[0].benefit) {
            positives.push(cached[0].benefit);
          }

          // Taurine check
          if (normalizedName === 'taurine' || normalizedName.includes('taurine')) {
            hasTaurine = true;
          }
        } else {
          missingIngredients.push(name);
        }
      } catch (err) {
        missingIngredients.push(name);
      }
    }

    // Apply diminishing returns: sort penalties descending, each successive one contributes less
    // 1st: 100%, 2nd: 75%, 3rd: 50%, 4th+: 25%
    const diminishingMultipliers = [1.0, 0.75, 0.5];
    penalties.sort((a, b) => b - a);
    for (let i = 0; i < penalties.length; i++) {
      const multiplier = i < diminishingMultipliers.length ? diminishingMultipliers[i] : 0.25;
      totalRiskScore += parseFloat((penalties[i] * multiplier).toFixed(2));
    }

    if (missingIngredients.length > 0) {
      return { allCached: false, missingIngredients };
    }

    const cachedCount = ingredientsList.length;

    // ── Base score: supplements 85, treats 75, food 100 ──
    let baseScore = isSupplement ? 85 : (isTreat ? 75 : 100);

    // ── Treat-specific bonuses (matching AI treat prompt calibration) ──
    let treatBonus = 0;
    if (isTreat) {
      const firstIngredient = normalizedNames[0] || '';
      const proteinKeywords = [
        'chicken', 'beef', 'salmon', 'turkey', 'duck', 'lamb', 'pork', 'venison',
        'bison', 'rabbit', 'fish', 'tuna', 'whitefish', 'herring', 'trout',
        'meat', 'liver', 'heart', 'lung'
      ];
      const naturalPreservatives = ['mixed tocopherols', 'rosemary extract', 'tocopherols', 'rosemary'];
      const artificialColors = ['yellow 5', 'yellow 6', 'blue 1', 'blue 2', 'red 40', 'red 3'];
      const artificialPreservatives = ['bha', 'bht', 'ethoxyquin', 'tbhq', 'sodium nitrate', 'sodium nitrite'];

      // Protein as #1 ingredient → +12
      if (proteinKeywords.some(kw => firstIngredient.includes(kw))) {
        treatBonus += 12;
      }

      // Natural preservatives present → +3
      if (normalizedNames.some(n => naturalPreservatives.some(np => n.includes(np)))) {
        treatBonus += 3;
      }

      // Short clean list (≤5 ingredients) → +3
      if (ingredientsList.length <= 5) {
        treatBonus += 3;
      }

      // Artificial colors → -10
      if (normalizedNames.some(n => artificialColors.some(ac => n.includes(ac)))) {
        treatBonus -= 10;
        keyIssues.push('Contains artificial colors');
      }

      // Artificial preservatives → -12
      if (normalizedNames.some(n => artificialPreservatives.some(ap => n.includes(ap)))) {
        treatBonus -= 12;
        keyIssues.push('Contains artificial preservatives');
      }
    }

    // ── Condition-aware profile penalties ──
    const profilePenalty = this._computeConditionProfilePenalty(condition, normalizedNames);
    if (profilePenalty.penalty > 0) {
      keyIssues.push(...profilePenalty.reasons);
    }

    // ── Calculate final score ──
    let finalScore = baseScore + treatBonus - totalRiskScore - profilePenalty.penalty;

    // Taurine penalty for cats
    if (petType === 'cat' && !hasTaurine) {
      finalScore -= 25;
    }

    // Toxic cap
    if (hasToxic) {
      finalScore = Math.min(finalScore, 15);
    }

    // Clamp to 0-100
    finalScore = Math.max(0, Math.min(100, Math.round(finalScore)));

    // Boost treats/supplements only when score falls below 50
    if (finalScore < 50) {
      if (isTreat && !isSupplement) finalScore = Math.min(100, finalScore + 20);
      if (isSupplement) finalScore = Math.min(100, finalScore + 15);
    }

    // Grade & recommendation
    const { grade, recommendation } = this.getGradeAndRecommendation(finalScore, hasToxic);

    // Determine primary ingredient type and protein quality for treats
    let proteinQuality = null;
    let primaryIngredientType = null;
    if (isTreat) {
      const firstNorm = normalizedNames[0] || '';
      const proteinKeywords = ['chicken', 'beef', 'salmon', 'turkey', 'duck', 'lamb', 'pork', 'fish', 'meat', 'liver'];
      const carbKeywords = ['flour', 'starch', 'rice', 'wheat', 'corn', 'oat', 'potato'];
      if (proteinKeywords.some(kw => firstNorm.includes(kw))) {
        primaryIngredientType = 'protein';
        proteinQuality = 'high';
      } else if (carbKeywords.some(kw => firstNorm.includes(kw))) {
        primaryIngredientType = 'carb';
        proteinQuality = 'low';
      } else {
        primaryIngredientType = 'other';
        proteinQuality = 'none';
      }
    }

    return {
      allCached: missingIngredients.length === 0,
      missingIngredients,
      finalScore,
      grade,
      recommendation,
      keyIssues: keyIssues.slice(0, 5),
      positives: positives.slice(0, 5),
      aiSummary: `Computed from ${cachedCount}/${ingredientsList.length} cached ingredient assessments.`,
      proteinQuality,
      hasArtificialAdditives: keyIssues.some(k => /artificial|synthetic/i.test(k)),
      primaryIngredientType
    };
  }

  /**
   * Compute condition-specific profile penalty by scanning the full ingredient list
   * for problematic patterns (e.g., multiple fat sources for digestive sensitivity).
   * 
   * @param {string} condition - e.g., "digestive_sensitivity", "diabetes", "healthy"
   * @param {string[]} normalizedNames - All normalized ingredient names
   * @returns {{ penalty: number, reasons: string[] }}
   */
  _computeConditionProfilePenalty(condition, normalizedNames) {
    const allText = normalizedNames.join(' ');

    // Keyword lists for ingredient profile detection
    // Note: healthy oils (fish oil, salmon oil, flaxseed oil, canola oil) are excluded from fatSources
    const fatSources = ['animal fat', 'poultry fat', 'chicken fat', 'beef fat', 'pork fat', 'vegetable oil', 'palm oil', 'lard', 'tallow', 'butter', 'peanut butter', 'bacon', 'suet'];
    const sugarSources = ['sugar', 'molasses', 'syrup', 'dextrose', 'fructose', 'sucrose', 'honey', 'cane'];
    const dairySources = ['milk', 'cheese', 'whey', 'casein', 'lactose', 'dairy', 'cream', 'yogurt'];
    // Note: only animal-specific meals to avoid false positives from plant meals (alfalfa meal, oat meal, etc.)
    const highProteinSources = ['chicken meal', 'beef meal', 'lamb meal', 'fish meal', 'meat meal', 'turkey meal', 'salmon meal', 'pork meal', 'duck meal', 'venison meal', 'meat', 'chicken', 'beef', 'lamb', 'salmon', 'turkey', 'liver', 'heart', 'lung'];
    const phosphorusSources = ['bone meal', 'organ', 'liver', 'kidney', 'dairy', 'cheese', 'phosphoric acid', 'phosphate'];
    const sodiumSources = ['salt', 'sodium', 'soy sauce', 'brine'];
    // Note: 'copper sulfate' is a standard micronutrient in all pet foods — not clinically relevant for liver disease
    const copperSources = ['organ', 'liver', 'shellfish', 'copper proteinate', 'copper amino acid', 'copper chelate'];
    const mineralSources = ['magnesium', 'phosphorus', 'phosphate', 'calcium', 'mineral'];

    const countMatches = (keywords, excludeKeywords = []) => {
      return normalizedNames.filter(n => 
        keywords.some(kw => n.includes(kw)) && !excludeKeywords.some(ek => n.includes(ek))
      ).length;
    };

    let penalty = 0;
    const reasons = [];

    switch (condition) {
      case 'digestive_sensitivity': {
        const fatCount = countMatches(fatSources);
        const sugarCount = countMatches(sugarSources);
        const dairyCount = countMatches(dairySources);
        const problematicCount = fatCount + sugarCount + dairyCount;
        if (problematicCount >= 3) {
          penalty = 15;
          reasons.push('Multiple fat, sugar, or dairy sources may irritate sensitive digestion');
        } else if (problematicCount >= 2) {
          penalty = 10;
          reasons.push('Fat and sugar combination may affect sensitive digestion');
        }
        break;
      }
      case 'diabetes': {
        const sugarCount = countMatches(sugarSources);
        if (sugarCount >= 2) {
          penalty = 20;
          reasons.push('Multiple sugar sources are harmful for diabetic pets');
        } else if (sugarCount >= 1) {
          penalty = 15;
          reasons.push('Contains sugar sources problematic for diabetic pets');
        }
        break;
      }
      case 'pancreatitis': {
        const fatCount = countMatches(fatSources);
        if (fatCount >= 3) {
          penalty = 20;
          reasons.push('Multiple fat sources can trigger pancreatitis flares');
        } else if (fatCount >= 2) {
          penalty = 15;
          reasons.push('Fat-rich ingredient profile may worsen pancreatitis');
        }
        break;
      }
      case 'obesity': {
        const fatCount = countMatches(fatSources);
        const sugarCount = countMatches(sugarSources);
        if (fatCount + sugarCount >= 3) {
          penalty = 15;
          reasons.push('High-fat and high-sugar profile contributes to weight gain');
        } else if (fatCount >= 2) {
          penalty = 10;
          reasons.push('Multiple fat sources contribute to calorie density');
        }
        break;
      }
      case 'kidney_disease': {
        const proteinCount = countMatches(highProteinSources, ['oil']);
        const phosphorusCount = countMatches(phosphorusSources);
        if (proteinCount >= 4 || phosphorusCount >= 2) {
          penalty = 15;
          reasons.push('High protein/phosphorus content strains kidneys');
        } else if (proteinCount >= 3) {
          penalty = 10;
          reasons.push('Protein-heavy profile may be concerning for kidney disease');
        }
        break;
      }
      case 'heart_disease': {
        const sodiumCount = countMatches(sodiumSources);
        if (sodiumCount >= 2) {
          penalty = 15;
          reasons.push('Multiple sodium sources are harmful for heart disease');
        } else if (sodiumCount >= 1) {
          penalty = 10;
          reasons.push('Contains sodium source problematic for heart disease');
        }
        break;
      }
      case 'liver_disease': {
        const proteinCount = countMatches(highProteinSources, ['oil']);
        const copperCount = countMatches(copperSources);
        if (proteinCount >= 4 || copperCount >= 1) {
          penalty = 15;
          reasons.push('High protein/copper content may strain the liver');
        } else if (proteinCount >= 3) {
          penalty = 10;
          reasons.push('Protein-heavy profile may be concerning for liver disease');
        }
        break;
      }
      case 'urinary': {
        const mineralCount = countMatches(mineralSources);
        if (mineralCount >= 2) {
          penalty = 12;
          reasons.push('High mineral content may worsen urinary issues');
        }
        break;
      }
      default:
        // healthy or unknown condition — no profile penalty
        break;
    }

    return { penalty, reasons };
  }

  /**
   * Get pet's health conditions
   */
  async getPetConditions(petId) {
    return await query(
      'SELECT condition_type, severity FROM pet_health_conditions WHERE pet_id = ?',
      [petId]
    );
  }

  /**
   * Normalize ingredient name for matching.
   * MUST match the pre-caching script format: lowercase, spaces, trimmed.
   */
  normalizeIngredientName(name) {
    return name
      .toLowerCase()
      .replace(/[-()[\]{},;:]/g, ' ')   // Hyphens, parens, brackets → spaces
      .replace(/[^\w\s]/g, '')           // Remove remaining special chars
      .replace(/\s+/g, ' ')             // Collapse multiple spaces
      .replace(/^ingredients?\s*/, '')   // Strip "ingredients" prefix (OCR artifact)
      .trim();
  }

  /**
   * Depluralize an ingredient name.
   * "sweet potatoes" → "sweet potato", "blueberries" → "blueberry", "peas" → "pea"
   */
  depluralize(name) {
    const NO_STRIP = new Set(['grass', 'molasses', 'asparagus', 'citrus', 'floss', 'moss', 'hibiscus']);
    if (NO_STRIP.has(name)) return name;
    
    // Handle last word only (e.g., "sweet potatoes" → change "potatoes" only)
    const words = name.split(' ');
    let lastWord = words[words.length - 1];
    
    if (lastWord.endsWith('ies') && lastWord.length > 4) {
      lastWord = lastWord.slice(0, -3) + 'y';        // blueberries → blueberry
    } else if (lastWord.endsWith('oes') && lastWord.length > 4) {
      lastWord = lastWord.slice(0, -2);               // potatoes → potato
    } else if (lastWord.endsWith('ses') || lastWord.endsWith('xes') || lastWord.endsWith('zes')) {
      // Skip: "molasses", "boxes" — risky to strip
    } else if (lastWord.endsWith('s') && !lastWord.endsWith('ss') && lastWord.length > 3) {
      lastWord = lastWord.slice(0, -1);               // peas → pea, apples → apple
    }
    
    words[words.length - 1] = lastWord;
    return words.join(' ');
  }

  /**
   * Strip common processing/quality prefixes from ingredient name.
   * "deboned beef" → "beef", "organic alfalfa" → "alfalfa"
   */
  stripPrefix(name) {
    const PREFIXES = [
      'deboned', 'ground', 'boneless', 'frozen', 'smoked', 'fermented',
      'roasted', 'cooked', 'minced', 'chopped', 'mechanically separated',
      'dehydrated', 'hydrolyzed', 'dried', 'fresh', 'raw', 'organic',
      'natural', 'whole', 'concentrated', 'powdered', 'freeze dried'
    ];
    for (const prefix of PREFIXES) {
      if (name.startsWith(prefix + ' ')) {
        return name.slice(prefix.length + 1);
      }
    }
    return name;
  }

  /**
   * Look up an ingredient in ai_assessment_cache with fallback strategies:
   *  1. Exact match
   *  2. Depluralized ("sweet potatoes" → "sweet potato")
   *  3. Prefix-stripped ("deboned beef" → "beef")
   *  4. Depluralized + prefix-stripped
   *  5. SQL LIKE fuzzy match (last resort)
   *
   * @returns {Array} cached rows (empty if no match found)
   */
  async cacheLookup(normalizedName, conditionHash, petType, conditionClause = null) {
    // Build the WHERE clause parts that stay constant
    const baseWhere = conditionClause 
      ? conditionClause.sql    // e.g., "conditions_hash LIKE 'healthy_%'"
      : `conditions_hash = ?`;
    const baseParams = conditionClause 
      ? conditionClause.params  // e.g., []  (already baked in)
      : [conditionHash];

    const tryExact = async (name) => {
      return await query(
        `SELECT * FROM ai_assessment_cache 
         WHERE REPLACE(ingredient_normalized, '-', ' ') = ? AND ${baseWhere} AND pet_type = ?
         LIMIT 1`,
        [name, ...baseParams, petType]
      );
    };

    // 1. Exact match
    let cached = await tryExact(normalizedName);
    if (cached.length > 0) return cached;

    // 1b. Try hyphenated version ("dl methionine" → "dl-methionine")
    const hyphenated = normalizedName.replace(/ /g, '-');
    if (hyphenated !== normalizedName) {
      cached = await tryExact(hyphenated);
      if (cached.length > 0) {
        console.log(`🔄 [Cache] Hyphen match: "${normalizedName}" → "${hyphenated}"`);
        return cached;
      }
    }

    // 2. Depluralized
    const singular = this.depluralize(normalizedName);
    if (singular !== normalizedName) {
      cached = await tryExact(singular);
      if (cached.length > 0) {
        console.log(`🔄 [Cache] Deplural match: "${normalizedName}" → "${singular}"`);
        return cached;
      }
    }

    // 3. Prefix-stripped
    const stripped = this.stripPrefix(normalizedName);
    if (stripped !== normalizedName) {
      cached = await tryExact(stripped);
      if (cached.length > 0) {
        console.log(`🔄 [Cache] Prefix-strip match: "${normalizedName}" → "${stripped}"`);
        return cached;
      }
      
      // 4. Depluralized + prefix-stripped
      const strippedSingular = this.depluralize(stripped);
      if (strippedSingular !== stripped) {
        cached = await tryExact(strippedSingular);
        if (cached.length > 0) {
          console.log(`🔄 [Cache] Strip+deplural match: "${normalizedName}" → "${strippedSingular}"`);
          return cached;
        }
      }
    }

    // 5. SQL LIKE fuzzy (last resort)
    // Step 5a: Try full name LIKE match first (most precise)
    if (normalizedName.length >= 4) {
      const fuzzyFull = await query(
        `SELECT * FROM ai_assessment_cache 
         WHERE ingredient_normalized LIKE ? AND ${baseWhere} AND pet_type = ?
         ORDER BY CHAR_LENGTH(ingredient_normalized) ASC
         LIMIT 1`,
        [`%${normalizedName}%`, ...baseParams, petType]
      );
      const matchLenFull = fuzzyFull[0]?.ingredient_normalized?.length || 0;
      if (fuzzyFull.length > 0 && matchLenFull <= normalizedName.length * 2.5) {
        console.log(`🔄 [Cache] Fuzzy match: "${normalizedName}" → "${fuzzyFull[0].ingredient_normalized}"`);
        return fuzzyFull;
      }
    }

    return [];
  }

  /**
   * Check if ingredient matches an allergen type
   */
  isAllergenMatch(normalizedName, allergenType) {
    const allergenMap = {
      'chicken': ['chicken', 'poultry', 'fowl'],
      'beef': ['beef', 'cattle', 'bovine'],
      'fish': ['fish', 'salmon', 'tuna', 'sardine', 'anchovy', 'herring', 'cod', 'tilapia', 'whitefish'],
      'dairy': ['milk', 'cheese', 'whey', 'casein', 'lactose', 'dairy', 'butter'],
      'grains': ['wheat', 'corn', 'rice', 'barley', 'oat', 'grain', 'gluten'],
      'eggs': ['egg', 'albumin'],
      'soy': ['soy', 'soybean'],
      'lamb': ['lamb', 'mutton', 'sheep']
    };

    const matchTerms = allergenMap[allergenType] || [allergenType];
    return matchTerms.some(term => normalizedName.includes(term));
  }

  /**
   * Get risk level from score
   */
  getRiskLevel(score, isToxic) {
    if (isToxic) return 'danger';
    // Score is centered around 0: negative = beneficial, positive = harmful
    if (score <= 0) return 'safe';      // Beneficial or neutral
    if (score <= 15) return 'low';      // Slight concern
    if (score <= 40) return 'moderate'; // Moderate concern
    if (score <= 60) return 'high';     // High concern
    return 'danger';                    // Very high concern
  }

  /**
   * Get grade and recommendation from score
   */
  getGradeAndRecommendation(score, hasToxic) {
    if (hasToxic) {
      return { grade: 'F', recommendation: 'not_recommended' };
    }
    
    if (score >= 85) {
      return { grade: 'A', recommendation: 'highly_recommended' };
    } else if (score >= 70) {
      return { grade: 'B', recommendation: 'recommended' };
    } else if (score >= 55) {
      return { grade: 'C', recommendation: 'acceptable' };
    } else if (score >= 40) {
      return { grade: 'D', recommendation: 'caution' };
    } else {
      return { grade: 'F', recommendation: 'not_recommended' };
    }
  }

  /**
   * Build human-readable summary
   */
  buildSummary(pet, score, grade, toxicIngredients, allergenMatches, healthConcerns, hasTaurine) {
    const petName = pet.name || `your ${pet.pet_type}`;
    let summary = '';

    if (toxicIngredients.length > 0) {
      summary = `⛔ NOT SAFE: This food contains ingredients that are TOXIC to ${pet.pet_type}s. Do not feed this to ${petName}.`;
      return summary;
    }

    if (grade === 'A') {
      summary = `✅ Excellent choice for ${petName}! This food scores ${score}/100 with high-quality, safe ingredients.`;
    } else if (grade === 'B') {
      summary = `👍 Good choice for ${petName}. This food scores ${score}/100 and is generally well-suited.`;
    } else if (grade === 'C') {
      summary = `⚠️ Acceptable for ${petName}, but there are some concerns. Score: ${score}/100.`;
    } else if (grade === 'D') {
      summary = `⚠️ Use caution. This food has several issues for ${petName}. Score: ${score}/100.`;
    } else {
      summary = `❌ Avoid for ${petName}. This food has significant issues. Score: ${score}/100.`;
    }

    if (allergenMatches.length > 0) {
      summary += ` Contains ${allergenMatches.length} allergen(s) that ${petName} is sensitive to.`;
    }

    if (healthConcerns.length > 0) {
      summary += ` ${healthConcerns.length} ingredient(s) may affect ${petName}'s health conditions.`;
    }

    if (pet.pet_type === 'cat' && !hasTaurine) {
      summary += ` ⚠️ No taurine detected - essential for cats.`;
    }

    return summary;
  }

  /**
   * Parse raw ingredient text into list.
   * Handles parenthetical sub-ingredients correctly:
   *   "Soft Gel Capsule (Bovine Gelatin, Glycerin, Water)" → one ingredient, not three.
   */
  parseIngredientText(rawText) {
    if (!rawText) return [];

    // First, strip common prefixes from the beginning of the text
    let cleanedText = rawText
      .replace(/^ingredients\s*:\s*/i, '')  // Remove "Ingredients:" prefix
      .replace(/^contains\s*:\s*/i, '');    // Remove "Contains:" prefix

    // Normalize whitespace
    cleanedText = cleanedText.replace(/\n/g, ', ').replace(/\.\s/g, ', ');

    // Split on commas that are NOT inside parentheses/brackets
    // Walk char-by-char to respect nesting
    const ingredients = [];
    let current = '';
    let depth = 0;

    for (const ch of cleanedText) {
      if (ch === '(' || ch === '[') {
        depth++;
        current += ch;
      } else if (ch === ')' || ch === ']') {
        depth = Math.max(0, depth - 1);
        current += ch;
      } else if (ch === ',' && depth === 0) {
        // Top-level comma → split here
        const trimmed = current.trim()
          .replace(/\.$/, '')                          // Remove trailing period
          .replace(/^ingredients\s*:\s*/i, '');        // Remove prefix if still there
        if (trimmed.length > 0 && trimmed.length < 100) {
          ingredients.push(trimmed);
        }
        current = '';
      } else {
        current += ch;
      }
    }
    // Don't forget the last segment
    const last = current.trim()
      .replace(/\.$/, '')
      .replace(/^ingredients\s*:\s*/i, '');
    if (last.length > 0 && last.length < 100) {
      ingredients.push(last);
    }

    // Remove common non-ingredient text
    const filterWords = ['ingredients:', 'contains:', 'and', 'or', 'with', 'including'];
    return ingredients.filter(i => {
      const lower = i.toLowerCase();
      return !filterWords.includes(lower) && !/^\d+%?$/.test(i);
    });
  }

  /**
   * Generate rule-based condition warnings for a product's ingredients.
   * No AI needed — pure keyword matching against the pet's health conditions.
   */
  generateConditionWarnings(ingredientsList, healthConditions) {
    if (!healthConditions || healthConditions.length === 0) return [];
    if (!ingredientsList || ingredientsList.length === 0) return [];

    const warnings = [];
    const lowerIngredients = ingredientsList.map(i => i.toLowerCase());

    const allergyRules = {
      allergy_beef: { keywords: ['beef', 'cattle', 'bovine'], label: 'Beef' },
      allergy_chicken: { keywords: ['chicken', 'poultry'], label: 'Chicken' },
      allergy_fish: { keywords: ['fish', 'salmon', 'tuna', 'sardine', 'anchovy', 'herring', 'cod', 'tilapia', 'whitefish', 'trout', 'pollock', 'mackerel'], label: 'Fish' },
      allergy_dairy: { keywords: ['milk', 'cheese', 'whey', 'dairy', 'casein', 'lactose', 'yogurt', 'butter'], label: 'Dairy' },
      allergy_grains: { keywords: ['wheat', 'corn', 'rice', 'barley', 'oat', 'grain', 'sorghum', 'millet', 'rye'], label: 'Grains' },
      allergy_eggs: { keywords: ['egg'], label: 'Eggs' },
      allergy_soy: { keywords: ['soy', 'soybean'], label: 'Soy' },
      allergy_lamb: { keywords: ['lamb'], label: 'Lamb' }
    };

    const diseaseRules = {
      diabetes: {
        keywords: ['sugar', 'corn syrup', 'dextrose', 'sucrose', 'molasses', 'honey', 'fructose', 'caramel'],
        label: 'diabetes',
        message: 'may affect blood sugar levels'
      },
      obesity: {
        keywords: ['animal fat', 'beef tallow', 'lard', 'vegetable oil', 'corn syrup', 'sugar', 'dextrose'],
        label: 'weight management',
        message: 'high-calorie ingredient not ideal for weight management'
      },
      kidney_disease: {
        keywords: ['salt', 'sodium', 'phosphoric acid', 'bone meal', 'sodium phosphate', 'phosphorus'],
        label: 'kidney health',
        message: 'high phosphorus/sodium can stress kidneys'
      },
      heart_disease: {
        keywords: ['salt', 'sodium', 'sodium chloride', 'sodium nitrite'],
        label: 'heart health',
        message: 'high sodium not recommended for heart conditions'
      },
      pancreatitis: {
        keywords: ['animal fat', 'beef tallow', 'lard', 'bacon', 'vegetable oil', 'canola oil'],
        label: 'pancreatitis',
        message: 'high-fat ingredient can trigger pancreatitis flare-ups'
      },
      liver_disease: {
        keywords: ['copper sulfate', 'copper proteinate', 'copper amino acid', 'copper chelate'],
        label: 'liver health',
        message: 'added copper may be harmful for liver conditions'
      },
      ibd: {
        keywords: ['carrageenan', 'guar gum', 'xanthan gum', 'cellulose', 'soy'],
        label: 'digestive health (IBD)',
        message: 'thickener/additive may irritate sensitive GI tract'
      },
      urinary_issues: {
        keywords: ['salt', 'sodium', 'magnesium oxide', 'phosphoric acid', 'calcium carbonate'],
        label: 'urinary health',
        message: 'mineral content may affect urinary crystal formation'
      },
      digestive_sensitivity: {
        keywords: ['corn', 'wheat', 'soy', 'carrageenan', 'guar gum', 'xanthan gum', 'artificial flavor', 'bha', 'bht', 'ethoxyquin'],
        label: 'digestive sensitivity',
        message: 'may irritate a sensitive digestive system'
      },
      skin_issues: {
        keywords: ['artificial color', 'red 40', 'yellow 5', 'yellow 6', 'blue 2', 'corn', 'wheat', 'soy', 'by-product'],
        label: 'skin health',
        message: 'may contribute to skin irritation or inflammation'
      },
      joint_issues: {
        keywords: ['corn syrup', 'sugar', 'dextrose', 'sodium', 'salt'],
        label: 'joint health',
        message: 'may promote inflammation — not ideal for joint issues'
      },
      thyroid_issues: {
        keywords: ['soy', 'soybean', 'soy flour', 'soy protein', 'iodine'],
        label: 'thyroid health',
        message: 'may interfere with thyroid function'
      }
    };

    for (const condition of healthConditions) {
      const condType = condition.condition_type || condition.conditionType || condition;

      // Allergy warnings
      const allergyRule = allergyRules[condType];
      if (allergyRule) {
        for (let i = 0; i < ingredientsList.length; i++) {
          const lower = lowerIngredients[i];
          for (const keyword of allergyRule.keywords) {
            if (lower.includes(keyword)) {
              warnings.push({
                type: 'allergy',
                severity: 'high',
                condition: condType,
                conditionLabel: allergyRule.label,
                ingredient: ingredientsList[i],
                position: i + 1,
                message: `Contains ${ingredientsList[i]} — allergen for pets with ${allergyRule.label.toLowerCase()} allergy`
              });
              break;
            }
          }
        }
      }

      // Disease warnings
      const diseaseRule = diseaseRules[condType];
      if (diseaseRule) {
        for (let i = 0; i < ingredientsList.length; i++) {
          const lower = lowerIngredients[i];
          for (const keyword of diseaseRule.keywords) {
            if (lower.includes(keyword)) {
              warnings.push({
                type: 'disease',
                severity: i < 5 ? 'high' : 'medium',
                condition: condType,
                conditionLabel: diseaseRule.label,
                ingredient: ingredientsList[i],
                position: i + 1,
                message: `${ingredientsList[i]} — ${diseaseRule.message}`
              });
              break;
            }
          }
        }
      }
    }

    return warnings;
  }
}

module.exports = new IngredientAnalyzer();

