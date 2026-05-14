export type Rect = { left: number; top: number; width: number; height: number };

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Map a rectangle in preview view coordinates to a crop rect in full photo pixels.
 * Matches VisionCamera default preview {@link resizeMode} "cover".
 */
export function viewRectToImageCrop(
  guide: Rect,
  container: { width: number; height: number },
  photoW: number,
  photoH: number,
  mode: 'cover' | 'contain' = 'cover',
): { originX: number; originY: number; width: number; height: number } {
  const cw = container.width;
  const ch = container.height;
  const pw = photoW;
  const ph = photoH;

  let s: number;
  let offX: number;
  let offY: number;

  if (mode === 'cover') {
    s = Math.max(cw / pw, ch / ph);
    const sw = pw * s;
    const sh = ph * s;
    offX = (sw - cw) / 2;
    offY = (sh - ch) / 2;
  } else {
    s = Math.min(cw / pw, ch / ph);
    const sw = pw * s;
    const sh = ph * s;
    offX = (cw - sw) / 2;
    offY = (ch - sh) / 2;
  }

  const x1 = (guide.left + offX) / s;
  const y1 = (guide.top + offY) / s;
  const x2 = (guide.left + guide.width + offX) / s;
  const y2 = (guide.top + guide.height + offY) / s;

  let ox = Math.floor(Math.min(x1, x2));
  let oy = Math.floor(Math.min(y1, y2));
  let w = Math.ceil(Math.abs(x2 - x1));
  let h = Math.ceil(Math.abs(y2 - y1));

  ox = clamp(ox, 0, Math.max(0, pw - 1));
  oy = clamp(oy, 0, Math.max(0, ph - 1));
  w = clamp(w, 1, pw - ox);
  h = clamp(h, 1, ph - oy);

  return { originX: ox, originY: oy, width: w, height: h };
}

/** Default ingredient band: wide horizontal strip across middle of preview. */
export function defaultIngredientGuideRect(container: { width: number; height: number }): Rect {
  const w = container.width;
  const h = container.height;
  return {
    left: w * 0.06,
    top: h * 0.34,
    width: w * 0.88,
    height: h * 0.28,
  };
}
