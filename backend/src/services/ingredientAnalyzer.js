const { query } = require('../database/connection');

/**
 * Rule-based toxic / high-risk substrings (matched on normalizeIngredientName output).
 * - analyzeIngredient: any matching line flags that ingredient toxic.
 * - computeScoreFromCache: if any of the first 5 list lines matches, holistic finalScore is capped at 15.
 * Ultra-high-risk tokens (RULE_TOXIC_LEVENSHTEIN1) also match edit-distance ≤ 1 on tokens / letter runs (OCR typos).
 * Omit bare "alcohol" / "grape" to reduce false positives (fatty alcohols, grapefruit).
 */
const RULE_TOXIC_SUBSTRINGS = [
  'xylitol',
  'acetaminophen',
  'paracetamol',
  'ibuprofen',
  'pseudoephedrine',
  'chocolate',
  'cocoa',
  'cacao',
  'theobromine',
  'caffeine',
  'coffee',
  'grapes',
  'raisin',
  'currant',
  'sultana',
  'zante',
  'grape pomace',
  'onion',
  'garlic',
  'leek',
  'shallot',
  'chive',
  'scallion',
  'avocado',
  'macadamia',
  'hops',
  'nutmeg',
  'yeast dough',
  'ethylene glycol',
  'lilium',
  'lily',
];

/**
 * Ultra-high-risk tokens: allow Levenshtein distance ≤ 1 (OCR / single-letter typos).
 * Keep this list tiny — fuzzy matching is high-sensitivity.
 */
const RULE_TOXIC_LEVENSHTEIN1 = ['xylitol', 'theobromine'];

function levenshteinDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

/**
 * @param {string} normalizedLine - output of normalizeIngredientName
 */
function normalizedLineHasUltraFuzzyToxic(normalizedLine) {
  if (!normalizedLine) return false;
  for (const canonical of RULE_TOXIC_LEVENSHTEIN1) {
    const L = canonical.length;
    const words = normalizedLine.split(/[^a-z0-9]+/).filter((w) => w.length >= L - 1 && w.length <= L + 1);
    for (const word of words) {
      if (levenshteinDistance(word, canonical) <= 1) return true;
    }
    for (let wLen = Math.max(4, L - 1); wLen <= L + 1; wLen++) {
      for (let i = 0; i + wLen <= normalizedLine.length; i++) {
        const slice = normalizedLine.slice(i, i + wLen);
        if (!/^[a-z0-9]+$/i.test(slice)) continue;
        if (levenshteinDistance(slice.toLowerCase(), canonical) <= 1) return true;
      }
    }
  }
  return false;
}

function normalizedLineHasRuleToxic(normalizedLine) {
  if (!normalizedLine) return false;
  if (RULE_TOXIC_SUBSTRINGS.some((tok) => normalizedLine.includes(tok))) return true;
  return normalizedLineHasUltraFuzzyToxic(normalizedLine);
}

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

    ingredientsList = this.postProcessExtractedIngredientList(
      ingredientsList.map(s => String(s || '').trim()).filter(Boolean)
    );
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

    const listLen = Math.max(1, ingredientsList.length);

    // Create analysis promises for all ingredients
    const analysisPromises = ingredientsList.map((ingredientName, i) => {
      const trimmedName = ingredientName.trim();
      if (!trimmedName) return Promise.resolve(null);
      
      return this.analyzeIngredient(
        trimmedName,
        i + 1, // position (1-indexed)
        pet,
        petConditions,
        listLen
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

    // Toxic in first five positions → cap aggregate score (trace amounts lower on the list do not trigger this)
    const toxicTopFive = analysis.ingredients.filter((ing) => ing.isToxic && ing.position <= 5);
    if (toxicTopFive.length > 0) {
      finalScore = Math.min(finalScore, 15);
      analysis.warnings.unshift({
        ingredient: toxicTopFive.map((t) => t.name).join(', '),
        level: 'danger',
        reason: `TOXIC INGREDIENT(S) in the first five listed items. Capped score for your ${pet.pet_type}.`
      });
    }

    // Allergen match severe penalty
    if (allergenMatches.length > 0) {
      finalScore -= allergenMatches.length * 15;
    }

    // Clamp score
    finalScore = Math.max(0, Math.min(100, Math.round(finalScore)));

    // Determine grade and recommendation
    const { grade, recommendation } = this.getGradeAndRecommendation(finalScore, toxicTopFive.length > 0);

    // Build summary (NOT SAFE only when toxic rule hit in top five — same as score cap)
    const summary = this.buildSummary(pet, finalScore, grade, toxicTopFive, allergenMatches, healthConcerns, hasTaurine);

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
   * @param {number} [ingredientListLength] - N for (N-i+1)/N position weight; omit for legacy tier weights
   */
  async analyzeIngredient(name, position, pet, petConditions, ingredientListLength = null) {
    const normalizedName = this.normalizeIngredientName(name);
    
    let positionWeight =
      ingredientListLength != null
        ? this.getPositionWeightFromListOrder(position, ingredientListLength)
        : (() => {
            let w = 1.0;
            if (position > 10) w = 0.25;
            else if (position > 6) w = 0.5;
            else if (position > 3) w = 0.75;
            return w;
          })();

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

    // Check for known toxic ingredients (safety net): substring list + fuzzy for ultra-high-risk tokens
    if (normalizedLineHasRuleToxic(normalizedName)) {
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
   * Position weight from 1-based index among N listed ingredients (mass-order proxy).
   * w_i = (N - i + 1) / N — first row weight 1, last row 1/N.
   * @param {number} position - 1-based ingredient order
   * @param {number} listLength - N (ingredient array length)
   */
  getPositionWeightFromListOrder(position, listLength) {
    const N = Math.max(1, Number(listLength) || 1);
    const i = Math.min(Math.max(Number(position) || 1, 1), N);
    return (N - i + 1) / N;
  }

  /**
   * Compute a product score from ai_assessment_cache (no AI call needed)
   * Uses pre-cached individual ingredient scores to derive a holistic product score.
   *
   * Position weights: w_i = (N - i + 1) / N for i = 1..N (N = ingredientsList.length).
   *
   * Scoring model:
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

    const listLen = Math.max(1, ingredientsList.length);

    for (let i = 0; i < ingredientsList.length; i++) {
      const name = ingredientsList[i].trim();
      if (!name) continue;

      const normalizedName = normalizedNames[i];
      const position = i + 1;

      const positionWeight = this.getPositionWeightFromListOrder(position, listLen);

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

          // Position-weighted penalty only — high cached risk does not bypass placement
          const effectiveWeight = positionWeight;

          const adjusted = parseFloat((riskScore * effectiveWeight).toFixed(2));
          // Only count penalties (positive risk) — beneficial ingredients are the expected baseline
          if (riskScore > 0) {
            penalties.push(adjusted);
          }

          if (riskScore > 40) {
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

    // Clamp to 0-100
    finalScore = Math.max(0, Math.min(100, Math.round(finalScore)));

    // Boost treats/supplements only when score falls below 50
    if (finalScore < 50) {
      if (isTreat && !isSupplement) finalScore = Math.min(100, finalScore + 20);
      if (isSupplement) finalScore = Math.min(100, finalScore + 15);
    }

    // First 5 ingredients (label order): rule-based toxic term → cap holistic score at 15
    const topCheck = Math.min(5, normalizedNames.length);
    for (let ti = 0; ti < topCheck; ti++) {
      const nn = normalizedNames[ti] || '';
      if (nn && normalizedLineHasRuleToxic(nn)) {
        finalScore = Math.min(finalScore, 15);
        const lineName = String(ingredientsList[ti] || '').trim().slice(0, 80) || `row ${ti + 1}`;
        keyIssues.unshift(
          `Toxic / high-risk term in the first five ingredients (${lineName}); overall score capped at 15.`
        );
        break;
      }
    }

    // Grade & recommendation
    const { grade, recommendation } = this.getGradeAndRecommendation(finalScore, false);

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
   * For every line in ingredientsList, ensure ai_assessment_cache has a row for
   * (ingredient_normalized, getSingleConditionHash(condition, productTypeForHash), pet_type).
   * On MISS: batch Gemini assessIngredientsForPet (full label list as prompt context,
   * JSON assessments only for misses), then INSERT … ON DUPLICATE KEY UPDATE.
   * Rows Gemini does not map get risk_score=0 neutral fallback so deterministic scoring can proceed.
   *
   * @param {string[]} ingredientsList
   * @param {string} condition - e.g. 'healthy'
   * @param {string} productTypeForHash - 'food' | 'treats' (cacheHelpers second segment)
   * @param {string} petType - 'dog' | 'cat'
   * @param {string} [petName]
   * @param {string} [productTypeForAI] - passed to Gemini (e.g. dry_food)
   * @returns {{ filledFromAi: number, neutralFallbacks: number }}
   */
  async ensureIngredientAssessmentsInCache({
    ingredientsList,
    condition,
    productTypeForHash,
    petType,
    petName,
    productTypeForAI
  }) {
    const { getSingleConditionHash } = require('../utils/cacheHelpers');
    const geminiService = require('../services/geminiService');
    const conditionHash = getSingleConditionHash(condition, productTypeForHash);
    const displayName = petName || 'your pet';

    const collectUncached = async () => {
      const out = [];
      for (let i = 0; i < ingredientsList.length; i++) {
        const name = String(ingredientsList[i] || '').trim();
        if (!name) continue;
        const normalizedName = this.normalizeIngredientName(name);
        const cached = await this.cacheLookup(normalizedName, conditionHash, petType);
        if (!cached.length) {
          out.push({ name, normalizedName, position: i + 1 });
        }
      }
      return out;
    };

    let uncached = await collectUncached();
    if (!uncached.length) {
      return { filledFromAi: 0, neutralFallbacks: 0 };
    }

    console.log(
      `🧱 [CACHE-FILL] ${uncached.length} ingredient(s) miss ${conditionHash}/${petType} — AI assess + DB upsert`
    );

    const singleConditionList = condition === 'healthy' ? [] : [{ condition_type: condition }];
    let aiAssessments = {};

    try {
      geminiService.initialize();
      if (geminiService.model) {
        aiAssessments = await geminiService.assessIngredientsForPet(
          uncached,
          petType,
          displayName,
          singleConditionList,
          productTypeForAI || 'food',
          {
            fullIngredientLines: ingredientsList.map((s) => String(s || '').trim()).filter(Boolean),
          }
        );
      } else {
        console.warn('[CACHE-FILL] Gemini model unavailable — using neutral rows only');
      }
    } catch (err) {
      console.error('[CACHE-FILL] assessIngredientsForPet failed:', err.message);
    }

    const ingCacheInserts = [];
    const matchedNorm = new Set();

    const takeAssessment = (ing) => {
      let assessment = aiAssessments[ing.name];
      if (!assessment) {
        const lowerName = ing.name.toLowerCase();
        for (const [key, value] of Object.entries(aiAssessments)) {
          if (
            key.toLowerCase() === lowerName ||
            key.toLowerCase().includes(lowerName) ||
            lowerName.includes(key.toLowerCase())
          ) {
            assessment = value;
            break;
          }
        }
      }
      return assessment;
    };

    for (const ing of uncached) {
      const assessment = takeAssessment(ing);
      if (assessment && ing.normalizedName) {
        matchedNorm.add(ing.normalizedName);
        ingCacheInserts.push([
          ing.normalizedName,
          conditionHash,
          petType,
          assessment.riskScore ?? 0,
          assessment.explanation || '',
          assessment.benefit || ''
        ]);
      }
    }

    let neutralFallbacks = 0;
    for (const ing of uncached) {
      if (!matchedNorm.has(ing.normalizedName)) {
        neutralFallbacks += 1;
        ingCacheInserts.push([
          ing.normalizedName,
          conditionHash,
          petType,
          0,
          'No matching AI row; neutral risk used so deterministic scoring can proceed',
          ''
        ]);
      }
    }

    if (ingCacheInserts.length > 0) {
      try {
        const placeholders = ingCacheInserts.map(() => '(UUID(), ?, ?, ?, ?, ?, ?)').join(', ');
        await query(
          `INSERT INTO ai_assessment_cache (id, ingredient_normalized, conditions_hash, pet_type, risk_score, explanation, benefit)
           VALUES ${placeholders}
           ON DUPLICATE KEY UPDATE risk_score = VALUES(risk_score), explanation = VALUES(explanation), benefit = VALUES(benefit), hit_count = hit_count + 1`,
          ingCacheInserts.flat()
        );
        console.log(
          `💾 [CACHE-FILL] Upserted ${ingCacheInserts.length} row(s) for ${conditionHash} (AI-matched: ${matchedNorm.size}, neutral: ${neutralFallbacks})`
        );
      } catch (err) {
        console.warn('[CACHE-FILL] ai_assessment_cache batch failed:', err.message);
      }
    }

    uncached = await collectUncached();
    if (uncached.length > 0) {
      console.warn(`[CACHE-FILL] ${uncached.length} still missing after batch — neutral upsert each`);
      for (const ing of uncached) {
        try {
          await query(
            `INSERT INTO ai_assessment_cache (id, ingredient_normalized, conditions_hash, pet_type, risk_score, explanation, benefit)
             VALUES (UUID(), ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE risk_score = VALUES(risk_score), explanation = VALUES(explanation), benefit = VALUES(benefit), hit_count = hit_count + 1`,
            [
              ing.normalizedName,
              conditionHash,
              petType,
              0,
              'Retry neutral insert after batch failure',
              ''
            ]
          );
          neutralFallbacks += 1;
        } catch (e2) {
          console.warn('[CACHE-FILL] Single insert failed for', ing.normalizedName, e2.message);
        }
      }
    }

    return { filledFromAi: matchedNorm.size, neutralFallbacks };
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
   * Ingredient narrative only: from first real "Ingredients" header (with or
   * without colon — e.g. "OUR INGREDIENTS") through GA / guarantee / disclaimer tail.
   * @param {string} rawText
   * @returns {string}
   */
  sliceIngredientNarrativeFromRaw(rawText) {
    if (!rawText) return '';

    const src = String(rawText).replace(/\r\n/g, '\n').trim();

    // Section headers — colon optional; "OUR INGREDIENTS" / "Ingredients:" / etc.
    const headerPatterns = [
      /\b(?:our|the|de)\s+ingredients?\s*[:\-]?\s*(?:\n|$)/i,
      /\bingredients?\s*[:\-]\s*/i,
      /\bingredients?\s*(?:\n|$)/i,
      /\bingredient\s+list\s*[:\-]?\s*(?:\n|$|\s)/i,
      /\bcomposition\s*[:\-]?\s*(?:\n|$|\s)/i,
      /\b(?:made\s+with|contains)\s*[:\-]\s*/i,
    ];

    let startIdx = -1;
    for (const re of headerPatterns) {
      const m = src.match(re);
      if (m && m.index != null) {
        const candidate = m.index + m[0].length;
        if (candidate > startIdx) startIdx = candidate;
      }
    }

    let cleanedText = startIdx >= 0 ? src.slice(startIdx).trim() : src;

    // Legacy: strip a leading header if the whole blob started with one
    cleanedText = cleanedText.replace(
      /^\s*(?:our\s+|the\s+)?(?:ingredients|ingredient\s+list|composition|recipe|made\s+with|contains)\s*[:\-]?\s*/i,
      ''
    );

    const tailCutPattern =
      /(?:^|[\.\s\n])(?:this\s+(?:is|product)|manufactured\s+in|made\s+in|produced\s+in|processed\s+in|packaged\s+in|guaranteed\s+analysis|(?:the\s+\w+\s+){0,2}guarantee\b|feeding\s+(?:guide|instruction|direction)|store\s+in|keep\s+(?:in|away)|best\s+(?:by|before)|use\s+(?:by|before)|net\s+(?:wt|weight)|if for any reason|contact us at|text live chat)/i;
    const gaTailPattern =
      /\b(?:crude\s+protein|crude\s+fat|crude\s+fiber|analytical\s+constituents|typical\s+analysis|nutritional\s+levels\s+established|not recognized as an essential|contains a source of live)\b/i;
    const humanTailCutPattern =
      /\b(?:nutrition\s+facts|serving\s+size|calories\s+per\s+serving|amount\s*\/\s*serving|%\s*daily\s+value|daily\s+value|shake\s+well|refrigerate\s+after|dist\.?\s*&\s*sold|distributed\s+exclusively\s+by|distributed\s+by|sku\s*#|certified\s+organic\s+by|about\s+\d+\s+servings\s+per\s+container|www\.\w)\b/i;

    let disclaimerStart = cleanedText.search(tailCutPattern);
    const gaCut = cleanedText.search(gaTailPattern);
    const humanCut = cleanedText.search(humanTailCutPattern);
    for (const cut of [gaCut, humanCut]) {
      if (cut >= 0) {
        disclaimerStart = disclaimerStart === -1 ? cut : Math.min(disclaimerStart, cut);
      }
    }
    if (disclaimerStart > 0) {
      cleanedText = cleanedText.slice(0, disclaimerStart);
    }

    return cleanedText.trim();
  }

  /** @returns {boolean} whether sliceIngredientNarrativeFromRaw found a real header anchor */
  rawTextHasIngredientSectionHeader(rawText) {
    if (!rawText) return false;
    const src = String(rawText).replace(/\r\n/g, '\n');
    return [
      /\b(?:our|the|de)\s+ingredients?\s*[:\-]?\s*(?:\n|$)/i,
      /\bingredients?\s*[:\-]/i,
      /\bingredients?\s*(?:\n|$)/i,
      /\bingredient\s+list\s*[:\-]?/i,
      /\bcomposition\s*[:\-]?/i,
    ].some(re => re.test(src));
  }

  /**
   * Split ingredient narrative on top-level commas/semicolons only, respecting
   * nested (), []. Used by parseIngredientText and by reconcileExtractedListWithRaw.
   * @param {string} cleanedText — already narrative-sliced + newline-normalized if needed
   * @param {number} [maxSegment=560] — permissive cap for long legal premix lines (reconcile uses higher)
   * @returns {string[]}
   */
  _splitTopLevelIngredientSegments(cleanedText, maxSegment = 560) {
    const cap = typeof maxSegment === 'number' && maxSegment > 0 ? maxSegment : 560;
    const ingredients = [];
    let current = '';
    let depth = 0;

    for (const ch of String(cleanedText || '')) {
      if (ch === '(' || ch === '[') {
        depth++;
        current += ch;
      } else if (ch === ')' || ch === ']') {
        depth = Math.max(0, depth - 1);
        current += ch;
      } else if ((ch === ',' || ch === ';') && depth === 0) {
        const trimmed = current
          .trim()
          .replace(/\.$/, '')
          .replace(/^ingredients\s*:\s*/i, '');
        if (trimmed.length > 0 && trimmed.length <= cap) {
          ingredients.push(trimmed);
        }
        current = '';
      } else {
        current += ch;
      }
    }
    const last = current
      .trim()
      .replace(/\.$/, '')
      .replace(/^ingredients\s*:\s*/i, '');
    if (last.length > 0 && last.length <= cap) {
      ingredients.push(last);
    }
    return ingredients;
  }

  /** Text with parenthetical qualifiers removed — for disclaimer checks on split lines. */
  _textOutsideParentheses(line) {
    return String(line || '')
      .replace(/\([^)]*\)/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * True when the non-parenthetical part of a split line looks like GA/marketing,
   * not a real ingredient (e.g. "Manufactured in…"). Ignores text inside "(…)".
   */
  _isDisclaimerSplitLine(line) {
    const outer = this._textOutsideParentheses(line);
    if (!outer) return false;
    const disclaimerPattern =
      /\b(?:this\s+(?:is|product)|manufactured|processed\s+in|packaged|may\s+contain|naturally\s+preserved|facility|guaranteed\s+analysis|feeding\s+(?:guide|instruction|direction)|store\s+in|keep\s+(?:in|away)|best\s+(?:by|before)|use\s+(?:by|before)|nutrition\s+facts|serving\s+size|daily\s+value|calories\s+per|amount\s*\/\s*serving|shake\s+well|refrigerate|distributed\s+by|dist\.?\s*&\s*sold|sku\s*#)\b/i;
    if (disclaimerPattern.test(outer)) return true;
    // Standalone marketing sentence — not "Mixed Tocopherols (added to preserve freshness)"
    if (/^[^()]*\bpreserve(?:d|s)?\s+freshness\b/i.test(outer)) return true;
    return false;
  }

  /** Minimal gate after comma-split: keep OCR lines; drop empty/header/disclaimer only. */
  _keepSplitIngredientLine(line) {
    const s = String(line || '').trim();
    if (!s) return false;
    const lower = s.toLowerCase();
    if (/^(?:ingredients?|ingredient\s+list|contains)\s*:?\s*$/.test(lower)) return false;
    if (/^\d+%?$/.test(s)) return false;
    if (/^\bnutrition\s+facts\b/i.test(lower)) return false;
    if (this._isDisclaimerSplitLine(s)) return false;
    return true;
  }

  /**
   * Parse raw ingredient text into list.
   * Handles parenthetical sub-ingredients correctly:
   *   "Soft Gel Capsule (Bovine Gelatin, Glycerin, Water)" → one ingredient, not three.
   */
  parseIngredientText(rawText) {
    if (!rawText) return [];

    let cleanedText = this.sliceIngredientNarrativeFromRaw(rawText);
    if (!cleanedText) return [];

    // Newlines inside "(…)" are usually wrapped sub-ingredients → treat as comma.
    // Newlines outside parens are usually one ingredient wrapped across lines → space.
    cleanedText = this._normalizeIngredientNewlines(cleanedText).replace(/\.\s/g, ', ');

    const ingredients = this._splitTopLevelIngredientSegments(cleanedText, 2400);
    const filtered = ingredients.filter(i => this._keepSplitIngredientLine(i));
    return this.postProcessExtractedIngredientList(filtered);
  }

  /**
   * First balanced (... span in a string (top-level).
   * @returns {{ inner: string, closeIdx: number } | null}
   */
  _firstBalancedParenSpan(line) {
    const open = line.indexOf('(');
    if (open === -1) return null;
    let depth = 0;
    for (let i = open; i < line.length; i++) {
      const c = line[i];
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) return { inner: line.slice(open + 1, i), closeIdx: i };
      }
    }
    return null;
  }

  /** OCR / GA-merge garbage inside premix parentheses (not exact token fixes). */
  _premixInnerNoiseScore(inner) {
    if (!inner) return 0;
    const lo = inner.toLowerCase();
    let n = 0;
    if (/\bcrude\s+fiber\b/i.test(lo)) n += 12;
    if (/fiberima/i.test(lo)) n += 10;
    if (/calorie\s*conte/i.test(lo)) n += 10;
    if (/\bguaranteed\s+analysis\b/i.test(lo)) n += 14;
    if (/\bcrude\s+protein\b/i.test(lo)) n += 8;
    if (/\bprotein\s*%\b/i.test(lo)) n += 6;
    return n;
  }

  /**
   * Split raw label text into top-level ingredient segments (paren-aware commas).
   * Shared by reconcileExtractedListWithRaw and fillMissingIngredientsFromRaw.
   * @returns {string[]}
   */
  _deriveRawIngredientSegments(rawIngredientsText, maxSegment = 2400) {
    const raw = String(rawIngredientsText || '').trim();
    if (raw.length < 50) return [];

    const narr = this.sliceIngredientNarrativeFromRaw(raw);
    if (narr.length < 40) return [];

    let body = this._normalizeIngredientNewlines(narr).replace(/\.\s/g, ', ');
    let R = this._splitTopLevelIngredientSegments(body, maxSegment);

    R = R.filter(seg => this._keepSplitIngredientLine(seg));
    if (!R.length) return [];

    if (R.some(s => /\bcrude\s+(?:protein|fat|fiber)\b/i.test(s) && /\bmoisture\b/i.test(s))) {
      return [];
    }
    return R;
  }

  _normMatchLine(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** True when a vision list row and a raw segment refer to the same printed ingredient. */
  _listItemMatchesRawSegment(listItem, rawSeg) {
    const nl = this._normMatchLine(listItem);
    const nr = this._normMatchLine(rawSeg);
    if (!nl || !nr) return false;
    if (nl === nr) return true;
    const minSub = 4;
    if (nl.length >= minSub && nr.includes(nl)) return true;
    if (nr.length >= minSub && nl.includes(nr)) return true;
    return false;
  }

  _rawSegmentIsPlausibleIngredient(seg) {
    const t = String(seg || '').trim();
    if (!t || t.length > 2400) return false;
    return this._keepSplitIngredientLine(t);
  }

  /**
   * Insert raw-only segments into the vision JSON list in label order.
   * Fixes cases where rawIngredientsText is complete but ingredientsList drops a line
   * (e.g. "canola oil (preserved with mixed tocopherols)").
   */
  fillMissingIngredientsFromRaw(ingredientsList, rawIngredientsText) {
    if (!Array.isArray(ingredientsList) || ingredientsList.length === 0) return ingredientsList;

    const R = this._deriveRawIngredientSegments(rawIngredientsText);
    if (R.length === 0) return ingredientsList;

    const L = ingredientsList.map(s => String(s || '').trim()).filter(Boolean);
    const usedL = new Set();
    const out = [];

    for (const rSeg of R) {
      let matched = -1;
      for (let j = 0; j < L.length; j++) {
        if (usedL.has(j)) continue;
        if (this._listItemMatchesRawSegment(L[j], rSeg)) {
          matched = j;
          break;
        }
      }
      if (matched >= 0) {
        out.push(L[matched]);
        usedL.add(matched);
      } else if (this._rawSegmentIsPlausibleIngredient(rSeg)) {
        out.push(String(rSeg).trim());
      }
    }

    for (let j = 0; j < L.length; j++) {
      if (!usedL.has(j)) out.push(L[j]);
    }

    const added = out.length - L.length;
    if (added > 0) {
      console.log(
        `🔧 [Ingredients] Filled ${added} missing from raw (${L.length} → ${out.length})`
      );
    }

    return out.length > 0 ? out : ingredientsList;
  }

  /**
   * When structured `ingredientsList` from vision JSON disagrees with the same
   * declaration split mechanically from `rawIngredientsText` (depth-aware commas),
   * prefer the raw-derived list if evidence suggests the model dropped/merged/split
   * wrong (not keyword-specific — works for vitamins, minerals, probiotics,
   * enzymes, "natural flavors (…)", long cheese headers, etc.).
   *
   * Caller should still run postProcessExtractedIngredientList afterward.
   * @param {string[]} ingredientsList
   * @param {string} rawIngredientsText
   * @returns {string[]}
   */
  reconcileExtractedListWithRaw(ingredientsList, rawIngredientsText) {
    if (!Array.isArray(ingredientsList) || ingredientsList.length === 0) return ingredientsList;

    let R = this._deriveRawIngredientSegments(rawIngredientsText);
    if (!R.length) return ingredientsList;

    const L = ingredientsList.map(s => String(s || '').trim()).filter(Boolean);
    const norm = s => this._normMatchLine(s);
    const joinL = norm(L.join(', '));
    const joinR = norm(R.join(', '));

    const coverageLR = (() => {
      const nR = R.map(norm);
      const nL = L.map(norm);
      let hitL = 0;
      for (const nl of nL) {
        if (nR.some(nr => nr.includes(nl) || nl.includes(nr))) hitL++;
      }
      let hitR = 0;
      for (const nr of nR) {
        if (
          nL.some(
            nl =>
              nr.includes(nl) &&
              nl.length >= Math.min(12, Math.floor(0.27 * Math.max(nr.length, 1)))
          )
        ) {
          hitR++;
        }
      }
      return (
        hitL / Math.max(nL.length, 1) +
        hitR / Math.max(nR.length, 1)
      ) / 2;
    })();

    const lenRatio = joinR.length / Math.max(joinL.length, 1);
    const countDelta = R.length - L.length;

    // Strong agreement AND similar total characters → trust vision JSON list
    const similarSize = lenRatio <= 1.12 && lenRatio >= 0.86;
    if (
      joinR.length + 35 >= joinL.length &&
      coverageLR >= 0.88 &&
      similarSize &&
      Math.abs(countDelta) <= 2
    ) {
      return ingredientsList;
    }

    if (joinR.length + 30 < joinL.length) {
      return ingredientsList;
    }

    let useRaw = false;
    if (lenRatio > 1.055) {
      useRaw = true;
    } else if (countDelta >= 3 && lenRatio > 0.92) {
      useRaw = true;
    } else if (coverageLR < 0.52 && lenRatio > 1.0) {
      useRaw = true;
    } else if (countDelta >= 2 && lenRatio > 1.03) {
      useRaw = true;
    } else if (L.length >= R.length + 5 && lenRatio > 0.95) {
      useRaw = true;
    } else if (countDelta <= -3 && lenRatio > 1.06) {
      useRaw = true;
    }

    if (!useRaw) return ingredientsList;
    return R;
  }

  /**
   * Fix common OCR / layout errors on extracted lines, then drop duplicate
   * Minerals(/Vitamins( rows when one copy is clearly corrupted.
   */
  postProcessExtractedIngredientList(list) {
    if (!Array.isArray(list) || list.length === 0) return list;
    const step1 = list.map(s => this._fixOCRPremixLine(String(s || '').trim())).filter(Boolean);
    const step2 = this._dedupeNoisyPremixDuplicates(step1);
    return this._dedupeListCaseInsensitivePreserveOrder(step2);
  }

  /**
   * Drop exact duplicate lines (case-insensitive, normalized spaces). Keeps first occurrence / order.
   */
  _dedupeListCaseInsensitivePreserveOrder(list) {
    if (!Array.isArray(list) || list.length === 0) return list;
    const seen = new Set();
    const out = [];
    for (const item of list) {
      const s = String(item || '').trim();
      if (!s) continue;
      const k = s.toLowerCase().replace(/\s+/g, ' ').trim();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(s);
    }
    return out;
  }

  /**
   * Merge output sometimes repeats the same two-word phrase with a short OCR
   * garbage token between (e.g. "salt microbial eus salt microbial enzyme").
   * Class-level: any two alphabetic words, not ingredient names.
   */
  _collapseSandwichedDuplicatePair(s) {
    let t = String(s || '');
    const wc = t.split(/\s+/).filter(Boolean).length;
    if (t.length > 130 || wc > 22) return t;
    for (let k = 0; k < 3; k++) {
      const next = t.replace(
        /(\b[A-Za-z]{2,}\s+[A-Za-z]{2,})\s+[^\s,()]{1,8}\s+\1\b/gi,
        '$1',
      );
      if (next === t) break;
      t = next;
    }
    return t;
  }

  /**
   * Newline handling for a single ingredient paragraph before comma-splitting.
   * Outside parentheses: join wrapped lines with a space (avoid "Parmesan, Cheese").
   * Inside parentheses: join with ", " (FDA-style sub-enumerators often wrap per line).
   */
  _normalizeIngredientNewlines(text) {
    const src = String(text || '');
    if (!src) return '';
    let out = '';
    let depth = 0;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (c === '(' || c === '[') {
        depth++;
        out += c;
      } else if (c === ')' || c === ']') {
        depth = Math.max(0, depth - 1);
        out += c;
      } else if (c === '\r' || c === '\n') {
        if (c === '\r' && src[i + 1] === '\n') i++;
        out += depth > 0 ? ', ' : ' ';
      } else {
        out += c;
      }
    }
    return out
      .replace(/\s+,/g, ',')
      .replace(/,\s*,+/g, ', ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  _fixOCRPremixLine(line) {
    let s = this._collapseSandwichedDuplicatePair(String(line || '').trim());
    if (!s) return s;

    // Dropped leading "M" on Minerals (Vision / seam splice)
    s = s.replace(/^\s*rinerals\b/i, 'Minerals');
    s = s.replace(/^\s*inerals\b/i, 'Minerals');
    s = s.replace(/^\s*winerals\b/i, 'Minerals');

    // GA "Moisture" line fused with a vitamin/mineral premix enumerator
    if (/^\s*moisture\s*\(/i.test(s)) {
      const span = this._firstBalancedParenSpan(s);
      if (span) {
        const hi = span.inner;
        const vitLike =
          /\b(vitamin|thiam|riboflav|niacin|pyridox|pantothen|folic|folate|biotin|cyanocobal|choline|supplement|tocopherol|calciferol|ascorb|menadione)\b/i.test(
            hi
          );
        const minLike =
          /\b(proteinate|proteinates|zinc|copper|manganese|iron|selenium|iodide|iodate|chloride|oxide|sulfate|carbonate|phosphate|chelat)\b/i.test(
            hi
          ) && !vitLike;
        const suffix = s.slice(span.closeIdx + 1);
        if (vitLike) {
          return `Vitamins (${span.inner})${suffix}`;
        }
        if (minLike) {
          return `Minerals (${span.inner})${suffix}`;
        }
      }
    }

    return s;
  }

  /**
   * When two "Minerals (" or two "Vitamins (" rows exist and one has heavy
   * GA/OCR noise, keep the cleaner row.
   */
  _dedupeNoisyPremixDuplicates(items) {
    const headerRe = /^\s*(vitamins?|minerals?)\s*\(/i;

    const kindOf = line => {
      const m = line.match(headerRe);
      if (!m) return null;
      return /^v/i.test(m[1]) ? 'vitamins' : 'minerals';
    };

    const byKind = { vitamins: [], minerals: [] };
    items.forEach((line, idx) => {
      const k = kindOf(line);
      if (k) byKind[k].push(idx);
    });

    const removeIdx = new Set();

    for (const kind of ['minerals', 'vitamins']) {
      const idxs = byKind[kind];
      if (idxs.length < 2) continue;

      const scored = idxs.map(idx => {
        const span = this._firstBalancedParenSpan(items[idx]);
        const inner = span ? span.inner : '';
        return { idx, noise: this._premixInnerNoiseScore(inner), innerLen: inner.length };
      });
      scored.sort((a, b) => a.noise - b.noise || b.innerLen - a.innerLen);

      const best = scored[0];
      for (let i = 1; i < scored.length; i++) {
        const o = scored[i];
        if (best.noise >= 8) break;
        if (o.noise >= 8 && best.noise <= 3) removeIdx.add(o.idx);
        else if (o.noise > best.noise + 4) removeIdx.add(o.idx);
      }
    }

    return items.filter((_, i) => !removeIdx.has(i));
  }

  /**
   * Generate rule-based condition warnings for a product's ingredients.
   * No AI needed — word-boundary keyword matching with exclusion lists,
   * per-keyword severity/messages, and position-aware context.
   */
  generateConditionWarnings(ingredientsList, healthConditions) {
    if (!healthConditions || healthConditions.length === 0) return [];
    if (!ingredientsList || ingredientsList.length === 0) return [];

    const warnings = [];
    const lowerIngredients = ingredientsList.map(i => i.toLowerCase());

    function matchesKeyword(ingredientLower, keyword, excludes) {
      if (excludes && excludes.some(ex => ingredientLower.includes(ex))) return false;
      const regex = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      return regex.test(ingredientLower);
    }

    function positionSuffix(pos) {
      if (pos <= 3) return ' (main ingredient — significant amount)';
      if (pos >= 8) return ' (minor ingredient — small amount)';
      return '';
    }

    const allergyRules = {
      allergy_beef: {
        keywords: ['beef', 'cattle', 'bovine'],
        excludes: [],
        label: 'Beef'
      },
      allergy_chicken: {
        keywords: ['chicken', 'poultry'],
        excludes: ['chickpea', 'chickpeas'],
        label: 'Chicken'
      },
      allergy_fish: {
        keywords: ['fish', 'salmon', 'tuna', 'sardine', 'anchovy', 'herring', 'cod', 'tilapia', 'whitefish', 'trout', 'pollock', 'mackerel', 'menhaden'],
        excludes: ['starfish'],
        label: 'Fish'
      },
      allergy_dairy: {
        keywords: ['milk', 'cheese', 'whey', 'dairy', 'casein', 'lactose', 'yogurt', 'butter', 'cream'],
        excludes: ['coconut milk', 'coconut cream', 'buttercup'],
        label: 'Dairy'
      },
      allergy_grains: {
        keywords: ['wheat', 'corn', 'rice', 'barley', 'oat', 'grain', 'sorghum', 'millet', 'rye', 'spelt', 'maize'],
        excludes: ['grain-free', 'licorice'],
        label: 'Grains'
      },
      allergy_eggs: {
        keywords: ['egg'],
        excludes: ['eggplant'],
        label: 'Eggs'
      },
      allergy_soy: {
        keywords: ['soy', 'soybean'],
        excludes: [],
        label: 'Soy'
      },
      allergy_lamb: {
        keywords: ['lamb'],
        excludes: [],
        label: 'Lamb'
      }
    };

    const diseaseRules = {
      diabetes: {
        label: 'Diabetes',
        entries: [
          { keywords: ['corn syrup', 'high fructose corn syrup'], severity: 'high', message: '{ingredient} is a high-glycemic sweetener that can spike blood sugar' },
          { keywords: ['sugar', 'sucrose', 'dextrose', 'fructose', 'glucose'], severity: 'high', message: '{ingredient} is a simple sugar that can elevate blood glucose levels' },
          { keywords: ['molasses', 'honey', 'caramel'], severity: 'medium', message: '{ingredient} contains natural sugars — monitor intake for diabetic pets' },
          { keywords: ['white rice', 'brewers rice', 'rice flour'], severity: 'medium', message: '{ingredient} is high-glycemic and may cause blood sugar fluctuations' },
        ]
      },
      obesity: {
        label: 'Weight Management',
        entries: [
          { keywords: ['animal fat', 'beef tallow', 'lard', 'poultry fat'], severity: 'high', message: '{ingredient} is a concentrated fat source — adds significant calories' },
          { keywords: ['corn syrup', 'sugar', 'sucrose', 'dextrose'], severity: 'high', message: '{ingredient} adds empty calories with no nutritional benefit' },
          { keywords: ['vegetable oil', 'canola oil', 'soybean oil'], severity: 'medium', message: '{ingredient} is calorie-dense — portion control important for overweight pets' },
          { keywords: ['tapioca', 'potato starch'], severity: 'medium', message: '{ingredient} is a high-carb filler that can contribute to weight gain' },
        ]
      },
      kidney_disease: {
        label: 'Kidney Health',
        entries: [
          { keywords: ['sodium phosphate', 'phosphoric acid', 'dicalcium phosphate'], severity: 'high', message: '{ingredient} is high in phosphorus — can accelerate kidney damage' },
          { keywords: ['bone meal', 'meat and bone meal'], severity: 'high', message: '{ingredient} is very high in phosphorus — avoid for kidney disease' },
          { keywords: ['salt', 'sodium'], severity: 'high', message: '{ingredient} increases sodium load — stresses kidneys and raises blood pressure' },
          { keywords: ['phosphorus'], severity: 'medium', message: '{ingredient} adds to phosphorus intake — should be limited with kidney disease' },
        ]
      },
      heart_disease: {
        label: 'Heart Health',
        entries: [
          { keywords: ['salt', 'sodium chloride', 'sodium nitrite'], severity: 'high', message: '{ingredient} is high in sodium — can worsen fluid retention and heart strain' },
          { keywords: ['sodium'], severity: 'medium', message: '{ingredient} contributes to sodium intake — should be minimized for heart conditions' },
        ]
      },
      pancreatitis: {
        label: 'Pancreatitis',
        entries: [
          { keywords: ['animal fat', 'beef tallow', 'lard', 'bacon fat'], severity: 'high', message: '{ingredient} is very high in fat — can trigger a pancreatitis flare-up' },
          { keywords: ['vegetable oil', 'canola oil', 'soybean oil', 'coconut oil'], severity: 'medium', message: '{ingredient} adds fat content — use caution with pancreatitis history' },
          { keywords: ['butter', 'cream'], severity: 'high', message: '{ingredient} is a rich fat source — risky for pancreatitis-prone pets' },
        ]
      },
      liver_disease: {
        label: 'Liver Health',
        entries: [
          { keywords: ['copper sulfate', 'copper proteinate', 'copper amino acid', 'copper chelate', 'cupric'], severity: 'high', message: '{ingredient} contains added copper — can be toxic for pets with liver disease' },
          { keywords: ['bha', 'bht', 'ethoxyquin'], severity: 'medium', message: '{ingredient} is a chemical preservative — extra burden on a compromised liver' },
        ]
      },
      ibd: {
        label: 'IBD (Inflammatory Bowel)',
        entries: [
          { keywords: ['carrageenan'], severity: 'high', message: '{ingredient} is linked to GI inflammation — avoid with IBD' },
          { keywords: ['guar gum', 'xanthan gum', 'locust bean gum'], severity: 'medium', message: '{ingredient} is a thickener that may irritate an inflamed GI tract' },
          { keywords: ['cellulose', 'powdered cellulose'], severity: 'medium', message: '{ingredient} is an indigestible fiber filler — can aggravate IBD symptoms' },
          { keywords: ['soy', 'soybean'], severity: 'medium', message: '{ingredient} is a common irritant for pets with inflammatory bowel disease' },
        ]
      },
      urinary_issues: {
        label: 'Urinary Health',
        entries: [
          { keywords: ['magnesium oxide', 'magnesium sulfate'], severity: 'high', message: '{ingredient} is high in magnesium — can promote struvite crystal formation' },
          { keywords: ['phosphoric acid', 'dicalcium phosphate'], severity: 'high', message: '{ingredient} is high in phosphorus — can contribute to urinary stones' },
          { keywords: ['calcium carbonate'], severity: 'medium', message: '{ingredient} adds calcium — excess calcium can promote crystal formation' },
          { keywords: ['salt', 'sodium'], severity: 'medium', message: '{ingredient} affects hydration balance — monitor for urinary conditions' },
        ]
      },
      digestive_sensitivity: {
        label: 'Digestive Sensitivity',
        entries: [
          { keywords: ['carrageenan'], severity: 'high', message: '{ingredient} is a known GI irritant — avoid for sensitive stomachs' },
          { keywords: ['bha', 'bht', 'ethoxyquin'], severity: 'high', message: '{ingredient} is an artificial preservative that can upset sensitive digestion' },
          { keywords: ['corn', 'wheat', 'soy'], severity: 'medium', message: '{ingredient} is a common trigger for digestive discomfort in sensitive pets' },
          { keywords: ['guar gum', 'xanthan gum'], severity: 'medium', message: '{ingredient} is a thickening agent that some sensitive pets struggle to digest' },
          { keywords: ['artificial flavor', 'artificial colour', 'artificial color'], severity: 'medium', message: '{ingredient} is a synthetic additive — not ideal for sensitive digestion' },
        ]
      },
      skin_issues: {
        label: 'Skin Health',
        entries: [
          { keywords: ['red 40', 'yellow 5', 'yellow 6', 'blue 2', 'artificial color', 'artificial colour'], severity: 'high', message: '{ingredient} is an artificial dye linked to skin reactions and inflammation' },
          { keywords: ['by-product', 'by-products', 'meat by-product'], severity: 'medium', message: '{ingredient} is a low-quality protein source that may trigger skin issues' },
          { keywords: ['corn', 'wheat', 'soy'], severity: 'medium', message: '{ingredient} is a common allergen that can manifest as skin irritation' },
          { keywords: ['bha', 'bht'], severity: 'medium', message: '{ingredient} is a chemical preservative that may aggravate skin conditions' },
        ]
      },
      joint_issues: {
        label: 'Joint Health',
        entries: [
          { keywords: ['corn syrup', 'sugar', 'sucrose', 'dextrose'], severity: 'high', message: '{ingredient} promotes inflammation — counterproductive for joint issues' },
          { keywords: ['salt', 'sodium'], severity: 'medium', message: '{ingredient} can contribute to water retention and joint swelling' },
          { keywords: ['bha', 'bht'], severity: 'medium', message: '{ingredient} is a synthetic preservative that may promote oxidative stress in joints' },
        ]
      },
      thyroid_issues: {
        label: 'Thyroid Health',
        entries: [
          { keywords: ['soy', 'soybean', 'soy flour', 'soy protein', 'soy lecithin'], severity: 'high', message: '{ingredient} contains isoflavones that can interfere with thyroid hormone production' },
          { keywords: ['iodine', 'kelp', 'seaweed'], severity: 'medium', message: '{ingredient} affects iodine levels — requires monitoring for thyroid conditions' },
        ]
      }
    };

    for (const condition of healthConditions) {
      const condType = condition.condition_type || condition.conditionType || condition;

      // Allergy warnings — word-boundary matching with exclusion lists
      const allergyRule = allergyRules[condType];
      if (allergyRule) {
        for (let i = 0; i < ingredientsList.length; i++) {
          const lower = lowerIngredients[i];
          for (const keyword of allergyRule.keywords) {
            if (matchesKeyword(lower, keyword, allergyRule.excludes)) {
              const pos = i + 1;
              let message;
              if (pos <= 2) {
                message = `⚠️ ${ingredientsList[i]} is a primary ingredient — high exposure risk for ${allergyRule.label.toLowerCase()} allergy`;
              } else if (pos <= 5) {
                message = `Contains ${ingredientsList[i]} — potential allergen trigger for ${allergyRule.label.toLowerCase()} allergy`;
              } else {
                message = `${ingredientsList[i]} is listed further down but may still trigger ${allergyRule.label.toLowerCase()} allergy in sensitive pets`;
              }

              warnings.push({
                type: 'allergy',
                severity: pos <= 5 ? 'high' : 'medium',
                condition: condType,
                conditionLabel: allergyRule.label,
                ingredient: ingredientsList[i],
                position: pos,
                message
              });
              break;
            }
          }
        }
      }

      // Disease warnings — per-keyword severity and specific messages
      const diseaseRule = diseaseRules[condType];
      if (diseaseRule) {
        for (let i = 0; i < ingredientsList.length; i++) {
          const lower = lowerIngredients[i];
          let matched = false;

          for (const entry of diseaseRule.entries) {
            for (const keyword of entry.keywords) {
              if (matchesKeyword(lower, keyword)) {
                const pos = i + 1;
                const baseMsg = entry.message.replace('{ingredient}', ingredientsList[i]);

                warnings.push({
                  type: 'disease',
                  severity: entry.severity,
                  condition: condType,
                  conditionLabel: diseaseRule.label,
                  ingredient: ingredientsList[i],
                  position: pos,
                  message: baseMsg + positionSuffix(pos)
                });
                matched = true;
                break;
              }
            }
            if (matched) break;
          }
        }
      }
    }

    return warnings;
  }

  /**
   * Replace LLM holistic finalScore/grade/recommendation with computeScoreFromCache
   * (position-weighted AI risk scores, 0–100 clamp) when every ingredient has cache coverage.
   * Preserves keyIssues, positives, aiSummary, etc. from the holistic review.
   *
   * @param {Record<string, object>} conditionReviews - { [condition]: review }
   * @param {string[]} ingredientsList
   * @param {string} petType
   * @param {string} productTypeForHash - second arg to getSingleConditionHash (e.g. food, treats, dry_food)
   * @param {string} [productTypeForCompute] - computeScoreFromCache productType (supplement detection); defaults to productTypeForHash
   */
  async overlayDeterministicConditionReviews(conditionReviews, ingredientsList, petType, productTypeForHash, productTypeForCompute) {
    const { getSingleConditionHash } = require('../utils/cacheHelpers');
    if (!conditionReviews || !ingredientsList?.length) return conditionReviews;
    const ptCompute = productTypeForCompute != null ? productTypeForCompute : productTypeForHash;
    const out = { ...conditionReviews };
    for (const [condition, review] of Object.entries(out)) {
      if (!review) continue;
      const conditionHash = getSingleConditionHash(condition, productTypeForHash);
      try {
        const computed = await this.computeScoreFromCache(ingredientsList, conditionHash, petType, ptCompute);
        if (computed.allCached && computed.finalScore !== undefined) {
          out[condition] = {
            ...review,
            finalScore: computed.finalScore,
            grade: computed.grade,
            recommendation: computed.recommendation,
            proteinQuality: computed.proteinQuality != null ? computed.proteinQuality : review.proteinQuality,
            primaryIngredientType: computed.primaryIngredientType != null ? computed.primaryIngredientType : review.primaryIngredientType,
            hasArtificialAdditives: computed.hasArtificialAdditives
          };
        }
      } catch (_) {
        /* keep LLM scores */
      }
    }
    return out;
  }

  /**
   * Same as overlayDeterministicConditionReviews but for a single combined review object
   * (universal healthy baseline — uses condition key "healthy").
   */
  async overlayDeterministicHolisticScores(holisticReview, ingredientsList, petType, productTypeForHash, productTypeForCompute) {
    if (!holisticReview) return holisticReview;
    const wrapped = { healthy: holisticReview };
    const out = await this.overlayDeterministicConditionReviews(
      wrapped,
      ingredientsList,
      petType,
      productTypeForHash,
      productTypeForCompute
    );
    return out.healthy || holisticReview;
  }
}

module.exports = new IngredientAnalyzer();

