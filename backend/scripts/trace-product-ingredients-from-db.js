#!/usr/bin/env node
/**
 * Read one product from DB, list per-ingredient ai_assessment_cache hits (same as cacheLookup),
 * replay computeScoreFromCache math (position weight, supplement cap, diminishing returns, profile penalty).
 *
 * Usage:
 *   DB_HOST=... DB_PORT=... DB_USER=... DB_PASSWORD=... DB_NAME=railway \
 *   node scripts/trace-product-ingredients-from-db.js [product_uuid]
 *
 * Default product: COMPLETE ESSENTIALS SHREDDED BLEND BEEF & RICE FORMULA
 */
const path = require('path');
const { connectDB, query } = require(path.join(__dirname, '../src/database/connection'));
const ia = require(path.join(__dirname, '../src/services/ingredientAnalyzer'));
const { getSingleConditionHash } = require(path.join(__dirname, '../src/utils/cacheHelpers'));

const DEFAULT_PRODUCT_ID = '471c2a88-4f42-481f-ade8-063fd897d99c';

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

const supplementExceptions = {
  liver_disease: ['copper', 'copper sulfate', 'copper proteinate', 'copper amino acid'],
  heart_disease: ['salt', 'sodium selenite'],
  kidney_disease: ['salt'],
  thyroid_issues: ['iodine', 'calcium iodate', 'potassium iodide'],
  urinary_issues: ['calcium', 'calcium carbonate', 'magnesium']
};

function applySupplementCap(riskScore, normalizedName, condition) {
  let r = riskScore;
  if (
    r > 5 &&
    supplementIngredients.some((si) => normalizedName === si || normalizedName.includes(si))
  ) {
    const exceptionList = supplementExceptions[condition] || [];
    if (!exceptionList.some((ex) => normalizedName === ex || normalizedName.includes(ex))) {
      r = Math.min(r, 5);
    }
  }
  return r;
}

async function main() {
  const productId = process.argv[2] || DEFAULT_PRODUCT_ID;
  await connectDB();

  const rows = await query(
    'SELECT id, name, ingredient_hash, raw_ingredients_text FROM products WHERE id = ? LIMIT 1',
    [productId]
  );
  if (!rows.length) {
    console.error('No product for id', productId);
    process.exit(1);
  }
  const p = rows[0];
  const ingredientsList = ia.parseIngredientText(p.raw_ingredients_text || '');
  const conditionHash = getSingleConditionHash('healthy', 'food');
  const condition = 'healthy';
  const petType = 'dog';
  const productType = 'dry_food';

  console.log('=== PRODUCT ===');
  console.log('name:', p.name);
  console.log('ingredient_hash:', p.ingredient_hash);
  console.log('conditionHash:', conditionHash, '| petType:', petType, '| productType:', productType);
  console.log('parsed ingredient count:', ingredientsList.length);
  console.log('');

  const listLen = Math.max(1, ingredientsList.length);
  const normalizedNames = ingredientsList.map((n) => ia.normalizeIngredientName(n.trim()));

  const penalties = [];
  const missing = [];
  const table = [];

  for (let i = 0; i < ingredientsList.length; i++) {
    const name = ingredientsList[i].trim();
    if (!name) continue;
    const normalizedName = normalizedNames[i];
    const position = i + 1;
    const positionWeight = ia.getPositionWeightFromListOrder(position, listLen);

    const cached = await ia.cacheLookup(normalizedName, conditionHash, petType);
    if (!cached.length) {
      missing.push({ position, name, normalizedName });
      table.push({
        pos: position,
        name: name.slice(0, 72),
        hit: false,
        normalizedName: normalizedName.slice(0, 72)
      });
      continue;
    }

    const dbRisk = cached[0].risk_score || 0;
    let riskScore = applySupplementCap(dbRisk, normalizedName, condition);
    const effectiveWeight = positionWeight;
    const adjusted = parseFloat((riskScore * effectiveWeight).toFixed(2));
    if (riskScore > 0) penalties.push(adjusted);

    table.push({
      pos: position,
      name: name.slice(0, 72),
      hit: true,
      cacheKey: cached[0].ingredient_normalized,
      dbRisk,
      cappedRisk: riskScore,
      w: Number(positionWeight.toFixed(4)),
      penaltyContribution: riskScore > 0 ? adjusted : 0,
      counts: riskScore > 0,
      toxicFlag: riskScore > 40
    });
  }

  console.log('=== PER-INGREDIENT (cacheLookup → healthy_food, dog) ===');
  console.table(table);

  penalties.sort((a, b) => b - a);
  const diminishingMultipliers = [1.0, 0.75, 0.5];
  let totalRiskScore = 0;
  const dimRows = [];
  for (let i = 0; i < penalties.length; i++) {
    const mult = i < diminishingMultipliers.length ? diminishingMultipliers[i] : 0.25;
    const add = parseFloat((penalties[i] * mult).toFixed(2));
    totalRiskScore += add;
    if (i < 12) dimRows.push({ rank: i + 1, basePenalty: penalties[i], mult, added: add });
  }

  console.log('\n=== DIMINISHING RETURNS (positive penalties only, sorted desc) ===');
  console.table(dimRows);
  console.log('totalRiskScore (sum):', Number(totalRiskScore.toFixed(2)));

  const profile = ia._computeConditionProfilePenalty(condition, normalizedNames);
  console.log('\n=== PROFILE PENALTY (healthy) ===');
  console.log(JSON.stringify(profile, null, 2));

  let hypotheticalFinal = 100 - totalRiskScore - profile.penalty;
  hypotheticalFinal = Math.max(0, Math.min(100, Math.round(hypotheticalFinal)));

  console.log('\n=== IF every row had cache (hypothetical — NOT returned by API when any miss) ===');
  console.log('baseScore: 100');
  console.log('formula: round(clamp(100 - totalRiskScore - profilePenalty))');
  console.log('hypotheticalFinalScore:', hypotheticalFinal);

  if (missing.length) {
    console.log('\n=== MISSING (no cacheLookup hit — computeScoreFromCache stops here) ===');
    console.table(missing);
    console.log(
      '\nOfficial computeScoreFromCache for this list returns ONLY { allCached: false, missingIngredients } — NO finalScore.'
    );
    console.log(
      'So 54 cannot be produced by this deterministic pipeline; alternatives used AI (Tier 3) or an old product_review_cache row elsewhere.'
    );
  }

  const official = await ia.computeScoreFromCache(ingredientsList, conditionHash, petType, productType);
  console.log('\n=== OFFICIAL computeScoreFromCache() return ===');
  console.log(JSON.stringify(official, null, 2));

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
