const { GoogleGenerativeAI } = require('@google/generative-ai');
const crypto = require('crypto');
const { query } = require('../database/connection');
const { v4: uuidv4 } = require('uuid');
const cloudVisionService = require('./cloudVisionService');

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
   * Falls back to the legacy Gemini multi-image one-shot when the
   * Vision API key isn't configured (local dev without GCP setup).
   *
   * @param {Buffer[]} imageBuffers - 1+ image buffers (typically 6)
   * @param {string} mimeType
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
  async extractFromMultipleImages(imageBuffers, mimeType = 'image/jpeg') {
    this.initialize();
    if (!this.model) throw new Error('Gemini AI not initialized. Check API key.');
    if (!Array.isArray(imageBuffers) || imageBuffers.length === 0) {
      throw new Error('extractFromMultipleImages: imageBuffers must be a non-empty array');
    }

    // Cache key spans ALL frames so an exact re-scan hits cache.
    // Pipeline-salt suffix busts stale ocr_cache rows when post-merge
    // heuristics change (same pixels → new extraction).
    const combinedHash = crypto
      .createHash('sha256')
      .update(
        Buffer.concat([
          ...imageBuffers.map(b => crypto.createHash('sha256').update(b).digest()),
          Buffer.from('multiocr-merge-ga-sep-v14', 'utf8'),
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

    // ── STAGE 1: Cloud Vision per-frame OCR (parallel) ─────────────
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

    const haystack = usableFrames.map(f => f.rawText).join('\n\n');
    const ingredientAnalyzer = require('./ingredientAnalyzer');
    let recoveredList = this._injectParentheticalPremixFromHaystack(
      haystack,
      merged.ingredientsList || []
    );
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
    let recoveredList = this._injectParentheticalPremixFromHaystack(
      haystack,
      merged.ingredientsList || []
    );
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
    const prompt = `You are OCRing photo #${frameIndex} of a pet-food package.
This photo shows ONE viewpoint of a wrap-around ingredient panel —
other photos cover the rest of the panel. Your job for this frame is
just to read what THIS image shows, in the order it's printed.

Return ONLY this JSON (no prose, no code fences):
{
  "ingredients":     ["...", "...", ...],
  "has_start_anchor": true | false,
  "start_anchor":    "ingredients_header" | "first_protein" | null
}

Rules:
- VERBATIM INTEGRITY: keep headers and qualifiers as printed (e.g. MODIFIED, cultured, organic). Do not invent extra tokens inside parentheses; one balanced "(…)" per header must match the label.
- "ingredients" is the ordered list of ingredient noun phrases that
  appear in THIS photo, top-to-bottom / left-to-right exactly as
  printed. One short noun phrase per item.
- BE GENEROUS, NOT CONSERVATIVE. Include every ingredient you can
  read in this frame, including:
    • Items near the very top, bottom, left, or right edges where
      text may be slightly clipped, blurred, or curved away from
      the camera (cylindrical can wrap).
    • Tiny-print items (vitamin / mineral / preservative tail of
      the list — "Niacin", "Zinc Proteinate", "Mixed Tocopherols",
      "Rosemary Extract", etc.). These are easy to skip but they
      are real ingredients and the merge step depends on you
      surfacing them.
    • Items where you can read the word but it's not 100% sharp.
      Better to list a slightly uncertain reading than to drop it.
- A word that is cut off at the edge of the photo (e.g. "Chicken Me…"
  or "…l, Brown Rice") IS still listed — keep your best read of the
  fragment so the merge step can stitch it.
- If you see a noun-phrase HEADER immediately followed by "(" and a long
  comma-separated list inside parentheses spanning multiple lines in this
  photo (vitamin/mineral premixes, trace minerals, amino acids, probiotics,
  etc. — examples are NOT exhaustive), treat the ENTIRE header + one balanced
  "(" … ")" span as ONE ingredient string — either one array element, or
  consecutive elements that are obvious fragments of the SAME span so the
  merge step can join them. Do NOT split on inner commas into separate
  ingredients unless the label clearly prints those items OUTSIDE the
  parentheses as top-level comma-separated entries.
- Skip sentences and disclaimers ("manufactured", "preserved with",
  "guaranteed analysis", "feeding", "store ", "best by", "may contain",
  AAFCO statements, marketing copy).
- "has_start_anchor": true iff EITHER the literal text "Ingredients:"
  is visible in this photo OR the first ingredient of the recipe is
  visible (typically a protein source — "Chicken", "Beef", "Salmon",
  "Deboned <meat>", "<meat> Meal", "Lamb"...).
- "start_anchor": "ingredients_header" if the header is visible,
  "first_protein" if only the first protein is visible, null if
  neither.
- If no ingredient panel is visible at all, return:
  { "ingredients": [], "has_start_anchor": false, "start_anchor": null }`;

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

  /**
   * Deterministic recovery: LLM merge often drops long legal ingredients
   * printed as "Header (a, b, c, …)" — vitamin/mineral premixes,
   * probiotics, amino packs, chelates, etc. We scan Cloud Vision raw
   * text for (1) high-precision named headers and (2) a generic
   * balanced-parenthesis enumerator with inner heuristics + denylists
   * to avoid GA rows, "(source of …)", and marketing sentences.
   *
   * @param {string} haystack  Raw OCR text (multi-frame join is fine).
   * @param {string[]} ingredientsList  Gemini merge output.
   * @returns {string[]}
   */
  _injectParentheticalPremixFromHaystack(haystack, ingredientsList) {
    const list = Array.isArray(ingredientsList)
      ? ingredientsList.map(s => String(s || '').trim()).filter(Boolean)
      : [];
    const mergeN = list.length;
    const hayHasVitOpen = /\b(?:vitamins?|itamins)\s*\(/i.test(String(haystack || ''));
    const mergeHasVitLine = list.some(s => /^\s*(?:vitamins?|itamins)\s*\(/i.test(String(s)));

    const logSummary = (extra = {}) => {
      const out = extra.out || list;
      const outHasVitLine = out.some(s => /^\s*(?:vitamins?|itamins)\s*\(/i.test(String(s)));
      console.log(
        `[MULTI-OCR] Premix inject summary: haystackLen=${String(haystack || '').length} mergeN=${mergeN} ` +
          `${Object.entries(extra)
            .filter(([k]) => k !== 'out')
            .map(([k, v]) => `${k}=${v}`)
            .join(' ')} ` +
          `haystackVitaminsOpen=${hayHasVitOpen} mergeVitaminsLine=${mergeHasVitLine} outVitaminsLine=${outHasVitLine}`
      );
    };

    if (!haystack || typeof haystack !== 'string' || haystack.length < 40) {
      logSummary({ spans: 0, reason: 'haystack_short_or_empty' });
      return list;
    }

    const spans = this._extractPremixParentheticalSpans(haystack);
    if (spans.length === 0) {
      logSummary({ spans: 0, reason: 'no_spans' });
      return list;
    }

    for (let si = 0; si < spans.length; si++) {
      const s = spans[si];
      const hdr = (s.premixHeader || '').slice(0, 56);
      const pv = `${s.block.slice(0, 88)}${s.block.length > 88 ? '…' : ''}`;
      console.log(
        `[MULTI-OCR] Premix span cand[${si}]: source=${s.source || '?'} ` +
          `haystack=[${s.start},${s.end ?? '?'}) openParen=${s.openParenIdx ?? '?'} ` +
          `header="${hdr}" len=${s.block.length} preview="${pv}"`
      );
    }

    let out = list.slice();
    let skippedDup = 0;
    let inserted = 0;
    for (const span of spans) {
      const { block, start, source, premixHeader, end, openParenIdx } = span;
      if (this._ingredientListAlreadyContainsPremixBlock(out, block)) {
        skippedDup += 1;
        console.log(
          `[MULTI-OCR] Premix span skip_dup: source=${source || '?'} ` +
            `haystack=[${start},${end ?? '?'}) header="${(premixHeader || '').slice(0, 56)}"`
        );
        continue;
      }
      const insertAt = this._premixInsertIndex(haystack, out, start);
      out.splice(insertAt, 0, block);
      inserted += 1;
      const pv = `${block.slice(0, 72)}${block.length > 72 ? '…' : ''}`;
      console.log(
        `[MULTI-OCR] Paren-cluster inject @${insertAt}: source=${source || '?'} ` +
          `haystack=[${start},${end ?? '?'}) openParen=${openParenIdx ?? '?'} ` +
          `header="${(premixHeader || '').slice(0, 56)}" "${pv}"`
      );
    }
    logSummary({ spans: spans.length, skippedDup, inserted, out });
    return out;
  }

  /** Lowercase + collapse whitespace for fuzzy substring tests. */
  _normIngHay(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  _isLikelyGaRegionBefore(haystack, headerStartIdx, opts = {}) {
    const win = opts.narrowWindow === true ? 90 : 260;
    const lo = Math.max(0, headerStartIdx - win);
    const slice = haystack.slice(lo, headerStartIdx);
    return (
      /\bGuaranteed\s+Analysis\b/i.test(slice) ||
      /\bAnalytical\s+(?:constituents|components)\b/i.test(slice) ||
      /\bTypical\s+Analysis\b/i.test(slice) ||
      /\bCalorie\s+Content\b/i.test(slice) ||
      /\bNutritional\s+Additives\b/i.test(slice) ||
      /\bCrude\s+Protein\b[\s\S]{0,120}%/i.test(slice)
    );
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

  /**
   * Snap a parenthetical line to the literal balanced "(…)" span found in
   * raw OCR / rawIngredientsText so dropped prefixes (MODIFIED …) or
   * invented inner tokens (, WATER) can be corrected when the source text
   * still contains the true span.
   */
  _reconcileParenLineFromRaw(rawOrHaystack, line) {
    const trimmed = String(line || '').trim();
    const open = trimmed.indexOf('(');
    if (open <= 0) return trimmed;
    if (trimmed.lastIndexOf(')') <= open) return trimmed;
    const rawS = String(rawOrHaystack || '');
    if (rawS.length < 40) return trimmed;
    const words = trimmed
      .slice(0, open)
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!words.length) return trimmed;
    for (let take = words.length; take >= 1; take -= 1) {
      const h = words.slice(-take).join(' ');
      if (h.length < 3) continue;
      const esc = h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(esc + '\\s*\\(', 'gi');
      let m;
      while ((m = re.exec(rawS)) !== null) {
        let start = m.index;
        const openIdx = m.index + m[0].length - 1;
        if (rawS[openIdx] !== '(') continue;
        while (start > 0) {
          const c = rawS[start - 1];
          if (c === '\n' || c === '\r') break;
          if (c === ',' || c === ';') break;
          if (/[A-Za-z0-9'\-.]/.test(c) || c === ' ') start -= 1;
          else break;
        }
        const closeIdx = this._closingParenIndex(rawS, openIdx);
        if (closeIdx === -1) continue;
        const candidate = rawS
          .slice(start, closeIdx + 1)
          .replace(/\s+/g, ' ')
          .trim();
        if (candidate.length < 8 || candidate.length > 2200) continue;
        const nC = candidate.replace(/\s+/g, ' ').toLowerCase();
        const nT = trimmed.replace(/\s+/g, ' ').toLowerCase();
        if (nC === nT) continue;
        const ratio = candidate.length / Math.max(trimmed.length, 1);
        if (ratio > 1.45 && take < words.length) continue;
        if (ratio > 1.55) continue;
        return candidate;
      }
    }
    return trimmed;
  }

  _reconcileListParenFromRaw(rawOrHaystack, list) {
    if (!Array.isArray(list) || list.length === 0) return list;
    const hay = String(rawOrHaystack || '');
    if (hay.length < 50) return list;
    return list.map(line => this._reconcileParenLineFromRaw(hay, line));
  }

  /**
   * Headers that almost always introduce a comma-enumerated premix on
   * pet-food labels. Matches here are validated with _isDeniedParenHeader
   * and _parenInnerLooksLikePremix; they are NOT subject to GA-region
   * lookback (that heuristic is only for the generic "(" walk in branch B).
   */
  _namedParenPremixRegexes() {
    return [
      // "Vitamins (" / "Vitamin (" — also colon or line-break before '(' (common on labels).
      /\bVitamins?\s*(?:\n\s*)?\s*\(/gi,
      /\bVitamins?\s*:\s*\(/gi,
      // OCR drops leading V on "Vitamins"
      /\bitamins\s*(?:\n\s*)?\s*\(/gi,
      /\bitamins\s*:\s*\(/gi,
      /\bMinerals?\s*(?:\n\s*)?\s*\(/gi,
      /\bMinerals?\s*:\s*\(/gi,
      /\bTrace\s+Minerals?\s*(?:\n\s*)?\s*\(/gi,
      /\bTrace\s+Minerals?\s*:\s*\(/gi,
      /\bAmino\s+Acids?\s*(?:\n\s*)?\s*\(/gi,
      /\bAmino\s+Acids?\s*:\s*\(/gi,
      /\bProbiotics?\s*(?:\n\s*)?\s*\(/gi,
      /\b(?:Direct-?fed\s+)?Microbials?\s*(?:\n\s*)?\s*\(/gi,
      /\bEnzymes?\s*(?:\n\s*)?\s*\(/gi,
      /\bChelated\s+Minerals?\s*(?:\n\s*)?\s*\(/gi,
      /\b(?:Trace\s+)?Elements?\s*(?:\n\s*)?\s*\(/gi,
      /\bMicronutrients?\s*(?:\n\s*)?\s*\(/gi,
      /\bNutrient\s+(?:Premix|Blend|Package)\s*(?:\n\s*)?\s*\(/gi,
      /\bElectrolytes?\s*(?:\n\s*)?\s*\(/gi,
      /\bPreservatives?\s*(?:\n\s*)?\s*\(/gi,
      /\bNatural\s+Flavors?\s*(?:\n\s*)?\s*\(/gi,
      /\b(?:Added\s+)?(?:Vitamins|Minerals)\s+and\s+Minerals\s*(?:\n\s*)?\s*\(/gi,
    ];
  }

  /** Reject marketing / GA / facility / allergen clause openers. */
  _isDeniedParenHeader(header) {
    const h = this._normIngHay(header);
    if (h.length < 2 || h.length > 80) return true;
    return (
      /^(manufactured|guaranteed|feeding|storage|distributor|packaged|processed|allergen|warning|disclaimer|not\s+for|for\s+use|questions|contact|website|best\s+by|use\s+by)/i.test(
        h
      ) ||
      /^(contains|may\s+contain|ingredients)\s*$/i.test(h) ||
      /\b(guaranteed|analysis|calorie\s+content)\b/i.test(h) ||
      /^crude\b/i.test(h) ||
      /^if\s+/i.test(h)
    );
  }

  /**
   * Walk back from '(' to capture a plausible header noun phrase
   * (letters/digits/punctuation used in ingredient names). Includes
   * multiple words separated by spaces (e.g. "PARMESAN CHEESE (…)")
   * but stops at comma/semicolon/newline so the previous ingredient
   * is not absorbed — older logic stopped at the first space and
   * mis-attributed headers as "CHEESE" only.
   * @returns {{ headerStart: number, header: string } | null}
   */
  _walkBackParenHeader(text, openParenIdx) {
    const MAX_HEADER = 80;
    let j = openParenIdx - 1;
    while (j >= 0 && /\s/.test(text[j])) j--;
    if (j < 0) return null;

    const idChar = /[A-Za-z0-9.\-&'\/]/;
    let k = j;

    const collectWord = () => {
      while (k >= 0 && idChar.test(text[k])) k--;
    };
    collectWord();
    let start = k + 1;

    while (start > 0) {
      let p = start - 1;
      while (p >= 0 && /\s/.test(text[p])) p--;
      if (p < 0) break;
      const c = text[p];
      if (c === ',' || c === ';' || c === '\n' || c === '\r') break;
      if (!idChar.test(c)) break;
      k = p;
      collectWord();
      const nextStart = k + 1;
      const cand = text.slice(nextStart, openParenIdx).replace(/\s+/g, ' ').trim();
      if (cand.length > MAX_HEADER) break;
      start = nextStart;
    }

    const header = text.slice(start, openParenIdx).replace(/\s+/g, ' ').trim();
    if (header.length < 2 || header.length > MAX_HEADER) return null;
    if (!/[A-Za-z]/.test(header)) return null;
    return { headerStart: start, header };
  }

  /** Inner text of parentheses looks like a premix / cluster, not "(min 5%)". */
  _parenInnerLooksLikePremix(header, inner) {
    const hi = this._normIngHay(inner);
    const commas = (hi.match(/[,;·]/g) || []).length;
    const len = hi.length;

    if (len < 18) return false;
    if (/\bmin\b.*%|\bmax\b.*%|\bnot\s+less\s+than\b.*%/i.test(hi) && commas <= 2 && len < 90) {
      return false;
    }
    if (/\bcrude\s+(protein|fat|fiber)\b/i.test(hi)) return false;

    // Strong inner vocabulary typical of vitamin/mineral/probiotic tails
    const PREMIX_INNER =
      /(supplement|proteinate|proteinates?|chloride|hydrochloride|mononitrate|thiamine|riboflavin|pyridoxine|pantothenate|folic|folate|biotin|niacin|choline|tocopherol|chelate|chelated|fermentation\s+product|lactobacillus|enterococcus|bacillus|acidophilus|bifidobacterium|streptococcus|subtilis|faecium|licheniformis|ascorb|citrate|oxide|sulfate|selenite|iodate|carbonate|phosphate|polynicotinate|methionine|taurine|lysine|carnitine|glucosamine|chondroitin|extract|derivative|enzyme|lipase|protease|cellulase|amylase)/i;
    if (PREMIX_INNER.test(hi) && (commas >= 2 || len >= 55)) return true;
    if (commas >= 5) return true;
    if (len >= 85 && commas >= 3) return true;

    // Named premix header: same keyword coverage as _namedParenPremixRegexes()
    // (looser inner threshold when header clearly labels a legal cluster).
    if (this._headerLooksLikeNamedPremixKeyword(header) && (commas >= 2 || len >= 48)) {
      return true;
    }

    return false;
  }

  /**
   * Vision sometimes splices two cheese declarations into one `(…)`; reject
   * generic premix candidates whose inner text repeats the same tail.
   */
  _genericInnerLooksLikeScrambledOcrDuplication(inner) {
    const hi = this._normIngHay(inner);
    const cc = (hi.match(/\bcheese\s+cultures\b/g) || []).length;
    if (cc >= 2) return true;
    if (/\bmilk,\s*cheese\s+cultures\b.*\bmilk,\s*cheese\s+cultures\b/i.test(hi)) return true;
    if (/\bcheese\s+milk,\s*cheese\b/i.test(hi)) return true;
    if (/\bcheese\s+cultures\b/i.test(hi) && /\byolks?\b/i.test(hi)) return true;
    if (/\besg\s+yolks?\b/i.test(hi)) return true;
    return false;
  }

  /** OCR line-break garbage glued into a generic premix header. */
  _genericPremixHeaderLooksCorrupt(header) {
    const h = this._normIngHay(header);
    if (/\bcult\s+and\b/i.test(h)) return true;
    if (/\bcheese\s+cult\b/i.test(h)) return true;
    if (/^eat\s+cheese$/i.test(h.trim())) return true;
    if (/^and\s+cheese$/i.test(h.trim())) return true;
    if (/\band\s+cheese\s+cult/i.test(h)) return true;
    return false;
  }

  /**
   * True when header matches any premix opener we scan for in branch A
   * (mirrors _namedParenPremixRegexes intent for inner heuristics).
   */
  _headerLooksLikeNamedPremixKeyword(header) {
    const h = this._normIngHay(header);
    if (h.length < 2 || h.length > 80) return false;
    return (
      /\b(?:vitamins?|itamins)\b/i.test(h) ||
      /\bminerals?\b/i.test(h) ||
      /\btrace\s+minerals?\b/i.test(h) ||
      /\b(?:trace\s+)?elements?\b/i.test(h) ||
      /\bamino\s+acids?\b/i.test(h) ||
      /\bprobiotics?\b/i.test(h) ||
      /\b(?:direct[- ]?fed\s+)?microbials?\b/i.test(h) ||
      /\benzymes?\b/i.test(h) ||
      /\bchelated\s+minerals?\b/i.test(h) ||
      /\bmicronutrients?\b/i.test(h) ||
      /\bnutrient\s+(?:premix|blend|package)\b/i.test(h) ||
      /\belectrolytes?\b/i.test(h) ||
      /\bpreservatives?\b/i.test(h) ||
      /\bnatural\s+flavors?\b/i.test(h) ||
      /\b(?:added\s+)?(?:vitamins|minerals)\s+and\s+minerals\b/i.test(h)
    );
  }

  _wholeBlockLooksDisclaimed(block) {
    const b = this._normIngHay(block);
    return (
      /\bmanufactured\s+in\b/i.test(b) ||
      /\bmay\s+contain\s+traces\b/i.test(b) ||
      /\bthis\s+is\s+a\s+naturally\b/i.test(b)
    );
  }

  /**
   * Generic "(" walk matched too wide a balanced span (nested cheese lines,
   * allergen banners spliced into OCR). Reject before inject.
   */
  _genericParenBlockLooksContaminated(block) {
    const b = this._normIngHay(block);
    return (
      /\bcontains\s+milk\b/i.test(b) ||
      /\bcontains\s*:\s*/i.test(b) ||
      /\bmay\s+contain\b/i.test(b) ||
      /\bdist\.?\s*&\s*sold\b/i.test(b) ||
      /\bexclusively\s+by\b/i.test(b) ||
      /\bdistributed\s+by\b/i.test(b) ||
      /\bsold\s+exclusively\b/i.test(b) ||
      /\bnutrition\s+facts\b/i.test(b) ||
      /\bdaily\s+value\b/i.test(b) ||
      /\bshake\s+well\b/i.test(b) ||
      /\brefrigerate\s+after\s+opening\b/i.test(b) ||
      /\bpackaged\s+in\b/i.test(b)
    );
  }

  /**
   * @param {string} haystack
   * @returns {{ block: string, start: number }[]}
   */
  _extractPremixParentheticalSpans(haystack) {
    const collectFromText = text => {
      const spans = [];
      const seen = new Set();
      let genericSpanPushed = 0;

      const pushSpan = (start, closeIdx, rawBlock, diag = {}) => {
        let block = String(rawBlock || '')
          .replace(/\s+/g, ' ')
          .trim();
        if (block.length < 48) return;
        if (this._wholeBlockLooksDisclaimed(block)) return;
        if (/\bcrude\s+(protein|fat|fiber)\b/i.test(block)) return;
        if (diag.source === 'generic') {
          const GENERIC_PREMIX_MAX = 950;
          if (block.length > GENERIC_PREMIX_MAX) return;
          if (this._genericParenBlockLooksContaminated(block)) return;
          if (genericSpanPushed >= 1) return;
        }
        const key = block.toLowerCase().slice(0, 140);
        if (seen.has(key)) return;
        seen.add(key);
        if (diag.source === 'generic') genericSpanPushed += 1;
        spans.push({
          block,
          start,
          end: closeIdx + 1,
          source: diag.source || 'unknown',
          premixHeader: String(diag.header || '').replace(/\s+/g, ' ').trim(),
          openParenIdx: typeof diag.openParenIdx === 'number' ? diag.openParenIdx : -1,
        });
      };

      // --- A) Named high-precision headers ---
      for (const re of this._namedParenPremixRegexes()) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text)) !== null) {
          const start = m.index;
          const openIdx = m.index + m[0].length - 1;
          if (text[openIdx] !== '(') continue;
          const header = text.slice(start, openIdx).replace(/\s+/g, ' ').trim();
          // Named regexes are ingredient-panel headers only; GA lookback
          // produced false negatives for probiotics, minerals, flavors, etc.
          // when Crude Protein / Calorie Content appeared above on the label.
          const closeIdx = this._closingParenIndex(text, openIdx);
          if (closeIdx === -1) continue;
          const inner = text.slice(openIdx + 1, closeIdx);
          if (this._isDeniedParenHeader(header)) continue;
          if (!this._parenInnerLooksLikePremix(header, inner)) continue;
          pushSpan(start, closeIdx, text.slice(start, closeIdx + 1), {
            source: 'named',
            header,
            openParenIdx: openIdx,
          });
        }
      }

      // --- B) Generic: any '(' with a plausible header + enumerator inner ---
      for (let i = 0; i < text.length; i++) {
        if (text[i] !== '(') continue;
        if (this._isLikelyGaRegionBefore(text, i)) continue;
        const wb = this._walkBackParenHeader(text, i);
        if (!wb) continue;
        if (this._isDeniedParenHeader(wb.header)) continue;
        const hw = wb.header.trim().split(/\s+/).filter(Boolean);
        if (hw.length > 3) continue;
        if (this._genericPremixHeaderLooksCorrupt(wb.header)) continue;
        const closeIdx = this._closingParenIndex(text, i);
        if (closeIdx === -1) continue;
        const inner = text.slice(i + 1, closeIdx);
        if (!this._parenInnerLooksLikePremix(wb.header, inner)) continue;
        if (this._genericInnerLooksLikeScrambledOcrDuplication(inner)) continue;
        // Skip very common short sourcing clauses
        if (/^source\s+of\b/i.test(this._normIngHay(inner)) && inner.length < 120) continue;
        pushSpan(wb.headerStart, closeIdx, text.slice(wb.headerStart, closeIdx + 1), {
          source: 'generic',
          header: wb.header,
          openParenIdx: i,
        });
      }

      spans.sort((a, b) => a.start - b.start);
      // Drop near-duplicates (OCR doubled the same line)
      const merged = [];
      for (const s of spans) {
        const prev = merged[merged.length - 1];
        if (!prev) {
          merged.push(s);
          continue;
        }
        if (Math.abs(s.start - prev.start) <= 2 && s.block === prev.block) continue;
        if (prev.block.length >= 60 && s.block.includes(prev.block.slice(0, 40))) continue;
        merged.push(s);
      }
      return merged;
    };

    const a = collectFromText(haystack);
    if (a.length) return a;
    const flattened = haystack.replace(/[\r\n]+/g, ' ');
    return collectFromText(flattened);
  }

  _ingredientListAlreadyContainsPremixBlock(list, block) {
    const nb = this._normIngHay(block);
    if (nb.length < 24) return true;
    const head = nb.slice(0, Math.min(56, nb.length));
    return list.some(ing => {
      const ni = this._normIngHay(ing);
      if (ni.includes(head)) return true;
      if (head.length >= 28 && ni.length >= 50 && ni.slice(0, 28) === nb.slice(0, 28)) return true;
      return false;
    });
  }

  /**
   * Pick splice index so the premix lands near its printed neighbours.
   * Falls back to near-tail when OCR alignment is weak.
   */
  _premixInsertIndex(haystack, list, blockStart) {
    let bestI = -1;
    let bestPos = -1;
    for (let i = 0; i < list.length; i++) {
      const ing = list[i];
      if (!ing || ing.length < 5) continue;
      const p = haystack.lastIndexOf(ing, Math.max(0, blockStart - 1));
      if (p === -1) continue;
      if (p + ing.length <= blockStart && p >= bestPos) {
        bestPos = p;
        bestI = i;
      }
    }
    if (bestI >= 0) return bestI + 1;
    return Math.max(0, list.length - 3);
  }

  /** Stable capture order for Stage 1 → Stage 2 handoff. */
  _sortFramesByCaptureOrder(frames) {
    if (!Array.isArray(frames)) return [];
    return frames.slice().sort((a, b) => (a.frameIndex || 0) - (b.frameIndex || 0));
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
   * Cloud Vision returns EVERYTHING visible in the photo — the
   * ingredient panel, nutrition facts, marketing copy, disclaimer
   * paragraphs, even barcode digits. The first job of this prompt is
   * to discard all of that noise; the second is to do the same
   * "anchor → walk forward, stitch seams" reconstruction the older
   * merge prompt did.
   */
  async _mergeRawTextWithGemini(frames, totalFrameCount) {
    const framesBlock = frames
      .map(
        f =>
          `Photo ${f.frameIndex} (raw OCR):\n${this._structuralOcrHintsForMerge(f.rawText)}"""\n${f.rawText}\n"""`
      )
      .join('\n\n');

    const prompt = `You are reconstructing the ingredient panel of a pet-food
package from raw OCR text dumps of ${frames.length} photos that the
user took while rotating the package in their hand. Each dump
contains EVERYTHING the camera saw in that frame — the ingredient
panel itself, plus nutrition facts, AAFCO statements, feeding
guidelines, marketing copy, barcode digits, sometimes random package
text. Your job is to extract just the ingredient list, in the
correct order, from across all the dumps.

Photos are listed in capture / rotation order — the user rotated in
ONE direction, so consecutive photos are rotationally adjacent on
the can / pouch.

Each photo may start with a single server line "[merge_hints: …]"
listing cheap regex hits detected in THAT dump's text (e.g.
guaranteed_analysis, ingredients_header). Use hints only as weak
structure — the quoted OCR body always wins if they disagree.

REGION SEPARATION (do this mentally before step 1):
Many frames interleave two vertical columns or adjacent blocks: (A)
regulatory analysis (Guaranteed / Typical / Analytical constituents,
Crude Protein/Fat/Fiber, Moisture with min/max and %, Calorie Content)
and (B) the ingredient statement under "Ingredients:". OCR reading
order can splice them into one linear stream. GA rows are NOT
ingredients: they pair a nutrient label with regulatory min/max and a
percentage. Ingredient premix lines ("Vitamins (...)", "Minerals (...)",
etc.) enumerate additives by name inside parentheses — they are NOT
GA moisture rows even if the word "Moisture" or "Crude" leaked in from
a neighboring column. Never attach GA headers to premix parentheses.
Human FDA panels (dressings, sauces, beverages) may splice in
"Nutrition Facts", "Serving size", "% Daily Value", shake/refrigerate
lines, distributor blocks, SKU, or a duplicated "INGREDIENTS:" — never
emit those as ingredients or merge them into one ingredient string.

RAW OCR DUMPS:

${framesBlock}

Procedure (in priority order):

  0. MAP REGIONS (silent, mandatory). For each photo, mark which spans
     are GA / calorie / feeding vs true ingredient-list narrative. When
     two printed regions collide in the OCR text, follow the
     Ingredients: comma-list continuity — do not pull GA table rows into
     the ingredient output. This step must NOT cause you to omit any
     legal parenthetical premix cluster from the dumps (vitamins,
     minerals, probiotics, enzymes, natural flavors, preservatives, etc.
     — see 3b), even if merge_hints lists guaranteed_analysis for the
     same photo.

  1. ANCHOR THE START. Scan all dumps for a clear start signal:
       a. The literal text "Ingredients:" (or "INGREDIENTS:",
          "Ingredients :"). The first ingredient is the noun phrase
          immediately after it.
       b. Else the first ingredient of the recipe — typically a
          protein source ("Chicken", "Beef", "Salmon", "Deboned
          <meat>", "<meat> Meal", "Lamb", "Turkey"...).
       c. Else use Photo 1 as the start and lower confidence; set
          missing_section: "start".

  2. WALK FORWARD from the anchor through the rotational order,
     hopping into adjacent photos using overlapping ingredients as
     seams. The same ingredient often appears at the END of one
     photo and the START of the next, possibly with one of the two
     views being a partial fragment (e.g. "Chicken Me…" vs
     "…al, Brown Rice"). Treat those as ONE ingredient; combine
     using the overlap. Do not list both halves.

  3. KEEP SINGLETONS. If an ingredient appears in only ONE of the
     raw dumps and nowhere else, INCLUDE IT. A single appearance is
     not noise — it just means that section of the panel was only
     captured by one photo. Tail-of-panel items (vitamins,
     minerals, preservatives like "Niacin", "Zinc Proteinate",
     "Mixed Tocopherols", "Rosemary Extract") are especially common
     in the singleton bucket because the print is small.

  3b. PARENTHETICAL ENUMERATION = ONE INGREDIENT (critical).
     Labels often print ONE legal ingredient as: a short HEADER (noun
     phrase) immediately followed by "(" then many comma-separated
     sub-items ending with ")", wrapping across 2+ physical lines.
     Examples include but are NOT limited to: "Vitamins (...)",
     "Minerals (...)", "Trace Minerals (...)", "Amino Acids (...)",
     probiotic/enzyme clusters, etc. Raw OCR splits these across lines
     or across adjacent photos (small type, left edge of a can).
     You MUST: (a) concatenate fragments until the closing ")" that
     balances the "(" that opened right after the header; (b) output
     exactly ONE string in "ingredients" for that block; (c) do NOT
     explode inner commas into separate top-level ingredients unless
     the label clearly prints them outside the parentheses; (d) NEVER
     drop this block because inner tokens resemble a Guaranteed
     Analysis table — it is still part of the ingredient list when it
     follows the ingredient narrative, even if GA text appears earlier
     in the same OCR dump. Reject ONLY when the "(" … ")" block is
     clearly the GA table itself (percentages, min/max for crude
     nutrients on those lines).

  4. EXCLUDE non-ingredient text. Discard anything that is clearly:
       - "Guaranteed Analysis" / "Crude Protein" / "Crude Fat" /
         "Crude Fiber" / "Moisture" **as regulatory GA rows** (with
         min/max and % on those lines).
       - FDA human-food panels: "Nutrition Facts", "Serving size",
         "Amount per serving", "Calories per serving", "% Daily Value",
         "Total Fat", "Saturated Fat", "Trans Fat", "Cholesterol",
         "Total Carbohydrate", "Dietary Fiber", "Total Sugars",
         "Added Sugars", "Protein", "Vitamin D", "Calcium", "Iron",
         "Potassium", "Includes X Added Sugars" when part of the facts table.
       - "SHAKE WELL", "REFRIGERATE AFTER OPENING", "DIST. & SOLD",
         "Distributed by", "SKU", long certifier / organic audit boilerplate,
         duplicated marketing "INGREDIENTS:" repeats not part of the real list.
       - "Feeding Guidelines" / "Storage" / "Best By" / "Made in".
       - AAFCO statements ("complete and balanced for all life
         stages", "formulated to meet the nutritional levels...").
       - Marketing copy ("naturally preserved", "real chicken
         #1 ingredient", "no fillers").
       - Disclaimers ("manufactured in a facility that...",
         "may contain traces of...").
       - Barcode digits, batch codes, weights ("12 oz", "340g").
       - Brand names, product names, and recipe names (those are
         already known from the front label).

  5. DEDUPLICATE case-insensitively across photos. Treat clearly
     different items as distinct ("Chicken Meal" vs "Chicken
     By-Product Meal" → keep both).

  6. NEVER alphabetise. NEVER sort by length / plausibility. NEVER
     fall back to "the order I happened to encounter ingredients
     across the dumps". Only the panel's printed order is correct.

  7. COVERAGE AUDIT (critical). After you build the ordered list,
     skim every raw dump again for ingredient-style lines in the
     panel (comma-separated noun phrases). If a phrase clearly appears
     as an ingredient in any dump but is missing from your output —
     and it is not an exact duplicate of an item you already merged —
     INSERT it in the correct position using neighboring items as
     glue. When torn between dropping vs keeping a borderline line,
     KEEP it; a spurious extra item is less harmful than silently
     losing a real ingredient users compare against the label.

VERBATIM INTEGRITY: Preserve parenthetical content and leading qualifiers
(MODIFIED, cultured, organic, etc.) as in the raw dumps. Do not invent
inner enumerators or collapse official headers; when wording differs between
noise and the ingredient narrative, prefer the exact ingredient-line wording.

Return ONLY this JSON (no prose, no code fences):
{
  "ingredients":      ["...", "...", ...],
  "is_complete":      true | false,
  "confidence":       0.0,
  "missing_section":  "start" | "middle" | "end" | null,
  "notes":            "brief reason for confidence/missing"
}

Confidence calibration:
  0.90–1.00  start anchor visible AND a natural end marker reached
             (preservatives line / AAFCO statement / disclaimer)
  0.70–0.90  one of start anchor or end marker missing
  0.50–0.70  both missing but the chain stitched cleanly
  0.30–0.50  significant gaps, multiple un-stitched fragments
  0.00–0.30  too little usable text — recommend recapture

is_complete = true ONLY when BOTH a start anchor and a natural end
marker are present in the final list.

missing_section:
  "start"  → no start anchor in any photo
  "end"    → list cuts off mid-word, no closing marker
  "middle" → unrecoverable gap between adjacent photos
  null     → list looks complete`;

    const result = await this.model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.0, candidateCount: 1 },
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

    const prompt = `You are merging ${frames.length} partial ingredient lists OCR'd
from ${totalFrameCount} photos of the same pet-food package as the user
rotated it in their hand. Each list preserves the LOCAL reading order
within its photo. Lists overlap at rotational seams — the same
ingredient may appear at the end of one photo and at the start of the
next, possibly with one of the two views being a partial fragment.

The photos are listed in capture / rotation order. Photo "[START
ANCHOR: ...]" tags mark frames where you (the OCR pass) saw the
panel's start — either the literal "Ingredients:" header or the
first protein-source ingredient. Use those tags as your starting
point.

PARTIAL LISTS:

${framesBlock}

Reconstruct the COMPLETE, deduplicated, ordered ingredient list as
printed on the panel.

REGULATORY vs INGREDIENT: A partial list may still contain Guaranteed
Analysis-style lines ("Crude Protein", "Moisture (max) …%") if the
per-frame OCR bled columns together. Those are NOT ingredients — drop
them. Ingredient premix clusters ("Vitamins (...)", "Minerals (...)")
remain ingredients; never replace their header with GA words like
"Moisture" just because GA lines appeared nearby in the same frame.

FDA HUMAN-FOOD NOISE (dressings, sauces, beverages): partial lists may
also contain "Nutrition Facts", "Serving size", "% Daily Value",
"SHAKE WELL", "REFRIGERATE", "DIST. & SOLD", SKU lines, or a second
"INGREDIENTS:" repeat — never merge those into a single ingredient
string; drop them entirely from output.

Procedure (in priority order):

  1. ANCHOR: pick the starting frame.
       a. Prefer a frame tagged [START ANCHOR: ingredients_header].
       b. Else prefer a frame tagged [START ANCHOR: first_protein].
       c. Else use the frame whose first item is the most likely
          first-ingredient (a protein source — "Chicken", "Beef",
          "Salmon", "Deboned <meat>", "<meat> Meal", "Lamb"...).
       d. Else use Photo 1 and lower confidence.
  2. WALK FORWARD from the anchor, hopping into adjacent frames using
     overlapping ingredients as the seam. The user rotated in ONE
     direction, so consecutive photos are rotationally adjacent.
  3. STITCH fragments: a word broken across photos ("Chicken Me" +
     "al, Brown Rice…") is ONE ingredient — combine using the
     overlap. Do not list both halves.
  4. DEDUPLICATE case-insensitively. Treat clearly different items
     as distinct ("Chicken Meal" vs "Chicken By-Product Meal").
  5. KEEP SINGLETONS. If an ingredient appears in only ONE of the
     partial lists and nowhere else, INCLUDE IT in the final list.
     A single appearance is NOT noise — it just means that section
     of the panel was only captured by one photo (small print at
     the tail of the list, items at the edge of a frame, etc.).
     Position it using the surrounding ingredients in the frame
     where it appeared.

  5b. PARENTHETICAL ENUMERATION (same intent as raw-merge 3b). Any printed
     HEADER "(" long comma-list ")" cluster is ONE ingredient even if
     wrapped or split across partial lists / photos — reassemble; do
     not drop or explode inner commas. GA rows use min/max and % for
     crude nutrients; premix lines list additive names — if both appear
     intertwined in a partial list, keep premix as ingredients and drop
     GA table lines.

  6. NEVER alphabetise. NEVER sort by length or plausibility. NEVER
     fall back to "the order I happened to encounter ingredients
     across the lists". Only the panel's printed order is correct.

  7. COVERAGE AUDIT (critical). After merging, re-read every partial
     list. If an ingredient line appears in exactly one photo and is
     absent from your final output — and it is not a duplicate of an
     adjacent merged line — add it back in the right place. When
     unsure whether to keep a line, KEEP it.

VERBATIM INTEGRITY: Preserve parenthetical content and leading qualifiers
(MODIFIED, cultured, organic, etc.) as in the partial lists. Do not invent
inner enumerators or collapse official headers; prefer exact wording from the
source lists when stitching.

Return ONLY this JSON (no prose, no code fences):
{
  "ingredients":      ["...", "...", ...],
  "is_complete":      true | false,
  "confidence":       0.0,
  "missing_section":  "start" | "middle" | "end" | null,
  "notes":            "brief reason for confidence/missing"
}

Confidence calibration:
  0.90–1.00  start anchor visible AND a natural end marker reached
             (preservatives line / AAFCO statement / disclaimer)
  0.70–0.90  one of start anchor or end marker missing
  0.50–0.70  both missing but the chain stitched cleanly
  0.30–0.50  significant gaps, multiple un-stitched fragments
  0.00–0.30  too little data — recommend recapture

is_complete = true ONLY when BOTH a start anchor and a natural end
marker are present in the final list.

missing_section:
  "start"  → no start anchor in any photo
  "end"    → list cuts off mid-word, no closing marker
  "middle" → unrecoverable gap between adjacent photos
  null     → list looks complete`;

    const result = await this.model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.0, candidateCount: 1 },
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
          Buffer.from('multiocr-merge-ga-sep-v14', 'utf8'),
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
    return `You are reading the ingredient panel of a pet-food package from
${frameCount} photos taken as the user rotated it in their hand. Use
all photos together to reconstruct the panel.

Photos are given in CAPTURE order (photo 1 first, photo ${frameCount} last)
as the user rotated the package in one direction. They are NOT
guaranteed to start at the panel's first ingredient — the user could
have started rotating from any point on the can.

What to expect:
- The same ingredient may appear in several photos (label wrap).
- Some photos may be redundant; some parts of the panel may be missing.
- Words may break across photos (e.g. "Chicken Me" / "al, Brown Rice").

Produce ONE deduplicated, ordered list of ingredient names as they
appear on the panel. This is data extraction, not transcription —
output a structured list, not a copy of the printed paragraph.

Return ONLY this JSON object (no prose, no code fences):
{
  "ingredients":      ["...", "...", ...],
  "is_complete":      true | false,
  "confidence":       0.0,
  "missing_section":  "start" | "middle" | "end" | null,
  "notes":            "brief reason for confidence/missing"
}

═══════════════════════════════════════════════════
ORDER (most important step — do this first)
═══════════════════════════════════════════════════
Pet-food panels list ingredients in descending order by weight, and
that order drives our nutrition scoring, so getting it wrong is
worse than missing an ingredient.

Reconstruct order with this procedure, in this exact priority:

  1. ANCHOR THE START. Scan all photos for a clear "start signal":
       a. The literal text "Ingredients:" (or "Ingredients :") —
          the first ingredient is the noun phrase right after it.
       b. If no header is visible, use the first ingredient of
          the recipe (typically a meat: "Chicken", "Beef", "Salmon",
          "Deboned <meat>", "<meat> Meal", "Lamb"…). Pet-food panels
          almost always start with the protein source.
       c. If neither (a) nor (b) is visible in any photo, set
          "missing_section": "start" and lower confidence; sequence
          the rest the best you can.

  2. WALK FORWARD FROM THE ANCHOR. Once you know which photo / position
     the first ingredient is in, follow the panel's natural reading
     order from there, jumping between photos as the text wraps.
     Use overlapping ingredients (the same name appearing in two
     adjacent photos) as your guide — that overlap is your seam.

  3. NEVER fall back to "list ingredients in the order I happened
     to read them across photos". Photo order ≠ label order.

  4. NEVER alphabetise, never sort by length, never reorder by
     plausibility. Only the panel's printed order is correct.

═══════════════════════════════════════════════════
DEDUPLICATION
═══════════════════════════════════════════════════
- Same ingredient appearing in multiple photos → list it once.
- Match case-insensitively ("Chicken Meal" = "chicken meal").
- A word broken across photos ("Chicken Me" + "al") is still ONE
  ingredient — stitch it together using the overlap.
- Treat clearly different items as distinct ("Chicken Meal" vs
  "Chicken By-Product Meal" → keep both).

═══════════════════════════════════════════════════
WORD CHOICE
═══════════════════════════════════════════════════
- Use the wording printed on the panel (e.g. keep "By-Product Meal",
  do not rename it to "Meal").
- If different photos disagree on a word due to glare or blur, take
  the version from the clearest photo.
- If you are unsure of a word, keep your best read, lower the
  confidence score, and mention the uncertainty in "notes".

═══════════════════════════════════════════════════
WHAT TO INCLUDE / EXCLUDE
═══════════════════════════════════════════════════
- Each entry is a short noun phrase naming one ingredient.
- Skip sentences and disclaimers, e.g. "manufactured", "processed in",
  "facility that", "preserved with", "guaranteed analysis", "feeding
  guidelines", "store ", "best by", "may contain", "this product",
  "this is", AAFCO statements, marketing copy.
- If no real ingredient list is visible, return ingredients: [].

═══════════════════════════════════════════════════
COMPLETENESS
═══════════════════════════════════════════════════
"is_complete": true ONLY if BOTH visible:
  - START: an "Ingredients:" header OR clearly the first ingredient
  - END:   a natural closing — preservative line (e.g. "Mixed
    Tocopherols", "Rosemary Extract"), AAFCO statement, or a
    disclaimer / copyright paragraph

"missing_section":
  - "start"  → header / first ingredient never visible
  - "end"    → list cuts off mid-word, no closing marker
  - "middle" → visible gap between captured photos
  - null     → list looks complete

═══════════════════════════════════════════════════
CONFIDENCE
═══════════════════════════════════════════════════
0.90–1.00  clearly complete, all words readable, end marker present
0.70–0.90  looks complete, a few words slightly blurry
0.50–0.70  mostly captured, 1–2 ingredients uncertain
0.30–0.50  significant gaps or many uncertain ingredients
0.00–0.30  too little data — recommend recapture

If nothing usable is visible, return:
  {"ingredients":[], "is_complete":false, "confidence":0.0,
   "missing_section":null, "notes":"<why>"}`;
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
    return `Task: extract the ingredient panel from ${frameCount} photos of a
pet-food package taken from different angles, and emit it as
structured data only. Do not reproduce any other paragraphs from the
package — only the ordered ingredient names belong in the output.

Photos are in capture order (photo 1 oldest, photo ${frameCount} newest)
as the user rotated the package. Capture order is NOT label reading
order. To rebuild the panel:

  step 1 — find the START: the photo containing "Ingredients:"
           (or the first protein-source ingredient like "Chicken",
           "Beef", "Salmon", "Deboned Chicken", "Chicken Meal",
           "Lamb", etc.). That is item index 0.
  step 2 — walk FORWARD from that anchor through the panel's
           natural reading order, hopping between photos using
           overlapping (duplicated) ingredients as seams.
  step 3 — drop every duplicate; stitch words split across photos
           ("Chicken Me" + "al" → "Chicken Meal").
  step 4 — never alphabetise, never sort by length / plausibility.
           Only the panel's printed order is correct.

If the start anchor never appears in any photo, set
"missing": "start" and lower "score".

Skip sentences / disclaimers / nutrition statements / marketing copy.

Return ONLY this JSON (no markdown, no commentary):
{
  "items": [ { "name": "..." }, { "name": "..." } ],
  "panel_only": true,
  "complete": true | false,
  "missing": "start" | "middle" | "end" | null,
  "score": 0.0,
  "note": "short explanation"
}

Rules:
- "items" is descending order by weight, exactly as on the panel.
- One short noun phrase per item (e.g. "Chicken Meal", "Brown Rice").
- Use the wording printed on the panel; if a word is unclear, keep
  your best read and lower "score".
- "complete": true only when both an "Ingredients:" opener (or first
  ingredient) and a natural end marker (preservatives line / AAFCO
  statement / disclaimer paragraph) are visible.
- If nothing usable is visible:
  { "items": [], "panel_only": true, "complete": false,
    "missing": null, "score": 0.0, "note": "<why>" }`;
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

