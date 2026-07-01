/**
 * Canonical product match key for stable SKU identity (brand + line + stage + …).
 * Display names are built separately; match_key is for exact DB lookup.
 */

const ALLOWED_LIFE_STAGES = new Set(['puppy', 'kitten', 'adult', 'senior', 'all']);
const ALLOWED_BREED_SIZES = new Set(['all', 'large_breed', 'small_breed']);

function normalizeBrand(brand) {
  if (!brand) return '';
  return String(brand).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeLineName(lineName) {
  if (!lineName) return '';
  return String(lineName)
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeProteinList(primaryProteins) {
  let list = primaryProteins;
  if (list == null || list === '') return '';
  if (typeof list === 'string') {
    list = list.split(/[,+]/).map((s) => s.trim()).filter(Boolean);
  }
  if (!Array.isArray(list)) return '';
  return list
    .map((p) => String(p).toLowerCase().trim().replace(/\s+/g, '_'))
    .filter(Boolean)
    .sort()
    .join('+');
}

function normalizeDietTags(dietTags) {
  let list = dietTags;
  if (list == null || list === '') return '';
  if (typeof list === 'string') {
    list = list.split(/[,+]/).map((s) => s.trim()).filter(Boolean);
  }
  if (!Array.isArray(list)) return '';
  return list
    .map((t) => String(t).toLowerCase().trim().replace(/\s+/g, '_'))
    .filter(Boolean)
    .sort()
    .join('+');
}

/**
 * Resolve legacy puppy_kitten and ambiguous values using pet type when available.
 * @param {string|null|undefined} lifeStage
 * @param {'dog'|'cat'|'both'|null|undefined} [petType]
 */
function resolveLifeStage(lifeStage, petType = null) {
  const v = String(lifeStage || 'all').toLowerCase().trim();
  if (v === 'puppy_kitten') {
    if (petType === 'dog') return 'puppy';
    if (petType === 'cat') return 'kitten';
    return 'all';
  }
  if (v === 'puppy' || v === 'kitten') return v;
  if (ALLOWED_LIFE_STAGES.has(v)) return v;
  return 'all';
}

function normalizeLifeStage(lifeStage, petType = null) {
  return resolveLifeStage(lifeStage, petType);
}

function normalizeBreedSize(breedSize) {
  const v = String(breedSize || 'all').toLowerCase().trim();
  return ALLOWED_BREED_SIZES.has(v) ? v : 'all';
}

/**
 * @param {object} slots
 * @param {string} [slots.brand]
 * @param {string} [slots.lineName]
 * @param {string} [slots.lifeStage]
 * @param {string} [slots.targetPetType]
 * @param {string[]|string} [slots.primaryProteins]
 * @param {string} [slots.breedSize]
 * @param {string[]|string} [slots.dietTags]
 */
function buildMatchKey(slots = {}) {
  const parts = [
    normalizeBrand(slots.brand),
    normalizeLineName(slots.lineName),
    normalizeLifeStage(slots.lifeStage, slots.targetPetType),
    normalizeProteinList(slots.primaryProteins),
    normalizeBreedSize(slots.breedSize),
    normalizeDietTags(slots.dietTags),
  ];
  return `${parts.join('|')}|`;
}

/** DB column value: comma-separated sorted proteins */
function serializePrimaryProteins(primaryProteins) {
  const joined = normalizeProteinList(primaryProteins);
  if (!joined) return null;
  return joined.split('+').join(',');
}

/** DB column value: comma-separated sorted diet tags */
function serializeDietTags(dietTags) {
  const joined = normalizeDietTags(dietTags);
  if (!joined) return null;
  return joined.split('+').join(',');
}

/**
 * Build DB-ready match fields from scan/import slots.
 */
function titleCaseToken(token) {
  if (!token) return '';
  return String(token)
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function formatLineDisplay(lineName) {
  const normalized = normalizeLineName(lineName);
  if (!normalized) return '';
  return normalized
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function formatProteinsForDisplay(primaryProteins) {
  const joined = normalizeProteinList(primaryProteins);
  if (!joined) return '';
  return joined
    .split('+')
    .map((p) => titleCaseToken(p.replace(/_/g, ' ')))
    .join(' & ');
}

/**
 * Display name: [stage] → [line] → [breed] → [protein]
 * Omits adult/all; senior shows as "7+" (match_key still uses senior).
 */
function buildDisplayName(slots = {}) {
  const parts = [];
  const stage = normalizeLifeStage(slots.lifeStage, slots.targetPetType);

  if (stage === 'puppy') parts.push('Puppy');
  else if (stage === 'kitten') parts.push('Kitten');
  else if (stage === 'senior') parts.push('7+');

  const line = formatLineDisplay(slots.lineName);
  if (line) parts.push(line);

  const breed = normalizeBreedSize(slots.breedSize);
  if (breed === 'large_breed') parts.push('Large Breed');
  else if (breed === 'small_breed') parts.push('Small Breed');

  const protein = formatProteinsForDisplay(slots.primaryProteins);
  if (protein) parts.push(protein);

  return parts.join(' ').trim() || null;
}

function coerceStringList(value) {
  if (value == null || value === '') return null;
  if (Array.isArray(value)) {
    const list = value.map((v) => String(v).trim()).filter(Boolean);
    return list.length ? list : null;
  }
  if (typeof value === 'string') {
    const list = value.split(/[,+]/).map((s) => s.trim()).filter(Boolean);
    return list.length ? list : null;
  }
  return null;
}

/**
 * Normalize Gemini / scan payload into canonical match slots.
 */
function buildSlotsFromExtracted(extracted = {}) {
  const targetPetType = extracted.targetPet || extracted.targetPetType || null;
  const lifeStage = extracted.lifeStage
    ? resolveLifeStage(extracted.lifeStage, targetPetType)
    : 'all';

  let lineName = extracted.lineName || extracted.line_name || null;
  if (!lineName && extracted.productName) {
    lineName = extracted.productName;
  }

  let breedSize = extracted.breedSize || extracted.breed_size || 'all';
  if (!ALLOWED_BREED_SIZES.has(String(breedSize).toLowerCase())) {
    breedSize = 'all';
  }

  return {
    brand: extracted.brand || null,
    lineName,
    lifeStage,
    targetPetType,
    primaryProteins: coerceStringList(extracted.primaryProteins ?? extracted.primary_proteins),
    breedSize,
    dietTags: coerceStringList(extracted.dietTags ?? extracted.diet_tags),
  };
}

/** Enough signal for exact match_key lookup (brand + line). */
function hasMinimumMatchSlots(slots = {}) {
  return !!normalizeBrand(slots.brand) && !!normalizeLineName(slots.lineName);
}

function buildProductMatchFields(slots = {}) {
  const brandNorm = normalizeBrand(slots.brand) || null;
  const lineName = normalizeLineName(slots.lineName) || null;
  const lifeStage = normalizeLifeStage(slots.lifeStage, slots.targetPetType);
  const breedSize = normalizeBreedSize(slots.breedSize);
  const primaryProteins = serializePrimaryProteins(slots.primaryProteins);
  const dietTags = serializeDietTags(slots.dietTags);
  const matchKey = buildMatchKey({
    brand: slots.brand,
    lineName: slots.lineName,
    lifeStage,
    targetPetType: slots.targetPetType,
    primaryProteins: slots.primaryProteins,
    breedSize,
    dietTags: slots.dietTags,
  });

  return {
    brand_norm: brandNorm,
    line_name: lineName,
    target_life_stage: lifeStage,
    breed_size: breedSize,
    primary_proteins: primaryProteins,
    diet_tags: dietTags,
    match_key: matchKey,
  };
}

module.exports = {
  ALLOWED_LIFE_STAGES,
  ALLOWED_BREED_SIZES,
  normalizeBrand,
  normalizeLineName,
  normalizeProteinList,
  normalizeDietTags,
  resolveLifeStage,
  normalizeLifeStage,
  normalizeBreedSize,
  buildMatchKey,
  buildDisplayName,
  buildSlotsFromExtracted,
  hasMinimumMatchSlots,
  serializePrimaryProteins,
  serializeDietTags,
  buildProductMatchFields,
};
