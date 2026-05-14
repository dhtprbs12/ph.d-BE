/**
 * Deterministic stitching of per-frame OCR for curved / spin captures.
 *
 * Consecutive photos overlap on the label; Cloud Vision returns slightly
 * different tokenization at seams. We merge by longest suffix/prefix
 * overlap (tokens first, then characters) so the model receives ONE
 * reading-ordered blob instead of N independent blocks (reduces wrong
 * reordering and duplicate shards without product-specific regex).
 *
 * Character-level overlaps are only accepted on word boundaries to
 * avoid mid-token merges. After stitching, immediate duplicate phrases
 * (same token run twice in a row) are collapsed — common when two
 * frames re-read the same seam.
 *
 * Per-frame Vision text is trimmed to the ingredient-declaration window using
 * generic cues (URLs, net weight, line-shape heuristics), not SKU-specific
 * strings, before stitching.
 */

'use strict';

/** Hard cap before Gemini merge (chars). */
const MAX_STITCHED_CHARS_FOR_MERGE = 120_000;

/** Max chars kept from declaration start (safety vs runaway OCR). */
const MAX_ING_WINDOW = 6000;

/** Declaration line: common EN/EU label words (not product-specific). */
const ING_DECL_START =
  /\b(Ingredients?|INGREDIENTS?|Composition|Composi(?:tion|ci[oó]n)|Zutaten|Ingrediente|INGREDIENTI|Ingr[eé]dients)\s*:\s*/i;

/**
 * High-confidence substrings: if these appear after "Ingredients:", the label
 * has almost certainly left the comma-list block (URLs, NF repeat, net weight, …).
 */
const FOOTER_INLINE_RES = [
  /\bhttps?:\/\/\S+/i,
  /\bwww\.[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/i,
  /\b\S+@\S+\.\S+\b/i,
  /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/,
  /[©®]|(?:\([Cc]\)\s*20\d{2})/,
  /\b(?:nutrition\s*facts|supplement\s*facts|amount\s*per\s*serving|%[\s]*daily[\s]*value)\b/i,
  /\b(?:net\s*wt|net\s*weight|gross\s*wt|drained\s*wt)\b/i,
  /\b(?:best\s*by|use\s*by|sell\s*by|exp\.?|lot\s*#|lot\s*no\.?|batch\s*#)\b/i,
  /\bproduct\s+of\b/i,
  /\b(?:made|packed|produced|manufactured)\s+in\b/i,
  /\b(?:manufactured|packed|produced)\s+(?:for|by)\b/i,
  /\b(?:distributed|distribuido|distribu[ií]do|distribué|fabriqué|fabricado|elaborado|importado|prepared)\s+(?:by|for|pour|par|por|en|de)\b/i,
  /\bdist\.\s*&\s*sold\b/i,
  /\bdist\s*&\s*sold\b/i,
  /\bmay\s+contain\b/i,
  /\b(?:keep|store|refrigerate)\b.{0,40}\b(?:cool|dry|frozen|refrigerat|after\s*opening)\b/i,
  /\b(?:questions?|comments?|consumer|customer|help)\b.{0,30}\b(?:call|contact|visit)\b/i,
];

/**
 * Earliest index in `s` where any regex matches (search-only; not global loops).
 * @param {string} s
 * @param {RegExp[]} patterns
 * @returns {number}
 */
function earliestRegexIndex(s, patterns) {
  let best = s.length;
  for (const re of patterns) {
    const flags = re.flags.replace(/g/g, '');
    const m = new RegExp(re.source, flags).exec(s);
    if (m && m.index < best) best = m.index;
  }
  return best;
}

/**
 * Allergen-style CONTAINS / CONTAINS: … — skip in-list "contains less than …".
 * @param {string} after text after declaration header
 * @returns {number} index of first allergen CONTAINS or after.length
 */
function earliestAllergenContainsIndex(after) {
  const re = /\bCONTAINS\b/gi;
  let best = after.length;
  let m;
  while ((m = re.exec(after)) !== null) {
    const i = m.index;
    const head = after.slice(i, i + 24).toLowerCase();
    if (head.startsWith('contains less than')) continue;
    best = Math.min(best, i);
  }
  return best;
}

/**
 * Score how much a single OCR line looks like boilerplate / regulatory footer
 * (not an ingredient continuation). Uses shape signals, not brand strings.
 * @param {string} line
 * @returns {number}
 */
function footerLineScore(line) {
  const s = line.trim();
  if (s.length < 6) return 0;

  if (/\bcontains\s+less\s+than\b/i.test(s)) return -10;

  let score = 0;

  if (/https?:\/\/|www\.\S+/i.test(s)) score += 8;
  if (/\b\S+@\S+\.\S+\b/i.test(s)) score += 8;
  if (/\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/.test(s)) score += 7;
  if (/[©®]|\([Cc]\)\s*20\d{2}/.test(s)) score += 6;
  if (/\b(?:nutrition|supplement)\s+facts\b/i.test(s)) score += 7;
  if (/\b(?:net\s*wt|net\s*weight|gross\s*wt)\b/i.test(s)) score += 6;
  if (/\b(?:best\s*by|use\s*by|sell\s*by|lot\s*#|batch\s*#)\b/i.test(s)) score += 5;
  if (/\bproduct\s+of\b|\b(?:made|packed|manufactured)\s+in\b/i.test(s)) score += 5;
  if (/\b(?:distributed|distribuido|fabricado|fabriqué|elaborado)\s+(?:by|por|par|en)\b/i.test(s))
    score += 5;
  if (/\b(?:manufactured|packed|produced)\s+(?:for|by)\b/i.test(s)) score += 5;
  if (/\bdist\.\s*&\s*sold\b|\bdist\s*&\s*sold\b/i.test(s)) score += 5;
  if (/\bmay\s+contain\b/i.test(s)) score += 5;
  if (/^\s*CONTAINS\b/i.test(s) && !/^contains\s+less\s+than\b/i.test(s.toLowerCase())) score += 6;
  if (/\b(?:keep|store|refrigerate)\b/i.test(s) && /\b(?:cool|dry|frozen|refrigerat)\b/i.test(s))
    score += 4;
  if (/\b(?:questions?|comments?|consumer)\b/i.test(s) && /\b(?:call|visit|www)\b/i.test(s))
    score += 5;

  const letters = s.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 12) {
    const upper = (s.match(/[A-Z]/g) || []).length / letters.length;
    const commas = (s.match(/,/g) || []).length;
    if (commas >= 4) score -= 6;
    else if (commas >= 2) score -= 2;
    if (upper > 0.58 && s.length >= 14 && s.length < 260 && commas <= 2) score += 4;
  }

  if (/^\d[\d\s./%]*$/i.test(s.replace(/,/g, '')) && s.length <= 28) score += 3;

  return score;
}

/**
 * When Vision preserves newlines, cut before the first line that reads like footer.
 * @param {string} after
 * @returns {number}
 */
function earliestNewlineFooterCut(after) {
  if (!/\n/.test(after)) return after.length;
  const parts = after.split(/\n/);
  const THRESH = 5;
  let pos = parts[0].length + 1;
  for (let i = 1; i < parts.length; i++) {
    if (footerLineScore(parts[i]) >= THRESH) return pos;
    pos += parts[i].length + 1;
  }
  return after.length;
}

/**
 * Earliest position where post-declaration text is likely no longer the ingredient list.
 * @param {string} after
 * @returns {number}
 */
function earliestFooterBoundary(after) {
  return Math.min(
    earliestRegexIndex(after, FOOTER_INLINE_RES),
    earliestAllergenContainsIndex(after),
    earliestNewlineFooterCut(after),
  );
}

/**
 * Keep only the ingredient-declaration window from one Vision OCR dump.
 * Uses generic footer detection (line shape, URLs, NF repeat, allergen CONTAINS
 * vs in-list "contains less than"), not exhaustive label phrase lists.
 *
 * @param {string} rawText
 * @returns {string} trimmed; may be original text if no safe slice
 */
function sliceRawToIngredientsWindow(rawText) {
  const t = String(rawText || '').trim();
  if (!t) return '';
  const sm = ING_DECL_START.exec(t);
  if (!sm) return t;

  const after = t.slice(sm.index + sm[0].length).trim();
  const end = earliestFooterBoundary(after);
  const footerFound = end < after.length;
  let body = after.slice(0, end).trim();
  body = body.replace(/[,\s.]+$/, '');
  if (body.length === 0) return t;
  if (!footerFound && body.length < 10) return t;
  if (body.length > MAX_ING_WINDOW) body = body.slice(0, MAX_ING_WINDOW).trim();
  return `Ingredients: ${body}`;
}

function squashWs(s) {
  return String(s || '')
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(s) {
  const t = squashWs(s);
  if (!t) return [];
  return t.split(/\s+/).filter(Boolean);
}

function normTok(w) {
  return String(w || '')
    .toLowerCase()
    .replace(/^[,.;:()[\]'"]+|[,.;:()[\]'"]+$/g, '');
}

/**
 * Largest n such that last n tokens of `aTok` equal first n tokens of `bTok`
 * (normalized), within [minTokens, maxTokens].
 */
function longestTokenOverlap(aTok, bTok, opts) {
  const minN = opts.minTokens ?? 3;
  const maxN = opts.maxTokens ?? 150;
  const aN = aTok.length;
  const bN = bTok.length;
  const upper = Math.min(maxN, aN, bN);
  for (let n = upper; n >= minN; n--) {
    let ok = true;
    for (let i = 0; i < n; i++) {
      if (normTok(aTok[aN - n + i]) !== normTok(bTok[i])) {
        ok = false;
        break;
      }
    }
    if (ok) return n;
  }
  return 0;
}

/**
 * Longest L where suffix(A,L) === prefix(B,L), only if the seam is
 * word-safe: do not merge mid-token (avoids "sal" + "lk" → "sal lk" glitches).
 */
function longestCharOverlapWordSafe(a, b, opts) {
  const minL = opts.minChars ?? 8;
  const maxL = opts.maxChars ?? 900;
  const A = squashWs(a);
  const B = squashWs(b);
  const up = Math.min(maxL, A.length, B.length);

  for (let L = up; L >= minL; L--) {
    if (A.slice(-L) !== B.slice(0, L)) continue;

    const startInA = A.length - L;
    const beforeA = startInA > 0 ? A[startInA - 1] : '';
    const firstInOverlapA = A[startInA];
    if (beforeA && /\w/.test(beforeA) && /\w/.test(firstInOverlapA)) continue;

    if (L < B.length) {
      const lastInOverlapB = B[L - 1];
      const afterB = B[L];
      if (/\w/.test(lastInOverlapB) && /\w/.test(afterB)) continue;
    }

    return L;
  }
  return 0;
}

/**
 * Join two OCR chunks in capture order: prefer overlap merge, else paragraph break
 * (keeps order without inventing false continuity).
 */
function stitchTwoStrings(prev, next, opts) {
  const A = squashWs(prev);
  const B = squashWs(next);
  if (!B) return A;
  if (!A) return B;

  const aTok = tokenize(A);
  const bTok = tokenize(B);
  const nTok = longestTokenOverlap(aTok, bTok, opts);
  if (nTok > 0) {
    const tail = bTok.slice(nTok).join(' ');
    return tail ? `${A} ${tail}` : A;
  }

  const nChar = longestCharOverlapWordSafe(A, B, opts);
  if (nChar > 0) {
    return A + B.slice(nChar);
  }

  return `${A}\n\n${B}`;
}

/**
 * Collapse repeated "Ingredients:" headers from frame-to-frame re-capture.
 */
function dedupeIngredientHeaders(text) {
  const re = /\bIngredients\s*:?\s*/gi;
  let first = true;
  return text.replace(re, () => {
    if (first) {
      first = false;
      return 'Ingredients: ';
    }
    return ' ';
  });
}

/**
 * When the same word sequence appears twice in a row (OCR re-read the seam),
 * keep one copy. Token-normalized; min phrase length avoids touching "salt, sugar".
 */
function collapseAdjacentDuplicatePhrases(text) {
  let tokens = tokenize(text);
  if (tokens.length < 6) return squashWs(text);

  const minWords = 3;
  const maxWords = 40;
  let changed = true;
  while (changed) {
    changed = false;
    const next = [];
    for (let i = 0; i < tokens.length; ) {
      let handled = false;
      const remain = tokens.length - i;
      const maxN = Math.min(maxWords, Math.floor(remain / 2));
      for (let n = maxN; n >= minWords; n--) {
        if (i + 2 * n > tokens.length) continue;
        let same = true;
        for (let k = 0; k < n; k++) {
          if (normTok(tokens[i + k]) !== normTok(tokens[i + n + k])) {
            same = false;
            break;
          }
        }
        if (same) {
          for (let k = 0; k < n; k++) next.push(tokens[i + k]);
          i += 2 * n;
          handled = true;
          changed = true;
          break;
        }
      }
      if (!handled) {
        next.push(tokens[i]);
        i++;
      }
    }
    tokens = next;
  }
  return squashWs(tokens.join(' '));
}

/**
 * @param {{ frameIndex: number, rawText: string }[]} frames
 * @returns {string}
 */
function stitchSequentialFrameTexts(frames) {
  if (!Array.isArray(frames) || frames.length === 0) return '';
  const sorted = frames.slice().sort((x, y) => (x.frameIndex || 0) - (y.frameIndex || 0));
  const stitchOpts = { minTokens: 3, maxTokens: 150, minChars: 8, maxChars: 900 };

  let acc = '';
  for (const f of sorted) {
    const slim = sliceRawToIngredientsWindow(f.rawText || '');
    acc = stitchTwoStrings(acc, slim, stitchOpts);
  }
  const withHeaders = dedupeIngredientHeaders(acc);
  return collapseAdjacentDuplicatePhrases(withHeaders);
}

/**
 * @param {string} stitched
 * @returns {string}
 */
function truncateForMerge(stitched) {
  const s = String(stitched || '');
  if (s.length <= MAX_STITCHED_CHARS_FOR_MERGE) return s;
  return `${s.slice(0, MAX_STITCHED_CHARS_FOR_MERGE)}\n...[truncated ${s.length - MAX_STITCHED_CHARS_FOR_MERGE} chars]`;
}

module.exports = {
  stitchSequentialFrameTexts,
  truncateForMerge,
  sliceRawToIngredientsWindow,
  MAX_STITCHED_CHARS_FOR_MERGE,
};
