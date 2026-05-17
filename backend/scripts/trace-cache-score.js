#!/usr/bin/env node
/**
 * One-off: parse ingredient text, read ai_assessment_cache from DB, replay computeScoreFromCache math.
 * Usage: node scripts/trace-cache-score.js [dog|cat] [dry_food|food|treats]
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const path = require('path');
const { connectDB } = require(path.join(__dirname, '../src/database/connection'));
const ingredientAnalyzer = require(path.join(__dirname, '../src/services/ingredientAnalyzer'));
const { getSingleConditionHash } = require(path.join(__dirname, '../src/utils/cacheHelpers'));

const RAW = `INGREDIENTS: Chicken, rice, whole grain wheat, poultry by-product meal, whole grain corn, soybean meal, beef fat preserved with mixed-tocopherols, corn gluten meal, dried egg product, natural flavor, dried beet pulp, glycerin, mono and dicalcium phosphate, wheat bran, calcium carbonate, fish meal, salt, soybean oil, potassium chloride. MINERALS [zinc proteinate, ferrous sulfate, manganese proteinate, copper proteinate, calcium iodate, sodium selenite]. VITAMINS [Vitamin E supplement, niacin (Vitamin B-3), thiamine mononitrate (Vitamin B-1), calcium pantothenate (Vitamin B-5), Vitamin A supplement, riboflavin supplement (Vitamin B-2), Vitamin B-12 supplement, pyridoxine hydrochloride (Vitamin B-6), folic acid (Vitamin B-9), menadione sodium bisulfite complex (Vitamin K), biotin (Vitamin B-7), Vitamin D-3 supplement], choline chloride, dried Bacillus coagulans fermentation product, L-ascorbyl-2-polyphosphate (Vitamin C), L-Lysine monohydrochloride, garlic oil.`;

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

async function traceRow(conditionHash, petType, productType) {
  const ingredientsList = ingredientAnalyzer.parseIngredientText(RAW);
  const normalizedNames = ingredientsList.map((n) => ingredientAnalyzer.normalizeIngredientName(n.trim()));
  const condition = conditionHash.replace(/_treats$/, '').replace(/_food$/, '');

  const rows = [];
  const penalties = [];
  const missing = [];

  for (let i = 0; i < ingredientsList.length; i++) {
    const name = ingredientsList[i].trim();
    if (!name) continue;
    const normalizedName = normalizedNames[i];
    const position = i + 1;

    let positionWeight = 1.0;
    if (position > 10) positionWeight = 0.25;
    else if (position > 6) positionWeight = 0.5;
    else if (position > 3) positionWeight = 0.75;

    const cached = await ingredientAnalyzer.cacheLookup(normalizedName, conditionHash, petType);
    if (!cached.length) {
      missing.push({ position, name, normalizedName });
      rows.push({ position, name, normalizedName, cacheHit: false });
      continue;
    }

    let riskScore = cached[0].risk_score || 0;
    const dbRisk = riskScore;

    if (
      riskScore > 5 &&
      supplementIngredients.some((si) => normalizedName === si || normalizedName.includes(si))
    ) {
      const exceptionList = supplementExceptions[condition] || [];
      if (!exceptionList.some((ex) => normalizedName === ex || normalizedName.includes(ex))) {
        riskScore = Math.min(riskScore, 5);
      }
    }

    const effectiveWeight = positionWeight;

    const adjusted = parseFloat((riskScore * effectiveWeight).toFixed(2));
    if (riskScore > 0) penalties.push(adjusted);

    rows.push({
      position,
      name: name.slice(0, 70),
      normalizedName: normalizedName.slice(0, 80),
      cacheKey: cached[0].ingredient_normalized,
      dbRisk,
      cappedRisk: riskScore,
      positionWeight,
      effectiveWeight,
      adjustedPenalty: adjusted,
      countsTowardSum: riskScore > 0
    });
  }

  penalties.sort((a, b) => b - a);
  const diminishingMultipliers = [1.0, 0.75, 0.5];
  let totalRiskScore = 0;
  const dimBreakdown = [];
  for (let i = 0; i < penalties.length; i++) {
    const mult = i < diminishingMultipliers.length ? diminishingMultipliers[i] : 0.25;
    const add = parseFloat((penalties[i] * mult).toFixed(2));
    totalRiskScore += add;
    if (i < 15) {
      dimBreakdown.push({ rank: i + 1, basePenalty: penalties[i], mult, added: add });
    }
  }

  const computed = await ingredientAnalyzer.computeScoreFromCache(
    ingredientsList,
    conditionHash,
    petType,
    productType
  );

  return {
    ingredientsList,
    conditionHash,
    conditionParsed: condition,
    petType,
    productType,
    rows,
    missing,
    penalties,
    totalRiskScore: parseFloat(totalRiskScore.toFixed(2)),
    dimBreakdown,
    computed
  };
}

async function main() {
  const petType = process.argv[2] || 'dog';
  const productType = process.argv[3] || 'dry_food';

  await connectDB();

  const hashesToTry = [
    getSingleConditionHash('healthy', productType),
    getSingleConditionHash('healthy', 'food'),
    getSingleConditionHash('healthy', 'dry_food')
  ];
  const uniqueHashes = [...new Set(hashesToTry)];

  console.log(JSON.stringify({ petType, productType, hashesTried: uniqueHashes }, null, 2));

  for (const h of uniqueHashes) {
    const out = await traceRow(h, petType, productType);
    console.log('\n=== condition_hash:', h, '===');
    console.log('parsedIngredientCount:', out.ingredientsList.length);
    console.log('missingCacheCount:', out.missing.length);
    if (out.missing.length) {
      console.log('missing (first 12):', out.missing.slice(0, 12));
    }
    console.log('computeScoreFromCache:', {
      allCached: out.computed.allCached,
      finalScore: out.computed.finalScore,
      grade: out.computed.grade,
      recommendation: out.computed.recommendation
    });
    console.log('replay totalRiskScore (penalties only):', out.totalRiskScore);
    console.log('diminishing breakdown (top 12 contributors):', JSON.stringify(out.dimBreakdown.slice(0, 12), null, 2));

    const hits = out.rows.filter((r) => r.cacheHit !== false);
    const byAdj = [...hits].filter((r) => r.countsTowardSum).sort((a, b) => b.adjustedPenalty - a.adjustedPenalty);
    console.log('top rows by adjustedPenalty (up to 18):');
    console.log(JSON.stringify(byAdj.slice(0, 18), null, 2));

    if (out.computed.allCached) {
      break;
    }
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
