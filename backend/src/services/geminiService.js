const { GoogleGenerativeAI } = require('@google/generative-ai');
const crypto = require('crypto');
const { query } = require('../database/connection');
const { v4: uuidv4 } = require('uuid');
const cloudVisionService = require('./cloudVisionService');
const imageService = require('./imageService');
const { stitchSequentialFrameTexts, truncateForMerge } = require('../utils/ocrTextStitch');

/**
 * GEMINI AI SERVICE
 * 
 * Handles:
 * 1. OCR extraction from pet food label images
 * 2. Ingredient normalization and parsing
 * 3. Product information extraction
 */

class GeminiService {
  constructor() {
    this.genAI = null;
    this.model = null;
    this.initialized = false;
  }

  /**
   * Initialize Gemini AI client
   */
  initialize() {
    if (this.initialized) return;

    if (!process.env.GEMINI_API_KEY) {
      console.warn('⚠️ GEMINI_API_KEY not set. OCR features will be unavailable.');
      return;
    }

    this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    this.model = this.genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    this.initialized = true;
    console.log('✅ Gemini AI initialized');
  }

  /**
   * Extract ingredients from pet food label image
   * @param {Buffer} imageBuffer - Image data
   * @param {string} mimeType - Image MIME type
   * @returns {Object} Extracted data
   */
  async extractFromImage(imageBuffer, mimeType = 'image/jpeg') {
    this.initialize();

    if (!this.model) {
      throw new Error('Gemini AI not initialized. Check API key.');
    }

    // Generate image hash for caching
    const imageHash = crypto.createHash('sha256').update(imageBuffer).digest('hex');

    // Check cache
    const cached = await this.checkCache(imageHash);
    if (cached) {
      console.log('📦 Using cached OCR result');
      return cached;
    }

    // Convert buffer to base64 for Gemini
    const imageBase64 = imageBuffer.toString('base64');

    const prompt = `You are analyzing a pet food product image. First, determine what type of image this is, then extract information accordingly.

STEP 1: Identify the image type
- "ingredients_label": Shows the ingredients list (usually back of package)
- "front_label": Shows product name/brand/marketing (front of package)  
- "mixed": Shows both product info AND ingredients

STEP 2: Extract information based on what's visible

Return your response in this exact JSON format:
{
  "imageType": "ingredients_label" | "front_label" | "mixed",
  "productName": "string or null",
  "brand": "string or null", 
  "productType": "dry_food" | "wet_food" | "treats" | "supplement" | "other" | null,
  "texture": "dry" | "wet" | "semi_moist" | "freeze_dried" | null,
  "targetPet": "dog" | "cat" | "both" | null,
  "lifeStage": "puppy_kitten" | "adult" | "senior" | "all" | null,
  "packageShape": "flat" | "round" | "pouch" | null,
  "ingredientsList": ["ingredient1", "ingredient2", ...],
  "rawIngredientsText": "original text as written on label or null if not visible",
  "guaranteedAnalysis": {
    "protein": number or null,
    "fat": number or null,
    "fiber": number or null,
    "moisture": number or null
  },
  "confidence": number between 0 and 1,
  "notes": "any relevant notes about extraction quality"
}

Package shape inference (used by the app to pick a single-shot vs.
multi-frame OCR pipeline — be conservative, default "flat" when
genuinely uncertain):
- "round": cylindrical can or bottle. Visible curvature on the body,
  metal lid/seam visible, label clearly wraps around (text on the
  edges runs off into perspective distortion). Typical wet food cans,
  treat tins, supplement bottles.
- "pouch": soft stand-up pouch / curved foil bag. Has a flexible /
  curved face but is not a rigid cylinder. Often used for wet food
  pouches, freeze-dried treats.
- "flat": rigid box, kibble bag laid flat, sachet, or any package
  where the ingredient panel is plausibly readable in a single
  straight-on photo. THIS IS THE DEFAULT.
- null: package not clearly visible (e.g. only a closeup of text).

Product type hints:
- "dry_food": kibble, dry food, crunchy food
- "wet_food": canned, pâté, gravy, pouches, stew
- "treats": treats, snacks, chews, dental sticks, training treats, biscuits
- "supplement": vitamins, oils, probiotics, joint support, supplements
- "other": anything else

Texture inference rules (IMPORTANT):
- "dry": No water in top 3 ingredients, OR product name contains "kibble", "jerky", "biscuit", "crunchy", OR moisture < 14%
- "wet": Water/broth is #1-2 ingredient, OR product is canned/pâté/stew, OR moisture > 70%
- "semi_moist": Water in top 3-5 but not #1-2, OR contains glycerin as humectant, OR soft chews, OR moisture 14-70%
- "freeze_dried": Product name mentions freeze-dried or raw freeze-dried
- If unsure, infer from product name and ingredient position

CRITICAL RULES:
- If imageType is "front_label" and no ingredients visible, set ingredientsList to [] and rawIngredientsText to null
- If imageType is "ingredients_label" or "mixed", extract the COMPLETE ingredients list
- Ingredients are listed in order of weight (most to least)
- If you cannot read something clearly, note it but still extract what you can
- VERBATIM INTEGRITY (parentheticals and qualifiers). Copy each ingredient line from the label when possible. Never invent comma-separated tokens inside "(" … ")" that are not visible (e.g. do not add ", WATER" inside "BUTTER (CREAM)"). Preserve leading adjectives and legal qualifiers exactly ("MODIFIED EGG YOLK", not "EGG YOLK"). Do not normalize spellings or compress official names. For rawIngredientsText, stay faithful to the printed list paragraph (harmless whitespace collapse only).

INGREDIENT LIST EXTRACTION RULES (very important):
- Include ONLY actual food/nutrient ingredients (e.g., "Deboned Chicken", "Vitamin E Supplement", "Rosemary Extract").
- DO NOT include any of the following — they are NOT ingredients, even if they appear right next to the ingredient list:
  * Manufacturing/facility statements: "Manufactured in a facility that also processes grains", "Made in the USA", "Packaged in...", "Processed in..."
  * Preservation/marketing claims: "This is a naturally preserved product", "Naturally preserved", "Preserved with mixed tocopherols" (when written as a standalone sentence — but DO keep "Mixed Tocopherols" itself if listed as an ingredient)
  * Allergen warnings: "May contain traces of...", "Contains: ..."
  * Guaranteed analysis, feeding instructions, storage, expiration, net weight, or any sentence-like text
- REGULATORY TABLE vs INGREDIENT PANEL (many backs show both side by side):
  The "Guaranteed Analysis" / "Typical Analysis" / "Analytical Constituents" block
  (Crude Protein/Fat/Fiber, Moisture with min/max and %, Calorie Content) is NOT
  part of the ingredient statement. Never copy those rows into ingredientsList or
  rawIngredientsText — only populate the structured guaranteedAnalysis numbers when
  visible. Ingredient premix lines ("Vitamins (...)", "Minerals (...)", etc.) list
  additives by name; do not relabel them as "Moisture" or other GA headers just because
  GA text appeared nearby in the photo.
- For "ingredientsList", each item is usually a short noun phrase (1–6 words).
  EXCEPTION — PARENTHETICAL ENUMERATION (any group header): The panel may
  show ONE legal ingredient as a header word or short phrase immediately
  followed by "(" then many comma-separated sub-items ending with ")",
  often wrapping across several printed lines (common for vitamin/mineral
  premixes, trace-mineral packs, amino-acid packs, probiotics/enzymes
  listed in a cluster, etc.). Treat that whole header + one balanced
  "(" … ")" span as ONE list item. Do NOT split on inner commas into
  separate top-level items; do NOT drop the block for length; do NOT
  discard it just because inner tokens look "table-like" — it is still
  ingredient-list text unless it clearly sits under a Guaranteed Analysis
  heading with crude protein/fat/fiber/moisture percentages.
- If you find yourself writing a full standalone marketing sentence as
  an item, it is not an ingredient — drop it.
- For "rawIngredientsText", include ONLY the verbatim ingredient list itself, stopping at the first non-ingredient sentence (e.g., stop before "This is a naturally preserved product." or "Manufactured in...").
- HUMAN FOODS & CONDIMENTS (FDA-style labels — same rules as pet food):
  Many jars, dressings, sauces, and beverages show "Nutrition Facts",
  "Serving size", "Amount per serving", "Calories per serving", "% Daily Value",
  "SHAKE WELL", "REFRIGERATE AFTER OPENING", "DIST. & SOLD EXCLUSIVELY BY",
  "Distributed by", "SKU", certifier boilerplate ("Certified Organic by …"),
  or a second duplicated "INGREDIENTS:" block from an outer sleeve. NONE of
  that may appear inside ingredientsList or rawIngredientsText. If OCR places
  Nutrition Facts before the ingredient paragraph, start rawIngredientsText at
  the real "Ingredients:" / "INGREDIENTS:" line and end it where the list ends
  (before CONTAINS / allergen banners, Nutrition Facts, or usage lines).
  Never emit one giant ingredientsList element that concatenates the oil line,
  Nutrition Facts numbers, marketing text, and a second INGREDIENTS header —
  each top-level ingredient must be a plausible single product component with
  balanced parentheses only for its own sub-ingredients.`;

    try {
      const result = await this.model.generateContent([
        {
          inlineData: {
            mimeType,
            data: imageBase64
          }
        },
        prompt
      ]);

      const response = result.response;
      const text = response.text();

      // Parse JSON from response
      const extracted = this.parseGeminiResponse(text);

      // Cache the result
      await this.cacheResult(imageHash, extracted);

      return extracted;

    } catch (error) {
      console.error('Gemini OCR error:', error);
      throw new Error(`OCR extraction failed: ${error.message}`);
    }
  }

  /**
   * Multi-image OCR for cylindrical / curved packages.
   *
   * Two-stage pipeline:
   *
   *   Stage 1 — PER-FRAME RAW OCR (parallel, Cloud Vision)
   *     Each photo is OCR'd in isolation by Google Cloud Vision's
   *     DOCUMENT_TEXT_DETECTION. Cloud Vision is a dedicated OCR
   *     engine — materially more accurate at reading small / blurred
   *     / curved label text than Gemini's general vision model, and
   *     it doesn't hallucinate "corrections" the way Gemini sometimes
   *     does. Output is the raw text block of everything visible in
   *     that frame (ingredient panel + nutrition facts + disclaimers
   *     all mixed together).
   *
   *   Stage 2 — TEXT MERGE (single call, Gemini)
   *     The N raw text blocks are fed to Gemini as TEXT. Gemini's
   *     job is the part it's actually good at: reasoning over text
   *     to (a) pick out the ingredient lines, (b) discard nutrition /
   *     marketing / disclaimer copy, (c) find the start anchor, (d)
   *     stitch overlapping seams across frames, (e) deduplicate, and
   *     (f) emit the ordered list.
   *
   * Why this split (vs. asking Gemini to do everything in one
   * multimodal call): doing pixels→characters AND
   * characters→structured-list in the same model means the visual
   * weakness (small text, glare, curvature) bleeds into the
   * extraction and the model silently drops or "corrects" ingredients.
   * With Cloud Vision owning the visual half, every legible character
   * makes it into Stage 2, where Gemini can reason about it cleanly.
   *
   * When Vision is available, Stage 1 prefers a server-built **center-strip
   * panorama** (ordered frames → one wide JPEG) + single
   * DOCUMENT_TEXT_DETECTION call; if that fails or returns too little text,
   * it falls back to per-frame Vision + merge (original path).
   *
   * Falls back to the legacy Gemini multi-image one-shot when the
   * Vision API key isn't configured (local dev without GCP setup).
   *
   * @param {Buffer[]} imageBuffers - 1+ image buffers (typically 6)
   * @param {string} mimeType
   * @param {{ skipPanorama?: boolean }} [opts]  skipPanorama: if true, skip strip-panorama + panorama Gemini
   *   and use per-frame Vision + text merge only (for A/B tests or when panorama
   *   consistently misaligns for a capture mode). Default false — including
   *   frames extracted from spin video.
   * @returns {{
   *   ingredientsList: string[],
   *   rawIngredientsText: string,
   *   isComplete: boolean,
   *   confidence: number,           // 0.0 – 1.0
   *   missingSection: string|null,  // 'start'|'middle'|'end'|null
   *   notes: string,
   *   imageCount: number
   * }}
   */
  async extractFromMultipleImages(imageBuffers, mimeType = 'image/jpeg', opts = {}) {
    this.initialize();
    if (!this.model) throw new Error('Gemini AI not initialized. Check API key.');
    if (!Array.isArray(imageBuffers) || imageBuffers.length === 0) {
      throw new Error('extractFromMultipleImages: imageBuffers must be a non-empty array');
    }

    const skipPanorama = Boolean(opts && opts.skipPanorama);
    const pipelineSalt = Buffer.from(
      skipPanorama ? 'multiocr-ffmpeg-perframe-v7' : 'multiocr-panorama-gemini-primary-v6',
      'utf8'
    );

    // Cache key spans ALL frames so an exact re-scan hits cache.
    // Pipeline-salt suffix busts stale ocr_cache rows when post-merge
    // heuristics change (same pixels → new extraction).
    const combinedHash = crypto
      .createHash('sha256')
      .update(
        Buffer.concat([
          ...imageBuffers.map(b => crypto.createHash('sha256').update(b).digest()),
          pipelineSalt,
        ])
      )
      .digest('hex');

    const cached = await this.checkCache(combinedHash);
    if (cached) {
      console.log(`📦 [MULTI-OCR] Cache hit (${imageBuffers.length} frames)`);
      return {
        ingredientsList: cached.ingredientsList || [],
        rawIngredientsText: cached.rawIngredientsText || '',
        isComplete: true,
        confidence: 0.95,
        missingSection: null,
        notes: 'cached',
        imageCount: imageBuffers.length,
      };
    }

    // No Vision key → fall back to the legacy Gemini-per-frame
    // pipeline so local dev / staging without GCP setup still works.
    if (!cloudVisionService.isAvailable()) {
      console.warn(
        '[MULTI-OCR] Cloud Vision key missing — falling back to Gemini per-frame OCR'
      );
      return this._extractFromMultipleImagesGeminiOnly(imageBuffers, mimeType, combinedHash);
    }

    const ingredientAnalyzer = require('./ingredientAnalyzer');

    if (!skipPanorama) {
      // ── STAGE 1 (preferred): center-strip panorama → single Vision OCR ─
      const { buildStripPanoramaFromFrames } = require('./labelPanoramaService');

      let panoramaBuffer = null;
      let panMeta = null;
      try {
        const pan = await buildStripPanoramaFromFrames(imageBuffers);
        panoramaBuffer = pan.buffer;
        panMeta = pan.meta;
        console.log(
          `🖼️  [MULTI-OCR] Strip panorama ${panMeta.width}x${panMeta.height}px (${panoramaBuffer.length} bytes)`
        );
        try {
          const dbg = await imageService.savePanoramaDebug(panoramaBuffer, {
            cacheHashShort: combinedHash,
            width: panMeta.width,
            height: panMeta.height,
          });
          if (dbg.publicUrl) console.log(`🗂️  [Panorama] R2: ${dbg.publicUrl}`);
        } catch (dbgErr) {
          console.warn(`[Panorama] save failed: ${dbgErr.message}`);
        }
      } catch (panErr) {
        console.warn(`[MULTI-OCR] Strip panorama build skipped: ${panErr.message}`);
      }

      if (panoramaBuffer) {
        try {
          let panTrim = '';
          const tHay = Date.now();
          try {
            const { rawText: panRawFull } = await cloudVisionService.detectDocumentText(panoramaBuffer, {
              languageHints: ['en'],
            });
            panTrim = String(panRawFull || '').trim();
            console.log(
              `👁️  [MULTI-OCR] Panorama Vision haystack: ${panTrim.length} chars in ${Date.now() - tHay}ms`
            );
            if (panTrim.length > 0) {
              const panLogChunk = 8000;
              const panLen = panTrim.length;
              const panParts = Math.max(1, Math.ceil(panLen / panLogChunk));
              console.log(
                `[MULTI-OCR] Panorama Vision haystack FULL len=${panLen} — ${panParts} log chunk(s)`
              );
              for (let off = 0, part = 1; off < panLen; off += panLogChunk, part++) {
                const end = Math.min(off + panLogChunk, panLen);
                console.log(
                  `[MULTI-OCR] Panorama Vision haystack part ${part}/${panParts} [char ${off}..${end}):\n${panTrim.slice(off, end)}`
                );
              }
            }
          } catch (hayErr) {
            console.warn(`[MULTI-OCR] Panorama Vision haystack failed: ${hayErr.message}`);
          }

          const minChars = Math.max(120, imageBuffers.length * 40);
          const tGem = Date.now();
          try {
            const gemPan = await this._extractIngredientsFromPanoramaImage(
              panoramaBuffer,
              mimeType,
              imageBuffers.length
            );
            const gList = gemPan.ingredientsList || [];
            let gemUnderSplit = false;
            if (gList.length >= 3 && panTrim.length >= 50) {
              const narrative = ingredientAnalyzer.sliceIngredientNarrativeFromRaw(panTrim);
              const blob = (narrative || '').trim() || panTrim;
              const outerSep = this._countOuterCommaSeparators(blob);
              if (outerSep >= 14 && gList.length <= Math.min(12, outerSep - 4)) {
                gemUnderSplit = true;
                console.warn(
                  `[MULTI-OCR] Panorama Gemini likely under-split (${gList.length} items vs ${outerSep} outer commas in declaration) — Vision+text merge`
                );
              }
            }
            if (gList.length >= 3 && !gemUnderSplit) {
              let recovered = gList;
              if (panTrim.length >= 50) {
                recovered = this._reconcileListParenFromRaw(panTrim, recovered);
              }
              recovered = ingredientAnalyzer.postProcessExtractedIngredientList(recovered);
              const mergedOutPan = {
                ...gemPan,
                ingredientsList: recovered,
                rawIngredientsText: recovered.join(', '),
              };
              await this.cacheResult(combinedHash, {
                rawIngredientsText: mergedOutPan.rawIngredientsText,
                ingredientsList: mergedOutPan.ingredientsList,
              });
              const preVitPan = recovered.some(s =>
                /^\s*(?:vitamins?|itamins)\s*\(/i.test(String(s))
              );
              console.log(
                `✅ [MULTI-OCR] panorama Gemini image primary: n=${mergedOutPan.ingredientsList.length} ` +
                  `mergeVitaminsLine=${preVitPan} in ${Date.now() - tGem}ms, ` +
                  `confidence=${mergedOutPan.confidence.toFixed(2)}, complete=${mergedOutPan.isComplete}, ` +
                  `missing=${mergedOutPan.missingSection || 'none'}`
              );
              return { ...mergedOutPan, imageCount: imageBuffers.length };
            }
            if (!gemUnderSplit) {
              console.warn(
                `[MULTI-OCR] Panorama Gemini image too few items (${gList.length}); Vision text-merge fallback`
              );
            }
          } catch (gemErr) {
            console.warn(
              `[MULTI-OCR] Panorama Gemini image failed: ${gemErr.message} — Vision text-merge fallback`
            );
          }

          if (panTrim.length >= minChars) {
            const narrative = ingredientAnalyzer.sliceIngredientNarrativeFromRaw(panTrim);
            const textForMerge = narrative.length >= 80 ? narrative : panTrim;
            if (textForMerge.length < panTrim.length) {
              console.log(
                `[MULTI-OCR] Panorama merge input: focused ${textForMerge.length} chars (Vision ${panTrim.length})`
              );
            }
            const mergedPan = await this._mergeRawTextWithGemini(
              [{ frameIndex: 1, rawText: textForMerge }],
              imageBuffers.length
            );
            const preListPan = mergedPan.ingredientsList || [];
            const preVitPan = preListPan.some(s =>
              /^\s*(?:vitamins?|itamins)\s*\(/i.test(String(s))
            );
            console.log(
              `[MULTI-OCR] Stage2 (panorama Vision text fallback): n=${preListPan.length} mergeVitaminsLine=${preVitPan}`
            );

            const haystackPan = panTrim;
            let recoveredPan = mergedPan.ingredientsList || [];
            recoveredPan = this._reconcileListParenFromRaw(haystackPan, recoveredPan);
            recoveredPan = ingredientAnalyzer.postProcessExtractedIngredientList(recoveredPan);
            const mergedOutPan = {
              ...mergedPan,
              ingredientsList: recoveredPan,
              rawIngredientsText: recoveredPan.join(', '),
            };

            await this.cacheResult(combinedHash, {
              rawIngredientsText: mergedOutPan.rawIngredientsText,
              ingredientsList: mergedOutPan.ingredientsList,
            });

            console.log(
              `✅ [MULTI-OCR] panorama Vision+text path ${mergedOutPan.ingredientsList.length} ingredients, ` +
                `confidence=${mergedOutPan.confidence.toFixed(2)}, complete=${mergedOutPan.isComplete}, ` +
                `missing=${mergedOutPan.missingSection || 'none'}`
            );

            return { ...mergedOutPan, imageCount: imageBuffers.length };
          }
          console.warn(
            `[MULTI-OCR] Panorama haystack too short (${panTrim.length} < ${minChars}) — per-frame Vision fallback`
          );
        } catch (visErr) {
          console.warn(`[MULTI-OCR] Panorama branch failed: ${visErr.message} — per-frame fallback`);
        }
      }
    } else {
      console.log('[MULTI-OCR] skipPanorama — per-frame Vision + text merge only (opt-in)');
    }

    // ── STAGE 1 (fallback): Cloud Vision per-frame OCR (parallel) ────
    console.log(
      `👁️  [MULTI-OCR] Stage 1: Cloud Vision OCR for ${imageBuffers.length} frames`
    );
    const t0 = Date.now();
    const frames = await Promise.all(
      imageBuffers.map((buf, i) =>
        cloudVisionService
          .detectDocumentText(buf, { languageHints: ['en'] })
          .then(({ rawText }) => ({
            frameIndex: i + 1,
            rawText: rawText.trim(),
          }))
          .catch(err => {
            // One bad frame (network blip, transient 5xx) shouldn't
            // tank the burst. Drop it; Stage 2 still works with the
            // surviving frames and the missing coverage shows up in
            // the final confidence.
            console.warn(`[MULTI-OCR] Frame ${i + 1} Vision OCR failed: ${err.message}`);
            return { frameIndex: i + 1, rawText: '' };
          })
      )
    );
    console.log(`👁️  [MULTI-OCR] Stage 1 done in ${Date.now() - t0}ms`);

    // Log Vision OCR per frame (fixed preview cap — no env toggles).
    const visionRawPreviewChars = 2500;
    const sortedForLog = this._sortFramesByCaptureOrder(frames);
    for (const f of sortedForLog) {
      const raw = f.rawText || '';
      if (!raw.length) {
        console.log(`👁️  [MULTI-OCR] Vision raw frame ${f.frameIndex} len=0 (empty)`);
        continue;
      }
      const oneLine = raw.replace(/\s+/g, ' ').trim();
      const clipped =
        oneLine.length > visionRawPreviewChars
          ? `${oneLine.slice(0, visionRawPreviewChars)} …[+${
              oneLine.length - visionRawPreviewChars
            } more chars]`
          : oneLine;
      console.log(`👁️  [MULTI-OCR] Vision raw frame ${f.frameIndex} len=${raw.length}: ${clipped}`);
    }

    const usableFrames = this._sortFramesByCaptureOrder(frames.filter(f => f.rawText.length > 0));
    if (usableFrames.length === 0) {
      console.warn('[MULTI-OCR] No frames yielded any text');
      return {
        ingredientsList: [],
        rawIngredientsText: '',
        isComplete: false,
        confidence: 0,
        missingSection: null,
        notes: 'no_text_visible',
        imageCount: imageBuffers.length,
      };
    }

    // ── STAGE 2: Gemini text merge ─────────────────────────────────
    console.log(
      `🧩 [MULTI-OCR] Stage 2: Gemini merge of ${usableFrames.length}/${imageBuffers.length} frame texts`
    );
    const merged = await this._mergeRawTextWithGemini(usableFrames, imageBuffers.length);
    const preList = merged.ingredientsList || [];
    const preVit = preList.some(s => /^\s*(?:vitamins?|itamins)\s*\(/i.test(String(s)));
    console.log(
      `[MULTI-OCR] Stage2 merge only: n=${preList.length} mergeVitaminsLine=${preVit}`
    );

    const haystack = stitchSequentialFrameTexts(usableFrames);
    let recoveredList = merged.ingredientsList || [];
    recoveredList = this._reconcileListParenFromRaw(haystack, recoveredList);
    recoveredList = ingredientAnalyzer.postProcessExtractedIngredientList(recoveredList);
    const mergedOut = {
      ...merged,
      ingredientsList: recoveredList,
      rawIngredientsText: recoveredList.join(', '),
    };

    await this.cacheResult(combinedHash, {
      rawIngredientsText: mergedOut.rawIngredientsText,
      ingredientsList: mergedOut.ingredientsList,
    });

    console.log(
      `✅ [MULTI-OCR] ${mergedOut.ingredientsList.length} ingredients, ` +
      `confidence=${mergedOut.confidence.toFixed(2)}, complete=${mergedOut.isComplete}, ` +
      `missing=${mergedOut.missingSection || 'none'}`
    );

    return { ...mergedOut, imageCount: imageBuffers.length };
  }

  /**
   * Legacy fallback path: Gemini-only per-frame + merge. Used when
   * GOOGLE_CLOUD_VISION_API_KEY is missing (local dev without GCP).
   * Keeps the public contract of extractFromMultipleImages stable so
   * the route handler doesn't need to branch on env config.
   */
  async _extractFromMultipleImagesGeminiOnly(imageBuffers, mimeType, combinedHash) {
    console.log(`🤖 [MULTI-OCR] Stage 1 (Gemini fallback): per-frame OCR for ${imageBuffers.length} frames`);
    const frames = await Promise.all(
      imageBuffers.map((buf, i) =>
        this._extractFrameForMerge(buf, mimeType, i + 1).catch(err => {
          console.warn(`[MULTI-OCR] Frame ${i + 1} Gemini OCR failed: ${err.message}`);
          return { frameIndex: i + 1, ingredients: [], hasStartAnchor: false };
        })
      )
    );

    const usableFrames = this._sortFramesByCaptureOrder(frames.filter(f => f.ingredients.length > 0));
    if (usableFrames.length === 0) {
      return {
        ingredientsList: [],
        rawIngredientsText: '',
        isComplete: false,
        confidence: 0,
        missingSection: null,
        notes: 'no_ingredients_visible',
        imageCount: imageBuffers.length,
      };
    }

    console.log(
      `🧩 [MULTI-OCR] Stage 2 (Gemini fallback): merging ${usableFrames.length}/${imageBuffers.length} frame results`
    );
    const merged = await this._mergeFramesWithGemini(usableFrames, imageBuffers.length);
    const preList = merged.ingredientsList || [];
    const preVit = preList.some(s => /^\s*(?:vitamins?|itamins)\s*\(/i.test(String(s)));
    console.log(
      `[MULTI-OCR] Stage2 (Gemini fallback) merge only: n=${preList.length} mergeVitaminsLine=${preVit}`
    );

    const haystack = usableFrames.map(f => (Array.isArray(f.ingredients) ? f.ingredients : []).join('\n')).join('\n\n');
    const ingredientAnalyzer = require('./ingredientAnalyzer');
    let recoveredList = merged.ingredientsList || [];
    recoveredList = this._reconcileListParenFromRaw(haystack, recoveredList);
    recoveredList = ingredientAnalyzer.postProcessExtractedIngredientList(recoveredList);
    const mergedOut = {
      ...merged,
      ingredientsList: recoveredList,
      rawIngredientsText: recoveredList.join(', '),
    };

    await this.cacheResult(combinedHash, {
      rawIngredientsText: mergedOut.rawIngredientsText,
      ingredientsList: mergedOut.ingredientsList,
    });

    return { ...mergedOut, imageCount: imageBuffers.length };
  }

  /**
   * Stage-1 helper: OCR a single frame for the merge pipeline.
   * Returns just enough for the text merger — the ordered partial list
   * and a flag for whether the "Ingredients:" header / first protein
   * is visible in this frame (used as the start anchor in Stage 2).
   *
   * Deliberately does NOT use `extractFromImage`: that helper is shaped
   * for a one-shot back-label scan with brand inference / disclaimer
   * filtering / package-shape detection — none of which we want here.
   */
  async _extractFrameForMerge(imageBuffer, mimeType, frameIndex) {
    const prompt = `Photo #${frameIndex} of a product label. Read only the text that belongs to the ingredient declaration under "Ingredients:" (or the same idea in another language) visible in this image. Split that into separate ingredients as printed and analyze.

Return ONLY this JSON (no prose, no code fences):
{
  "ingredients":     ["...", "...", ...],
  "has_start_anchor": true | false,
  "start_anchor":    "ingredients_header" | "first_protein" | null
}

If the literal "Ingredients:" header is visible, set has_start_anchor true and start_anchor "ingredients_header". Else if the start of that list is visible, has_start_anchor true and start_anchor "first_protein". Else has_start_anchor false, start_anchor null. If nothing from that section is visible, ingredients [].`;

    const parts = [
      { inlineData: { mimeType, data: imageBuffer.toString('base64') } },
      { text: prompt },
    ];

    const result = await this.model.generateContent({
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature: 0.0, candidateCount: 1 },
    });

    const text = this._extractFirstText(result?.response);
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { frameIndex, ingredients: [], hasStartAnchor: false, startAnchor: null };
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      return { frameIndex, ingredients: [], hasStartAnchor: false, startAnchor: null };
    }

    const ingredients = (Array.isArray(parsed.ingredients) ? parsed.ingredients : [])
      .map(s => String(s || '').trim().replace(/[.,;:]+$/, '').trim())
      .filter(Boolean);

    return {
      frameIndex,
      ingredients,
      hasStartAnchor: Boolean(parsed.has_start_anchor),
      startAnchor:
        parsed.start_anchor === 'ingredients_header' || parsed.start_anchor === 'first_protein'
          ? parsed.start_anchor
          : null,
    };
  }

  /** @returns {number} index of closing ')' that balances openParenIdx, or -1 */
  _closingParenIndex(haystack, openParenIdx) {
    let depth = 0;
    for (let i = openParenIdx; i < haystack.length; i++) {
      const c = haystack[i];
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  /** First top-level "( … )" in a single line (merge output), or null. */
  _firstBalancedParenSpanInLine(line) {
    const s = String(line || '');
    const open = s.indexOf('(');
    if (open <= 0) return null;
    const close = this._closingParenIndex(s, open);
    if (close === -1 || close <= open) return null;
    return { open, close, inner: s.slice(open + 1, close) };
  }

  /** Tokens for overlap (letters/digits; min length 2). */
  _overlapTokens(s) {
    return String(s || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(w => w.length >= 2);
  }

  /** Index after ")" that precedes openIdx with no "(" or ")" in the gap (start of next surface ingredient). */
  _gapStartAfterPrevCloseParen(raw, openIdx) {
    for (let i = openIdx - 1; i >= 0; i--) {
      if (raw[i] !== ')') continue;
      const gap = raw.slice(i + 1, openIdx);
      if (!/[\(\)]/.test(gap)) return i + 1;
    }
    return -1;
  }

  /** Last comma/semicolon before openIdx at parenthesis depth 0 (ignores commas inside nested "(...)"). */
  _lastTopLevelCommaBefore(raw, openIdx) {
    let depth = 0;
    for (let i = openIdx - 1; i >= 0; i--) {
      const c = raw[i];
      if (c === ')') depth++;
      else if (c === '(') depth--;
      else if ((c === ',' || c === ';') && depth === 0) return i;
    }
    return -1;
  }

  /**
   * Start index in raw for the header immediately preceding `openIdx` '('.
   * Uses depth-0 commas, else tail-word trim when many tokens lack commas,
   * else a short character walkback.
   */
  _headerStartBeforeParen(raw, openIdx) {
    const before = raw.slice(0, openIdx);
    const lastComma = this._lastTopLevelCommaBefore(raw, openIdx);
    if (lastComma >= 0) {
      let s = lastComma + 1;
      while (s < openIdx && /\s/.test(raw[s])) s++;
      return s;
    }
    const trimmed = before.trimEnd();
    if (!trimmed.length) return openIdx;
    const words = trimmed.split(/\s+/);
    const head0 = (words[0] || '').toLowerCase();
    const longPhrase =
      /^(contains|including|less\s+than|added|with\s+added)\b/.test(head0) ||
      /^[\d.]+%?$/.test(head0);
    if (longPhrase || words.length <= 4) {
      const si = openIdx - trimmed.length;
      return si >= 0 ? si : 0;
    }
    const nTail = words.length >= 8 ? 5 : 3;
    const tail = words.slice(-nTail).join(' ');
    let idx = before.lastIndexOf(tail);
    if (idx < 0) {
      const ir = trimmed.indexOf(tail);
      idx = ir >= 0 ? openIdx - trimmed.length + ir : -1;
    }
    if (idx < 0) {
      let start = openIdx;
      let steps = 0;
      const maxHeaderChars = 56;
      while (start > 0 && steps < maxHeaderChars) {
        const c = raw[start - 1];
        if (c === '\n' || c === '\r') break;
        if (c === ',' || c === ';') break;
        if (/[A-Za-z0-9'\-.]/.test(c) || c === ' ') {
          start -= 1;
          steps++;
        } else break;
      }
      return start;
    }
    return Math.max(0, idx);
  }

  /** Enumerate balanced "(…)" spans in Vision haystack with safe header bounds. */
  _listHaystackParenSpans(rawS) {
    const raw = String(rawS || '');
    const out = [];
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] !== '(') continue;
      const close = this._closingParenIndex(raw, i);
      if (close === -1) continue;
      let start = this._headerStartBeforeParen(raw, i);
      const afterClose = this._gapStartAfterPrevCloseParen(raw, i);
      if (afterClose >= 0) start = Math.max(start, afterClose);
      while (start < raw.length && /\s/.test(raw[start])) start++;
      const inner = raw.slice(i + 1, close).replace(/\s+/g, ' ').trim();
      const full = raw.slice(start, close + 1).replace(/\s+/g, ' ').trim();
      if (full.length >= 10 && full.length <= 2200 && inner.length >= 3) out.push({ full, inner });
    }
    return out;
  }

  /**
   * When merge drops a header ("Modified …"), drops "Roasted …", or omits
   * parentheses entirely, snap to a haystack span whose INNER token set
   * matches the merge line (Jaccard / coverage). No product names — only
   * structure + token overlap against the same Vision dump.
   */
  _reconcileLineByParenInnerOverlap(rawS, line) {
    const L = String(line || '').trim();
    if (!rawS || rawS.length < 40 || !L) return L;
    const spans = this._listHaystackParenSpans(rawS);
    if (!spans.length) return L;

    const spanL = this._firstBalancedParenSpanInLine(L);
    const innerL = spanL ? spanL.inner : null;
    const toksL = new Set(this._overlapTokens(innerL || L));
    if (toksL.size < 2) return L;

    let best = null;
    let bestAdj = -1;

    for (const { full, inner } of spans) {
      const toksI = new Set(this._overlapTokens(inner));
      const toksF = new Set(this._overlapTokens(full));
      if (toksI.size < 2) continue;

      let score = 0;
      if (innerL) {
        const a = new Set(this._overlapTokens(innerL));
        const b = toksI;
        let inter = 0;
        for (const x of a) if (b.has(x)) inter++;
        const uni = new Set([...a, ...b]).size;
        score = uni ? inter / uni : 0;
        if (score < 0.56) continue;
      } else {
        if (toksL.size < 4) continue;
        let interI = 0;
        for (const x of toksI) if (toksL.has(x)) interI++;
        const coverI = toksI.size ? interI / toksI.size : 0;
        let interF = 0;
        for (const x of toksL) if (toksF.has(x)) interF++;
        const coverF = toksL.size ? interF / toksL.size : 0;
        score = Math.min(coverI, coverF) * 0.55 + Math.max(coverI, coverF) * 0.45;
        if (score < 0.74) continue;
      }

      const lenPen = full.replace(/\s+/g, ' ').length * 0.00012;
      const adj = score - lenPen;
      if (adj > bestAdj) {
        bestAdj = adj;
        best = full;
      }
    }

    if (!best) return L;
    if (!this._reconcileHaystackSwapPassesSanity(L, best)) return L;
    const nL = L.replace(/\s+/g, ' ').toLowerCase();
    const nB = best.replace(/\s+/g, ' ').toLowerCase();
    if (nB === nL) return L;
    if (L.includes('(') && best.length < L.length * 0.82) return L;
    return best.replace(/\s+/g, ' ').trim();
  }

  /**
   * Reject haystack replacements that are almost certainly multi-ingredient
   * OCR blobs or runaway repeats (would poison AI cache keys).
   */
  _reconcileHaystackSwapPassesSanity(line, candidate) {
    const L = String(line || '').trim();
    const B = String(candidate || '').trim();
    if (!L || !B) return false;
    const l = L.length;
    const b = B.length;
    if (b > 520) return false;
    if (b > Math.max(220, l * 2.0 + 80)) return false;
    if (l > 140 && b > l + 100) return false;
    const wc = B.split(/\s+/).filter(Boolean).length;
    if (wc > 44) return false;
    const compact = B.replace(/\s+/g, ' ');
    if (/(.{14,42})\1\1/i.test(compact)) return false;
    const opens = (B.match(/\(/g) || []).length;
    if (opens > 3) return false;
    return true;
  }

  /**
   * Snap a parenthetical line to the literal balanced "(…)" span found in
   * raw OCR / rawIngredientsText so dropped prefixes (MODIFIED …) or
   * invented inner tokens (, WATER) can be corrected when the source text
   * still contains the true span.
   */
  _reconcileParenLineFromRaw(rawOrHaystack, line) {
    const trimmed = String(line || '').trim();
    const rawS = String(rawOrHaystack || '');
    if (rawS.length < 40) return this._reconcileLineByParenInnerOverlap(rawS, trimmed);

    let out = trimmed;
    const open = trimmed.indexOf('(');
    if (open > 0 && trimmed.lastIndexOf(')') > open) {
      const words = trimmed
        .slice(0, open)
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      if (words.length) {
        outer: for (let take = words.length; take >= 1; take -= 1) {
          const h = words.slice(-take).join(' ');
          if (h.length < 3) continue;
          const esc = h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const re = new RegExp(esc + '\\s*\\(', 'gi');
          let m;
          while ((m = re.exec(rawS)) !== null) {
            const openIdx = m.index + m[0].length - 1;
            if (rawS[openIdx] !== '(') continue;
            let start = this._headerStartBeforeParen(rawS, openIdx);
            const afterClose = this._gapStartAfterPrevCloseParen(rawS, openIdx);
            if (afterClose >= 0) start = Math.max(start, afterClose);
            while (start < rawS.length && /\s/.test(rawS[start])) start++;
            const closeIdx = this._closingParenIndex(rawS, openIdx);
            if (closeIdx === -1) continue;
            const candidate = rawS
              .slice(start, closeIdx + 1)
              .replace(/\s+/g, ' ')
              .trim();
            if (candidate.length < 8 || candidate.length > 2200) continue;
            if (!this._reconcileHaystackSwapPassesSanity(trimmed, candidate)) continue;
            const nC = candidate.replace(/\s+/g, ' ').toLowerCase();
            const nT = trimmed.replace(/\s+/g, ' ').toLowerCase();
            if (nC === nT) continue;
            const ratio = candidate.length / Math.max(trimmed.length, 1);
            if (ratio > 1.45 && take < words.length) continue;
            if (ratio > 1.55) continue;
            out = candidate;
            break outer;
          }
        }
      }
    }

    return this._reconcileLineByParenInnerOverlap(rawS, out);
  }

  _reconcileListParenFromRaw(rawOrHaystack, list) {
    if (!Array.isArray(list) || list.length === 0) return list;
    const hay = String(rawOrHaystack || '');
    if (hay.length < 50) return list;
    return list.map(line => this._reconcileParenLineFromRaw(hay, line));
  }

  /** Stable capture order for Stage 1 → Stage 2 handoff. */
  _sortFramesByCaptureOrder(frames) {
    if (!Array.isArray(frames)) return [];
    return frames.slice().sort((a, b) => (a.frameIndex || 0) - (b.frameIndex || 0));
  }

  /**
   * Commas/semicolons at paren depth 0 — rough lower bound on how many
   * top-level ingredient breaks the printed declaration has (FDA-style).
   */
  _countOuterCommaSeparators(text) {
    const t = String(text || '');
    let depth = 0;
    let n = 0;
    for (let i = 0; i < t.length; i++) {
      const ch = t[i];
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
      else if ((ch === ',' || ch === ';') && depth === 0) n++;
    }
    return n;
  }

  /**
   * Regex-only tags prepended to each Vision OCR dump. Helps Gemini
   * separate regulatory tables from the ingredient narrative before merging.
   */
  _structuralOcrHintsForMerge(rawText) {
    const t = String(rawText || '');
    if (!t.trim()) return '';
    const tags = [];
    if (/\bIngredients?\s*:/i.test(t)) tags.push('ingredients_header');
    if (/\bComposition\s*:/i.test(t)) tags.push('composition_header');
    if (/\bGuaranteed\s+Analysis\b/i.test(t)) tags.push('guaranteed_analysis');
    if (/\bAnalytical\s+(?:constituents|components)\b/i.test(t)) tags.push('analytical_table');
    if (/\bTypical\s+Analysis\b/i.test(t)) tags.push('typical_analysis');
    if (/\bCalorie\s+Content\b/i.test(t)) tags.push('calorie_content');
    if (/\bNutritional\s+Additives\b/i.test(t)) tags.push('nutritional_additives');
    if (/\bCrude\s+(?:Protein|Fat|Fiber)\b/i.test(t)) tags.push('crude_nutrient_tokens');
    if (/\bMoisture\b.*(?:%|\bmin\b|\bmax\b)/i.test(t)) tags.push('moisture_percent_pattern');
    return tags.length > 0 ? `[merge_hints: ${tags.join(', ')}]\n` : '';
  }

  /**
   * Stage-2 helper for the Cloud-Vision pipeline: take the raw text
   * blocks Cloud Vision extracted from each rotated frame and turn
   * them into one ordered, deduped ingredient list.
   *
   * Frames are first stitched deterministically (suffix/prefix overlap
   * in capture order) into one reading-ordered document so the LLM
   * reasons about order the same way a human reads one continuous blob,
   * instead of juggling dozens of independent OCR blocks.
   */
  async _mergeRawTextWithGemini(frames, totalFrameCount) {
    const sorted = frames.slice().sort((a, b) => (a.frameIndex || 0) - (b.frameIndex || 0));
    const stitchedRaw = stitchSequentialFrameTexts(sorted);
    const stitched = truncateForMerge(stitchedRaw);
    const hint = this._structuralOcrHintsForMerge(stitched);

    // Full stitched OCR (what Gemini receives as the document body, modulo truncateForMerge).
    const stitchTotalLogChunk = 8000;
    const rawLen = stitchedRaw.length;
    const parts = Math.max(1, Math.ceil(rawLen / stitchTotalLogChunk));
    console.log(
      `[MULTI-OCR] stitched TOTAL raw (pre-Gemini) len=${rawLen} from ${sorted.length}/${totalFrameCount} frames — ${parts} log chunk(s)`
    );
    for (let off = 0, part = 1; off < rawLen; off += stitchTotalLogChunk, part++) {
      const end = Math.min(off + stitchTotalLogChunk, rawLen);
      console.log(
        `[MULTI-OCR] stitched TOTAL part ${part}/${parts} [char offset ${off}..${end}):\n${stitchedRaw.slice(off, end)}`
      );
    }
    if (stitched.length < stitchedRaw.length) {
      console.log(
        `[MULTI-OCR] stitched prompt body was truncated for model: ${stitched.length} of ${rawLen} chars (see truncateForMerge cap)`
      );
    }

    const prompt = `You receive ONE OCR document for a single product label. It was built by joining consecutive photos taken while the package was rotated: overlap at seams was merged algorithmically, so the character order is already the natural reading order around the package (not alphabetized, not shuffled).

Your tasks:
1) Keep ONLY the ingredient declaration (typically after "Ingredients:" or the same idea in another language). Drop nutrition tables, marketing copy, barcodes, and unrelated blocks.
2) Split that declaration into discrete ingredients exactly as a regulator-style comma/parenthesis list would be read — one JSON string per top-level ingredient as printed (commas at parenthesis depth 0 separate items). Do NOT merge multiple printed ingredients into one long run-on string to shorten the list.
3) ORDER (critical): the JSON "ingredients" array MUST follow the declaration order in THIS DOCUMENT from first token to last. Never alphabetize, never group by category, never reorder by importance. If noise makes order ambiguous, lower "confidence" instead of guessing a reorder.
4) Prefer fidelity to this noisy OCR over inventing cleaner text: do not add ingredients, spellings, or order that are not grounded in the document string; when the source is ambiguous, lower "confidence" and explain briefly in "notes" instead of guessing.

${hint}"""
${stitched}
"""

Return ONLY this JSON (no prose, no code fences):
{
  "ingredients":      ["...", "...", ...],
  "is_complete":      true | false,
  "confidence":       0.0,
  "missing_section":  "start" | "middle" | "end" | null,
  "notes":            "brief"
}`;

    const result = await this.model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.0,
        candidateCount: 1,
        maxOutputTokens: 8192,
      },
    });

    const text = this._extractFirstText(result?.response);
    return this._parseMultiImageResponse(text);
  }

  /**
   * Stage-2 helper for the legacy Gemini-only fallback pipeline:
   * merge the per-frame partial lists into one ordered list using a
   * text-only Gemini call. No images involved — Gemini's text
   * reasoning is much stronger than its multi-image spatial
   * reasoning, which is the whole point of the split.
   */
  async _mergeFramesWithGemini(frames, totalFrameCount) {
    const framesBlock = frames
      .map(f => {
        const anchorTag = f.hasStartAnchor
          ? ` [START ANCHOR: ${f.startAnchor || 'visible'}]`
          : '';
        const list = f.ingredients.map((ing, i) => `    ${i + 1}. ${ing}`).join('\n');
        return `Photo ${f.frameIndex}${anchorTag}:\n${list}`;
      })
      .join('\n\n');

    const prompt = `Below are partial ingredient lists from ${frames.length} photos (${totalFrameCount} photos total) of one product label. Use only what belongs to the text under "Ingredients:" (or the same idea in another language). Read that and merge into one ordered ingredient list.

Preserve declaration order as printed around the package (photo numbers increase in capture order). Do not alphabetize. If segments conflict, lower confidence instead of inventing a new order.

${framesBlock}

Return ONLY this JSON (no prose, no code fences):
{
  "ingredients":      ["...", "...", ...],
  "is_complete":      true | false,
  "confidence":       0.0,
  "missing_section":  "start" | "middle" | "end" | null,
  "notes":            "brief"
}`;

    const result = await this.model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.0,
        candidateCount: 1,
        maxOutputTokens: 8192,
      },
    });

    const text = this._extractFirstText(result?.response);
    return this._parseMultiImageResponse(text);
  }

  /**
   * Legacy one-shot multi-image OCR. Kept for the rare case where the
   * two-stage pipeline above fails completely (e.g. all per-frame
   * calls error out). Not currently wired in — left here as a fallback
   * we can reach for if telemetry shows the new pipeline regressing.
   */
  async _extractFromMultipleImagesOneShot(imageBuffers, mimeType = 'image/jpeg') {
    this.initialize();
    if (!this.model) throw new Error('Gemini AI not initialized. Check API key.');
    if (!Array.isArray(imageBuffers) || imageBuffers.length === 0) {
      throw new Error('extractFromMultipleImages: imageBuffers must be a non-empty array');
    }

    // Cache key includes ALL buffers so two scans of the same can with the
    // same captured frames hit cache. Multi-image cache hits are rare in
    // practice but cheap to support.
    const combinedHash = crypto
      .createHash('sha256')
      .update(
        Buffer.concat([
          ...imageBuffers.map(b => crypto.createHash('sha256').update(b).digest()),
          Buffer.from('multiocr-panorama-gemini-primary-v6', 'utf8'),
        ])
      )
      .digest('hex');

    const cached = await this.checkCache(combinedHash);
    if (cached) {
      console.log(`📦 [MULTI-OCR] Cache hit (${imageBuffers.length} frames)`);
      return {
        ingredientsList: cached.ingredientsList || [],
        rawIngredientsText: cached.rawIngredientsText || '',
        isComplete: true,
        confidence: 0.95,
        missingSection: null,
        notes: 'cached',
        imageCount: imageBuffers.length,
      };
    }

    const imageParts = imageBuffers.map(buf => ({
      inlineData: {
        mimeType,
        data: buf.toString('base64'),
      },
    }));

    // Two attempts with two phrasings of the same task. Pet-food labels
    // are widely indexed online, so Gemini often blocks the first
    // attempt with `RECITATION` (the model thinks its output mirrors
    // its training data too closely). The retry rewords the schema and
    // de-emphasizes "verbatim" copy so the response is structurally
    // different enough to slip past the recitation filter.
    const attempts = [
      this._buildMultiImagePrompt(imageBuffers.length),
      this._buildMultiImagePromptAlt(imageBuffers.length),
    ];

    let lastError = null;
    for (let i = 0; i < attempts.length; i += 1) {
      const promptText = attempts[i];
      const parts = [...imageParts, { text: promptText }];

      try {
        console.log(
          `🤖 [MULTI-OCR] Sending ${imageBuffers.length} frames to Gemini` +
          (i > 0 ? ` (retry ${i} after RECITATION)` : '')
        );
        const result = await this.model.generateContent({
          contents: [{ role: 'user', parts }],
          generationConfig: {
            // Determinism matters more than diversity here:
            // - Order accuracy is fragile, and any sampling jitter
            //   produces a different sequence on re-scan of the same
            //   can (the user complaint we're optimising for).
            // - RECITATION is mitigated separately via the prompt
            //   itself + the alt-prompt retry path below, not via
            //   temperature.
            temperature: 0.0,
            candidateCount: 1,
          },
        });
        const text = this._extractFirstText(result?.response);
        const parsed = this._parseMultiImageResponse(text);

        await this.cacheResult(combinedHash, {
          rawIngredientsText: parsed.rawIngredientsText,
          ingredientsList: parsed.ingredientsList,
        });

        console.log(
          `✅ [MULTI-OCR] ${parsed.ingredientsList.length} ingredients, ` +
          `confidence=${parsed.confidence.toFixed(2)}, complete=${parsed.isComplete}, ` +
          `missing=${parsed.missingSection || 'none'}`
        );

        return { ...parsed, imageCount: imageBuffers.length };
      } catch (error) {
        lastError = error;
        const msg = String(error?.message || '');
        // Only retry on RECITATION — other errors (network, quota,
        // bad images) won't be helped by a different prompt.
        if (!msg.includes('RECITATION') || i >= attempts.length - 1) {
          break;
        }
        console.warn('[MULTI-OCR] RECITATION block, retrying with alt prompt');
      }
    }

    console.error('[MULTI-OCR] Gemini error:', lastError);
    throw new Error(`Multi-image OCR failed: ${lastError?.message || 'unknown'}`);
  }

  /**
   * Pull the text out of a Gemini response, tolerating cases where one
   * of the candidates was blocked (RECITATION / SAFETY) but another
   * succeeded. Throws if NO candidate yielded usable text — in which
   * case the caller will handle the retry.
   */
  _extractFirstText(response) {
    if (!response) throw new Error('Empty Gemini response');

    const candidates = response.candidates || [];
    for (const c of candidates) {
      const finish = c?.finishReason;
      // STOP / MAX_TOKENS are fine; RECITATION / SAFETY mean blocked.
      if (finish && finish !== 'STOP' && finish !== 'MAX_TOKENS') continue;
      const partsText = (c?.content?.parts || [])
        .map(p => p?.text || '')
        .join('')
        .trim();
      if (partsText) return partsText;
    }

    // Fall back to .text() — it throws on a fully blocked response,
    // surfacing the RECITATION error to the caller's catch block.
    return response.text();
  }

  /**
   * Build the multi-image extraction prompt.
   *
   * Kept as a private helper so the giant string template doesn't crowd
   * `extractFromMultipleImages`. We deliberately AVOID asking the model
   * to "copy verbatim" or to emit the original block of label text:
   * pet-food labels are widely indexed online, and Gemini's
   * recitation-detection filter blocks responses whose text overlaps
   * its training corpus too heavily (`finishReason: RECITATION`). The
   * structured JSON list of normalized ingredient names is far less
   * likely to trip that filter than a paragraph of label text.
   */
  _buildMultiImagePrompt(frameCount) {
    return `You have ${frameCount} photos of one product label. Read only the text that belongs to the ingredient declaration under "Ingredients:" (or the same idea in another language). Split that into separate ingredients as printed and return your analysis as JSON only (no other prose).

Return ONLY this JSON object (no prose, no code fences):
{
  "ingredients":      ["...", "...", ...],
  "is_complete":      true | false,
  "confidence":       0.0,
  "missing_section":  "start" | "middle" | "end" | null,
  "notes":            "brief"
}`;
  }

  /**
   * Alternate phrasing of `_buildMultiImagePrompt`, used as a retry
   * when the primary prompt trips Gemini's RECITATION filter. The
   * structure of the requested JSON is intentionally different (extra
   * `panel_only` flag, ingredient items wrapped in a "name" object)
   * so the model's output diverges enough from any memorised label
   * paragraph to escape the recitation match.
   */
  _buildMultiImagePromptAlt(frameCount) {
    return `You have ${frameCount} photos of one product label. Read only the text under "Ingredients:" (or equivalent). Split into separate ingredients as printed and return structured JSON only.

Return ONLY this JSON (no markdown, no commentary):
{
  "items": [ { "name": "..." }, { "name": "..." } ],
  "panel_only": true,
  "complete": true | false,
  "missing": "start" | "middle" | "end" | null,
  "score": 0.0,
  "note": "brief"
}

If nothing from that section is visible:
  { "items": [], "panel_only": true, "complete": false,
    "missing": null, "score": 0.0, "note": "<why>" }`;
  }

  /**
   * Single Gemini vision call on the stitched panorama (center-strip).
   * Primary path for multi-frame OCR when Cloud Vision is available; Vision
   * text is still used separately as a reconcile haystack. On failure the
   * caller falls back to Vision OCR + text merge.
   */
  async _extractIngredientsFromPanoramaImage(panoramaBuffer, mimeType, totalFrameCount) {
    const prompt = `This is one stitched image from ${totalFrameCount} photos of the same product label as the user rotated it.

Read ONLY the ingredient declaration (the paragraph after "Ingredients:" / "INGREDIENTS:" or the same idea in another language). Ignore Nutrition Facts, % Daily Value, serving sizes, storage/distribution lines, and recipe text.

SPLITTING (critical — under-splitting is a common failure mode):
- Emit ONE JSON array element per printed TOP-LEVEL ingredient, in the same order as on the label.
- A "top-level" ingredient ends at a comma (or semicolon) that is NOT inside nested parentheses or brackets. Example: WATER, CREAM, PARMESAN CHEESE (MILK, SALT), BUTTER (CREAM) → four array elements; inner commas stay inside the string for that element.
- Do NOT merge multiple top-level ingredients into one long run-on string (wrong: "egg yolk egg yolks salt sugar"; right: separate items like "EGG YOLK", "SALT", "SUGAR" when the label separates them with commas).
- Do NOT collapse the whole list into ~10 mega-lines to save space. Jarred sauces and pet foods often have 12–30+ top-level items; match the label granularity.
- When a header is immediately followed by "(" … ")" listing subparts, keep that whole header + balanced "(" … ")" span as ONE element (vitamin/mineral premix style).

ORDER: first ingredient on the label = first array element; never alphabetize.

Return ONLY this JSON (no markdown, no code fences):
{
  "ingredients": ["...", "..."],
  "is_complete": true,
  "confidence": 0.9,
  "missing_section": null,
  "notes": "brief"
}

Use missing_section: "start" | "middle" | "end" | null. is_complete and confidence 0.0–1.0 as you judge from the image. If the list clearly continues past the stitched frame edges, lower confidence and set missing_section.`;

    const imageBase64 = Buffer.from(panoramaBuffer).toString('base64');
    const result = await this.model.generateContent({
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: mimeType || 'image/jpeg', data: imageBase64 } },
            { text: prompt },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.0,
        candidateCount: 1,
        maxOutputTokens: 8192,
      },
    });
    const text = this._extractFirstText(result?.response);
    return this._parseMultiImageResponse(text);
  }

  /**
   * Parse the JSON shape produced by `_buildMultiImagePrompt` into the
   * camelCase contract used by the rest of the backend (`isComplete`, etc.)
   * Tolerates Gemini wrapping the JSON in prose or adding a leading "+".
   */
  _parseMultiImageResponse(text) {
    const fallback = {
      ingredientsList: [],
      rawIngredientsText: '',
      isComplete: false,
      confidence: 0,
      missingSection: null,
      notes: 'failed_to_parse',
    };

    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return fallback;

      const cleanedJson = jsonMatch[0].replace(/:\s*\+(\d)/g, ': $1');
      const parsed = JSON.parse(cleanedJson);

      // Accept BOTH the primary schema (`ingredients: [string]`) and the
      // alternate retry schema (`items: [{name: string}]`) so the
      // RECITATION-retry path needs no separate parser.
      let rawList = [];
      if (Array.isArray(parsed.ingredients)) {
        rawList = parsed.ingredients;
      } else if (Array.isArray(parsed.items)) {
        rawList = parsed.items.map(it => (typeof it === 'string' ? it : it?.name));
      }

      // Sanitize ingredients list: strip leading "Ingredients:" prefix on
      // index 0 (Gemini sometimes leaves it in) and drop empty strings.
      const ingredients = rawList
        .map((ing, i) => {
          let s = String(ing || '').trim();
          if (i === 0) s = s.replace(/^ingredients?:?\s*/i, '');
          return s.replace(/[.,;:]+$/, '').trim();
        })
        .filter(Boolean);

      const rawConfidence = Number(parsed.confidence ?? parsed.score);
      const confidence = Number.isFinite(rawConfidence)
        ? Math.max(0, Math.min(1, rawConfidence))
        : 0;

      const missingRaw = parsed.missing_section ?? parsed.missing;
      const missingSection =
        missingRaw === 'start' || missingRaw === 'middle' || missingRaw === 'end'
          ? missingRaw
          : null;

      const isComplete = Boolean(
        parsed.is_complete !== undefined ? parsed.is_complete : parsed.complete
      );

      return {
        ingredientsList: ingredients,
        // We no longer ask Gemini for a verbatim raw text block (it was a
        // recitation-trigger and nothing downstream actually used it).
        // Fall back to a join() so the cache shape stays stable.
        rawIngredientsText: ingredients.join(', '),
        isComplete,
        confidence,
        missingSection,
        notes: String(parsed.notes || parsed.note || ''),
      };
    } catch (e) {
      console.error('[MULTI-OCR] JSON parse error:', e.message);
      return fallback;
    }
  }

  /**
   * Normalize and parse ingredient text
   * Useful for manual input or cleaning up OCR results
   */
  async normalizeIngredients(rawText) {
    this.initialize();

    if (!this.model) {
      // Fallback to simple parsing without AI
      return this.simpleParseIngredients(rawText);
    }

    const prompt = `Parse this pet food ingredient list and return a clean, normalized array of ingredients.

INPUT TEXT:
${rawText}

Rules:
1. Split by commas, but keep compound names together (e.g., "chicken meal" stays together)
2. Remove parenthetical percentages like "(min 4%)"
3. Keep preservative information like "preserved with mixed tocopherols"
4. Normalize common variations:
   - "deboned chicken" → "chicken"
   - "chicken by-product meal" → "chicken by-product meal" (keep as is, it's different from chicken)
5. Remove marketing language but keep scientific names if present
6. Return in order of weight (as listed)
7. EXCLUDE non-ingredient text that often appears around the ingredient list:
   - Manufacturing/facility statements ("Manufactured in a facility...", "Made in the USA")
   - Standalone marketing/preservation sentences ("This is a naturally preserved product")
   - Allergen warnings ("May contain traces of...")
   - Guaranteed analysis, feeding instructions, storage, expiration, net weight
   - Any item that reads like a sentence (contains a verb like "is", "are", "may", "manufactured", "processed") is NOT an ingredient

Return ONLY a JSON array of strings, no explanation:
["ingredient1", "ingredient2", ...]`;

    try {
      const result = await this.model.generateContent(prompt);
      const text = result.response.text();
      
      // Extract JSON array from response
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      
      // Fallback to simple parsing
      return this.simpleParseIngredients(rawText);

    } catch (error) {
      console.error('Ingredient normalization error:', error);
      return this.simpleParseIngredients(rawText);
    }
  }

  /**
   * Get AI-powered explanation for an ingredient in pet food (universal healthy-pet baseline).
   * @param {unknown} _healthConditions ignored (call-site compatibility)
   */
  async explainIngredientRisk(ingredientName, petType, _healthConditions = []) {
    this.initialize();

    if (!this.model) {
      return null;
    }

    const prompt = `Explain briefly (2-3 sentences) how "${ingredientName}" is generally viewed in ${petType} food for a typical, healthy ${petType}. Do not personalize for diseases, allergies, or special diets.

Be factual and specific. If it is usually fine for healthy pets, say so. If it is sometimes controversial, describe the general concern.`;

    try {
      const result = await this.model.generateContent(prompt);
      return result.response.text().trim();
    } catch (error) {
      console.error('Explanation generation error:', error);
      return null;
    }
  }

  /**
   * Generate personalized analysis summary for a product + pet combination
   * This is the "AI-enhanced" result that provides natural language insights
   * 
   * @param {Object} product - Product data (name, brand, ingredients)
   * @param {Object} pet - Pet profile (name, type, conditions, allergies)
   * @param {Object} analysis - Rule-based analysis results (score, grade, warnings, positives)
   * @returns {Object} AI-generated personalized insights
   */
  async generatePersonalizedInsights(product, pet, analysis) {
    this.initialize();

    if (!this.model) {
      return this.generateFallbackInsights(product, pet, analysis);
    }

    // Build cache key for this combination
    const cacheKey = this.buildInsightsCacheKey(product.id, pet.id, analysis.finalScore);
    
    // Check memory cache (not DB, just for this session)
    if (this.insightsCache && this.insightsCache.has(cacheKey)) {
      return this.insightsCache.get(cacheKey);
    }

    const healthConditions = pet.healthConditions?.map(c => c.condition_type || c.conditionType) || [];
    const allergies = healthConditions.filter(c => c.startsWith('allergy_')).map(c => c.replace('allergy_', ''));
    const conditions = healthConditions.filter(c => !c.startsWith('allergy_'));

    const prompt = `You are a pet nutrition expert. Analyze this pet food for a specific pet and provide personalized insights.

## PRODUCT
Name: ${product.name}
Brand: ${product.brand || 'Unknown'}
Type: ${product.product_type || 'dry food'}
Target: ${product.target_pet_type || 'unknown'}
Ingredients: ${product.raw_ingredients_text || 'Not available'}

## PET PROFILE
Name: ${pet.name}
Type: ${pet.pet_type} (${pet.pet_type === 'cat' ? 'obligate carnivore - needs high protein, taurine essential' : 'omnivore - more flexible diet'})
Breed: ${pet.breed || 'Unknown'}
Age: ${pet.age_months ? Math.floor(pet.age_months / 12) + ' years' : 'Unknown'}
Weight: ${pet.weight_kg ? pet.weight_kg + ' kg' : 'Unknown'}
Activity Level: ${pet.activity_level || 'moderate'}
${allergies.length > 0 ? `Allergies: ${allergies.join(', ')}` : 'No known allergies'}
${conditions.length > 0 ? `Health Conditions: ${conditions.join(', ')}` : 'No health conditions'}

## RULE-BASED ANALYSIS (already calculated)
Score: ${analysis.finalScore}/100
Grade: ${analysis.grade}
Recommendation: ${analysis.recommendation}
Warnings: ${analysis.warnings?.length || 0}
Positives: ${analysis.positives?.length || 0}

## YOUR TASK
Generate a JSON response with personalized insights for ${pet.name}:

{
  "personalizedSummary": "2-3 sentence summary written directly to the pet owner, mentioning ${pet.name} by name. Be warm but factual.",
  "topConcerns": ["List 1-3 specific concerns for THIS pet, or empty if none"],
  "topBenefits": ["List 1-3 specific benefits for THIS pet"],
  "feedingTip": "One practical feeding tip specific to ${pet.name}'s profile (age, weight, conditions)",
  "alternativeAdvice": "If score is below 70, suggest what type of food to look for instead. If score is good, say why this is a good match.",
  "confidenceNote": "Brief note about how confident you are in this analysis based on available data"
}

Be specific to ${pet.name}. Don't be generic. Reference their actual conditions/allergies if any.`;

    try {
      const result = await this.model.generateContent(prompt);
      const text = result.response.text();
      
      // Parse JSON response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const insights = JSON.parse(jsonMatch[0]);
        
        // Cache the result
        if (!this.insightsCache) this.insightsCache = new Map();
        this.insightsCache.set(cacheKey, insights);
        
        return {
          ...insights,
          aiGenerated: true
        };
      }
      
      return this.generateFallbackInsights(product, pet, analysis);
      
    } catch (error) {
      console.error('Personalized insights generation error:', error);
      return this.generateFallbackInsights(product, pet, analysis);
    }
  }

  /**
   * Build cache key for insights
   */
  buildInsightsCacheKey(productId, petId, score) {
    return `insights_${productId}_${petId}_${score}`;
  }

  /**
   * Generate fallback insights when Gemini is unavailable
   */
  generateFallbackInsights(product, pet, analysis) {
    const petName = pet.name || 'your pet';
    const petType = pet.pet_type || 'pet';
    
    let summary = '';
    if (analysis.grade === 'A') {
      summary = `Great news! This food is an excellent match for ${petName}. It scores ${analysis.finalScore}/100 with high-quality ingredients suitable for ${petType}s.`;
    } else if (analysis.grade === 'B') {
      summary = `This food is a good choice for ${petName}, scoring ${analysis.finalScore}/100. It meets most nutritional needs for ${petType}s.`;
    } else if (analysis.grade === 'C') {
      summary = `This food is acceptable for ${petName} but has some concerns. Score: ${analysis.finalScore}/100. Consider the warnings below.`;
    } else {
      summary = `This food may not be ideal for ${petName}. Score: ${analysis.finalScore}/100. Review the concerns carefully.`;
    }

    return {
      personalizedSummary: summary,
      topConcerns: analysis.warnings?.slice(0, 3).map(w => w.reason) || [],
      topBenefits: analysis.positives?.slice(0, 3).map(p => p.benefit) || [],
      feedingTip: `Follow the feeding guidelines on the package based on ${petName}'s weight and activity level.`,
      alternativeAdvice: analysis.finalScore < 70 
        ? `Look for ${petType} food with higher-quality protein sources and fewer fillers.`
        : `This appears to be a suitable choice for ${petName}.`,
      confidenceNote: 'Analysis based on ingredient database rules.',
      aiGenerated: false
    };
  }

  /**
   * Parse Gemini response and extract JSON
   */
  parseGeminiResponse(text) {
    try {
      // Try to find JSON in the response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        
        // Clean ingredients list - remove OCR artifacts
        let ingredientsList = parsed.ingredientsList || [];
        if (ingredientsList.length > 0) {
          ingredientsList = ingredientsList.map((ing, index) => {
            let cleaned = ing.trim();
            // Remove "Ingredients:" prefix from first item (common OCR artifact)
            if (index === 0) {
              cleaned = cleaned.replace(/^ingredients?:?\s*/i, '');
            }
            // Remove trailing punctuation
            cleaned = cleaned.replace(/[.,;:]+$/, '').trim();
            return cleaned;
          }).filter(ing => ing.length > 0);
        }
        const rawTrim = String(parsed.rawIngredientsText || '').trim();
        if (rawTrim.length > 50 && ingredientsList.length > 0) {
          ingredientsList = this._reconcileListParenFromRaw(rawTrim, ingredientsList);
        }
        {
          const ingredientAnalyzer = require('./ingredientAnalyzer');
          ingredientsList = ingredientAnalyzer.postProcessExtractedIngredientList(ingredientsList);
        }

        // packageShape feeds the front-end's auto mode-toggle for the
        // back-label step. Constrain to the closed set ("flat" / "round"
        // / "pouch") and fall back to null so the client can apply its
        // own default rather than getting an invalid value.
        const allowedShapes = new Set(['flat', 'round', 'pouch']);
        const packageShape = allowedShapes.has(parsed.packageShape)
          ? parsed.packageShape
          : null;

        return {
          imageType: parsed.imageType || null,  // front_label, ingredients_label, mixed
          productType: parsed.productType || null,  // dry_food, wet_food, treats, etc.
          productName: parsed.productName || null,
          brand: parsed.brand || null,
          targetPet: parsed.targetPet || null,
          lifeStage: parsed.lifeStage || null,
          packageShape,
          ingredientsList: ingredientsList,
          rawIngredientsText: parsed.rawIngredientsText || '',
          guaranteedAnalysis: parsed.guaranteedAnalysis || {},
          confidence: parsed.confidence || 0.5,
          notes: parsed.notes || ''
        };
      }
    } catch (e) {
      console.error('JSON parsing error:', e);
    }

    // Return empty result if parsing fails
    return {
      imageType: null,
      productType: null,
      productName: null,
      brand: null,
      targetPet: null,
      lifeStage: null,
      packageShape: null,
      ingredientsList: [],
      rawIngredientsText: text,
      guaranteedAnalysis: {},
      confidence: 0,
      notes: 'Failed to parse structured response'
    };
  }

  /**
   * Simple ingredient parsing without AI.
   * Delegates to ingredientAnalyzer.parseIngredientText so the same disclaimer
   * stripping and sentence filtering rules apply everywhere.
   */
  simpleParseIngredients(rawText) {
    if (!rawText) return [];
    const ingredientAnalyzer = require('./ingredientAnalyzer');
    return ingredientAnalyzer.parseIngredientText(rawText);
  }

  /**
   * Check OCR cache
   */
  async checkCache(imageHash) {
    try {
      const results = await query(
        'SELECT extracted_text, parsed_ingredients FROM ocr_cache WHERE image_hash = ? AND (expires_at IS NULL OR expires_at > NOW())',
        [imageHash]
      );

      if (results.length > 0) {
        let ingredientsList = [];
        try {
          // Safely parse ingredients JSON
          const rawIngredients = results[0].parsed_ingredients;
          if (rawIngredients && rawIngredients.trim()) {
            ingredientsList = JSON.parse(rawIngredients);
          }
        } catch (parseError) {
          // Invalid JSON in cache - delete this corrupted entry
          await query('DELETE FROM ocr_cache WHERE image_hash = ?', [imageHash]);
          return null; // Cache miss - will re-process
        }
        
        return {
          rawIngredientsText: results[0].extracted_text,
          ingredientsList,
          fromCache: true
        };
      }
    } catch (error) {
      // Silently handle cache errors - not critical
      console.warn('Cache unavailable:', error.message);
    }
    return null;
  }

  /**
   * Cache OCR result
   */
  async cacheResult(imageHash, extracted) {
    try {
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30); // Cache for 30 days

      await query(
        `INSERT INTO ocr_cache (id, image_hash, extracted_text, parsed_ingredients, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE extracted_text = VALUES(extracted_text), parsed_ingredients = VALUES(parsed_ingredients)`,
        [
          uuidv4(),
          imageHash,
          extracted.rawIngredientsText,
          JSON.stringify(extracted.ingredientsList),
          expiresAt
        ]
      );
    } catch (error) {
      console.error('Cache write error:', error);
    }
  }

  /**
   * Quickly assess a list of ingredients for a specific pet type
   * Returns risk adjustments and explanations for each ingredient
   *
   * Always uses a universal "healthy pet" nutritional baseline. Pet-specific conditions
   * (allergies, etc.) are NOT passed into this prompt — they are handled by rule-based
   * layers (e.g. allergen match) and conditionWarnings elsewhere.
   *
   * @param {unknown} _healthConditions ignored (kept for call-site compatibility)
   */
  async assessIngredientsForPet(ingredients, petType, petName, _healthConditions = [], productType = 'food') {
    this.initialize();

    if (!this.model || ingredients.length === 0) {
      return {};
    }

    // Build ingredient list with positions
    const ingredientDetails = ingredients.map((i, idx) => {
      const name = i.name || i;
      const position = i.position || (idx + 1);
      return `${position}. ${name}`;
    }).join('\n');
    
    const totalIngredients = ingredients.length;
    
    // Determine if this is a treat or supplement (more lenient scoring)
    const isSupplement = productType === 'supplement';
    const isTreat = isSupplement || productType === 'treats' || productType === 'treat' || 
                    (ingredients.length <= 6 && ingredients.some(i => 
                      (i.name || i).toLowerCase().includes('jerky') || 
                      (i.name || i).toLowerCase().includes('treat')));

    // Product type context
    const productContext = isSupplement ? `
PRODUCT TYPE: SUPPLEMENT (not a food source)
- This is a dietary supplement, NOT daily food or a treat
- It is NOT expected to be nutritionally complete — it supplements the diet
- Capsule shells, binders, and carrier ingredients (gelatin, glycerin, water, cellulose) are standard delivery mechanisms — score them NEUTRAL (-2 to +2)
- Focus ONLY on: active ingredient quality and general safety
- Do NOT penalize for "nutritional inadequacy" — supplements are not meals
` : isTreat ? `
PRODUCT TYPE: TREAT (occasional consumption)
- Treats are given occasionally, not as daily nutrition
- Be MORE LENIENT with minor concerns (sugars, salts) since exposure is limited
- Focus on SAFETY (toxic ingredients) rather than optimal nutrition
- A small amount of sugar/salt in a treat is acceptable for healthy pets
- Quality matters: "organic cane sugar" is better than "corn syrup"
` : `
PRODUCT TYPE: DAILY FOOD (regular consumption)
- This food is eaten daily, so ingredient quality matters more
- Be appropriately strict with fillers, sugars, artificial additives
- Prioritize nutritional completeness and digestibility
`;

    const prompt = `You are a veterinary nutritionist. Assess these pet food ingredients for a ${petType} named ${petName}.
Assume a generally healthy, typical ${petType} (no special medical conditions) — this is a universal product assessment.

INGREDIENTS (by position - earlier = larger amount):
${ingredientDetails}

TOTAL INGREDIENTS: ${totalIngredients}
PET TYPE: ${petType}
HEALTH CONDITIONS: None (universal / healthy-pet baseline — do not personalize for diseases or allergies)
${productContext}

SCORING GUIDELINES:
- riskScore: -20 to +50 (negative = BENEFICIAL, positive = concerning)

For SUPPLEMENTS - score the ACTIVE ingredients, not delivery mechanisms:
  - Active beneficial ingredients (fish oil, glucosamine, probiotics, vitamins, CoQ10): -15 to -20 (very beneficial!)
  - Carrier oils (coconut oil, flaxseed oil): -5 to -10 (beneficial)
  - Capsule/delivery components (gelatin, glycerin, water, cellulose, starch): -2 to +2 (NEUTRAL — standard delivery)
  - Natural preservatives (tocopherols, rosemary): -3 to +2 (neutral to beneficial)
  - Artificial additives: +10 to +15

For TREATS (healthy pets) - BE LENIENT, treats are occasional:
  - Quality proteins (chicken, beef, fish, eggs): -12 to -18 (very beneficial!)
  - Wholesome grains (oatmeal, brown rice): -5 to -10 (good fiber & energy)
  - TREAT FILLERS/BINDERS (rice flour, vegetable glycerin, water, tapioca, potato starch, pea starch, maltodextrin, cellulose, guar gum, xanthan gum, lecithin, gelatin): -2 to +2 (NEUTRAL - expected in treats for texture/binding!)
  - Vegetables, fruits: -5 to -10 (beneficial)
  - Minerals/supplements (calcium carbonate, vitamins): -3 to +2 (neutral to beneficial)
  - Organic/natural sugars (in moderation): +2 to +5 (minor concern, acceptable in treats)
  - Refined sugars, corn syrup: +8 to +15 (more concerning)
  - Natural preservatives (rosemary, tocopherols): -3 to +2 (neutral to beneficial)
  - Artificial colors (Yellow 5, Blue 1, Red 40): +8 to +15 (unnecessary but not toxic)
  - Artificial preservatives: +10 to +20
  - Toxic ingredients (xylitol, onion, grapes, chocolate): +40 to +50

For DAILY FOOD (healthy pets):
  - Quality proteins (chicken, beef, salmon, eggs): -10 to -18 (VERY beneficial!)
  - Organ meats (liver, heart): -8 to -12 (nutrient-dense)
  - WHOLESOME grains (oatmeal, brown rice, barley, quinoa): -5 to -10 (beneficial fiber & energy!)
  - Vegetables & fruits: -5 to -10 (beneficial vitamins)
  - LOWER QUALITY grains/fillers (corn, wheat gluten, soy): +3 to +8 (common allergens, less nutritious - but not dangerous)
  - Any added sugars: +8 to +15 (more strict for daily consumption)
  - Artificial colors/flavors: +10 to +18
  - Byproducts (unspecified): +5 to +10

GRAIN/FILLER DISTINCTION (important!):
- GOOD whole grains: oatmeal, brown rice, barley, quinoa, millet → score NEGATIVE (beneficial)
- NEUTRAL fillers (OK for treats): rice flour, white rice, tapioca, potato starch, pea starch, pea flour, chickpea flour → score -2 to +2
- NEUTRAL binders/texture: vegetable glycerin, glycerin, gelatin, guar gum, xanthan gum, cellulose, lecithin → score -2 to +2
- LOWER QUALITY fillers (common allergens, less nutritious): corn, wheat, soy, wheat gluten, corn gluten → score +2 to +8 (not ideal but not dangerous for healthy pets)

IMPORTANT RULES:
1. Consider ingredient QUALITY (organic > conventional > artificial)
2. Use position to WEIGHT the risk score (earlier = more impactful), but...
3. DO NOT mention position/order in explanations! Write descriptions that apply to the ingredient itself, regardless of where it appears in the list.

BAD explanation: "As the 5th ingredient, its quantity is likely small"
GOOD explanation: "Provides empty calories with no nutritional benefit"

Return VALID JSON (no + prefix on numbers, use -5 or 5, not +5):
{
  "assessments": {
    "Ingredient Name": {
      "riskScore": <integer like -15, 0, 10, 45 - NO + prefix>,
      "category": "string",
      "explanation": "string (describe the ingredient itself, NOT its position)",
      "benefit": "string or empty"
    }
  }
}

Use standard nutritional assessment for a healthy ${petType}. Explanations describe the ingredient itself, not a specific sick pet.`;

    try {
      console.log('🤖 [AI PROMPT] Ingredient assessment: universal healthy-pet baseline (no condition personalization)');
      
      const result = await this.model.generateContent(prompt);
      const text = result.response.text();
      
      console.log(`🤖 [AI RAW RESPONSE]:\n${text.substring(0, 500)}...`);
      
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        // Fix invalid JSON: AI sometimes returns +5 instead of 5 for positive numbers
        const cleanedJson = jsonMatch[0].replace(/:\s*\+(\d)/g, ': $1');
        const parsed = JSON.parse(cleanedJson);
        const assessments = parsed.assessments || {};
        
        // Log each assessment
        for (const [ingName, assessment] of Object.entries(assessments)) {
          console.log(`🤖 [AI RESULT] ${ingName}: score=${assessment.riskScore}, level=${assessment.riskScore > 30 ? 'danger' : assessment.riskScore > 15 ? 'high' : assessment.riskScore > 0 ? 'moderate' : 'safe'}`);
        }
        
        return assessments;
      }
    } catch (error) {
      console.error('AI ingredient assessment error:', error.message);
    }
    
    return {};
  }

  /**
   * HOLISTIC PRODUCT REVIEW
   * AI evaluates the ENTIRE product and gives a final score (universal healthy-pet product quality only).
   * @param {Object} params
   * @param {string[]} params.healthConditions - ignored; kept for call-site compatibility
   * @param {string} params.petName - may be used in summary tone only, not for medical context
   */
  async reviewProductHolistically({ ingredients, petType, healthConditions: _healthConditions = [], productType = 'food', petName = 'your pet' }) {
    this.initialize();
    
    if (!this.model) {
      throw new Error('Gemini AI not initialized. Check GEMINI_API_KEY.');
    }

    const conditionsText = 'None — universal healthy pet (do not adjust score or text for specific diseases, allergies, or special diets)';
    const isSupplement = productType === 'supplement';
    const isTreat = isSupplement || productType === 'treats' || productType === 'treat';

    // Different evaluation criteria for treats vs. daily food vs. supplements
    const supplementPrompt = `You are a veterinary nutritionist reviewing a PET DIETARY SUPPLEMENT.

PRODUCT TYPE: SUPPLEMENT (not food or treat)
PET: ${petType} named ${petName}
HEALTH CONDITIONS: ${conditionsText}

INGREDIENTS (by weight):
${ingredients.map((ing, i) => `${i + 1}. ${ing}`).join('\n')}

IMPORTANT: This is a SUPPLEMENT, NOT daily food or a treat. Supplements are:
- Taken to complement the regular diet (e.g., fish oil, joint support, probiotics)
- NOT expected to be nutritionally complete
- Capsule shells/binders/carriers (gelatin, glycerin, water, cellulose) are standard delivery mechanisms — NEUTRAL
- Evaluate ONLY: active ingredient quality and general safety (universal, healthy pet)

BASE SCORE: 80 (supplements start here)

SCORING ADJUSTMENTS FOR SUPPLEMENTS:

PENALTIES (subtract from base):
- Artificial preservatives (BHA, BHT): -10 to -15
- Toxic ingredients: -50 (instant fail)
- Low-quality/rancid oil sources: -10 to -15
- Artificial colors or flavors: -5 to -10

BONUSES (add to base):
- High-quality active ingredients (wild-caught fish oil, organic extracts): +10 to +15
- Natural preservatives (tocopherols, rosemary extract): +3 to +5
- Clean, minimal ingredient list: +3 to +5
- Proven beneficial supplements (omega-3, glucosamine, probiotics): +5 to +10

NEUTRAL FOR SUPPLEMENTS (don't penalize):
- Capsule shell ingredients (gelatin, glycerin, water) — standard delivery
- Cellulose, starch — common filler in capsules/tablets
- Small amounts of carrier oils
- No protein content — supplements aren't protein sources

SCORING GUIDE FOR SUPPLEMENTS:
- 90-100: Excellent supplement (high-quality actives + clean + no artificial additives)
- 80-89: Good supplement (quality actives, minimal concerns)
- 70-79: Acceptable (some minor concerns, still potentially beneficial)
- 60-69: Caution (quality concerns)
- Below 60: Not recommended (toxic or very low quality)

IMPORTANT: In keyIssues, positives, and aiSummary, DO NOT mention ingredient position/order.

Return JSON:
{
  "finalScore": <number 0-100>,
  "grade": "<A|B|C|D|F>",
  "recommendation": "<highly_recommended|recommended|acceptable|caution|not_recommended>",
  "proteinQuality": "<none|low|medium|high>",
  "primaryIngredientType": "<protein|carb|filler|fat|other>",
  "hasArtificialAdditives": <true|false>,
  "keyIssues": ["<issue without position reference>"],
  "positives": ["<positive without position reference>"],
  "aiSummary": "<2-3 sentence summary for ${petName} - no position references>"
}`;

    const treatPrompt = `You are a veterinary nutritionist reviewing a PET TREAT (not daily food).

PRODUCT TYPE: TREAT / SNACK
PET: ${petType} named ${petName}
HEALTH CONDITIONS: ${conditionsText}

INGREDIENTS (by weight):
${ingredients.map((ing, i) => `${i + 1}. ${ing}`).join('\n')}

IMPORTANT: This is a TREAT, not daily food. Treats are:
- Given occasionally (not primary nutrition source)
- NOT expected to be nutritionally complete
- Allowed to have fillers for texture/shape
- Evaluated differently than daily food

BASE SCORE: 75 (treats start here)

SCORING ADJUSTMENTS FOR TREATS:

PENALTIES (subtract from base):
- Artificial colors (Yellow 5, Blue 1, Red 40): -8 to -12 (unnecessary, potentially harmful)
- Artificial preservatives (BHA, BHT, ethoxyquin): -10 to -15
- Toxic ingredients (xylitol, chocolate, grapes): -50 (instant fail)
- Sugar/sweeteners as #1 or #2 ingredient: -2 to -4 (minor concern for treats)
- Long ingredient list (15+) with many unrecognizable items: -3 to -5

BONUSES (add to base):
- Real meat/protein as #1 ingredient: +12 to +18 (significant bonus!)
- Real meat/protein in top 3 (not #1): +6 to +10
- Natural preservatives (tocopherols, rosemary extract): +3 to +5
- Short, clean ingredient list (5 or fewer ingredients): +3 to +5
- All recognizable, whole-food ingredients: +3 to +5
- Functional benefits (dental, joint, skin): +2 to +3
- Beneficial herbs (parsley, peppermint): +1 to +2

NEUTRAL FOR TREATS (don't penalize):
- Fillers as primary ingredient (rice flour, corn starch) - expected in treats
- No protein - treats don't need to be protein-rich
- Glycerin/water - common in soft treats
- "Natural Flavor" - acceptable for treats
- Organic sugar in small amounts - treats are meant to be tasty

SCORING GUIDE FOR TREATS:
- 90-100: Excellent treat (real protein #1 + clean ingredients + no artificial additives)
- 80-89: Great treat (real protein + mostly clean OR very clean but no protein)
- 70-79: Good treat (acceptable ingredients, may have minor concerns)
- 60-69: Caution (artificial additives or multiple concerns)
- Below 60: Not recommended (toxic, artificial colors + preservatives, or serious issues)

IMPORTANT: In keyIssues, positives, and aiSummary, DO NOT mention ingredient position/order.
BAD: "Cane sugar as the #1 ingredient is concerning"
GOOD: "Contains added sugar which provides empty calories"

Return JSON:
{
  "finalScore": <number 0-100>,
  "grade": "<A|B|C|D|F>",
  "recommendation": "<highly_recommended|recommended|acceptable|caution|not_recommended>",
  "proteinQuality": "<none|low|medium|high>",
  "primaryIngredientType": "<protein|carb|filler|fat|other>",
  "hasArtificialAdditives": <true|false>,
  "keyIssues": ["<issue without position reference>", "<issue 2>"],
  "positives": ["<positive without position reference>", "<positive 2>"],
  "aiSummary": "<2-3 sentence summary for ${petName} - no position references>"
}

CALIBRATION EXAMPLES (follow these closely):
- Chicken #1, organic sugar, vinegar, rosemary extract (4 ingredients, all recognizable, natural preservative) = 90-93 (Grade A)
- Chicken #1, sugar, glycerin, natural flavors, rosemary (clean but slightly longer) = 86-89 (Grade A)
- Rice flour, glycerin, natural preservatives, herbs, NO artificial colors = 78-82 (Grade B)
- Rice flour, glycerin, natural preservatives, herbs, WITH artificial colors (Yellow 5, Blue 1) = 65-72 (Grade C/D)
- Artificial colors AND artificial preservatives = 55-65 (Grade D/F)

KEY PRINCIPLE: Score for a typical healthy pet. Treats deserve 90+ if clean ingredients and no artificial additives.`;

    const foodPrompt = `You are a veterinary nutritionist reviewing DAILY PET FOOD (not treats).

PRODUCT TYPE: DAILY FOOD
PET: ${petType} named ${petName}
HEALTH CONDITIONS: ${conditionsText}

INGREDIENTS (by weight):
${ingredients.map((ing, i) => `${i + 1}. ${ing}`).join('\n')}

IMPORTANT: This is DAILY FOOD - the primary nutrition source. Must be:
- Nutritionally appropriate
- Protein should be prominent
- Quality matters significantly

BASE SCORE: 75 (daily food starts here - stricter than treats)

SCORING FOR DAILY FOOD:

PENALTIES:
- No real protein in top 3: -10 to -15
- "Flavor" instead of real meat: -8 to -12
- Artificial colors: -8 to -12
- Artificial preservatives: -8 to -12
- Corn/wheat as #1 ingredient: -8 to -12
- By-products as primary protein: -5 to -8
- Toxic ingredients: -50 (instant fail)

BONUSES:
- Real meat as #1 ingredient: +8 to +12
- Named meat (chicken, beef) vs generic: +3 to +5
- Natural preservatives: +3 to +5
- Whole grains vs refined: +2 to +4
- Added vitamins/minerals: +2 to +4
- Omega fatty acids: +2 to +4

${petType === 'cat' ? `
CAT-SPECIFIC:
- Cats are obligate carnivores - NEED high protein
- No taurine listed: -10 to -15
- Carb-heavy formula: -8 to -12
` : `
DOG-SPECIFIC:
- Dogs are omnivores - some carbs OK
- Still need quality protein
- Balanced nutrition important
`}

IMPORTANT: In keyIssues, positives, and aiSummary, DO NOT mention ingredient position/order.
BAD: "Real chicken as the #1 ingredient" or "Sugar is the first ingredient"
GOOD: "Contains quality chicken protein" or "High sugar content is concerning"

Return JSON:
{
  "finalScore": <number 0-100>,
  "grade": "<A|B|C|D|F>",
  "recommendation": "<highly_recommended|recommended|acceptable|caution|not_recommended>",
  "proteinQuality": "<none|low|medium|high>",
  "primaryIngredientType": "<protein|carb|filler|fat|other>",
  "hasArtificialAdditives": <true|false>,
  "keyIssues": ["<issue without position reference>", "<issue 2>"],
  "positives": ["<positive without position reference>", "<positive 2>"],
  "aiSummary": "<2-3 sentence product-quality summary (typical healthy pet) — you may use ${petName} naturally; no position references>"
}`;

    const prompt = isSupplement ? supplementPrompt : (isTreat ? treatPrompt : foodPrompt);

    // Two-pass strategy:
    //   Pass 1 — model returns JSON directly via responseMimeType.
    //   Pass 2 — if that still returns malformed JSON (rare but happens
    //            when the model tries to "explain"), reissue with an even
    //            stricter prompt suffix.
    //
    // We deliberately do NOT silently return a placeholder ("Unable to
    // complete AI analysis"). That fallback used to be cached forever in
    // product_review_cache, polluting every future scan that hashed to
    // the same ingredient list. Instead, throw — the call sites are all
    // wrapped in try/catch and will simply skip caching.
    // NOTE: We intentionally don't set responseMimeType: 'application/json'
    // here — the @google/generative-ai SDK pinned in this project is too
    // old to translate that field, and the v1 REST endpoint rejects it
    // (HTTP 400 "Unknown name 'responseMimeType' at 'generation_config'").
    // Strict-JSON behaviour comes from the prompt + the tolerant parser
    // + the retry below; not from the SDK option.
    const baseGenerationConfig = {
      temperature: 0.0,
      candidateCount: 1,
    };

    const attempts = [
      {
        suffix: '\n\nReturn ONLY a single valid JSON object. No markdown fences, no prose, no comments, no trailing text. Start the response with `{` and end with `}`.',
        config: baseGenerationConfig,
      },
      {
        suffix: '\n\nIMPORTANT: Your previous attempt produced invalid JSON. Output exactly one JSON object that JSON.parse() can read. Do not wrap it in ```. No commentary before or after. Begin with `{` and end with `}`.',
        config: baseGenerationConfig,
      },
    ];

    let lastError = null;

    for (let attempt = 0; attempt < attempts.length; attempt++) {
      const { suffix, config } = attempts[attempt];
      try {
        const result = await this.model.generateContent({
          contents: [{ role: 'user', parts: [{ text: prompt + suffix }] }],
          generationConfig: config,
        });
        const text = this._extractFirstText(result?.response) || '';
        const parsed = this._parseHolisticReviewJson(text);

        return {
          finalScore: Math.max(0, Math.min(100, parseInt(parsed.finalScore) || 50)),
          grade: ['A', 'B', 'C', 'D', 'F'].includes(parsed.grade) ? parsed.grade : 'C',
          recommendation: parsed.recommendation || 'acceptable',
          proteinQuality: parsed.proteinQuality || 'unknown',
          primaryIngredientType: parsed.primaryIngredientType || 'unknown',
          hasArtificialAdditives: !!parsed.hasArtificialAdditives,
          keyIssues: Array.isArray(parsed.keyIssues) ? parsed.keyIssues : [],
          positives: Array.isArray(parsed.positives) ? parsed.positives : [],
          aiSummary: parsed.aiSummary || ''
        };
      } catch (error) {
        lastError = error;
        console.warn(
          `[reviewProductHolistically] attempt ${attempt + 1}/${attempts.length} failed: ${error.message}`
        );
      }
    }

    // Both passes failed → surface the error so callers skip caching.
    const finalErr = new Error(
      `Holistic AI review failed after ${attempts.length} attempts: ${lastError?.message || 'unknown error'}`
    );
    finalErr.cause = lastError;
    throw finalErr;
  }

  /**
   * Tolerant JSON extractor for holistic-review responses.
   *
   * Tries (in order):
   *   1. Strip ``` / ```json fences, then JSON.parse the whole thing
   *      (responseMimeType: application/json should already give clean JSON,
   *       but Gemini still occasionally wraps it).
   *   2. Pull the first {...} block out and parse that.
   *   3. Apply a couple of targeted fixups (trailing commas) before re-parsing.
   *
   * Throws if nothing parseable is found — caller should retry or give up.
   */
  _parseHolisticReviewJson(text) {
    if (!text || typeof text !== 'string') {
      throw new Error('Empty AI response');
    }

    const stripFences = (s) =>
      s
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/```\s*$/i, '')
        .trim();

    const cleaned = stripFences(text);

    try {
      return JSON.parse(cleaned);
    } catch (_) { /* try the next strategy */ }

    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON object found in AI response');
    }

    try {
      return JSON.parse(jsonMatch[0]);
    } catch (_) { /* try one more fixup */ }

    // Last-chance cleanup: drop trailing commas before } or ].
    const fixed = jsonMatch[0]
      .replace(/,(\s*[}\]])/g, '$1')
      .replace(/[\u0000-\u001F]+/g, ' ');

    return JSON.parse(fixed);
  }

  /**
   * MERGED: Per-ingredient assessment + Holistic review in ONE Gemini call.
   * @param {Object} params
   * @param {Array} params.uncachedIngredients - Only the ingredients needing AI assessment
   * @param {Array} params.allIngredients - Full ingredient list for holistic review
   * @param {string} params.petType
   * @param {string} params.petName
   * @param {Array} params.healthConditions ignored (holistic is universal healthy baseline)
   * @param {string} params.productType
   */
  async assessAndReviewProduct({ uncachedIngredients, allIngredients, petType, petName = 'your pet', healthConditions: _healthConditions = [], productType = 'food' }) {
    this.initialize();

    const ingredients = uncachedIngredients || allIngredients;
    const fullIngredients = allIngredients || ingredients;

    if (!this.model || ingredients.length === 0) {
      throw new Error('Gemini AI not initialized or no ingredients');
    }

    const uncachedDetails = ingredients.map((i, idx) => {
      const name = i.name || i;
      const position = i.position || (idx + 1);
      return `${position}. ${name}`;
    }).join('\n');

    const fullIngredientDetails = fullIngredients.map((i, idx) => {
      const name = i.name || i;
      const position = i.position || (idx + 1);
      return `${position}. ${name}`;
    }).join('\n');

    const totalIngredients = fullIngredients.length;
    const conditionsText = 'None (universal healthy pet — same baseline as per-ingredient assessment)';

    const isSupplement = productType === 'supplement';
    const isTreat = isSupplement || productType === 'treats' || productType === 'treat' ||
                    (ingredients.length <= 6 && ingredients.some(i =>
                      (i.name || i).toLowerCase().includes('jerky') ||
                      (i.name || i).toLowerCase().includes('treat')));

    const productTypeLabel = isSupplement ? 'SUPPLEMENT' : (isTreat ? 'TREAT' : 'DAILY FOOD');

    const hasPartialCache = ingredients.length < fullIngredients.length;
    
    const prompt = `You are a veterinary nutritionist. Perform a COMPLETE analysis of this pet food product.

PRODUCT TYPE: ${productTypeLabel}
PET: ${petType} named ${petName}

PART 1: Per-ingredient — UNIVERSAL healthy-pet baseline (no disease or allergy personalization).
PART 2: Holistic product score & summary — UNIVERSAL healthy-pet baseline (same; score overall product quality for a typical healthy ${petType}).
HEALTH CONDITIONS: ${conditionsText}

FULL INGREDIENT LIST (for holistic review - by weight, earlier = larger amount):
${fullIngredientDetails}

TOTAL INGREDIENTS: ${totalIngredients}

You must return TWO things in your response:

═══ PART 1: PER-INGREDIENT ASSESSMENT ═══
Assume a typical healthy ${petType} — do NOT personalize per-ingredient text for specific diseases or named allergies.
${hasPartialCache ? `Assess ONLY these ${ingredients.length} ingredients (the others are already evaluated):
${uncachedDetails}` : `For EACH ingredient, provide a risk score and explanation.`}

riskScore guidelines: -20 (very beneficial) to +50 (dangerous)
${isSupplement ? `- Active beneficial ingredients (fish oil, glucosamine, probiotics): -15 to -20
- Carrier/capsule components (gelatin, glycerin, cellulose): -2 to +2 (NEUTRAL)
- Natural preservatives: -3 to +2` :
isTreat ? `- Quality proteins (chicken, beef, fish): -12 to -18 (very beneficial)
- Wholesome grains (oatmeal, brown rice): -5 to -10
- Treat fillers/binders (rice flour, glycerin, tapioca, guar gum): -2 to +2 (NEUTRAL - expected in treats)
- Vegetables, fruits: -5 to -10
- Organic sugars in moderation: +2 to +5
- Refined sugars, corn syrup: +8 to +15
- Artificial colors: +8 to +15
- Artificial preservatives: +10 to +20
- Toxic ingredients (xylitol, chocolate): +40 to +50` :
`- Quality proteins (chicken, beef, salmon): -10 to -18 (very beneficial)
- Wholesome grains (oatmeal, brown rice, barley): -5 to -10
- Vegetables & fruits: -5 to -10
- Lower quality fillers (corn, wheat gluten, soy): +3 to +8
- Any added sugars: +8 to +15
- Artificial colors/flavors: +10 to +18
- Byproducts (unspecified): +5 to +10`}

IMPORTANT: Do NOT mention ingredient position/order in explanations.

═══ PART 2: HOLISTIC PRODUCT REVIEW ═══
Evaluate the ENTIRE product (all ${totalIngredients} ingredients in the FULL INGREDIENT LIST above) for overall quality for a typical healthy ${petType}. Do not adjust the holistic score for specific medical conditions or allergies.

${isSupplement ? 'BASE SCORE: 80 (supplements start here)' : isTreat ? 'BASE SCORE: 75 (treats start here)' : 'BASE SCORE: 75 (daily food starts here)'}

Scoring guide:
- 90-100: Excellent (Grade A) ${isTreat ? '- real protein + clean ingredients' : '- high-quality protein + nutritionally complete'}
- 80-89: Good (Grade B)
- 70-79: Acceptable (Grade C)
- 55-69: Below average (Grade D)
- Below 55: Avoid - significant issues (Grade F)

Return VALID JSON (no + prefix on numbers):
{
  "assessments": {
    "Ingredient Name": {
      "riskScore": <integer>,
      "category": "string",
      "explanation": "string",
      "benefit": "string or empty"
    }
  },
  "holistic": {
    "finalScore": <number 0-100>,
    "grade": "<A|B|C|D|F>",
    "recommendation": "<highly_recommended|recommended|acceptable|caution|not_recommended>",
    "proteinQuality": "<none|low|medium|high>",
    "primaryIngredientType": "<protein|carb|filler|fat|other>",
    "hasArtificialAdditives": <true|false>,
    "keyIssues": ["issue 1", "issue 2"],
    "positives": ["positive 1", "positive 2"],
    "aiSummary": "<2-3 sentence summary for ${petName}>"
  }
}`;

    try {
      console.log(`🚀 [MERGED AI] Single call for ${totalIngredients} ingredients + holistic (${conditionsText})`);
      const result = await this.model.generateContent(prompt);
      const text = result.response.text();

      console.log(`🤖 [MERGED AI RAW]:\n${text.substring(0, 500)}...`);

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const cleanedJson = jsonMatch[0].replace(/:\s*\+(\d)/g, ': $1');
        const parsed = JSON.parse(cleanedJson);

        const assessments = parsed.assessments || {};
        const holistic = parsed.holistic || {};

        const normalizedHolistic = {
          finalScore: Math.max(0, Math.min(100, parseInt(holistic.finalScore) || 50)),
          grade: ['A', 'B', 'C', 'D', 'F'].includes(holistic.grade) ? holistic.grade : 'C',
          recommendation: holistic.recommendation || 'acceptable',
          proteinQuality: holistic.proteinQuality || 'unknown',
          primaryIngredientType: holistic.primaryIngredientType || 'unknown',
          hasArtificialAdditives: !!holistic.hasArtificialAdditives,
          keyIssues: Array.isArray(holistic.keyIssues) ? holistic.keyIssues : [],
          positives: Array.isArray(holistic.positives) ? holistic.positives : [],
          aiSummary: holistic.aiSummary || ''
        };

        console.log(`✅ [MERGED AI] Got ${Object.keys(assessments).length} ingredient assessments + holistic score=${normalizedHolistic.finalScore} grade=${normalizedHolistic.grade}`);

        return { assessments, holistic: normalizedHolistic };
      }

      throw new Error('Invalid JSON response from merged AI call');
    } catch (error) {
      console.error('Merged AI assessment error:', error.message);
      throw error;
    }
  }

  /**
   * Identify food from photo (Step 1 - always needed for image recognition)
   * @param {Buffer} imageBuffer - Image data
   * @param {string} mimeType - Image MIME type
   * @returns {Object} Food identification { identified, foodName, category, foodType }
   */
  async identifyFoodFromImage(imageBuffer, mimeType = 'image/jpeg') {
    this.initialize();

    if (!this.model) {
      throw new Error('Gemini AI not initialized. Check API key.');
    }

    const imageBase64 = imageBuffer.toString('base64');

    const prompt = `You are a food identification expert. Look at this photo and identify what food is shown.

INSTRUCTIONS:
1. Identify the food in the photo
2. Determine if it's a SIMPLE food or PREPARED dish
3. Be specific with the name

FOOD TYPES:
- "simple": Single ingredient or raw food (apple, egg, raw chicken, carrot, cheese, chocolate bar)
- "prepared": Cooked dish, meal, recipe with multiple ingredients (soup, pizza, stew, sandwich, salad, pasta dish, Korean food, etc.)

Return ONLY a JSON object:
{
  "identified": true,
  "foodName": "<Name of the food>",
  "category": "<Fruit|Vegetable|Meat|Dairy|Grain|Snack|Beverage|Candy|Nut|Seafood|PreparedDish|Other>",
  "foodType": "<simple|prepared>"
}

EXAMPLES:
- Photo of an apple → { "foodName": "Apple", "category": "Fruit", "foodType": "simple" }
- Photo of pizza → { "foodName": "Pizza", "category": "PreparedDish", "foodType": "prepared" }
- Photo of raw egg → { "foodName": "Egg", "category": "Dairy", "foodType": "simple" }
- Photo of Korean soup → { "foodName": "Tteok-Manduguk", "category": "PreparedDish", "foodType": "prepared" }
- Photo of chocolate → { "foodName": "Chocolate", "category": "Candy", "foodType": "simple" }

If the image does NOT show food:
{
  "identified": false,
  "foodName": null,
  "category": null,
  "foodType": null
}`;

    try {
      const result = await this.model.generateContent([
        {
          inlineData: {
            data: imageBase64,
            mimeType
          }
        },
        prompt
      ]);

      const text = result.response.text();
      const jsonMatch = text.match(/\{[\s\S]*\}/);

      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          identified: !!parsed.identified,
          foodName: parsed.foodName || null,
          category: parsed.category || null,
          foodType: parsed.foodType || 'simple' // default to simple if not specified
        };
      }

      return { identified: false, foodName: null, category: null, foodType: null };
    } catch (error) {
      console.error('[Food Identification] Error:', error.message);
      return { identified: false, foodName: null, category: null, foodType: null };
    }
  }

  /**
   * Assess food safety for a specific pet (Step 2 - can be cached)
   * @param {string} foodName - Name of the food
   * @param {string} category - Food category
   * @param {Object} petInfo - Pet details (name, type, healthConditions, foodType)
   * @returns {Object} Safety assessment { safetyLevel, explanation, tip, category }
   */
  async assessFoodSafety(foodName, category, petInfo) {
    this.initialize();

    if (!this.model) {
      throw new Error('Gemini AI not initialized. Check API key.');
    }

    const { petName, petType, healthConditions = [], foodType = 'simple' } = petInfo;
    const isPreparedDish = foodType === 'prepared' || category === 'PreparedDish';

    // Build health conditions context with EXPLICIT rules
    let healthContext = '';
    if (healthConditions.length > 0) {
      const conditionRules = healthConditions.map(c => {
        const condition = c.name || c.condition_type || c;
        if (condition.includes('allergy')) {
          const allergen = condition.replace('allergy_', '').replace(/_/g, ' ');
          return `🚨 ${allergen.toUpperCase()} ALLERGY: If food is ${allergen} or contains ${allergen} → safetyLevel="danger"`;
        }
        if (condition.includes('diabetes')) return `🚨 DIABETES: If high sugar food → safetyLevel="danger" or "caution"`;
        if (condition.includes('kidney')) return `🚨 KIDNEY DISEASE: If high protein/phosphorus → safetyLevel="caution"`;
        if (condition.includes('pancreatitis')) return `🚨 PANCREATITIS: If high fat → safetyLevel="danger"`;
        if (condition.includes('liver')) return `🚨 LIVER DISEASE: If high protein/copper → safetyLevel="caution"`;
        if (condition.includes('heart')) return `🚨 HEART DISEASE: If high sodium → safetyLevel="caution"`;
        if (condition.includes('digestive') || condition.includes('sensitive')) return `⚠️ DIGESTIVE SENSITIVITY: If hard to digest/fatty/dairy → safetyLevel="caution"`;
        if (condition.includes('obesity')) return `⚠️ OBESITY: If high calorie/fat → safetyLevel="caution"`;
        return `⚠️ ${condition.replace(/_/g, ' ').toUpperCase()}: Consider impact on this condition`;
      });
      healthContext = `\n⚠️ HEALTH CONDITIONS:\n${conditionRules.join('\n')}`;
    }

    // Different prompts for simple foods vs prepared dishes
    let prompt;
    
    if (isPreparedDish) {
      // PREPARED DISH prompt - cannot know exact ingredients
      prompt = `You are a veterinary nutrition expert. "${foodName}" is a PREPARED DISH (meal/recipe with multiple ingredients).

Assess safety for a ${petType}.${healthContext}

CRITICAL RULES FOR PREPARED DISHES:
1. You CANNOT know exact ingredients from just the dish name
2. NEVER say "contains X" - always say "often contains" or "may contain"
3. Mention common toxic ingredients typically found in this type of dish
4. Default to "caution" unless it's a dish KNOWN to always contain toxic ingredients

Common toxic ingredients in prepared foods:
- Many dishes: onion, garlic (toxic to dogs/cats)
- Asian dishes: often have garlic, soy sauce, MSG
- Western dishes: often have onion, garlic, butter
- Desserts: may have chocolate, xylitol, raisins

Return ONLY JSON:
{
  "safetyLevel": "<caution|danger>",
  "explanation": "<Max 15 words. Start with 'Often contains...' or 'May contain...' - list concerning ingredients>",
  "tip": "Check ingredients before sharing. Avoid if contains onion/garlic.",
  "category": "PreparedDish"
}

NEVER use "safe" for prepared dishes - we can't verify ingredients.`;
    } else {
      // SIMPLE FOOD prompt - single ingredient, can be definitive
      prompt = `You are a veterinary nutrition expert. Assess whether "${foodName}" (a simple, single food item) is safe for a ${petType}.${healthContext}

TOXIC FOR DOGS: Chocolate, grapes, raisins, onions, garlic, xylitol, macadamia nuts, avocado
TOXIC FOR CATS: Onions, garlic, chocolate, grapes, raisins, xylitol, lilies

Return ONLY JSON:
{
  "safetyLevel": "<safe|caution|danger>",
  "explanation": "<ONE sentence, max 15 words. Be direct about why it's safe/dangerous.>",
  "tip": "<Short tip about portion/preparation, or null>",
  "category": "${category || 'Other'}"
}

Examples:
- Apple: "Safe and nutritious, good source of fiber and vitamins."
- Chocolate: "Toxic - contains theobromine which is poisonous to dogs."
- Cheese: "Okay in small amounts, but may cause digestive upset."`;
    }

    try {
      console.log(`🔍 [Food Safety] Assessing "${foodName}" for ${petType}`);

      const result = await this.model.generateContent(prompt);
      const text = result.response.text();
      const jsonMatch = text.match(/\{[\s\S]*\}/);

      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        
        console.log(`✅ [Food Safety] "${foodName}" = ${parsed.safetyLevel}`);

        return {
          safetyLevel: parsed.safetyLevel || 'unknown',
          explanation: parsed.explanation || 'Unable to determine safety. Please consult your veterinarian.',
          tip: parsed.tip || null,
          category: parsed.category || category
        };
      }

      throw new Error('Invalid JSON response');
    } catch (error) {
      console.error('[Food Safety] Error:', error.message);

      return {
        safetyLevel: 'unknown',
        explanation: 'We couldn\'t assess this food\'s safety. Please consult your veterinarian.',
        tip: 'When in doubt, don\'t feed it to your pet.',
        category: category
      };
    }
  }
}

module.exports = new GeminiService();

