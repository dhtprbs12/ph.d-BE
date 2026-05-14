/**
 * Deterministic stitching of per-frame OCR for curved / spin captures.
 *
 * Consecutive photos overlap on the label; Cloud Vision returns slightly
 * different tokenization at seams. We merge by longest suffix/prefix
 * overlap (tokens first, then characters) so the model receives ONE
 * reading-ordered blob instead of N independent blocks (reduces wrong
 * reordering and duplicate shards without product-specific regex).
 */

'use strict';

/** Hard cap before Gemini merge (chars). */
const MAX_STITCHED_CHARS_FOR_MERGE = 120_000;

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
 * Longest L where squashWs(a).slice(-L) === squashWs(b).slice(0, L).
 */
function longestCharOverlap(a, b, opts) {
  const minL = opts.minChars ?? 8;
  const maxL = opts.maxChars ?? 900;
  const A = squashWs(a);
  const B = squashWs(b);
  const up = Math.min(maxL, A.length, B.length);
  for (let L = up; L >= minL; L--) {
    if (A.slice(-L) === B.slice(0, L)) return L;
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

  const nChar = longestCharOverlap(A, B, opts);
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
 * @param {{ frameIndex: number, rawText: string }[]} frames
 * @returns {string}
 */
function stitchSequentialFrameTexts(frames) {
  if (!Array.isArray(frames) || frames.length === 0) return '';
  const sorted = frames.slice().sort((x, y) => (x.frameIndex || 0) - (y.frameIndex || 0));
  const stitchOpts = { minTokens: 3, maxTokens: 150, minChars: 8, maxChars: 900 };

  let acc = '';
  for (const f of sorted) {
    acc = stitchTwoStrings(acc, f.rawText || '', stitchOpts);
  }
  return squashWs(dedupeIngredientHeaders(acc));
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
  MAX_STITCHED_CHARS_FOR_MERGE,
};
