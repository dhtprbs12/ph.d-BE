const { query } = require('../database/connection');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const ingredientAnalyzer = require('./ingredientAnalyzer');

class ProductService {
  /**
   * Generate ingredient hash for deduplication
   * Same ingredients (regardless of name) = Same hash
   */
  generateIngredientHash(ingredientsList) {
    if (!ingredientsList || ingredientsList.length === 0) {
      return null;
    }
    
    // Normalize: lowercase, trim, sort alphabetically, comma-separated
    // Must match seed-products.js hash format for consistency
    const normalized = ingredientsList
      .map(ing => ing.toLowerCase().trim().replace(/\s+/g, ' '))
      .filter(Boolean)
      .sort()
      .join(',');
    
    return crypto.createHash('md5').update(normalized).digest('hex');
  }

  /**
   * Find product by ingredient hash (exact ingredient match)
   */
  async findByIngredientHash(hash) {
    if (!hash) return null;
    
    const results = await query(
      'SELECT * FROM products WHERE ingredient_hash = ?',
      [hash]
    );
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Find product by ID
   */
  async findById(productId) {
    const results = await query(
      'SELECT * FROM products WHERE id = ?',
      [productId]
    );
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Search products by text
   */
  async search(searchTerm, options = {}) {
    const { targetPetType, productType, lifeStage, limit = 20, offset = 0 } = options;
    
    // Handle empty search term
    if (!searchTerm || searchTerm.trim() === '') {
      return [];
    }
    
    const term = searchTerm.trim();
    
    let sql = `
      SELECT * FROM products 
      WHERE (name LIKE ? OR brand LIKE ?)
    `;
    const params = [`%${term}%`, `%${term}%`];

    if (targetPetType) {
      sql += ` AND (target_pet_type = ? OR target_pet_type = 'both')`;
      params.push(targetPetType);
    }

    if (productType) {
      sql += ` AND product_type = ?`;
      params.push(productType);
    }

    if (lifeStage) {
      sql += ` AND (target_life_stage = ? OR target_life_stage = 'all')`;
      params.push(lifeStage);
    }

    sql += ` ORDER BY name ASC LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), parseInt(offset));

    return await query(sql, params);
  }


  /**
   * Filter products by multiple criteria
   * Used for product discovery feature
   */
  async filterProducts(filters = {}) {
    const {
      petType,
      productType,
      lifeStage,
      allergenExclusions = {},
      ingredientInclusions = {},
      healthConditions = [],
      minScore,
      searchTerm,
      limit = 20,
      offset = 0
    } = filters;

    // Ingredient keywords for allergen filtering
    const ingredientKeywords = {
      chicken: ['chicken', 'poultry'],
      beef: ['beef', 'cattle'],
      fish: ['fish', 'salmon', 'tuna', 'sardine', 'anchovy', 'herring', 'cod', 'tilapia', 'whitefish'],
      lamb: ['lamb'],
      turkey: ['turkey'],
      duck: ['duck'],
      dairy: ['milk', 'cheese', 'whey', 'dairy'],
      grains: ['wheat', 'corn', 'rice', 'barley', 'oat', 'grain'],
      eggs: ['egg'],
      soy: ['soy', 'soybean']
    };

    // Map allergy condition types to ingredient keyword keys
    const allergyToKeyword = {
      allergy_chicken: 'chicken',
      allergy_beef: 'beef',
      allergy_fish: 'fish',
      allergy_dairy: 'dairy',
      allergy_grains: 'grains',
      allergy_eggs: 'eggs',
      allergy_soy: 'soy',
      allergy_lamb: 'lamb'
    };

    // =============================================
    // Classify health conditions upfront
    // =============================================
    const allergyConditions = [];
    const diseaseConditions = [];

    for (const condition of healthConditions) {
      const conditionType = condition.condition_type || condition.conditionType || condition;
      if (allergyToKeyword[conditionType]) {
        allergyConditions.push(conditionType);
      } else if (conditionType !== 'healthy') {
        diseaseConditions.push(conditionType);
      }
    }

    // =============================================
    // Build SQL in order: SELECT → JOIN → WHERE → ORDER
    // Single params array, pushed in SQL clause order
    // =============================================
    const params = [];

    // ── 1. JOINs (disease condition exclusion via product_review_cache) ──
    const isTreats = productType === 'treats';
    const productTypeForHash = isTreats ? 'treats' : 'food';
    let joinSql = '';

    diseaseConditions.forEach((condition, idx) => {
      const alias = `prc${idx}`;
      const conditionHash = `${condition}_${productTypeForHash}`;
      joinSql += ` LEFT JOIN product_review_cache ${alias}` +
        ` ON ${alias}.ingredient_hash = p.ingredient_hash` +
        ` AND ${alias}.conditions_hash = ? AND ${alias}.pet_type = ?`;
      params.push(conditionHash, petType || 'dog');
    });

    // ── 2. WHERE clauses ──
    const where = [];

    // Pet type
    if (petType) {
      where.push(`(p.target_pet_type = ? OR p.target_pet_type = 'both')`);
      params.push(petType);
    }

    // Product type
    if (productType) {
      where.push('p.product_type = ?');
      params.push(productType);
    }

    // Life stage
    if (lifeStage) {
      where.push(`(p.target_life_stage = ? OR p.target_life_stage = 'all')`);
      params.push(lifeStage);
    }

    // Min score
    if (minScore) {
      if (petType === 'dog') {
        where.push('p.base_dog_score >= ?');
      } else if (petType === 'cat') {
        where.push('p.base_cat_score >= ?');
      } else {
        where.push('(p.base_dog_score >= ? OR p.base_cat_score >= ?)');
        params.push(minScore);
      }
      params.push(minScore);
    }

    // Allergy exclusions — only when browsing via filters, not when user typed a search
    if (!searchTerm) {
      for (const conditionType of allergyConditions) {
        const keywords = ingredientKeywords[allergyToKeyword[conditionType]];
        for (const keyword of keywords) {
          where.push(`LOWER(p.raw_ingredients_text) NOT LIKE ?`);
          params.push(`%${keyword}%`);
        }
      }

      // Disease condition WHERE filters (exclude D/F grades, keep unscored)
      diseaseConditions.forEach((_, idx) => {
        const alias = `prc${idx}`;
        where.push(`(${alias}.id IS NULL OR ${alias}.grade NOT IN ('D', 'F'))`);
      });
    }

    // Filter chip exclusions (grain-free toggle etc.)
    for (const [allergen, exclude] of Object.entries(allergenExclusions)) {
      if (exclude && ingredientKeywords[allergen]) {
        for (const keyword of ingredientKeywords[allergen]) {
          where.push(`LOWER(p.raw_ingredients_text) NOT LIKE ?`);
          params.push(`%${keyword}%`);
        }
      }
    }

    // Ingredient inclusions
    for (const [ingredient, include] of Object.entries(ingredientInclusions)) {
      if (include && ingredientKeywords[ingredient]) {
        const keywords = ingredientKeywords[ingredient];
        const orConditions = keywords.map(() => `LOWER(p.raw_ingredients_text) LIKE ?`).join(' OR ');
        where.push(`(${orConditions})`);
        for (const keyword of keywords) {
          params.push(`%${keyword}%`);
        }
      }
    }

    // Text search
    if (searchTerm && searchTerm.length >= 2) {
      where.push('(p.name LIKE ? OR p.brand LIKE ?)');
      params.push(`%${searchTerm}%`, `%${searchTerm}%`);
    }

    // ── 3. ORDER + LIMIT ──
    params.push(limit, offset);

    // ── Assemble ──
    const whereStr = where.length > 0 ? where.join(' AND ') : '1=1';
    const sql = `SELECT p.* FROM products p${joinSql} WHERE ${whereStr} ORDER BY p.name ASC LIMIT ? OFFSET ?`;

    console.log('🔍 Filter SQL:', sql);
    console.log('🔍 Filter params:', params);

    const results = await query(sql, params);
    console.log('🔍 Filter results:', results.length, 'products');
    
    // Convert MySQL TINYINT(1) to boolean for iOS compatibility
    return results;
  }

  /**
   * Create new product from scan data
   */
  async createFromScan(productData) {
    const id = uuidv4();
    
    // Generate ingredient hash for deduplication
    const ingredientHash = productData.ingredientsList 
      ? this.generateIngredientHash(productData.ingredientsList)
      : null;
    
    await query(
      `INSERT INTO products 
       (id, name, brand, product_type, texture, target_pet_type, target_life_stage, 
        raw_ingredients_text, ingredient_hash, image_url, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'user_scan')`,
      [
        id,
        productData.name || 'Unknown Product',
        productData.brand || null,
        productData.productType || 'dry_food',
        productData.texture || null,
        productData.targetPetType || 'both',
        productData.lifeStage || 'all',
        productData.rawIngredientsText || null,
        ingredientHash,
        productData.imageUrl || null
      ]
    );

    return await this.findById(id);
  }

  /**
   * Get product with full analysis for a specific pet
   */
  async getProductAnalysis(productId, pet) {
    console.log('🔍 [getProductAnalysis] Looking for product ID:', productId);
    const product = await this.findById(productId);
    if (!product) {
      console.log('❌ [getProductAnalysis] Product not found!');
      throw new Error('Product not found');
    }
    console.log('✅ [getProductAnalysis] Found product:', product.name);

    // Parse ingredients
    const ingredientsList = ingredientAnalyzer.parseIngredientText(product.raw_ingredients_text);

    // Run analysis
    const analysis = await ingredientAnalyzer.analyzeIngredients(ingredientsList, pet);

    return {
      product,
      analysis
    };
  }

  /**
   * Get candidate alternative products (no scoring - that's done in the route)
   * @param {string} productId - Source product to find alternatives for
   * @param {string} petType - 'dog' or 'cat'
   * @param {number} limit - Max candidates to return
   * @param {string[]} allergens - Allergen keywords to exclude (e.g., ['chicken', 'beef'])
   */
  async getCandidateAlternatives(productId, petType, limit = 10, allergens = []) {
    const product = await this.findById(productId);
    if (!product) return { product: null, candidates: [] };

    // Find similar products that are compatible with pet type
    // Exclude products containing allergen ingredients
    let allergenFilter = '';
    const params = [productId, product.product_type, petType];
    
    for (const allergen of allergens) {
      allergenFilter += ` AND LOWER(p.raw_ingredients_text) NOT LIKE ?`;
      params.push(`%${allergen.toLowerCase()}%`);
    }

    params.push(limit);

    const sql = `
      SELECT p.*,
        p.scan_count as relevance_score
      FROM products p
      WHERE p.id != ?
        AND p.product_type = ?
        AND (p.target_pet_type = ? OR p.target_pet_type = 'both')
        AND p.raw_ingredients_text IS NOT NULL
        AND p.raw_ingredients_text != ''
        ${allergenFilter}
      ORDER BY 
        p.scan_count DESC
      LIMIT ?
    `;

    const candidates = await query(sql, params);

    return { product, candidates };
  }

  /**
   * Get product reviews with filtering
   */
  async getReviews(productId, filters = {}) {
    const { petType, petSize, petAgeGroup, hasAllergies, limit = 20, offset = 0 } = filters;

    let sql = 'SELECT * FROM product_reviews WHERE product_id = ?';
    const params = [productId];

    if (petType) {
      sql += ' AND pet_type = ?';
      params.push(petType);
    }
    if (petSize) {
      sql += ' AND pet_size = ?';
      params.push(petSize);
    }
    if (petAgeGroup) {
      sql += ' AND pet_age_group = ?';
      params.push(petAgeGroup);
    }
    if (hasAllergies !== undefined) {
      sql += ' AND has_allergies = ?';
      params.push(hasAllergies);
    }

    sql += ' ORDER BY helpful_count DESC, created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const reviews = await query(sql, params);

    // Get aggregate stats
    const [stats] = await query(
      `SELECT 
        COUNT(*) as total_reviews,
        AVG(rating) as average_rating,
        SUM(CASE WHEN rating >= 4 THEN 1 ELSE 0 END) as positive_count,
        SUM(CASE WHEN rating <= 2 THEN 1 ELSE 0 END) as negative_count
       FROM product_reviews 
       WHERE product_id = ?`,
      [productId]
    );

    return {
      reviews,
      stats: stats || { total_reviews: 0, average_rating: 0 }
    };
  }

  /**
   * Add a review
   */
  async addReview(productId, userId, petId, reviewData) {
    // Get pet info for denormalization
    const [pet] = await query('SELECT * FROM pets WHERE id = ? AND user_id = ?', [petId, userId]);
    if (!pet) {
      throw new Error('Pet not found');
    }

    // Determine pet size based on weight
    let petSize = 'medium';
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

    // Determine age group
    let petAgeGroup = 'adult';
    if (pet.age_months < 12) petAgeGroup = 'puppy_kitten';
    else if (pet.age_months < 24) petAgeGroup = 'young';
    else if (pet.age_months > 84) petAgeGroup = 'senior';

    // Check for allergies/conditions
    const conditions = await query(
      'SELECT condition_type FROM pet_health_conditions WHERE pet_id = ?',
      [petId]
    );
    const hasAllergies = conditions.some(c => c.condition_type.startsWith('allergy_'));
    const hasHealthConditions = conditions.length > 0;

    const id = uuidv4();

    await query(
      `INSERT INTO product_reviews 
       (id, product_id, user_id, pet_id, rating, title, content,
        pet_type, pet_breed, pet_size, pet_age_group, has_allergies, has_health_conditions)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE rating = VALUES(rating), title = VALUES(title), content = VALUES(content), updated_at = NOW()`,
      [
        id, productId, userId, petId,
        reviewData.rating,
        reviewData.title || null,
        reviewData.content || null,
        pet.pet_type,
        pet.breed,
        petSize,
        petAgeGroup,
        hasAllergies,
        hasHealthConditions
      ]
    );

    return await query('SELECT * FROM product_reviews WHERE id = ?', [id]);
  }
}

module.exports = new ProductService();

