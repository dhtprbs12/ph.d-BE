const { v4: uuidv4 } = require('uuid');
const { query } = require('../database/connection');
const geminiService = require('./geminiService');
const ingredientAnalyzer = require('./ingredientAnalyzer');
const tokenService = require('./tokenService');
const { notifyLookup } = require('./lookupNotify');

const DAILY_LIMIT = 10;
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

function searchPrompt({ brand, name, url, hints, officialOnly }) {
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
${url ? `- Read only this URL: ${url}` : `- Find pages for brand "${brand}" and product "${name}".`}
If several different recipes match, return up to 3 candidates and extracted null.
If one page clearly matches and has both lists as text, fill extracted from that page only.`;
}

async function findLabel({ brand, name, url, hints, strict }) {
  const first = parseModelJson(await grounded(searchPrompt({ brand, name, url, hints, officialOnly: false })));
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
    'on_demand_lookup',
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
     SET status = 'ready', failure_reason = NULL, extracted_json = ?, chosen_url = ?, scan_id = ?,
         brand = COALESCE(brand, ?), query_name = COALESCE(query_name, ?)
     WHERE id = ?`,
    [JSON.stringify(extracted), extracted.sourceUrl || null, scanId, extracted.brand, extracted.productName, row.id],
  );
  try {
    await awardOnce(row, amount);
  } catch (err) {
    console.warn('[Lookup] token grant failed:', err.message);
  }
  const food = extracted.productName || row.query_name || 'your food';
  await notifyLookup(row, `${petName}'s analysis for ${food} is ready.`, { lookupId: row.id, scanId });
}

async function runNameLookup(id) {
  const [row] = await query('SELECT * FROM lookup_requests WHERE id = ?', [id]);
  if (!row || row.status === 'ready') return;
  await query(`UPDATE lookup_requests SET status = 'searching' WHERE id = ?`, [id]);
  try {
    const hints = row.filter_hints_json
      ? (typeof row.filter_hints_json === 'string' ? JSON.parse(row.filter_hints_json) : row.filter_hints_json)
      : null;
    const found = await findLabel({
      brand: row.brand,
      name: row.query_name,
      url: row.chosen_url || row.pasted_url,
      hints,
      strict: Boolean(row.chosen_url),
    });
    if (found.extracted) {
      const note = `Source: ${found.extracted.domain}. Read from the published page. This report is only on your account.`;
      await finishFromExtracted(row, found.extracted, 10, note);
      return;
    }
    if (found.candidates.length >= 2) {
      await query(
        `UPDATE lookup_requests SET status = 'needs_choice', candidates_json = ?, failure_reason = NULL WHERE id = ?`,
        [JSON.stringify(found.candidates), id],
      );
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

async function assertDailyRoom(userId) {
  const [row] = await query(
    `SELECT COUNT(*) AS c FROM lookup_requests WHERE user_id = ? AND created_at >= CURDATE()`,
    [userId],
  );
  if (Number(row?.c || 0) >= DAILY_LIMIT) {
    const error = new Error('You can request 10 food lookups a day.');
    error.status = 429;
    throw error;
  }
}

async function createNameLookup({ userId, pet, brand, queryName, pastedUrl, email, filterHints }) {
  const brandNorm = norm(brand);
  const nameNorm = norm(queryName);
  if (!brandNorm || !nameNorm) {
    const error = new Error('Brand and product name are both required');
    error.status = 400;
    throw error;
  }
  const [existing] = await query(
    `SELECT id FROM lookup_requests
     WHERE user_id = ? AND pet_id <=> ? AND brand_norm = ? AND query_name_norm = ? AND status = 'ready'
     LIMIT 1`,
    [userId, pet.id || null, brandNorm, nameNorm],
  );
  if (existing) return { id: existing.id, status: 'ready', reused: true, tokensAwarded: 0 };

  await assertDailyRoom(userId);
  const id = uuidv4();
  const url = pastedUrl ? stripUrl(pastedUrl) : null;
  if (pastedUrl && !url) {
    const error = new Error('Purchase link must be an http(s) URL');
    error.status = 400;
    throw error;
  }
  await query(
    `INSERT INTO lookup_requests
      (id, user_id, pet_id, pet_name, pet_type, brand, query_name, brand_norm, query_name_norm,
       filter_hints_json, pasted_url, status, entry, email_to)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'name', ?)`,
    [
      id, userId, pet.id || null, pet.name || null, pet.petType === 'cat' ? 'cat' : 'dog',
      brand.trim(), queryName.trim(), brandNorm, nameNorm,
      filterHints ? JSON.stringify(filterHints) : null,
      url, realEmail(email),
    ],
  );
  setImmediate(() => {
    runNameLookup(id).catch((err) => console.error('[Lookup] async name failed:', err.message));
  });
  return { id, status: 'queued', reused: false, tokensAwarded: 0 };
}

async function chooseCandidate(userId, id, url) {
  const [row] = await query('SELECT * FROM lookup_requests WHERE id = ? AND user_id = ?', [id, userId]);
  if (!row) {
    const error = new Error('Lookup not found');
    error.status = 404;
    throw error;
  }
  const candidates = typeof row.candidates_json === 'string' ? JSON.parse(row.candidates_json) : (row.candidates_json || []);
  const match = candidates.find((item) => item.url === url);
  if (!match) {
    const error = new Error('That page is not one of the choices');
    error.status = 400;
    throw error;
  }
  await query(`UPDATE lookup_requests SET chosen_url = ?, pasted_url = NULL, status = 'queued' WHERE id = ?`, [url, id]);
  setImmediate(() => {
    runNameLookup(id).catch((err) => console.error('[Lookup] choice failed:', err.message));
  });
  return { id, status: 'queued' };
}

function scanResultFrom(row, analysisJson) {
  const analysis = typeof analysisJson === 'string' ? JSON.parse(analysisJson) : analysisJson;
  const { sourceNote, sourceUrl, productName, brand, ...rest } = analysis || {};
  return {
    scanId: row.scan_id,
    scanType: 'on_demand_lookup',
    product: {
      name: productName || row.query_name || 'Pet food',
      brand: brand || row.brand || null,
      manufacturer: brand || row.brand || null,
    },
    analysis: rest,
    pet: { name: row.pet_name || 'your pet', petType: row.pet_type },
    sourceNote: sourceNote || (sourceUrl ? `Source: ${sourceUrl}` : null),
  };
}

async function getLookup(userId, id) {
  const [row] = await query('SELECT * FROM lookup_requests WHERE id = ? AND user_id = ?', [id, userId]);
  if (!row) return null;
  let scanResult = null;
  if (row.status === 'ready' && row.scan_id) {
    const [scan] = await query('SELECT analysis_json FROM scan_history WHERE id = ? AND user_id = ?', [row.scan_id, userId]);
    if (scan?.analysis_json) scanResult = scanResultFrom(row, scan.analysis_json);
  }
  const candidates = row.candidates_json
    ? (typeof row.candidates_json === 'string' ? JSON.parse(row.candidates_json) : row.candidates_json)
    : [];
  return {
    id: row.id,
    status: row.status,
    failureReason: row.failure_reason,
    brand: row.brand,
    queryName: row.query_name,
    entry: row.entry,
    candidates: row.status === 'needs_choice' ? candidates : [],
    scanResult,
    tokensAwarded: row.tokens_awarded,
    createdAt: row.created_at,
  };
}

async function listLookups(userId) {
  const rows = await query(
    `SELECT id, status, brand, query_name, entry, failure_reason, created_at
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
  createNameLookup,
  chooseCandidate,
  getLookup,
  listLookups,
  ackLookup,
  findReadyByBarcode,
  runPhotoLookup,
  assertDailyRoom,
};
