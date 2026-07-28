const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

// HEIC to JPEG conversion
async function ensureJpeg(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.heic' || ext === '.heif') {
    const convert = require('heic-convert');
    const inputBuffer = fs.readFileSync(filePath);
    const jpegBuffer = await convert({ buffer: inputBuffer, format: 'JPEG', quality: 0.9 });
    const jpegPath = filePath.replace(/\.heic$/i, '.jpg').replace(/\.heif$/i, '.jpg');
    fs.writeFileSync(jpegPath, jpegBuffer);
    return { path: jpegPath, buffer: jpegBuffer, mime: 'image/jpeg' };
  }
  // For non-HEIC, just read the buffer
  const buffer = fs.readFileSync(filePath);
  const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
  return { path: filePath, buffer, mime };
}

// Reuse existing backend services
const geminiService = require('../../backend/src/services/geminiService');
const ingredientAnalyzer = require('../../backend/src/services/ingredientAnalyzer');
const productMatchKey = require('../../backend/src/services/productMatchKey');
const productService = require('../../backend/src/services/productService');
const { query } = require('../../backend/src/database/connection');
const { decodeBarcode } = require('./barcodeDecoder');

const router = express.Router();

// Multer config
const uploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

// In-memory queue of processed but not-yet-reviewed products
const pendingQueue = [];

/**
 * POST /api/batch/process
 * Upload 3 images (front, ingredients, barcode) → AI extract → return JSON
 */
router.post(
  '/process',
  upload.fields([
    { name: 'front', maxCount: 1 },
    { name: 'ingredients', maxCount: 1 },
    { name: 'barcode', maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const frontFile = req.files?.front?.[0];
      const ingredientsFile = req.files?.ingredients?.[0];
      const barcodeFile = req.files?.barcode?.[0];

      if (!frontFile || !ingredientsFile) {
        return res.status(400).json({ error: 'front and ingredients images are required' });
      }

      // 1. Process front label (convert HEIC if needed)
      const front = await ensureJpeg(frontFile.path);
      const frontResult = await geminiService.extractFromImage(front.buffer, front.mime);

      // 2. Process ingredients (convert HEIC if needed)
      const ing = await ensureJpeg(ingredientsFile.path);
      const ingredientsResult = await geminiService.extractFromImage(ing.buffer, ing.mime);

      // 3. Decode barcode (if provided)
      let barcodeValue = null;
      if (barcodeFile) {
        try {
          const bc = await ensureJpeg(barcodeFile.path);
          barcodeValue = await decodeBarcode(bc.path);
        } catch (e) {
          console.warn('⚠️ Barcode decode failed:', e.message);
        }
      }

      // Build combined result
      const id = uuidv4();
      const result = {
        id,
        status: 'pending_review',
        images: {
          front: `/uploads/${path.basename(frontFile.path)}`,
          ingredients: `/uploads/${path.basename(ingredientsFile.path)}`,
          barcode: barcodeFile ? `/uploads/${path.basename(barcodeFile.path)}` : null,
        },
        extracted: {
          manufacturer: frontResult.manufacturer || null,
          brand: frontResult.brand || null,
          lineName: frontResult.lineName || null,
          productName: frontResult.productName || null,
          lifeStage: frontResult.lifeStage || 'all',
          primaryProteins: frontResult.primaryProteins || [],
          petType: frontResult.targetPet || 'dog',
          productType: frontResult.productType || 'dry_food',
          texture: frontResult.texture || null,
          breedSize: frontResult.breedSize || 'all',
          dietTags: frontResult.dietTags || [],
        },
        ingredients: ingredientsResult.ingredientsList || [],
        rawIngredientsText: ingredientsResult.rawIngredientsText || '',
        barcode: barcodeValue,
        createdAt: new Date().toISOString(),
      };

      pendingQueue.push(result);
      res.json(result);
    } catch (e) {
      console.error('❌ Process error:', e);
      res.status(500).json({ error: e.message });
    }
  }
);

/**
 * POST /api/batch/process-bulk
 * Upload multiple sets at once. Files named: 0-front, 0-ingredients, 0-barcode, 1-front, ...
 */
router.post('/process-bulk', upload.array('photos', 300), async (req, res) => {
  try {
    const files = req.files || [];
    const sets = {};

    // Group files by index prefix
    for (const file of files) {
      const match = file.originalname.match(/^(\d+)-(front|ingredients|barcode)\./i);
      if (match) {
        const idx = match[1];
        const role = match[2].toLowerCase();
        if (!sets[idx]) sets[idx] = {};
        sets[idx][role] = file;
      }
    }

    const results = [];
    for (const idx of Object.keys(sets).sort((a, b) => Number(a) - Number(b))) {
      const set = sets[idx];
      if (!set.front || !set.ingredients) continue;

      const front = await ensureJpeg(set.front.path);
      const frontResult = await geminiService.extractFromImage(front.buffer, front.mime);

      const ing = await ensureJpeg(set.ingredients.path);
      const ingredientsResult = await geminiService.extractFromImage(ing.buffer, ing.mime);

      let barcodeValue = null;
      if (set.barcode) {
        try {
          const bc = await ensureJpeg(set.barcode.path);
          barcodeValue = await decodeBarcode(bc.path);
        } catch (e) {
          console.warn(`⚠️ Barcode decode failed for set ${idx}:`, e.message);
        }
      }

      const id = uuidv4();
      const result = {
        id,
        status: 'pending_review',
        images: {
          front: `/uploads/${path.basename(set.front.path)}`,
          ingredients: `/uploads/${path.basename(set.ingredients.path)}`,
          barcode: set.barcode ? `/uploads/${path.basename(set.barcode.path)}` : null,
        },
        extracted: {
          manufacturer: frontResult.manufacturer || null,
          brand: frontResult.brand || null,
          lineName: frontResult.lineName || null,
          productName: frontResult.productName || null,
          lifeStage: frontResult.lifeStage || 'all',
          primaryProteins: frontResult.primaryProteins || [],
          petType: frontResult.targetPet || 'dog',
          productType: frontResult.productType || 'dry_food',
          texture: frontResult.texture || null,
          breedSize: frontResult.breedSize || 'all',
          dietTags: frontResult.dietTags || [],
        },
        ingredients: ingredientsResult.ingredientsList || [],
        rawIngredientsText: ingredientsResult.rawIngredientsText || '',
        barcode: barcodeValue,
        createdAt: new Date().toISOString(),
      };

      pendingQueue.push(result);
      results.push(result);
    }

    res.json({ processed: results.length, results });
  } catch (e) {
    console.error('❌ Bulk process error:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/batch/queue
 * List all pending review items
 */
router.get('/queue', (req, res) => {
  res.json(pendingQueue.filter(p => p.status === 'pending_review'));
});

/**
 * GET /api/batch/ingredients/suggest?q=
 * Autocomplete ingredient names from DB
 */
router.get('/ingredients/suggest', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json([]);

    // Try ingredient_dictionary table first
    try {
      const rows = await query(
        `SELECT name, frequency FROM ingredient_dictionary 
         WHERE name LIKE ? ORDER BY frequency DESC LIMIT 20`,
        [`%${q}%`]
      );
      return res.json(rows.map(r => r.name));
    } catch (e) {
      // Table might not exist yet; fall back to parsing products
    }

    // Fallback: search raw_ingredients_text across products
    const rows = await query(
      `SELECT DISTINCT raw_ingredients_text FROM products 
       WHERE raw_ingredients_text LIKE ? LIMIT 50`,
      [`%${q}%`]
    );

    const matches = new Set();
    for (const row of rows) {
      if (!row.raw_ingredients_text) continue;
      const parts = ingredientAnalyzer.parseIngredientText(row.raw_ingredients_text);
      for (const part of parts) {
        if (part.toLowerCase().includes(q.toLowerCase())) {
          matches.add(part.trim());
        }
      }
    }

    res.json([...matches].slice(0, 20));
  } catch (e) {
    console.error('❌ Suggest error:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/batch/save
 * Save a reviewed product to the production DB
 */
router.post('/save', async (req, res) => {
  try {
    const { id, extracted, ingredients, barcode } = req.body;

    if (!extracted || !ingredients || ingredients.length === 0) {
      return res.status(400).json({ error: 'extracted data and ingredients are required' });
    }

    const ingredientsList = ingredients.map(s => String(s).trim()).filter(Boolean);
    const rawText = ingredientsList.join(', ');

    // Build slots and match fields
    const slots = productMatchKey.buildSlotsFromExtracted({
      manufacturer: extracted.manufacturer,
      brand: extracted.brand,
      lineName: extracted.lineName,
      lifeStage: extracted.lifeStage,
      primaryProteins: extracted.primaryProteins,
      breedSize: extracted.breedSize,
      dietTags: extracted.dietTags,
      targetPet: extracted.petType,
      productName: extracted.productName,
    });

    const displayName = productMatchKey.buildDisplayName(slots) || extracted.productName || 'Unknown Product';

    // Check if product already exists
    let product = await productService.findProductForConfirm({
      slots,
      ingredientsList,
      brand: extracted.brand,
      displayName,
    });

    if (!product) {
      product = await productService.createFromScan({
        name: displayName,
        displayName,
        manufacturer: extracted.manufacturer,
        brand: extracted.brand,
        lineName: slots.lineName,
        primaryProteins: slots.primaryProteins,
        breedSize: slots.breedSize,
        dietTags: slots.dietTags,
        productType: extracted.productType || 'dry_food',
        texture: extracted.texture,
        targetPetType: extracted.petType || 'dog',
        lifeStage: extracted.lifeStage || 'all',
        rawIngredientsText: rawText,
        ingredientsList,
        imageUrl: null,
        barcode: barcode || null,
        source: 'batch_import',
      });
    } else {
      // Update barcode if not set
      if (barcode && !product.barcode) {
        await query('UPDATE products SET barcode = ? WHERE id = ?', [barcode, product.id]);
        product.barcode = barcode;
      }
    }

    // Update ingredient dictionary
    await updateIngredientDictionary(ingredientsList);

    // Remove from pending queue
    const queueIdx = pendingQueue.findIndex(p => p.id === id);
    if (queueIdx >= 0) pendingQueue[queueIdx].status = 'saved';

    res.json({
      success: true,
      product: { id: product.id, name: product.name, brand: product.brand, barcode: product.barcode },
    });
  } catch (e) {
    console.error('❌ Save error:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/batch/skip
 * Mark a queue item as skipped
 */
router.post('/skip', (req, res) => {
  const { id } = req.body;
  const item = pendingQueue.find(p => p.id === id);
  if (item) item.status = 'skipped';
  res.json({ success: true });
});

// Helper: update ingredient dictionary table
async function updateIngredientDictionary(ingredientsList) {
  try {
    for (const name of ingredientsList) {
      const trimmed = name.trim();
      if (!trimmed) continue;
      await query(
        `INSERT INTO ingredient_dictionary (name, frequency) VALUES (?, 1)
         ON DUPLICATE KEY UPDATE frequency = frequency + 1`,
        [trimmed]
      );
    }
  } catch (e) {
    // Table might not exist — that's okay
    if (e.code !== 'ER_NO_SUCH_TABLE') {
      console.warn('⚠️ ingredient_dictionary update failed:', e.message);
    }
  }
}

module.exports = router;
