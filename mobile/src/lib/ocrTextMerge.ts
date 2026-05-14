/**
 * Deterministic overlap merge for OCR snippets (reading order around a can).
 * Prefers longest token suffix/prefix overlap; falls back to word-safe char overlap.
 * (Same idea as server ocrTextStitch — no Jaccard-only set merge.)
 */

function squashWs(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
}

function tokenize(s: string): string[] {
  const t = squashWs(s);
  if (!t) return [];
  return t.split(/\s+/).filter(Boolean);
}

function normTok(w: string): string {
  return w
    .toLowerCase()
    .replace(/^[,.;:()[\]'"]+|[,.;:()[\]'"]+$/g, '');
}

function longestTokenOverlap(aTok: string[], bTok: string[], minN: number, maxN: number): number {
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

function longestCharOverlapWordSafe(a: string, b: string, minL: number, maxL: number): number {
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

function stitchTwo(prev: string, next: string): string {
  const A = squashWs(prev);
  const B = squashWs(next);
  if (!B) return A;
  if (!A) return B;
  const aTok = tokenize(A);
  const bTok = tokenize(B);
  const nTok = longestTokenOverlap(aTok, bTok, 3, 120);
  if (nTok > 0) {
    const tail = bTok.slice(nTok).join(' ');
    return tail ? `${A} ${tail}` : A;
  }
  const nChar = longestCharOverlapWordSafe(A, B, 8, 800);
  if (nChar > 0) return A + B.slice(nChar);
  return `${A}\n\n${B}`;
}

/**
 * Merge multiple raw OCR strings in capture order.
 */
export function mergeOcrFrames(frames: string[]): string {
  let acc = '';
  for (const f of frames) {
    acc = stitchTwo(acc, String(f || ''));
  }
  return squashWs(acc);
}
