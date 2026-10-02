/**
 * Cache Helper Utilities
 * Shared functions for per-condition caching strategy
 */

/**
 * Get condition hash for a single condition
 * Format: "{condition}_{productType}" e.g., "healthy_food", "diabetes_treats"
 * @param {string} condition - The health condition (or 'healthy' for no conditions)
 * @param {string} productType - 'food' or 'treats'
 * @returns {string} The condition hash
 */
function getSingleConditionHash(condition, productType) {
  if (!condition || condition === 'healthy') {
    return `healthy_${productType}`;
  }
  return `${condition}_${productType}`;
}

/** ai_assessment_cache.category ENUM values. */
const INGREDIENT_CATEGORIES = new Set([
  'protein', 'grain', 'vegetable', 'fruit', 'vitamin', 'mineral', 'other',
]);

/**
 * Coerce an AI-supplied category to the ai_assessment_cache ENUM, or null when
 * the model returned something else (older prompts allowed free text).
 * @param {unknown} raw
 * @returns {string|null}
 */
function normalizeIngredientCategory(raw) {
  const value = String(raw || '').trim().toLowerCase();
  return INGREDIENT_CATEGORIES.has(value) ? value : null;
}

/** Words that describe processing, not the plant or animal the ingredient came from. */
const SOURCE_NOISE_WORDS = new Set([
  'deboned', 'dried', 'dehydrated', 'ground', 'whole', 'fresh', 'raw', 'meal', 'meals',
  'byproduct', 'byproducts', 'by', 'product', 'products', 'hydrolyzed', 'concentrate',
  'isolate', 'protein', 'flour', 'bran', 'gluten', 'starch', 'oil', 'fat', 'flavor',
  'flavour', 'natural', 'powder', 'extract', 'source', 'of', 'and',
]);

/** Words that end in s but are already singular, so the -s rule must skip them. */
const ALREADY_SINGULAR = new Set(['sassafras', 'gras', 'tagetes', 'molasses', 'watercress']);

/** Singularize one word: potatoes -> potato, berries -> berry, peas -> pea. */
function singularizeWord(word) {
  if (word.length < 4 || ALREADY_SINGULAR.has(word)) return word;
  if (word.endsWith('oes')) return word.slice(0, -2);
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (/(ss|sh|ch|x|z)es$/.test(word)) return word.slice(0, -2);
  // Latin/Greek endings (citrus, asparagus, orris) are not plurals.
  if (/(us|is|ss)$/.test(word)) return word;
  if (word.endsWith('s')) return word.slice(0, -1);
  return word;
}

/** Different words for the same plant or animal. */
const SOURCE_ALIASES = {
  bovine: 'beef',
  cow: 'milk',
  dairy: 'milk',
  pig: 'pork',
  swine: 'pork',
  sheep: 'lamb',
  mutton: 'lamb',
  soy: 'soybean',
  flaxseed: 'flax',
  linseed: 'flax',
  garbanzo: 'chickpea',
  rapeseed: 'canola',
  maize: 'corn',
  'miscanthus grass': 'miscanthus',
  animal: 'meat',
};

/**
 * Coerce an AI-supplied ingredient source to a stable grouping key. Strips the
 * processing words the model sometimes leaves in so that "chicken meal" and
 * "deboned chicken" land on the same value.
 * @param {unknown} raw
 * @returns {string|null}
 */
function normalizeIngredientSource(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value || value === 'null' || value === 'none' || value === 'n/a') return null;

  const words = value
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w && !SOURCE_NOISE_WORDS.has(w))
    .map(singularizeWord);
  if (words.length === 0) return null;

  const cleaned = words.join(' ').slice(0, 60);
  if (!cleaned) return null;
  return SOURCE_ALIASES[cleaned] || cleaned;
}

/**
 * Safe JSON parsing with fallback
 * @param {string|array} str - JSON string or array to parse
 * @param {*} fallback - Fallback value if parsing fails (default: [])
 * @returns {array} Parsed array or fallback
 */
function safeJsonParse(str, fallback = []) {
  if (!str) return fallback;
  if (Array.isArray(str)) return str;
  try {
    const parsed = JSON.parse(str);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    if (typeof str === 'string' && str.length > 0) {
      return [str];
    }
    return fallback;
  }
}

/**
 * Convert grade letter to numeric value for comparison
 * @param {string} grade - Grade letter (A, B, C, D, F)
 * @returns {number} Numeric value (A=4, B=3, C=2, D=1, F=0)
 */
function gradeToNumber(grade) {
  const grades = { 'A': 4, 'B': 3, 'C': 2, 'D': 1, 'F': 0 };
  return grades[grade] ?? 2;
}

/**
 * Convert numeric value to grade letter
 * @param {number} num - Numeric value
 * @returns {string} Grade letter
 */
function numberToGrade(num) {
  if (num >= 3.5) return 'A';
  if (num >= 2.5) return 'B';
  if (num >= 1.5) return 'C';
  if (num >= 0.5) return 'D';
  return 'F';
}

/**
 * Extract individual conditions from pet's health conditions
 * @param {array} healthConditions - Array of condition objects or strings
 * @returns {array} Array of condition type strings
 */
function extractConditionTypes(healthConditions) {
  if (!healthConditions || healthConditions.length === 0) {
    return ['healthy'];
  }
  return healthConditions.map(c => c.condition_type || c.conditionType || c);
}

/**
 * Check if a conditions_hash is using the old combined MD5 format
 * Old format: 16-char hex string (MD5 hash)
 * New format: "{condition}_{productType}" e.g., "healthy_food", "diabetes_treats"
 * @param {string} hash - The conditions hash to check
 * @returns {boolean} True if using old MD5 format
 */
function isOldMd5Hash(hash) {
  if (!hash || hash.length !== 16) return false;
  // Check if it's a hex string (old MD5 format)
  return /^[0-9a-f]{16}$/.test(hash);
}

module.exports = {
  getSingleConditionHash,
  INGREDIENT_CATEGORIES,
  normalizeIngredientCategory,
  normalizeIngredientSource,
  safeJsonParse,
  gradeToNumber,
  numberToGrade,
  extractConditionTypes,
  isOldMd5Hash
};

