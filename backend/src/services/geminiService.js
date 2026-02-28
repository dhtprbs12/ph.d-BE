const { GoogleGenerativeAI } = require('@google/generative-ai');
const crypto = require('crypto');
const { query } = require('../database/connection');
const { v4: uuidv4 } = require('uuid');

/**
 * GEMINI AI SERVICE
 * 
 * Handles:
 * 1. OCR extraction from pet food label images
 * 2. Ingredient normalization and parsing
 * 3. Product information extraction
 */

class GeminiService {
  constructor() {
    this.genAI = null;
    this.model = null;
    this.initialized = false;
  }

  /**
   * Initialize Gemini AI client
   */
  initialize() {
    if (this.initialized) return;

    if (!process.env.GEMINI_API_KEY) {
      console.warn('⚠️ GEMINI_API_KEY not set. OCR features will be unavailable.');
      return;
    }

    this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    this.model = this.genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    this.initialized = true;
    console.log('✅ Gemini AI initialized');
  }

  /**
   * Extract ingredients from pet food label image
   * @param {Buffer} imageBuffer - Image data
   * @param {string} mimeType - Image MIME type
   * @returns {Object} Extracted data
   */
  async extractFromImage(imageBuffer, mimeType = 'image/jpeg') {
    this.initialize();

    if (!this.model) {
      throw new Error('Gemini AI not initialized. Check API key.');
    }

    // Generate image hash for caching
    const imageHash = crypto.createHash('sha256').update(imageBuffer).digest('hex');

    // Check cache
    const cached = await this.checkCache(imageHash);
    if (cached) {
      console.log('📦 Using cached OCR result');
      return cached;
    }

    // Convert buffer to base64 for Gemini
    const imageBase64 = imageBuffer.toString('base64');

    const prompt = `You are analyzing a pet food product image. First, determine what type of image this is, then extract information accordingly.

STEP 1: Identify the image type
- "ingredients_label": Shows the ingredients list (usually back of package)
- "front_label": Shows product name/brand/marketing (front of package)  
- "mixed": Shows both product info AND ingredients

STEP 2: Extract information based on what's visible

Return your response in this exact JSON format:
{
  "imageType": "ingredients_label" | "front_label" | "mixed",
  "productName": "string or null",
  "brand": "string or null", 
  "productType": "dry_food" | "wet_food" | "treats" | "supplement" | "other" | null,
  "texture": "dry" | "wet" | "semi_moist" | "freeze_dried" | null,
  "targetPet": "dog" | "cat" | "both" | null,
  "lifeStage": "puppy_kitten" | "adult" | "senior" | "all" | null,
  "ingredientsList": ["ingredient1", "ingredient2", ...],
  "rawIngredientsText": "original text as written on label or null if not visible",
  "guaranteedAnalysis": {
    "protein": number or null,
    "fat": number or null,
    "fiber": number or null,
    "moisture": number or null
  },
  "confidence": number between 0 and 1,
  "notes": "any relevant notes about extraction quality"
}

Product type hints:
- "dry_food": kibble, dry food, crunchy food
- "wet_food": canned, pâté, gravy, pouches, stew
- "treats": treats, snacks, chews, dental sticks, training treats, biscuits
- "supplement": vitamins, oils, probiotics, joint support, supplements
- "other": anything else

Texture inference rules (IMPORTANT):
- "dry": No water in top 3 ingredients, OR product name contains "kibble", "jerky", "biscuit", "crunchy", OR moisture < 14%
- "wet": Water/broth is #1-2 ingredient, OR product is canned/pâté/stew, OR moisture > 70%
- "semi_moist": Water in top 3-5 but not #1-2, OR contains glycerin as humectant, OR soft chews, OR moisture 14-70%
- "freeze_dried": Product name mentions freeze-dried or raw freeze-dried
- If unsure, infer from product name and ingredient position

CRITICAL RULES:
- If imageType is "front_label" and no ingredients visible, set ingredientsList to [] and rawIngredientsText to null
- If imageType is "ingredients_label" or "mixed", extract the COMPLETE ingredients list
- Ingredients are listed in order of weight (most to least)
- If you cannot read something clearly, note it but still extract what you can`;

    try {
      const result = await this.model.generateContent([
        {
          inlineData: {
            mimeType,
            data: imageBase64
          }
        },
        prompt
      ]);

      const response = result.response;
      const text = response.text();

      // Parse JSON from response
      const extracted = this.parseGeminiResponse(text);

      // Cache the result
      await this.cacheResult(imageHash, extracted);

      return extracted;

    } catch (error) {
      console.error('Gemini OCR error:', error);
      throw new Error(`OCR extraction failed: ${error.message}`);
    }
  }

  /**
   * Normalize and parse ingredient text
   * Useful for manual input or cleaning up OCR results
   */
  async normalizeIngredients(rawText) {
    this.initialize();

    if (!this.model) {
      // Fallback to simple parsing without AI
      return this.simpleParseIngredients(rawText);
    }

    const prompt = `Parse this pet food ingredient list and return a clean, normalized array of ingredients.

INPUT TEXT:
${rawText}

Rules:
1. Split by commas, but keep compound names together (e.g., "chicken meal" stays together)
2. Remove parenthetical percentages like "(min 4%)"
3. Keep preservative information like "preserved with mixed tocopherols"
4. Normalize common variations:
   - "deboned chicken" → "chicken"
   - "chicken by-product meal" → "chicken by-product meal" (keep as is, it's different from chicken)
5. Remove marketing language but keep scientific names if present
6. Return in order of weight (as listed)

Return ONLY a JSON array of strings, no explanation:
["ingredient1", "ingredient2", ...]`;

    try {
      const result = await this.model.generateContent(prompt);
      const text = result.response.text();
      
      // Extract JSON array from response
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      
      // Fallback to simple parsing
      return this.simpleParseIngredients(rawText);

    } catch (error) {
      console.error('Ingredient normalization error:', error);
      return this.simpleParseIngredients(rawText);
    }
  }

  /**
   * Get AI-powered explanation for why an ingredient is risky
   */
  async explainIngredientRisk(ingredientName, petType, healthConditions = []) {
    this.initialize();

    if (!this.model) {
      return null;
    }

    const prompt = `Explain briefly (2-3 sentences) why "${ingredientName}" might be concerning in pet food for a ${petType}${healthConditions.length > 0 ? ` with ${healthConditions.join(', ')}` : ''}.

Be factual and specific. If it's actually safe, say so. Focus on practical concerns for pet owners.`;

    try {
      const result = await this.model.generateContent(prompt);
      return result.response.text().trim();
    } catch (error) {
      console.error('Explanation generation error:', error);
      return null;
    }
  }

  /**
   * Generate personalized analysis summary for a product + pet combination
   * This is the "AI-enhanced" result that provides natural language insights
   * 
   * @param {Object} product - Product data (name, brand, ingredients)
   * @param {Object} pet - Pet profile (name, type, conditions, allergies)
   * @param {Object} analysis - Rule-based analysis results (score, grade, warnings, positives)
   * @returns {Object} AI-generated personalized insights
   */
  async generatePersonalizedInsights(product, pet, analysis) {
    this.initialize();

    if (!this.model) {
      return this.generateFallbackInsights(product, pet, analysis);
    }

    // Build cache key for this combination
    const cacheKey = this.buildInsightsCacheKey(product.id, pet.id, analysis.finalScore);
    
    // Check memory cache (not DB, just for this session)
    if (this.insightsCache && this.insightsCache.has(cacheKey)) {
      return this.insightsCache.get(cacheKey);
    }

    const healthConditions = pet.healthConditions?.map(c => c.condition_type || c.conditionType) || [];
    const allergies = healthConditions.filter(c => c.startsWith('allergy_')).map(c => c.replace('allergy_', ''));
    const conditions = healthConditions.filter(c => !c.startsWith('allergy_'));

    const prompt = `You are a pet nutrition expert. Analyze this pet food for a specific pet and provide personalized insights.

## PRODUCT
Name: ${product.name}
Brand: ${product.brand || 'Unknown'}
Type: ${product.product_type || 'dry food'}
Target: ${product.target_pet_type || 'unknown'}
Ingredients: ${product.raw_ingredients_text || 'Not available'}

## PET PROFILE
Name: ${pet.name}
Type: ${pet.pet_type} (${pet.pet_type === 'cat' ? 'obligate carnivore - needs high protein, taurine essential' : 'omnivore - more flexible diet'})
Breed: ${pet.breed || 'Unknown'}
Age: ${pet.age_months ? Math.floor(pet.age_months / 12) + ' years' : 'Unknown'}
Weight: ${pet.weight_kg ? pet.weight_kg + ' kg' : 'Unknown'}
Activity Level: ${pet.activity_level || 'moderate'}
${allergies.length > 0 ? `Allergies: ${allergies.join(', ')}` : 'No known allergies'}
${conditions.length > 0 ? `Health Conditions: ${conditions.join(', ')}` : 'No health conditions'}

## RULE-BASED ANALYSIS (already calculated)
Score: ${analysis.finalScore}/100
Grade: ${analysis.grade}
Recommendation: ${analysis.recommendation}
Warnings: ${analysis.warnings?.length || 0}
Positives: ${analysis.positives?.length || 0}

## YOUR TASK
Generate a JSON response with personalized insights for ${pet.name}:

{
  "personalizedSummary": "2-3 sentence summary written directly to the pet owner, mentioning ${pet.name} by name. Be warm but factual.",
  "topConcerns": ["List 1-3 specific concerns for THIS pet, or empty if none"],
  "topBenefits": ["List 1-3 specific benefits for THIS pet"],
  "feedingTip": "One practical feeding tip specific to ${pet.name}'s profile (age, weight, conditions)",
  "alternativeAdvice": "If score is below 70, suggest what type of food to look for instead. If score is good, say why this is a good match.",
  "confidenceNote": "Brief note about how confident you are in this analysis based on available data"
}

Be specific to ${pet.name}. Don't be generic. Reference their actual conditions/allergies if any.`;

    try {
      const result = await this.model.generateContent(prompt);
      const text = result.response.text();
      
      // Parse JSON response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const insights = JSON.parse(jsonMatch[0]);
        
        // Cache the result
        if (!this.insightsCache) this.insightsCache = new Map();
        this.insightsCache.set(cacheKey, insights);
        
        return {
          ...insights,
          aiGenerated: true
        };
      }
      
      return this.generateFallbackInsights(product, pet, analysis);
      
    } catch (error) {
      console.error('Personalized insights generation error:', error);
      return this.generateFallbackInsights(product, pet, analysis);
    }
  }

  /**
   * Build cache key for insights
   */
  buildInsightsCacheKey(productId, petId, score) {
    return `insights_${productId}_${petId}_${score}`;
  }

  /**
   * Generate fallback insights when Gemini is unavailable
   */
  generateFallbackInsights(product, pet, analysis) {
    const petName = pet.name || 'your pet';
    const petType = pet.pet_type || 'pet';
    
    let summary = '';
    if (analysis.grade === 'A') {
      summary = `Great news! This food is an excellent match for ${petName}. It scores ${analysis.finalScore}/100 with high-quality ingredients suitable for ${petType}s.`;
    } else if (analysis.grade === 'B') {
      summary = `This food is a good choice for ${petName}, scoring ${analysis.finalScore}/100. It meets most nutritional needs for ${petType}s.`;
    } else if (analysis.grade === 'C') {
      summary = `This food is acceptable for ${petName} but has some concerns. Score: ${analysis.finalScore}/100. Consider the warnings below.`;
    } else {
      summary = `This food may not be ideal for ${petName}. Score: ${analysis.finalScore}/100. Review the concerns carefully.`;
    }

    return {
      personalizedSummary: summary,
      topConcerns: analysis.warnings?.slice(0, 3).map(w => w.reason) || [],
      topBenefits: analysis.positives?.slice(0, 3).map(p => p.benefit) || [],
      feedingTip: `Follow the feeding guidelines on the package based on ${petName}'s weight and activity level.`,
      alternativeAdvice: analysis.finalScore < 70 
        ? `Look for ${petType} food with higher-quality protein sources and fewer fillers.`
        : `This appears to be a suitable choice for ${petName}.`,
      confidenceNote: 'Analysis based on ingredient database rules.',
      aiGenerated: false
    };
  }

  /**
   * Parse Gemini response and extract JSON
   */
  parseGeminiResponse(text) {
    try {
      // Try to find JSON in the response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        
        // Clean ingredients list - remove OCR artifacts
        let ingredientsList = parsed.ingredientsList || [];
        if (ingredientsList.length > 0) {
          ingredientsList = ingredientsList.map((ing, index) => {
            let cleaned = ing.trim();
            // Remove "Ingredients:" prefix from first item (common OCR artifact)
            if (index === 0) {
              cleaned = cleaned.replace(/^ingredients?:?\s*/i, '');
            }
            // Remove trailing punctuation
            cleaned = cleaned.replace(/[.,;:]+$/, '').trim();
            return cleaned;
          }).filter(ing => ing.length > 0);
        }
        
        return {
          imageType: parsed.imageType || null,  // front_label, ingredients_label, mixed
          productType: parsed.productType || null,  // dry_food, wet_food, treats, etc.
          productName: parsed.productName || null,
          brand: parsed.brand || null,
          targetPet: parsed.targetPet || null,
          lifeStage: parsed.lifeStage || null,
          ingredientsList: ingredientsList,
          rawIngredientsText: parsed.rawIngredientsText || '',
          guaranteedAnalysis: parsed.guaranteedAnalysis || {},
          confidence: parsed.confidence || 0.5,
          notes: parsed.notes || ''
        };
      }
    } catch (e) {
      console.error('JSON parsing error:', e);
    }

    // Return empty result if parsing fails
    return {
      imageType: null,
      productType: null,
      productName: null,
      brand: null,
      targetPet: null,
      lifeStage: null,
      ingredientsList: [],
      rawIngredientsText: text,
      guaranteedAnalysis: {},
      confidence: 0,
      notes: 'Failed to parse structured response'
    };
  }

  /**
   * Simple ingredient parsing without AI
   */
  simpleParseIngredients(rawText) {
    if (!rawText) return [];

    return rawText
      .replace(/\n/g, ', ')
      .replace(/\.\s/g, ', ')
      .replace(/\([^)]*\)/g, '') // Remove parentheticals
      .split(/,\s*/)
      .map(i => i.trim())
      .filter(i => i.length > 1 && i.length < 100)
      .filter(i => !/^(ingredients|contains|and|or|with|for|the)$/i.test(i));
  }

  /**
   * Check OCR cache
   */
  async checkCache(imageHash) {
    try {
      const results = await query(
        'SELECT extracted_text, parsed_ingredients FROM ocr_cache WHERE image_hash = ? AND (expires_at IS NULL OR expires_at > NOW())',
        [imageHash]
      );

      if (results.length > 0) {
        let ingredientsList = [];
        try {
          // Safely parse ingredients JSON
          const rawIngredients = results[0].parsed_ingredients;
          if (rawIngredients && rawIngredients.trim()) {
            ingredientsList = JSON.parse(rawIngredients);
          }
        } catch (parseError) {
          // Invalid JSON in cache - delete this corrupted entry
          await query('DELETE FROM ocr_cache WHERE image_hash = ?', [imageHash]);
          return null; // Cache miss - will re-process
        }
        
        return {
          rawIngredientsText: results[0].extracted_text,
          ingredientsList,
          fromCache: true
        };
      }
    } catch (error) {
      // Silently handle cache errors - not critical
      console.warn('Cache unavailable:', error.message);
    }
    return null;
  }

  /**
   * Cache OCR result
   */
  async cacheResult(imageHash, extracted) {
    try {
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30); // Cache for 30 days

      await query(
        `INSERT INTO ocr_cache (id, image_hash, extracted_text, parsed_ingredients, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE extracted_text = VALUES(extracted_text), parsed_ingredients = VALUES(parsed_ingredients)`,
        [
          uuidv4(),
          imageHash,
          extracted.rawIngredientsText,
          JSON.stringify(extracted.ingredientsList),
          expiresAt
        ]
      );
    } catch (error) {
      console.error('Cache write error:', error);
    }
  }

  /**
   * Quickly assess a list of ingredients for a specific pet type
   * Returns risk adjustments and explanations for each ingredient
   */
  async assessIngredientsForPet(ingredients, petType, petName, healthConditions = [], productType = 'food') {
    this.initialize();

    if (!this.model || ingredients.length === 0) {
      return {};
    }

    // Build ingredient list with positions
    const ingredientDetails = ingredients.map((i, idx) => {
      const name = i.name || i;
      const position = i.position || (idx + 1);
      return `${position}. ${name}`;
    }).join('\n');
    
    const totalIngredients = ingredients.length;
    
    // Determine if this is a treat or supplement (more lenient scoring)
    const isSupplement = productType === 'supplement';
    const isTreat = isSupplement || productType === 'treats' || productType === 'treat' || 
                    (ingredients.length <= 6 && ingredients.some(i => 
                      (i.name || i).toLowerCase().includes('jerky') || 
                      (i.name || i).toLowerCase().includes('treat')));
    
    // Build health conditions context
    const hasConditions = healthConditions && healthConditions.length > 0;
    const conditionsText = hasConditions 
      ? healthConditions.map(c => c.condition_type || c).join(', ')
      : 'None (healthy pet)';
    
    // Condition-specific instructions
    const conditionGuidelines = hasConditions ? `
CRITICAL - This pet has health conditions. Apply these scoring rules:
${healthConditions.map(c => {
  const condition = c.condition_type || c;
  
  // Handle allergies - extract the allergen and be explicit about BOTH score AND explanation
  if (condition.includes('allergy')) {
    const allergen = condition.replace('allergy_', '').replace(/_/g, ' ');
    return `- ⚠️ ${allergen.toUpperCase()} ALLERGY: Any ${allergen} or ${allergen}-derived ingredient MUST get:
      • riskScore: +45 to +50 (DANGEROUS)
      • explanation: MUST mention the allergy! Example: "ALLERGEN: This pet is allergic to ${allergen}. Do not feed."
      • DO NOT describe nutritional benefits - focus on the allergy danger!`;
  }
  
  // Other conditions
  if (condition.includes('obesity')) return '- OBESITY: Penalize high-calorie ingredients, fats, sugars (+10 to +20)';
  if (condition.includes('diabetes')) return '- DIABETES: Severely penalize sugars and simple carbs (+20 to +40)';
  if (condition.includes('kidney')) return '- KIDNEY DISEASE: Penalize high-protein and high-phosphorus ingredients (+15 to +30)';
  if (condition.includes('heart')) return '- HEART DISEASE: Penalize high-sodium ingredients (+15 to +25)';
  if (condition.includes('pancreatitis')) return '- PANCREATITIS: Severely penalize high-fat ingredients (+25 to +40)';
  if (condition.includes('liver')) return '- LIVER DISEASE: Penalize high-protein, copper-rich ingredients (+15 to +25)';
  if (condition.includes('urinary')) return '- URINARY ISSUES: Penalize high-mineral ingredients (+10 to +20)';
  if (condition.includes('digestive')) return '- DIGESTIVE SENSITIVITY: Penalize hard-to-digest ingredients, dairy, fatty foods (+10 to +20)';
  return `- ${condition.toUpperCase()}: Assess impact on this condition`;
}).join('\n')}
` : '';

    // Product type context
    const productContext = isSupplement ? `
PRODUCT TYPE: SUPPLEMENT (not a food source)
- This is a dietary supplement, NOT daily food or a treat
- It is NOT expected to be nutritionally complete — it supplements the diet
- Capsule shells, binders, and carrier ingredients (gelatin, glycerin, water, cellulose) are standard delivery mechanisms — score them NEUTRAL (-2 to +2)
- Focus ONLY on: active ingredient quality, safety, and compatibility with health conditions
- Do NOT penalize for "nutritional inadequacy" — supplements are not meals
` : isTreat ? `
PRODUCT TYPE: TREAT (occasional consumption)
- Treats are given occasionally, not as daily nutrition
- Be MORE LENIENT with minor concerns (sugars, salts) since exposure is limited
- Focus on SAFETY (toxic ingredients) rather than optimal nutrition
- A small amount of sugar/salt in a treat is acceptable for healthy pets
- Quality matters: "organic cane sugar" is better than "corn syrup"
` : `
PRODUCT TYPE: DAILY FOOD (regular consumption)
- This food is eaten daily, so ingredient quality matters more
- Be appropriately strict with fillers, sugars, artificial additives
- Prioritize nutritional completeness and digestibility
`;

    const prompt = `You are a veterinary nutritionist. Assess these pet food ingredients for a ${petType} named ${petName}.

INGREDIENTS (by position - earlier = larger amount):
${ingredientDetails}

TOTAL INGREDIENTS: ${totalIngredients}
PET TYPE: ${petType}
HEALTH CONDITIONS: ${conditionsText}
${productContext}
${conditionGuidelines}

SCORING GUIDELINES:
- riskScore: -20 to +50 (negative = BENEFICIAL, positive = concerning)

For SUPPLEMENTS - score the ACTIVE ingredients, not delivery mechanisms:
  - Active beneficial ingredients (fish oil, glucosamine, probiotics, vitamins, CoQ10): -15 to -20 (very beneficial!)
  - Carrier oils (coconut oil, flaxseed oil): -5 to -10 (beneficial)
  - Capsule/delivery components (gelatin, glycerin, water, cellulose, starch): -2 to +2 (NEUTRAL — standard delivery)
  - Natural preservatives (tocopherols, rosemary): -3 to +2 (neutral to beneficial)
  - Artificial additives: +10 to +15

For TREATS (healthy pets) - BE LENIENT, treats are occasional:
  - Quality proteins (chicken, beef, fish, eggs): -12 to -18 (very beneficial!)
  - Wholesome grains (oatmeal, brown rice): -5 to -10 (good fiber & energy)
  - TREAT FILLERS/BINDERS (rice flour, vegetable glycerin, water, tapioca, potato starch, pea starch, maltodextrin, cellulose, guar gum, xanthan gum, lecithin, gelatin): -2 to +2 (NEUTRAL - expected in treats for texture/binding!)
  - Vegetables, fruits: -5 to -10 (beneficial)
  - Minerals/supplements (calcium carbonate, vitamins): -3 to +2 (neutral to beneficial)
  - Organic/natural sugars (in moderation): +2 to +5 (minor concern, acceptable in treats)
  - Refined sugars, corn syrup: +8 to +15 (more concerning)
  - Natural preservatives (rosemary, tocopherols): -3 to +2 (neutral to beneficial)
  - Artificial colors (Yellow 5, Blue 1, Red 40): +8 to +15 (unnecessary but not toxic)
  - Artificial preservatives: +10 to +20
  - Toxic ingredients (xylitol, onion, grapes, chocolate): +40 to +50

For DAILY FOOD (healthy pets):
  - Quality proteins (chicken, beef, salmon, eggs): -10 to -18 (VERY beneficial!)
  - Organ meats (liver, heart): -8 to -12 (nutrient-dense)
  - WHOLESOME grains (oatmeal, brown rice, barley, quinoa): -5 to -10 (beneficial fiber & energy!)
  - Vegetables & fruits: -5 to -10 (beneficial vitamins)
  - LOWER QUALITY grains/fillers (corn, wheat gluten, soy): +3 to +8 (common allergens, less nutritious - but not dangerous)
  - Any added sugars: +8 to +15 (more strict for daily consumption)
  - Artificial colors/flavors: +10 to +18
  - Byproducts (unspecified): +5 to +10

GRAIN/FILLER DISTINCTION (important!):
- GOOD whole grains: oatmeal, brown rice, barley, quinoa, millet → score NEGATIVE (beneficial)
- NEUTRAL fillers (OK for treats): rice flour, white rice, tapioca, potato starch, pea starch, pea flour, chickpea flour → score -2 to +2
- NEUTRAL binders/texture: vegetable glycerin, glycerin, gelatin, guar gum, xanthan gum, cellulose, lecithin → score -2 to +2
- LOWER QUALITY fillers (common allergens, less nutritious): corn, wheat, soy, wheat gluten, corn gluten → score +2 to +8 (not ideal but not dangerous for healthy pets)

IMPORTANT RULES:
1. Consider ingredient QUALITY (organic > conventional > artificial)
2. Use position to WEIGHT the risk score (earlier = more impactful), but...
3. DO NOT mention position/order in explanations! Write descriptions that apply to the ingredient itself, regardless of where it appears in the list.

BAD explanation: "As the 5th ingredient, its quantity is likely small"
GOOD explanation: "Provides empty calories with no nutritional benefit"

Return VALID JSON (no + prefix on numbers, use -5 or 5, not +5):
{
  "assessments": {
    "Ingredient Name": {
      "riskScore": <integer like -15, 0, 10, 45 - NO + prefix>,
      "category": "string",
      "explanation": "string (describe the ingredient itself, NOT its position)",
      "benefit": "string or empty"
    }
  }
}

${hasConditions ? `⚠️ CRITICAL REMINDER: ${petName} has ${conditionsText}. 

FOR ALLERGIES:
- Any ingredient matching the allergen MUST have riskScore: +45 to +50
- The "explanation" field MUST warn about the allergy, NOT describe nutritional value!
- BAD explanation: "High-quality protein source" (ignores allergy!)
- GOOD explanation: "ALLERGEN: This pet is allergic to chicken. Do not feed."

FOR OTHER CONDITIONS:
- Penalize problematic ingredients with appropriate scores
- Mention the condition in the explanation when relevant` : 'This is a healthy pet - use standard nutritional assessment.'}`;

    try {
      console.log(`🤖 [AI PROMPT] Assessing for conditions: ${conditionsText}`);
      console.log(`🤖 [AI PROMPT] Condition guidelines:\n${conditionGuidelines}`);
      
      const result = await this.model.generateContent(prompt);
      const text = result.response.text();
      
      console.log(`🤖 [AI RAW RESPONSE]:\n${text.substring(0, 500)}...`);
      
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        // Fix invalid JSON: AI sometimes returns +5 instead of 5 for positive numbers
        const cleanedJson = jsonMatch[0].replace(/:\s*\+(\d)/g, ': $1');
        const parsed = JSON.parse(cleanedJson);
        const assessments = parsed.assessments || {};
        
        // Log each assessment
        for (const [ingName, assessment] of Object.entries(assessments)) {
          console.log(`🤖 [AI RESULT] ${ingName}: score=${assessment.riskScore}, level=${assessment.riskScore > 30 ? 'danger' : assessment.riskScore > 15 ? 'high' : assessment.riskScore > 0 ? 'moderate' : 'safe'}`);
        }
        
        return assessments;
      }
    } catch (error) {
      console.error('AI ingredient assessment error:', error.message);
    }
    
    return {};
  }

  /**
   * HOLISTIC PRODUCT REVIEW
   * AI evaluates the ENTIRE product and gives a final score
   * This catches edge cases that position-weighted scoring misses:
   * - No real protein in product
   * - Artificial colors present (even at low positions)
   * - Primary ingredients are all fillers
   * 
   * @param {Object} params
   * @param {string[]} params.ingredients - Full ingredient list
   * @param {string} params.petType - 'dog' or 'cat'
   * @param {string[]} params.healthConditions - Pet's health conditions
   * @param {string} params.productType - 'treats', 'food', 'supplement'
   * @param {string} params.petName - Pet's name for personalization
   * @returns {Object} { finalScore, grade, keyIssues, positives, aiSummary, ... }
   */
  async reviewProductHolistically({ ingredients, petType, healthConditions = [], productType = 'food', petName = 'your pet' }) {
    this.initialize();
    
    if (!this.model) {
      throw new Error('Gemini AI not initialized. Check GEMINI_API_KEY.');
    }

    const hasConditions = healthConditions.length > 0;
    const conditionsText = hasConditions ? healthConditions.join(', ') : 'none (healthy)';
    const isSupplement = productType === 'supplement';
    const isTreat = isSupplement || productType === 'treats' || productType === 'treat';

    // Different evaluation criteria for treats vs. daily food vs. supplements
    const supplementPrompt = `You are a veterinary nutritionist reviewing a PET DIETARY SUPPLEMENT.

PRODUCT TYPE: SUPPLEMENT (not food or treat)
PET: ${petType} named ${petName}
HEALTH CONDITIONS: ${conditionsText}

INGREDIENTS (by weight):
${ingredients.map((ing, i) => `${i + 1}. ${ing}`).join('\n')}

IMPORTANT: This is a SUPPLEMENT, NOT daily food or a treat. Supplements are:
- Taken to complement the regular diet (e.g., fish oil, joint support, probiotics)
- NOT expected to be nutritionally complete
- Capsule shells/binders/carriers (gelatin, glycerin, water, cellulose) are standard delivery mechanisms — NEUTRAL
- Evaluate ONLY: active ingredient quality, safety, and compatibility with health conditions

BASE SCORE: 80 (supplements start here)

SCORING ADJUSTMENTS FOR SUPPLEMENTS:

PENALTIES (subtract from base):
- Artificial preservatives (BHA, BHT): -10 to -15
- Toxic ingredients: -50 (instant fail)
- Known allergens if pet has allergies: -15 to -25
- Low-quality/rancid oil sources: -10 to -15
- Artificial colors or flavors: -5 to -10

BONUSES (add to base):
- High-quality active ingredients (wild-caught fish oil, organic extracts): +10 to +15
- Natural preservatives (tocopherols, rosemary extract): +3 to +5
- Clean, minimal ingredient list: +3 to +5
- Proven beneficial supplements (omega-3, glucosamine, probiotics): +5 to +10

NEUTRAL FOR SUPPLEMENTS (don't penalize):
- Capsule shell ingredients (gelatin, glycerin, water) — standard delivery
- Cellulose, starch — common filler in capsules/tablets
- Small amounts of carrier oils
- No protein content — supplements aren't protein sources

${hasConditions ? `
⚠️ CRITICAL - HEALTH CONDITIONS: ${conditionsText}
${healthConditions.map(c => {
  if (c.includes('allergy')) {
    const allergen = c.replace('allergy_', '').replace(/_/g, ' ');
    return '🚨 ' + allergen.toUpperCase() + ' ALLERGY: If ANY ' + allergen + ' or ' + allergen + '-derived ingredient is present → Score ≤30 (Grade F), not_recommended';
  }
  if (c.includes('diabetes')) return '⚠️ DIABETES: Most supplements are fine for diabetic pets unless sugar-coated';
  if (c.includes('obesity')) return '⚠️ OBESITY: Fish oil can actually help with weight management — bonus if present';
  if (c.includes('kidney')) return '🚨 KIDNEY DISEASE: High-protein supplements may be problematic → Subtract 10-20 points if high protein';
  if (c.includes('liver')) return '🚨 LIVER DISEASE: Avoid copper-heavy or high-protein supplements → Subtract 10-15';
  if (c.includes('heart')) return '⚠️ HEART DISEASE: Omega-3 is beneficial for heart → Bonus +5';
  if (c.includes('pancreatitis')) return '🚨 PANCREATITIS: High-fat supplements (fish oil in large doses) may be problematic → Check fat content';
  if (c.includes('digestive') || c.includes('sensitive')) return '⚠️ DIGESTIVE SENSITIVITY: Gelatin capsules are generally fine; watch for dairy-based ingredients';
  if (c.includes('urinary')) return '⚠️ URINARY ISSUES: Check mineral content';
  return '⚠️ ' + c.toUpperCase() + ': Evaluate supplement compatibility';
}).join('\n')}
` : ''}

SCORING GUIDE FOR SUPPLEMENTS:
- 90-100: Excellent supplement (high-quality active + clean + no artificial additives + compatible with health conditions)
- 80-89: Good supplement (quality active ingredients, minimal concerns)
- 70-79: Acceptable (some minor concerns, still beneficial)
- 60-69: Caution (quality concerns or potential condition conflicts)
- Below 60: Not recommended (allergen present, harmful for condition, or very low quality)

IMPORTANT: In keyIssues, positives, and aiSummary, DO NOT mention ingredient position/order.

Return JSON:
{
  "finalScore": <number 0-100>,
  "grade": "<A|B|C|D|F>",
  "recommendation": "<highly_recommended|recommended|acceptable|caution|not_recommended>",
  "proteinQuality": "<none|low|medium|high>",
  "primaryIngredientType": "<protein|carb|filler|fat|other>",
  "hasArtificialAdditives": <true|false>,
  "keyIssues": ["<issue without position reference>"],
  "positives": ["<positive without position reference>"],
  "aiSummary": "<2-3 sentence summary for ${petName} - no position references>"
}`;

    const treatPrompt = `You are a veterinary nutritionist reviewing a PET TREAT (not daily food).

PRODUCT TYPE: TREAT / SNACK
PET: ${petType} named ${petName}
HEALTH CONDITIONS: ${conditionsText}

INGREDIENTS (by weight):
${ingredients.map((ing, i) => `${i + 1}. ${ing}`).join('\n')}

IMPORTANT: This is a TREAT, not daily food. Treats are:
- Given occasionally (not primary nutrition source)
- NOT expected to be nutritionally complete
- Allowed to have fillers for texture/shape
- Evaluated differently than daily food

BASE SCORE: 75 (treats start here)

SCORING ADJUSTMENTS FOR TREATS:

PENALTIES (subtract from base):
- Artificial colors (Yellow 5, Blue 1, Red 40): -8 to -12 (unnecessary, potentially harmful)
- Artificial preservatives (BHA, BHT, ethoxyquin): -10 to -15
- Toxic ingredients (xylitol, chocolate, grapes): -50 (instant fail)
- Sugar/sweeteners as #1 or #2 ingredient: -2 to -4 (minor concern for treats)
- Known allergens if pet has allergies: -15 to -25
- Long ingredient list (15+) with many unrecognizable items: -3 to -5

BONUSES (add to base):
- Real meat/protein as #1 ingredient: +12 to +18 (significant bonus!)
- Real meat/protein in top 3 (not #1): +6 to +10
- Natural preservatives (tocopherols, rosemary extract): +3 to +5
- Short, clean ingredient list (5 or fewer ingredients): +3 to +5
- All recognizable, whole-food ingredients: +3 to +5
- Functional benefits (dental, joint, skin): +2 to +3
- Beneficial herbs (parsley, peppermint): +1 to +2

NEUTRAL FOR TREATS (don't penalize):
- Fillers as primary ingredient (rice flour, corn starch) - expected in treats
- No protein - treats don't need to be protein-rich
- Glycerin/water - common in soft treats
- "Natural Flavor" - acceptable for treats
- Organic sugar in small amounts - treats are meant to be tasty

${hasConditions ? `
⚠️ CRITICAL - HEALTH CONDITIONS: ${conditionsText}
${healthConditions.map(c => {
  if (c.includes('allergy')) {
    const allergen = c.replace('allergy_', '').replace(/_/g, ' ');
    return `🚨 ${allergen.toUpperCase()} ALLERGY: If ANY ${allergen} or ${allergen}-derived ingredient is present → Score ≤30 (Grade F), not_recommended`;
  }
  if (c.includes('diabetes')) return `🚨 DIABETES: If high sugar/simple carbs (sugar, corn syrup, dextrose, molasses) are prominent → Score ≤40 (Grade D/F), caution or not_recommended`;
  if (c.includes('obesity')) return `⚠️ OBESITY: If high-fat or calorie-dense ingredients dominate → Subtract 15-25 points`;
  if (c.includes('kidney')) return `🚨 KIDNEY DISEASE: If very high protein or high phosphorus (bone meal, organ meats, dairy) → Score ≤50 (Grade D), caution`;
  if (c.includes('liver')) return `🚨 LIVER DISEASE: If high protein/copper (organ meats, shellfish) → Score ≤50 (Grade D), caution`;
  if (c.includes('heart')) return `🚨 HEART DISEASE: If high sodium (salt, sodium nitrate) → Score ≤50 (Grade D), caution`;
  if (c.includes('pancreatitis')) return `🚨 PANCREATITIS: If high fat (animal fat, bacon, fatty meats) → Score ≤40 (Grade D/F), not_recommended`;
  if (c.includes('digestive') || c.includes('sensitive')) return `⚠️ DIGESTIVE SENSITIVITY: If hard-to-digest items (dairy, fatty foods, spicy, raw) → Subtract 15-25 points`;
  if (c.includes('urinary')) return `⚠️ URINARY ISSUES: If high mineral content (magnesium, phosphorus) → Subtract 10-20 points`;
  return `⚠️ ${c.toUpperCase()}: Evaluate ingredients for compatibility, penalize problematic ones`;
}).join('\n')}
` : ''}

SCORING GUIDE FOR TREATS:
- 90-100: Excellent treat (real protein #1 + clean ingredients + no artificial additives)
- 80-89: Great treat (real protein + mostly clean OR very clean but no protein)
- 70-79: Good treat (acceptable ingredients, may have minor concerns)
- 60-69: Caution (artificial additives or multiple concerns)
- Below 60: Not recommended (toxic, artificial colors + preservatives, or serious issues)

IMPORTANT: In keyIssues, positives, and aiSummary, DO NOT mention ingredient position/order.
BAD: "Cane sugar as the #1 ingredient is concerning"
GOOD: "Contains added sugar which provides empty calories"

Return JSON:
{
  "finalScore": <number 0-100>,
  "grade": "<A|B|C|D|F>",
  "recommendation": "<highly_recommended|recommended|acceptable|caution|not_recommended>",
  "proteinQuality": "<none|low|medium|high>",
  "primaryIngredientType": "<protein|carb|filler|fat|other>",
  "hasArtificialAdditives": <true|false>,
  "keyIssues": ["<issue without position reference>", "<issue 2>"],
  "positives": ["<positive without position reference>", "<positive 2>"],
  "aiSummary": "<2-3 sentence summary for ${petName} - no position references>"
}

CALIBRATION EXAMPLES (follow these closely):
- Chicken #1, organic sugar, vinegar, rosemary extract (4 ingredients, all recognizable, natural preservative) = 90-93 (Grade A)
- Chicken #1, sugar, glycerin, natural flavors, rosemary (clean but slightly longer) = 86-89 (Grade A)
- Rice flour, glycerin, natural preservatives, herbs, NO artificial colors = 78-82 (Grade B)
- Rice flour, glycerin, natural preservatives, herbs, WITH artificial colors (Yellow 5, Blue 1) = 65-72 (Grade C/D)
- Artificial colors AND artificial preservatives = 55-65 (Grade D/F)
🚨 IF PET HAS HEALTH CONDITIONS:
- Chicken treat + pet has CHICKEN ALLERGY → 20-30 (Grade F) - allergen present!
- Sugary treat + pet has DIABETES → 35-45 (Grade D/F) - sugar is harmful!
- Fatty treat + pet has PANCREATITIS → 30-40 (Grade F/D) - fat triggers flares!
- High-protein treat + pet has KIDNEY DISEASE → 45-55 (Grade D) - protein overload!

KEY PRINCIPLE: Treats deserve 90+ if clean ingredients + no artificial additives. BUT health conditions override everything - problematic ingredients for that condition MUST significantly lower the score.`;

    const foodPrompt = `You are a veterinary nutritionist reviewing DAILY PET FOOD (not treats).

PRODUCT TYPE: DAILY FOOD
PET: ${petType} named ${petName}
HEALTH CONDITIONS: ${conditionsText}

INGREDIENTS (by weight):
${ingredients.map((ing, i) => `${i + 1}. ${ing}`).join('\n')}

IMPORTANT: This is DAILY FOOD - the primary nutrition source. Must be:
- Nutritionally appropriate
- Protein should be prominent
- Quality matters significantly

BASE SCORE: 75 (daily food starts here - stricter than treats)

SCORING FOR DAILY FOOD:

PENALTIES:
- No real protein in top 3: -10 to -15
- "Flavor" instead of real meat: -8 to -12
- Artificial colors: -8 to -12
- Artificial preservatives: -8 to -12
- Corn/wheat as #1 ingredient: -8 to -12
- By-products as primary protein: -5 to -8
- Toxic ingredients: -50 (instant fail)

BONUSES:
- Real meat as #1 ingredient: +8 to +12
- Named meat (chicken, beef) vs generic: +3 to +5
- Natural preservatives: +3 to +5
- Whole grains vs refined: +2 to +4
- Added vitamins/minerals: +2 to +4
- Omega fatty acids: +2 to +4

${petType === 'cat' ? `
CAT-SPECIFIC:
- Cats are obligate carnivores - NEED high protein
- No taurine listed: -10 to -15
- Carb-heavy formula: -8 to -12
` : `
DOG-SPECIFIC:
- Dogs are omnivores - some carbs OK
- Still need quality protein
- Balanced nutrition important
`}

${hasConditions ? `
⚠️ CRITICAL - HEALTH CONDITIONS: ${conditionsText}
${healthConditions.map(c => {
  if (c.includes('allergy')) {
    const allergen = c.replace('allergy_', '').replace(/_/g, ' ');
    return `🚨 ${allergen.toUpperCase()} ALLERGY: If ANY ${allergen} or ${allergen}-derived ingredient is present → Score ≤30 (Grade F), not_recommended`;
  }
  if (c.includes('diabetes')) return `🚨 DIABETES: If high sugar/simple carbs (sugar, corn syrup, dextrose, molasses) are prominent → Score ≤40 (Grade D/F), caution or not_recommended`;
  if (c.includes('obesity')) return `⚠️ OBESITY: If high-fat or calorie-dense ingredients dominate → Subtract 15-25 points`;
  if (c.includes('kidney')) return `🚨 KIDNEY DISEASE: If very high protein or high phosphorus (bone meal, organ meats, dairy) → Score ≤50 (Grade D), caution`;
  if (c.includes('liver')) return `🚨 LIVER DISEASE: If high protein/copper (organ meats, shellfish) → Score ≤50 (Grade D), caution`;
  if (c.includes('heart')) return `🚨 HEART DISEASE: If high sodium (salt, sodium nitrate) → Score ≤50 (Grade D), caution`;
  if (c.includes('pancreatitis')) return `🚨 PANCREATITIS: If high fat (animal fat, bacon, fatty meats) → Score ≤40 (Grade D/F), not_recommended`;
  if (c.includes('digestive') || c.includes('sensitive')) return `⚠️ DIGESTIVE SENSITIVITY: If hard-to-digest items (dairy, fatty foods, spicy, raw) → Subtract 15-25 points`;
  if (c.includes('urinary')) return `⚠️ URINARY ISSUES: If high mineral content (magnesium, phosphorus) → Subtract 10-20 points`;
  return `⚠️ ${c.toUpperCase()}: Evaluate ingredients for compatibility, penalize problematic ones`;
}).join('\n')}
` : ''}

IMPORTANT: In keyIssues, positives, and aiSummary, DO NOT mention ingredient position/order.
BAD: "Real chicken as the #1 ingredient" or "Sugar is the first ingredient"
GOOD: "Contains quality chicken protein" or "High sugar content is concerning"

Return JSON:
{
  "finalScore": <number 0-100>,
  "grade": "<A|B|C|D|F>",
  "recommendation": "<highly_recommended|recommended|acceptable|caution|not_recommended>",
  "proteinQuality": "<none|low|medium|high>",
  "primaryIngredientType": "<protein|carb|filler|fat|other>",
  "hasArtificialAdditives": <true|false>,
  "keyIssues": ["<issue without position reference>", "<issue 2>"],
  "positives": ["<positive without position reference>", "<positive 2>"],
  "aiSummary": "<2-3 sentence summary for ${petName} - no position references>"
}`;

    const prompt = isSupplement ? supplementPrompt : (isTreat ? treatPrompt : foodPrompt);

    try {
      const result = await this.model.generateContent(prompt);
      const text = result.response.text();
      
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        
        // Validate and normalize response
        return {
          finalScore: Math.max(0, Math.min(100, parseInt(parsed.finalScore) || 50)),
          grade: ['A', 'B', 'C', 'D', 'F'].includes(parsed.grade) ? parsed.grade : 'C',
          recommendation: parsed.recommendation || 'acceptable',
          proteinQuality: parsed.proteinQuality || 'unknown',
          primaryIngredientType: parsed.primaryIngredientType || 'unknown',
          hasArtificialAdditives: !!parsed.hasArtificialAdditives,
          keyIssues: Array.isArray(parsed.keyIssues) ? parsed.keyIssues : [],
          positives: Array.isArray(parsed.positives) ? parsed.positives : [],
          aiSummary: parsed.aiSummary || ''
        };
      }
      
      throw new Error('Invalid JSON response from AI');
    } catch (error) {
      console.error('Holistic review error:', error.message);
      // Return a conservative fallback
      return {
        finalScore: 50,
        grade: 'C',
        recommendation: 'acceptable',
        proteinQuality: 'unknown',
        primaryIngredientType: 'unknown',
        hasArtificialAdditives: false,
        keyIssues: ['Unable to complete AI analysis'],
        positives: [],
        aiSummary: 'Analysis could not be completed. Please review ingredients manually.'
      };
    }
  }

  /**
   * Identify food from photo (Step 1 - always needed for image recognition)
   * @param {Buffer} imageBuffer - Image data
   * @param {string} mimeType - Image MIME type
   * @returns {Object} Food identification { identified, foodName, category, foodType }
   */
  async identifyFoodFromImage(imageBuffer, mimeType = 'image/jpeg') {
    this.initialize();

    if (!this.model) {
      throw new Error('Gemini AI not initialized. Check API key.');
    }

    const imageBase64 = imageBuffer.toString('base64');

    const prompt = `You are a food identification expert. Look at this photo and identify what food is shown.

INSTRUCTIONS:
1. Identify the food in the photo
2. Determine if it's a SIMPLE food or PREPARED dish
3. Be specific with the name

FOOD TYPES:
- "simple": Single ingredient or raw food (apple, egg, raw chicken, carrot, cheese, chocolate bar)
- "prepared": Cooked dish, meal, recipe with multiple ingredients (soup, pizza, stew, sandwich, salad, pasta dish, Korean food, etc.)

Return ONLY a JSON object:
{
  "identified": true,
  "foodName": "<Name of the food>",
  "category": "<Fruit|Vegetable|Meat|Dairy|Grain|Snack|Beverage|Candy|Nut|Seafood|PreparedDish|Other>",
  "foodType": "<simple|prepared>"
}

EXAMPLES:
- Photo of an apple → { "foodName": "Apple", "category": "Fruit", "foodType": "simple" }
- Photo of pizza → { "foodName": "Pizza", "category": "PreparedDish", "foodType": "prepared" }
- Photo of raw egg → { "foodName": "Egg", "category": "Dairy", "foodType": "simple" }
- Photo of Korean soup → { "foodName": "Tteok-Manduguk", "category": "PreparedDish", "foodType": "prepared" }
- Photo of chocolate → { "foodName": "Chocolate", "category": "Candy", "foodType": "simple" }

If the image does NOT show food:
{
  "identified": false,
  "foodName": null,
  "category": null,
  "foodType": null
}`;

    try {
      const result = await this.model.generateContent([
        {
          inlineData: {
            data: imageBase64,
            mimeType
          }
        },
        prompt
      ]);

      const text = result.response.text();
      const jsonMatch = text.match(/\{[\s\S]*\}/);

      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          identified: !!parsed.identified,
          foodName: parsed.foodName || null,
          category: parsed.category || null,
          foodType: parsed.foodType || 'simple' // default to simple if not specified
        };
      }

      return { identified: false, foodName: null, category: null, foodType: null };
    } catch (error) {
      console.error('[Food Identification] Error:', error.message);
      return { identified: false, foodName: null, category: null, foodType: null };
    }
  }

  /**
   * Assess food safety for a specific pet (Step 2 - can be cached)
   * @param {string} foodName - Name of the food
   * @param {string} category - Food category
   * @param {Object} petInfo - Pet details (name, type, healthConditions, foodType)
   * @returns {Object} Safety assessment { safetyLevel, explanation, tip, category }
   */
  async assessFoodSafety(foodName, category, petInfo) {
    this.initialize();

    if (!this.model) {
      throw new Error('Gemini AI not initialized. Check API key.');
    }

    const { petName, petType, healthConditions = [], foodType = 'simple' } = petInfo;
    const isPreparedDish = foodType === 'prepared' || category === 'PreparedDish';

    // Build health conditions context with EXPLICIT rules
    let healthContext = '';
    if (healthConditions.length > 0) {
      const conditionRules = healthConditions.map(c => {
        const condition = c.name || c.condition_type || c;
        if (condition.includes('allergy')) {
          const allergen = condition.replace('allergy_', '').replace(/_/g, ' ');
          return `🚨 ${allergen.toUpperCase()} ALLERGY: If food is ${allergen} or contains ${allergen} → safetyLevel="danger"`;
        }
        if (condition.includes('diabetes')) return `🚨 DIABETES: If high sugar food → safetyLevel="danger" or "caution"`;
        if (condition.includes('kidney')) return `🚨 KIDNEY DISEASE: If high protein/phosphorus → safetyLevel="caution"`;
        if (condition.includes('pancreatitis')) return `🚨 PANCREATITIS: If high fat → safetyLevel="danger"`;
        if (condition.includes('liver')) return `🚨 LIVER DISEASE: If high protein/copper → safetyLevel="caution"`;
        if (condition.includes('heart')) return `🚨 HEART DISEASE: If high sodium → safetyLevel="caution"`;
        if (condition.includes('digestive') || condition.includes('sensitive')) return `⚠️ DIGESTIVE SENSITIVITY: If hard to digest/fatty/dairy → safetyLevel="caution"`;
        if (condition.includes('obesity')) return `⚠️ OBESITY: If high calorie/fat → safetyLevel="caution"`;
        return `⚠️ ${condition.replace(/_/g, ' ').toUpperCase()}: Consider impact on this condition`;
      });
      healthContext = `\n⚠️ HEALTH CONDITIONS:\n${conditionRules.join('\n')}`;
    }

    // Different prompts for simple foods vs prepared dishes
    let prompt;
    
    if (isPreparedDish) {
      // PREPARED DISH prompt - cannot know exact ingredients
      prompt = `You are a veterinary nutrition expert. "${foodName}" is a PREPARED DISH (meal/recipe with multiple ingredients).

Assess safety for a ${petType}.${healthContext}

CRITICAL RULES FOR PREPARED DISHES:
1. You CANNOT know exact ingredients from just the dish name
2. NEVER say "contains X" - always say "often contains" or "may contain"
3. Mention common toxic ingredients typically found in this type of dish
4. Default to "caution" unless it's a dish KNOWN to always contain toxic ingredients

Common toxic ingredients in prepared foods:
- Many dishes: onion, garlic (toxic to dogs/cats)
- Asian dishes: often have garlic, soy sauce, MSG
- Western dishes: often have onion, garlic, butter
- Desserts: may have chocolate, xylitol, raisins

Return ONLY JSON:
{
  "safetyLevel": "<caution|danger>",
  "explanation": "<Max 15 words. Start with 'Often contains...' or 'May contain...' - list concerning ingredients>",
  "tip": "Check ingredients before sharing. Avoid if contains onion/garlic.",
  "category": "PreparedDish"
}

NEVER use "safe" for prepared dishes - we can't verify ingredients.`;
    } else {
      // SIMPLE FOOD prompt - single ingredient, can be definitive
      prompt = `You are a veterinary nutrition expert. Assess whether "${foodName}" (a simple, single food item) is safe for a ${petType}.${healthContext}

TOXIC FOR DOGS: Chocolate, grapes, raisins, onions, garlic, xylitol, macadamia nuts, avocado
TOXIC FOR CATS: Onions, garlic, chocolate, grapes, raisins, xylitol, lilies

Return ONLY JSON:
{
  "safetyLevel": "<safe|caution|danger>",
  "explanation": "<ONE sentence, max 15 words. Be direct about why it's safe/dangerous.>",
  "tip": "<Short tip about portion/preparation, or null>",
  "category": "${category || 'Other'}"
}

Examples:
- Apple: "Safe and nutritious, good source of fiber and vitamins."
- Chocolate: "Toxic - contains theobromine which is poisonous to dogs."
- Cheese: "Okay in small amounts, but may cause digestive upset."`;
    }

    try {
      console.log(`🔍 [Food Safety] Assessing "${foodName}" for ${petType}`);

      const result = await this.model.generateContent(prompt);
      const text = result.response.text();
      const jsonMatch = text.match(/\{[\s\S]*\}/);

      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        
        console.log(`✅ [Food Safety] "${foodName}" = ${parsed.safetyLevel}`);

        return {
          safetyLevel: parsed.safetyLevel || 'unknown',
          explanation: parsed.explanation || 'Unable to determine safety. Please consult your veterinarian.',
          tip: parsed.tip || null,
          category: parsed.category || category
        };
      }

      throw new Error('Invalid JSON response');
    } catch (error) {
      console.error('[Food Safety] Error:', error.message);

      return {
        safetyLevel: 'unknown',
        explanation: 'We couldn\'t assess this food\'s safety. Please consult your veterinarian.',
        tip: 'When in doubt, don\'t feed it to your pet.',
        category: category
      };
    }
  }
}

module.exports = new GeminiService();

