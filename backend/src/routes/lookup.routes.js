const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();
const { query } = require('../database/connection');
const { authenticateToken } = require('../middleware/auth');
const lookupService = require('../services/lookupService');
const imageService = require('../services/imageService');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  },
});

function requireUser(req, res) {
  if (!req.user?.id || req.user.id === 'anonymous') {
    res.status(401).json({ error: 'Sign in to request an analysis' });
    return false;
  }
  return true;
}

function sendError(res, error) {
  const status = error.status || 500;
  if (status >= 500) console.error('[Lookup]', error);
  res.status(status).json({ error: error.message || 'Lookup failed' });
}

async function storeLookupPhoto(buffer, key) {
  if (imageService.r2Client) {
    return imageService.uploadToR2(buffer, key, 'image/jpeg', { skipResize: true, skipThumb: true });
  }
  return imageService.saveLocally(buffer, key.replace(/\//g, '_'));
}

router.post('/', authenticateToken, async (req, res) => {
  try {
    if (!requireUser(req, res)) return;
    const pet = req.body.pet || {};
    const created = await lookupService.createNameLookup({
      userId: req.user.id,
      pet: {
        id: pet.id || req.body.petId || null,
        name: pet.name || req.body.petName || null,
        petType: pet.petType || pet.pet_type || req.body.petType || 'dog',
      },
      brand: req.body.brand,
      queryName: req.body.queryName,
      protein: req.body.protein,
      lifeStage: req.body.lifeStage,
      foodForm: req.body.foodForm,
      pastedUrl: req.body.pastedUrl,
      email: req.body.email,
      setAsCurrentFood: req.body.setAsCurrentFood === true,
      replaceCurrentFood: req.body.replaceCurrentFood === true,
    });
    res.status(created.reused ? 200 : 201).json(created);
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/', authenticateToken, async (req, res) => {
  try {
    if (!requireUser(req, res)) return;
    if (req.query.barcode) {
      const found = await lookupService.findReadyByBarcode(req.user.id, String(req.query.barcode));
      return res.json({ lookup: found });
    }
    res.json(await lookupService.listLookups(req.user.id));
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/:id', authenticateToken, async (req, res) => {
  try {
    if (!requireUser(req, res)) return;
    const lookup = await lookupService.getLookup(req.user.id, req.params.id);
    if (!lookup) return res.status(404).json({ error: 'Lookup not found' });
    res.json(lookup);
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/:id/ack', authenticateToken, async (req, res) => {
  try {
    if (!requireUser(req, res)) return;
    await lookupService.ackLookup(req.user.id, req.params.id);
    res.json({ ok: true });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/photo',
  authenticateToken,
  upload.fields([
    { name: 'frontImage', maxCount: 1 },
    { name: 'ingredientImage', maxCount: 1 },
    { name: 'barcodeImage', maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      if (!requireUser(req, res)) return;
      const front = req.files?.frontImage?.[0];
      const ingredient = req.files?.ingredientImage?.[0];
      const barcodeImage = req.files?.barcodeImage?.[0];
      const barcode = String(req.body.barcode || '').trim() || null;
      if (!front || !ingredient || (!barcodeImage && !barcode)) {
        return res.status(400).json({ error: 'Front and ingredient photos are required' });
      }
      const pet = {
        id: req.body.petId || null,
        name: req.body.petName || null,
        petType: req.body.petType === 'cat' ? 'cat' : 'dog',
      };
      const id = uuidv4();
      const setAsCurrentFood = req.body.setAsCurrentFood === '1' || req.body.setAsCurrentFood === 'true';
      const replaceCurrentFood = req.body.replaceCurrentFood === '1' || req.body.replaceCurrentFood === 'true';
      const [frontImageUrl, ingredientImageUrl, barcodeImageUrl] = await Promise.all([
        storeLookupPhoto(front.buffer, `lookups/${id}_front.jpg`),
        storeLookupPhoto(ingredient.buffer, `lookups/${id}_ingredients.jpg`),
        barcodeImage ? storeLookupPhoto(barcodeImage.buffer, `lookups/${id}_barcode.jpg`) : Promise.resolve(null),
      ]);
      let petFoodId = null;
      if (setAsCurrentFood) {
        petFoodId = await lookupService.ensureCurrentFood(
          req.user.id,
          pet,
          String(req.body.productName || barcode || 'Scanned food'),
          replaceCurrentFood,
        );
      }
      await query(
        `INSERT INTO lookup_requests
          (id, user_id, pet_id, pet_food_id, pet_name, pet_type, barcode, front_image_url, ingredient_image_url, barcode_image_url, status, entry, email_to)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'photo', ?)`,
        [id, req.user.id, pet.id, petFoodId, pet.name, pet.petType, barcode, frontImageUrl, ingredientImageUrl, barcodeImageUrl, lookupService.realEmail(req.body.email)],
      );
      res.status(201).json({
        id,
        status: 'queued',
        reused: false,
        tokensAwarded: 0,
        frontImageUrl,
        ingredientImageUrl,
        barcodeImageUrl,
      });
    } catch (error) {
      sendError(res, error);
    }
  },
);

router.post('/push-token', authenticateToken, async (req, res) => {
  try {
    if (!requireUser(req, res)) return;
    const token = String(req.body.token || '').trim();
    if (!token) return res.status(400).json({ error: 'token is required' });
    await query('UPDATE users SET expo_push_token = ? WHERE id = ?', [token.slice(0, 255), req.user.id]);
    res.json({ ok: true });
  } catch (error) {
    sendError(res, error);
  }
});

module.exports = router;
