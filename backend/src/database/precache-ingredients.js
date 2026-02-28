#!/usr/bin/env node

/**
 * PRE-CACHE INGREDIENTS SCRIPT
 * 
 * Pre-populates ai_assessment_cache with AI assessments for ALL known ingredients
 * across ALL health conditions, product types, and pet types.
 * 
 * This uses the EXACT SAME geminiService.assessIngredientsForPet() function
 * and getSingleConditionHash() that the live app uses, so cached results
 * are immediately usable by label scan, product search, etc.
 * 
 * Combos: 21 conditions × 2 product types × 2 pet types = 84 combos
 * Ingredients: ~1,400
 * Batch size: 50 ingredients per AI call
 * Estimated API calls: ~2,400 (with resume support for interrupted runs)
 * 
 * Usage:
 *   cd backend
 *   node src/database/precache-ingredients.js
 * 
 * Options (env vars):
 *   BATCH_SIZE=50          - Ingredients per AI call (default: 50)
 *   DELAY_MS=1500          - Delay between AI calls in ms (default: 1500)
 *   DRY_RUN=true           - Preview without calling AI or writing DB
 *   SKIP_EXISTING=true     - Skip combos that are fully cached (default: true)
 *   START_COMBO=0          - Resume from a specific combo index
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { connectDB, query } = require('../database/connection');
const { getSingleConditionHash } = require('../utils/cacheHelpers');
const { getComprehensiveList } = require('./comprehensive-ingredients');

// We import the geminiService singleton — same instance the live app uses
const geminiService = require('../services/geminiService');

// =============================================
// CONFIGURATION
// =============================================

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE) || 50;
const DELAY_MS = parseInt(process.env.DELAY_MS) || 1500;
const DRY_RUN = process.env.DRY_RUN === 'true';
const SKIP_EXISTING = process.env.SKIP_EXISTING !== 'false'; // default true
const START_COMBO = parseInt(process.env.START_COMBO) || 0;
const AAFCO_PATH = '/Users/kayoh/Desktop/AAFCO_ingredients.txt';

// All 20 health conditions from schema + "healthy"
const ALL_CONDITIONS = [
  'healthy',
  'allergy_chicken', 'allergy_beef', 'allergy_fish', 'allergy_dairy',
  'allergy_grains', 'allergy_eggs', 'allergy_soy', 'allergy_lamb',
  'digestive_sensitivity', 'skin_issues', 'joint_issues',
  'kidney_disease', 'liver_disease', 'heart_disease',
  'diabetes', 'obesity', 'urinary_issues', 'thyroid_issues',
  'pancreatitis', 'ibd'
];

const PET_TYPES = ['dog', 'cat'];
const PRODUCT_TYPES = ['food', 'treats'];

// =============================================
// HELPERS
// =============================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeIngredientName(name) {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

// =============================================
// BUILD ALL COMBOS
// =============================================

function buildCombos() {
  const combos = [];
  for (const condition of ALL_CONDITIONS) {
    for (const productType of PRODUCT_TYPES) {
      for (const petType of PET_TYPES) {
        const conditionsHash = getSingleConditionHash(condition, productType);
        combos.push({
          condition,
          productType,
          petType,
          conditionsHash,
          label: `${condition} / ${productType} / ${petType}`
        });
      }
    }
  }
  return combos;
}

// =============================================
// CHECK EXISTING CACHE
// =============================================

async function getCachedIngredients(conditionsHash, petType) {
  const rows = await query(
    `SELECT ingredient_normalized FROM ai_assessment_cache 
     WHERE conditions_hash = ? AND pet_type = ?`,
    [conditionsHash, petType]
  );
  return new Set(rows.map(r => r.ingredient_normalized));
}

// =============================================
// SAVE BATCH TO CACHE
// =============================================

async function saveBatchToCache(assessments, conditionsHash, petType) {
  const entries = Object.entries(assessments);
  if (entries.length === 0) return 0;

  const values = [];
  const placeholders = [];

  for (const [ingredientName, assessment] of entries) {
    const normalized = normalizeIngredientName(ingredientName);
    const riskScore = assessment.riskScore ?? 0;
    const explanation = assessment.explanation || '';
    const benefit = assessment.benefit || '';

    placeholders.push('(UUID(), ?, ?, ?, ?, ?, ?)');
    values.push(normalized, conditionsHash, petType, riskScore, explanation, benefit);
  }

  const sql = `INSERT INTO ai_assessment_cache 
    (id, ingredient_normalized, conditions_hash, pet_type, risk_score, explanation, benefit)
    VALUES ${placeholders.join(', ')}
    ON DUPLICATE KEY UPDATE 
      risk_score = VALUES(risk_score), 
      explanation = VALUES(explanation), 
      benefit = VALUES(benefit), 
      hit_count = hit_count + 1`;

  await query(sql, values);
  return entries.length;
}

// =============================================
// MAIN SCRIPT
// =============================================

async function main() {
  const scriptStart = Date.now();

  console.log('='.repeat(60));
  console.log('🚀 PET FOOD INGREDIENT PRE-CACHE SCRIPT');
  console.log('='.repeat(60));
  console.log(`Mode: ${DRY_RUN ? '🧪 DRY RUN (no AI calls, no DB writes)' : '🔥 LIVE'}`);
  console.log(`Batch size: ${BATCH_SIZE} ingredients per AI call`);
  console.log(`Delay: ${DELAY_MS}ms between AI calls`);
  console.log(`Skip existing: ${SKIP_EXISTING}`);
  console.log();

  // Step 0: Connect to DB & load ingredients
  console.log('📦 Step 0: Setup...');
  await connectDB();
  console.log('✅ Database connected');

  const ingredients = getComprehensiveList(AAFCO_PATH);
  console.log(`✅ Loaded ${ingredients.length} unique ingredients`);

  const combos = buildCombos();
  console.log(`✅ Built ${combos.length} condition combos (${ALL_CONDITIONS.length} conditions × ${PRODUCT_TYPES.length} product types × ${PET_TYPES.length} pet types)`);
  console.log();

  // Stats tracking
  let totalApiCalls = 0;
  let totalIngredientsCached = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  let combosProcessed = 0;
  let combosSkipped = 0;

  // Step 1-3: Process each combo
  for (let i = START_COMBO; i < combos.length; i++) {
    const combo = combos[i];
    const comboStart = Date.now();

    console.log('─'.repeat(60));
    console.log(`📋 Combo ${i + 1}/${combos.length}: ${combo.label}`);
    console.log(`   Hash: ${combo.conditionsHash} | Pet: ${combo.petType}`);

    // Step 1: Check what's already cached for this combo
    const cached = await getCachedIngredients(combo.conditionsHash, combo.petType);
    console.log(`   Cached: ${cached.size}/${ingredients.length}`);

    // Filter out already-cached ingredients
    const uncached = ingredients.filter(ing => !cached.has(normalizeIngredientName(ing)));

    if (uncached.length === 0 && SKIP_EXISTING) {
      console.log(`   ⏭️  Fully cached — skipping`);
      combosSkipped++;
      continue;
    }

    console.log(`   🔍 Need to assess: ${uncached.length} ingredients`);

    if (DRY_RUN) {
      console.log(`   🧪 DRY RUN — would make ${Math.ceil(uncached.length / BATCH_SIZE)} API calls`);
      combosProcessed++;
      continue;
    }

    // Step 2: Process in batches
    const batches = [];
    for (let j = 0; j < uncached.length; j += BATCH_SIZE) {
      batches.push(uncached.slice(j, j + BATCH_SIZE));
    }

    let comboIngredientsCached = 0;

    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batch = batches[batchIdx];
      const batchLabel = `Batch ${batchIdx + 1}/${batches.length} (${batch.length} ingredients)`;

      console.log(`   🤖 ${batchLabel}...`);

      // Build the health conditions array that assessIngredientsForPet expects
      const healthConditions = combo.condition === 'healthy' ? [] : [combo.condition];

      try {
        // Step 3: Call the SAME AI function the live app uses
        const assessments = await geminiService.assessIngredientsForPet(
          batch.map((name, idx) => ({ name, position: idx + 1 })),
          combo.petType,
          combo.petType === 'dog' ? 'Buddy' : 'Whiskers',  // placeholder pet name
          healthConditions,
          combo.productType
        );

        totalApiCalls++;

        // Count how many were returned
        const assessmentCount = Object.keys(assessments).length;

        if (assessmentCount === 0) {
          console.log(`   ⚠️  ${batchLabel}: AI returned empty — retrying once...`);
          await sleep(3000);

          // Retry once
          const retryAssessments = await geminiService.assessIngredientsForPet(
            batch.map((name, idx) => ({ name, position: idx + 1 })),
            combo.petType,
            combo.petType === 'dog' ? 'Buddy' : 'Whiskers',
            healthConditions,
            combo.productType
          );
          totalApiCalls++;

          const retryCount = Object.keys(retryAssessments).length;
          if (retryCount > 0) {
            const saved = await saveBatchToCache(retryAssessments, combo.conditionsHash, combo.petType);
            comboIngredientsCached += saved;
            console.log(`   ✅ ${batchLabel}: Retry succeeded — ${saved} saved`);
          } else {
            console.log(`   ❌ ${batchLabel}: Retry also empty — skipping batch`);
            totalErrors++;
          }
        } else {
          // Save to DB
          const saved = await saveBatchToCache(assessments, combo.conditionsHash, combo.petType);
          comboIngredientsCached += saved;

          // Show a few samples
          const sampleKeys = Object.keys(assessments).slice(0, 3);
          for (const key of sampleKeys) {
            const a = assessments[key];
            console.log(`      → ${key}: score=${a.riskScore}, "${(a.explanation || '').substring(0, 50)}..."`);
          }

          console.log(`   ✅ ${batchLabel}: ${saved} saved (${assessmentCount} returned)`);
        }
      } catch (error) {
        console.error(`   ❌ ${batchLabel}: ERROR — ${error.message}`);
        totalErrors++;

        // If rate limited, wait longer
        if (error.message.includes('429') || error.message.includes('quota') || error.message.includes('rate')) {
          console.log('   ⏳ Rate limited — waiting 30s...');
          await sleep(30000);
        }
      }

      // Delay between batches to avoid rate limiting
      if (batchIdx < batches.length - 1) {
        await sleep(DELAY_MS);
      }
    }

    totalIngredientsCached += comboIngredientsCached;
    combosProcessed++;

    const comboTime = Date.now() - comboStart;
    console.log(`   📊 Combo done: ${comboIngredientsCached} cached in ${formatDuration(comboTime)}`);

    // Estimate remaining time
    const avgComboTime = (Date.now() - scriptStart) / (combosProcessed + combosSkipped);
    const remaining = combos.length - i - 1;
    console.log(`   ⏱️  Est. remaining: ${formatDuration(avgComboTime * remaining)}`);
  }

  // =============================================
  // FINAL SUMMARY
  // =============================================
  const totalTime = Date.now() - scriptStart;

  console.log();
  console.log('='.repeat(60));
  console.log('📊 PRE-CACHE COMPLETE');
  console.log('='.repeat(60));
  console.log(`Total time:              ${formatDuration(totalTime)}`);
  console.log(`Combos processed:        ${combosProcessed}`);
  console.log(`Combos skipped (cached): ${combosSkipped}`);
  console.log(`API calls made:          ${totalApiCalls}`);
  console.log(`Ingredients cached:      ${totalIngredientsCached}`);
  console.log(`Errors:                  ${totalErrors}`);
  console.log();

  // Final cache stats
  const [totalRows] = await query('SELECT COUNT(*) as count FROM ai_assessment_cache');
  const [uniqueIngredients] = await query('SELECT COUNT(DISTINCT ingredient_normalized) as count FROM ai_assessment_cache');
  const [uniqueCombos] = await query('SELECT COUNT(DISTINCT CONCAT(conditions_hash, pet_type)) as count FROM ai_assessment_cache');

  console.log('📈 CACHE STATUS:');
  console.log(`   Total rows:            ${totalRows.count}`);
  console.log(`   Unique ingredients:    ${uniqueIngredients.count}`);
  console.log(`   Unique combos:         ${uniqueCombos.count}`);
  console.log('='.repeat(60));

  process.exit(0);
}

// Run
main().catch(err => {
  console.error('💥 Fatal error:', err);
  process.exit(1);
});

