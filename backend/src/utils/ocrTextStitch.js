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
    acc = stitchTwoStrings(acc, f.rawText || '', stitchOpts);
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
  MAX_STITCHED_CHARS_FOR_MERGE,
};
