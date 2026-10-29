const { v4: uuidv4 } = require('uuid');
const { query } = require('../database/connection');
const geminiService = require('./geminiService');
const ingredientAnalyzer = require('./ingredientAnalyzer');
const tokenService = require('./tokenService');
const { notifyLookup } = require('./lookupNotify');

const BANNED_HOSTS = ['reddit.com', 'facebook.com', 'instagram.com', 'youtube.com', 'youtu.be', 'quora.com', 'tiktok.com', 'pinterest.com', 'x.com', 'twitter.com'];
const VALID_RECS = new Set(['highly_recommended', 'recommended', 'acceptable', 'caution', 'not_recommended']);

function norm(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function stripUrl(raw) {
  try {
    const url = new URL(String(raw).trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith('utm_')) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return null;
  }
}

function hostOf(raw) {
  try {
    return new URL(raw).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function isBanned(raw) {
  const host = hostOf(raw);
  return BANNED_HOSTS.some((banned) => host === banned || host.endsWith(`.${banned}`));
}

function parseModelJson(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Model did not return JSON');
  return JSON.parse(body.slice(start, end + 1));
}

function asNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const match = value.match(/-?\d+(\.\d+)?/);
  if (!match) return null;
  const n = Number(match[0]);
  return Number.isFinite(n) ? n : null;
}

function looksLikeReviews(ingredients) {
  const text = ingredients.join(' ').toLowerCase();
  const hits = text.match(/\b(reviews?|customers?|stars?|ratings?)\b/g) || [];
  return hits.length >= 2;
}

function validateExtracted(extracted) {
  if (!extracted || typeof extracted !== 'object') return { ok: false, reason: 'no_label_text' };
  const sourceUrl = stripUrl(extracted.sourceUrl || extracted.source_url || '');
  if (!sourceUrl || isBanned(sourceUrl)) return { ok: false, reason: 'no_source' };
  const ingredients = Array.isArray(extracted.ingredients)
    ? extracted.ingredients.map((item) => String(item || '').trim()).filter((item) => item && item.length < 80)
    : [];
  if (ingredients.length < 5 || looksLikeReviews(ingredients)) return { ok: false, reason: 'no_label_text' };
  const ga = extracted.guaranteedAnalysis || extracted.guaranteed_analysis || {};
  const protein = asNumber(ga.protein);
  const fat = asNumber(ga.fat);
  const fiber = asNumber(ga.fiber);
  const moisture = asNumber(ga.moisture);
  if ([protein, fat, fiber, moisture].some((n) => n == null)) return { ok: false, reason: 'no_label_text' };
  return {
    ok: true,
    value: {
      brand: extracted.brand ? String(extracted.brand).slice(0, 200) : null,
      productName: extracted.productName || extracted.product_name || null,
      ingredients,
      guaranteedAnalysis: { protein, fat, fiber, moisture },
      sourceUrl,
      domain: hostOf(sourceUrl),
    },
  };
}

async function grounded(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set');
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(key)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.1 },
      }),
    },
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Gemini search failed');
  const parts = data.candidates?.[0]?.content?.parts || [];
  return parts.map((part) => part.text || '').join('\n');
}

function foodSearchLine({ brand, name, protein, lifeStage, foodForm, url }) {
  const details = [
    brand ? `brand "${brand}"` : '',
    name ? `product "${name}"` : '',
    protein ? `protein "${protein}"` : '',
    lifeStage ? `life stage "${lifeStage}"` : '',
    foodForm ? `${foodForm} food` : '',
  ].filter(Boolean).join(', ');
  if (url) {
    return `- Read only this URL: ${url}
- It must be this food: ${details}. If the page is a different protein, life stage, or dry/wet form, extracted must be null.`;
  }
  return `- Find pages for this food only: ${details}. Do not use a different protein, life stage, or dry/wet form.`;
}

function searchPrompt({ brand, name, protein, lifeStage, foodForm, url, hints, officialOnly }) {
  const hintText = hints ? JSON.stringify(hints) : 'none';
  return `You look up one US pet food from pages that publish the label as text.
Return ONLY JSON, no markdown:
{
  "candidates": [{ "title": string, "brand": string, "url": string }],
  "extracted": null | {
    "brand": string,
    "productName": string,
    "ingredients": string[],
    "guaranteedAnalysis": { "protein": number, "fat": number, "fiber": number, "moisture": number },
    "sourceUrl": string
  }
}
Rules:
- Read guaranteed analysis and ingredients from ONE page. If they are not written as text on that page, extracted must be null.
- Never invent numbers. Never mix two recipes. Never use reviews, Q&A, blogs, Reddit, or social posts.
- ingredients are short noun phrases in label order. If the text contains reviews or star ratings, return extracted null.
- Prefer the brand's official product page over a store page.
- Filter hints are preferences only. If the page disagrees, follow the page. Hints: ${hintText}
${officialOnly ? '- Search only the brand official website.' : ''}
${foodSearchLine({ brand, name, protein, lifeStage, foodForm, url })}
If several different recipes match, return up to 3 candidates and extracted null.
If one page clearly matches and has both lists as text, fill extracted from that page only.`;
}

async function findLabel({ brand, name, protein, lifeStage, foodForm, url, hints, strict }) {
  const first = parseModelJson(await grounded(searchPrompt({ brand, name, protein, lifeStage, foodForm, url, hints, officialOnly: false })));
  const extracted = validateExtracted(first.extracted);
  const candidates = (Array.isArray(first.candidates) ? first.candidates : [])
    .map((item) => {
      const page = stripUrl(item.url);
      if (!page || isBanned(page)) return null;
      return {
        title: String(item.title || item.brand || 'Product').slice(0, 180),
        brand: item.brand ? String(item.brand).slice(0, 120) : null,
        url: page,
        domain: hostOf(page),
      };
    })
    .filter(Boolean)
    .slice(0, 3);

  if (extracted.ok) return { extracted: extracted.value, candidates };
  if (url && !strict) {
    const title = candidates[0]?.title || name || brand;
    const second = parseModelJson(await grounded(searchPrompt({
      brand,
      name: title,
      protein,
      lifeStage,
      foodForm,
      url: null,
      hints,
      officialOnly: true,
    })));
    const retry = validateExtracted(second.extracted);
    if (retry.ok) return { extracted: retry.value, candidates: [] };
  }
  return { extracted: null, candidates, reason: extracted.reason || 'no_label_text' };
}

function historyRecommendation(grade, rec) {
  if (rec && VALID_RECS.has(rec)) return rec;
  return { A: 'highly_recommended', B: 'recommended', C: 'acceptable', D: 'caution', F: 'not_recommended' }[grade] || 'acceptable';
}

async function awardOnce(row, amount) {
  if (row.tokens_awarded > 0) return row.tokens_awarded;
  await tokenService.grantTokens(
    row.user_id,
    amount,
    'product_register',
    amount === 20 ? 'Food photos analyzed 🦴×20' : 'Food lookup ready 🦴×10',
    row.id,
  );
  await query('UPDATE lookup_requests SET tokens_awarded = ? WHERE id = ? AND tokens_awarded = 0', [amount, row.id]);
  return amount;
}

async function failLookup(row, reason, message) {
  await query('UPDATE lookup_requests SET status = ?, failure_reason = ? WHERE id = ?', ['failed', reason, row.id]);
  await notifyLookup(row, message, { lookupId: row.id });
}

async function finishFromExtracted(row, extracted, amount, sourceNote) {
  const petType = row.pet_type === 'cat' ? 'cat' : 'dog';
  const petName = row.pet_name || 'your pet';
  const review = await geminiService.reviewProductHolistically({
    ingredients: extracted.ingredients,
    petType,
    healthConditions: [],
    productType: 'food',
    petName,
  });
  let ingredientDetails = [];
  try {
    const detailed = await ingredientAnalyzer.analyzeIngredients(extracted.ingredients, {
      name: petName,
      pet_type: petType,
      healthConditions: [],
    });
    ingredientDetails = detailed.ingredients || [];
  } catch (err) {
    console.warn('[Lookup] ingredient analysis failed:', err.message);
  }
  const grade = ['A', 'B', 'C', 'D', 'F'].includes(review.grade) ? review.grade : 'C';
  const analysis = {
    finalScore: review.finalScore ?? 0,
    grade,
    recommendation: historyRecommendation(grade, review.recommendation),
    ingredients: ingredientDetails,
    warnings: [],
    positives: review.positives || [],
    summary: review.aiSummary || '',
    keyIssues: review.keyIssues || [],
    proteinQuality: review.proteinQuality,
    hasArtificialAdditives: review.hasArtificialAdditives,
    sourceNote,
    sourceUrl: extracted.sourceUrl || null,
    productName: extracted.productName || row.query_name || 'Pet food',
    brand: extracted.brand || row.brand || null,
  };
  const scanId = uuidv4();
  await query(
    `INSERT INTO scan_history
      (id, user_id, pet_name, pet_type, pet_id, product_id, scan_type, final_score, grade, recommendation, analysis_json)
     VALUES (?, ?, ?, ?, ?, NULL, 'on_demand_lookup', ?, ?, ?, ?)`,
    [scanId, row.user_id, petName, petType, row.pet_id || null, analysis.finalScore, grade, analysis.recommendation, JSON.stringify(analysis)],
  );
  await query(
    `UPDATE lookup_requests
     SET status = 'ready', failure_reason = NULL,
         brand = COALESCE(brand, ?), query_name = COALESCE(query_name, ?)
     WHERE id = ?`,
    [extracted.brand, extracted.productName, row.id],
  );
  try {
    await awardOnce(row, amount);
  } catch (err) {
    console.warn('[Lookup] token grant failed:', err.message);
  }
  await notifyLookup(row, `${petName}'s analysis request is ready.`, { lookupId: row.id, scanId });
}

async function runNameLookup(id) {
  const [row] = await query('SELECT * FROM lookup_requests WHERE id = ?', [id]);
  if (!row || row.status === 'ready') return;
  await query(`UPDATE lookup_requests SET status = 'searching' WHERE id = ?`, [id]);
  try {
    const found = await findLabel({
      brand: row.brand,
      name: row.query_name,
      protein: row.protein,
      lifeStage: row.life_stage,
      foodForm: row.food_form,
      url: row.pasted_url,
      hints: null,
      strict: false,
    });
    if (found.extracted) {
      const note = `Source: ${found.extracted.domain}. Read from the published page. This report is only on your account.`;
      await finishFromExtracted(row, found.extracted, 10, note);
      return;
    }
    if (found.candidates.length >= 2) {
      await query(`UPDATE lookup_requests SET status = 'queued', failure_reason = NULL WHERE id = ?`, [id]);
      return;
    }
    const name = row.query_name || 'this food';
    const message = row.pasted_url
      ? `That page doesn't include a written ingredient panel, and we couldn't find one on the brand site either.`
      : `We couldn't find a published ingredient panel for ${name}. Check the spelling, or add a product page link.`;
    await failLookup(row, found.reason || 'no_label_text', message);
  } catch (err) {
    console.error('[Lookup] name job failed:', err.message);
    await failLookup(row, 'no_source', `We couldn't find a published ingredient panel for ${row.query_name || 'this food'}. Check the spelling, or add a product page link.`);
  }
}

async function runPhotoLookup(id, ingredientBuffer, frontBuffer) {
  const [row] = await query('SELECT * FROM lookup_requests WHERE id = ?', [id]);
  if (!row) return;
  await query(`UPDATE lookup_requests SET status = 'searching' WHERE id = ?`, [id]);
  try {
    const ingredient = await geminiService.extractFromImage(ingredientBuffer, 'image/jpeg');
    const front = frontBuffer ? await geminiService.extractFromImage(frontBuffer, 'image/jpeg') : {};
    const ingredients = Array.isArray(ingredient.ingredients) ? ingredient.ingredients : [];
    if (ingredients.length < 5) {
      await failLookup(row, 'unreadable_photo', `We couldn't read the ingredient panel. Photograph it again.`);
      return;
    }
    const extracted = {
      brand: front.brand || ingredient.brand || null,
      productName: front.productName || ingredient.productName || 'Pet food',
      ingredients,
      sourceUrl: null,
      domain: 'your photos',
    };
    await finishFromExtracted(
      row,
      extracted,
      20,
      'Source: the photos you submitted. This report is only on your account.',
    );
  } catch (err) {
    console.error('[Lookup] photo job failed:', err.message);
    await failLookup(row, 'unreadable_photo', `We couldn't read the ingredient panel. Photograph it again.`);
  }
}

function realEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!email || email.endsWith('@nickname.local')) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

async function ensureCurrentFood(userId, pet, productName, replace = false) {
  if (!pet?.id) {
    const error = new Error('Pet is required');
    error.status = 400;
    throw error;
  }
  const owned = await query('SELECT id FROM pets WHERE id = ? AND user_id = ?', [pet.id, userId]);
  if (!owned.length) {
    const error = new Error('Pet not found');
    error.status = 404;
    throw error;
  }
  const [current] = await query(
    'SELECT id FROM pet_foods WHERE pet_id = ? AND is_current = TRUE LIMIT 1',
    [pet.id],
  );
  if (current && !replace) {
    const error = new Error('This pet already has a current food');
    error.status = 409;
    throw error;
  }
  if (current && replace) {
    await query(
      'UPDATE pet_foods SET is_current = FALSE, ended_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [current.id],
    );
  }
  const name = String(productName || '').trim().slice(0, 300);
  if (!name) {
    const error = new Error('Product name is required');
    error.status = 400;
    throw error;
  }
  const foodId = uuidv4();
  await query(
    `INSERT INTO pet_foods (id, pet_id, product_id, scan_id, product_name, is_current, started_at)
     VALUES (?, ?, NULL, NULL, ?, TRUE, CURRENT_TIMESTAMP)`,
    [foodId, pet.id, name],
  );
  return foodId;
}

function choice(value, allowed) {
  const text = norm(value);
  return allowed.includes(text) ? text : null;
}

async function createNameLookup({ userId, pet, brand, queryName, protein, lifeStage, foodForm, pastedUrl, email, setAsCurrentFood, replaceCurrentFood }) {
  const brandNorm = norm(brand);
  const nameNorm = norm(queryName);
  const proteinNorm = norm(protein);
  const stage = choice(lifeStage, ['puppy', 'kitten', 'adult', 'senior', 'all']);
  const form = choice(foodForm, ['dry', 'wet']);
  if (!brandNorm || !nameNorm || !proteinNorm) {
    const error = new Error('Brand, product name, and protein are required');
    error.status = 400;
    throw error;
  }
  const url = pastedUrl ? stripUrl(pastedUrl) : null;
  if (pastedUrl && !url) {
    const error = new Error('Purchase link must be an http(s) URL');
    error.status = 400;
    throw error;
  }

  const [existing] = await query(
    `SELECT id, status, product_id, pet_food_id FROM lookup_requests
     WHERE user_id = ? AND pet_id <=> ? AND brand_norm = ? AND query_name_norm = ?
       AND protein_norm <=> ? AND life_stage <=> ? AND food_form <=> ?
       AND status IN ('queued', 'searching', 'ready')
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId, pet.id || null, brandNorm, nameNorm, proteinNorm, stage, form],
  );
  if (existing) {
    if (setAsCurrentFood && !existing.pet_food_id) {
      const foodId = await ensureCurrentFood(userId, pet, queryName.trim(), replaceCurrentFood === true);
      if (existing.product_id) {
        await query('UPDATE pet_foods SET product_id = ?, product_name = ? WHERE id = ?', [existing.product_id, queryName.trim().slice(0, 300), foodId]);
      }
      await query('UPDATE lookup_requests SET pet_food_id = ? WHERE id = ? AND pet_food_id IS NULL', [foodId, existing.id]);
    }
    return { id: existing.id, status: existing.status, reused: true, tokensAwarded: 0, productId: existing.product_id || null };
  }

  let petFoodId = null;
  if (setAsCurrentFood) {
    petFoodId = await ensureCurrentFood(userId, pet, queryName.trim(), replaceCurrentFood === true);
  }

  const id = uuidv4();
  await query(
    `INSERT INTO lookup_requests
      (id, user_id, pet_id, pet_food_id, pet_name, pet_type, brand, query_name, brand_norm, query_name_norm,
       protein, protein_norm, life_stage, food_form, pasted_url, status, entry, email_to)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'name', ?)`,
    [
      id, userId, pet.id || null, petFoodId, pet.name || null, pet.petType === 'cat' ? 'cat' : 'dog',
      brand.trim(), queryName.trim(), brandNorm, nameNorm,
      protein.trim(), proteinNorm, stage, form,
      url, realEmail(email),
    ],
  );
  return { id, status: 'queued', reused: false, tokensAwarded: 0 };
}

async function getLookup(userId, id) {
  const [row] = await query('SELECT * FROM lookup_requests WHERE id = ? AND user_id = ?', [id, userId]);
  if (!row) return null;
  const scanResult = null;
  return {
    id: row.id,
    status: row.status,
    failureReason: row.failure_reason,
    brand: row.brand,
    queryName: row.query_name,
    entry: row.entry,
    petName: row.pet_name || null,
    frontImageUrl: row.front_image_url || null,
    ingredientImageUrl: row.ingredient_image_url || null,
    barcodeImageUrl: row.barcode_image_url || null,
    productId: row.product_id || null,
    scanResult,
    tokensAwarded: row.tokens_awarded,
    createdAt: row.created_at,
  };
}

async function listLookups(userId) {
  const rows = await query(
    `SELECT id, status, brand, query_name, pet_name, entry, failure_reason, created_at
     FROM lookup_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
    [userId],
  );
  const pending = rows.filter((row) => ['queued', 'searching', 'needs_choice'].includes(row.status)).length;
  return {
    pending,
    lookups: rows.map((row) => ({
      id: row.id,
      status: row.status,
      brand: row.brand,
      queryName: row.query_name,
      entry: row.entry,
      petName: row.pet_name || null,
      failureReason: row.failure_reason,
      createdAt: row.created_at,
    })),
  };
}

async function ackLookup(userId, id) {
  await query(
    `UPDATE lookup_requests SET client_acked_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND client_acked_at IS NULL`,
    [id, userId],
  );
}

async function findReadyByBarcode(userId, barcode) {
  const [row] = await query(
    `SELECT id FROM lookup_requests WHERE user_id = ? AND barcode = ? AND status = 'ready' ORDER BY created_at DESC LIMIT 1`,
    [userId, barcode],
  );
  if (!row) return null;
  return getLookup(userId, row.id);
}

module.exports = {
  realEmail,
  ensureCurrentFood,
  createNameLookup,
  getLookup,
  listLookups,
  ackLookup,
  findReadyByBarcode,
  runPhotoLookup,
};
