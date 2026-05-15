const express = require('express');
const cloudVision = require('../services/cloudVisionService');

const router = express.Router();

/**
 * PHD app `ScanScreen`: JPEG base64 → full document OCR text.
 * Contract matches `postVisionDocumentText` in ph.d-FE `api.ts`.
 */
router.post('/document-text', async (req, res, next) => {
  try {
    if (!cloudVision.isAvailable()) {
      return res.status(503).json({ error: 'Vision not configured' });
    }
    const b64 = req.body?.imageBase64;
    if (typeof b64 !== 'string' || !b64.length) {
      return res.status(400).json({ error: 'imageBase64 required' });
    }
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) {
      return res.status(400).json({ error: 'invalid base64' });
    }
    const { rawText } = await cloudVision.detectDocumentText(buf, {
      languageHints: ['en'],
    });
    res.json({ text: rawText || '' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
