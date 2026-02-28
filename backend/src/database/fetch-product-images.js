#!/usr/bin/env node

/**
 * FETCH PRODUCT IMAGES SCRIPT
 * 
 * Finds and downloads product images for all seeded products using Google Custom Search API.
 * Images are saved locally to backend/public/products/ and URLs stored in products.image_url.
 * 
 * Prerequisites:
 * 1. Go to https://programmablesearchengine.google.com/ → Create search engine
 *    - Add sites: chewy.com, petco.com, amazon.com
 *    - Copy the Search Engine ID (cx)
 * 2. Go to https://console.cloud.google.com/ → APIs & Services → Enable "Custom Search API"
 *    - Create credentials → API Key
 * 3. Add to backend/.env:
 *    GOOGLE_SEARCH_API_KEY=your_api_key
 *    GOOGLE_SEARCH_ENGINE_ID=your_cx_id
 * 
 * Usage:
 *   cd backend
 *   node src/database/fetch-product-images.js
 * 
 * Options:
 *   DRY_RUN=true     - Preview without downloading
 *   LIMIT=10         - Only process first N products
 *   DELAY_MS=1000    - Delay between API calls (default: 1000)
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { connectDB, query } = require('../database/connection');
const imageService = require('../services/imageService');

const DRY_RUN = process.env.DRY_RUN === 'true';
const LIMIT = parseInt(process.env.LIMIT) || 999;
const DELAY_MS = parseInt(process.env.DELAY_MS) || 1000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('='.repeat(60));
  console.log('📸 FETCH PRODUCT IMAGES');
  console.log('='.repeat(60));
  console.log(`Mode: ${DRY_RUN ? '🧪 DRY RUN' : '🔥 LIVE'}`);
  console.log();

  // Check config - need at least one image search provider
  const hasSerpApi = !!process.env.SERPAPI_KEY;
  const hasGoogle = process.env.GOOGLE_SEARCH_API_KEY && process.env.GOOGLE_SEARCH_ENGINE_ID;
  
  if (!hasSerpApi && !hasGoogle) {
    console.error('❌ Missing image search API keys. Need at least one:');
    console.error('   - SERPAPI_KEY (SerpAPI - recommended)');
    console.error('   - GOOGLE_SEARCH_API_KEY + GOOGLE_SEARCH_ENGINE_ID (Google Custom Search)');
    process.exit(1);
  }
  console.log(`🔑 Image search provider: ${hasSerpApi ? 'SerpAPI' : 'Google Custom Search'}`);

  await connectDB();
  console.log('✅ Database connected');

  // Get products without images
  const products = await query(
    `SELECT id, name, brand FROM products 
     WHERE (image_url IS NULL OR image_url = '') 
     ORDER BY scan_count DESC
     LIMIT ?`,
    [LIMIT]
  );

  const total = products.length;
  console.log(`📦 Found ${total} products without images`);
  console.log();

  let fetched = 0;
  let failed = 0;
  let skipped = 0;

  for (let i = 0; i < products.length; i++) {
    const product = products[i];
    console.log(`[${i + 1}/${total}] ${product.brand || ''} ${product.name}`);

    if (DRY_RUN) {
      console.log(`   🧪 Would search for image`);
      skipped++;
      continue;
    }

    try {
      const localUrl = await imageService.fetchAndSaveProductImage(
        product.id,
        product.name,
        product.brand
      );

      if (localUrl) {
        fetched++;
        console.log(`   ✅ ${localUrl}`);
      } else {
        failed++;
        console.log(`   ⚠️ No image found`);
      }
    } catch (error) {
      failed++;
      console.error(`   ❌ Error: ${error.message}`);
    }

    // Delay between requests
    if (i < products.length - 1) {
      await sleep(DELAY_MS);
    }
  }

  console.log();
  console.log('='.repeat(60));
  console.log('📊 RESULTS');
  console.log('='.repeat(60));
  console.log(`Total products:  ${total}`);
  console.log(`Images fetched:  ${fetched}`);
  console.log(`Failed:          ${failed}`);
  console.log(`Skipped:         ${skipped}`);

  // Show final stats
  const [withImages] = await query(
    `SELECT COUNT(*) as count FROM products WHERE image_url IS NOT NULL AND image_url != ''`
  );
  const [totalProducts] = await query('SELECT COUNT(*) as count FROM products');
  console.log();
  console.log(`📈 Products with images: ${withImages.count}/${totalProducts.count}`);
  console.log('='.repeat(60));

  process.exit(0);
}

main().catch(err => {
  console.error('💥 Fatal error:', err);
  process.exit(1);
});

