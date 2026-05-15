/**
 * Build a single wide image from an ordered burst (many rotations) by
 * resizing each frame to a common height, taking a vertical center strip,
 * and concatenating left → right. Not true cylindrical unwrap — cheap
 * server-side input for one DOCUMENT_TEXT_DETECTION pass.
 *
 * Defaults tuned for ~30 narrow strips: slightly narrower strip fraction
 * and higher max width so the final JPEG is not over-shrunk vs shorter bursts.
 */

'use strict';

const sharp = require('sharp');

const DEFAULTS = {
  maxStripHeight: 1550,
  centerStripFraction: 0.32,
  maxOutputWidthPx: 16000,
  jpegQuality: 88,
};

/**
 * @param {Buffer[]} imageBuffers  Ordered capture sequence
 * @param {object} [options]  Overrides for DEFAULTS
 * @returns {Promise<{ buffer: Buffer, meta: { width: number, height: number } }>}
 */
async function buildStripPanoramaFromFrames(imageBuffers, options = {}) {
  if (!Array.isArray(imageBuffers) || imageBuffers.length < 2) {
    throw new Error('buildStripPanoramaFromFrames: need at least 2 image buffers');
  }
  const o = { ...DEFAULTS, ...options };
  const strips = [];

  for (let i = 0; i < imageBuffers.length; i++) {
    const buf = imageBuffers[i];
    if (!buf || !Buffer.isBuffer(buf) || buf.length < 80) continue;

    const meta = await sharp(buf).metadata();
    const w0 = meta.width || 0;
    const h0 = meta.height || 0;
    if (!w0 || !h0) continue;

    const resized = await sharp(buf)
      .rotate()
      .resize({
        height: Math.min(h0, o.maxStripHeight),
        width: null,
        fit: 'inside',
      })
      .toBuffer({ resolveWithObject: true });

    const info = resized.info;
    const rw = info.width;
    const rh = info.height;
    const stripW = Math.max(8, Math.round(rw * o.centerStripFraction));
    const left = Math.max(0, Math.round((rw - stripW) / 2));

    const stripBuf = await sharp(resized.data)
      .extract({ left, top: 0, width: stripW, height: rh })
      .toBuffer();

    strips.push({ buf: stripBuf, w: stripW, h: rh });
  }

  if (strips.length < 2) {
    throw new Error('buildStripPanoramaFromFrames: too few decodable frames');
  }

  const outH = Math.min(...strips.map(s => s.h));
  const normalized = await Promise.all(
    strips.map(async s => {
      if (s.h === outH) return { buf: s.buf, w: s.w };
      const buf = await sharp(s.buf).resize({ height: outH, fit: 'cover' }).toBuffer();
      const m = await sharp(buf).metadata();
      return { buf, w: m.width || s.w };
    })
  );

  let totalW = normalized.reduce((acc, s) => acc + s.w, 0);
  let x = 0;
  const composites = [];
  for (const s of normalized) {
    composites.push({ input: s.buf, left: x, top: 0 });
    x += s.w;
  }

  let pipeline = sharp({
    create: {
      width: totalW,
      height: outH,
      channels: 3,
      background: { r: 250, g: 250, b: 250 },
    },
  }).composite(composites);

  if (totalW > o.maxOutputWidthPx) {
    pipeline = pipeline.resize({ width: o.maxOutputWidthPx, fit: 'inside' });
  }

  const buffer = await pipeline.jpeg({ quality: o.jpegQuality, mozjpeg: true }).toBuffer();
  const finalMeta = await sharp(buffer).metadata();
  return {
    buffer,
    meta: { width: finalMeta.width || totalW, height: finalMeta.height || outH },
  };
}

module.exports = { buildStripPanoramaFromFrames, DEFAULTS };
