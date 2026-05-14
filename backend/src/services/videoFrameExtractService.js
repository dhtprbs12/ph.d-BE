/**
 * Decode a short product spin video to JPEG frame buffers for OCR.
 * Requires `ffmpeg` on PATH (install in Docker / host image).
 */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULTS = {
  /** Hard cap on number of stills passed to Vision (cost / latency). */
  maxFrames: 24,
  /** Trim long recordings so ffmpeg work stays bounded. */
  maxDurationSec: 10,
};

/**
 * @param {Buffer} videoBuffer  Raw mp4/mov bytes
 * @param {{ maxFrames?: number, maxDurationSec?: number }} [options]
 * @returns {Buffer[]} JPEG buffers, time order
 */
function extractJpegFramesFromVideo(videoBuffer, options = {}) {
  if (!videoBuffer || !Buffer.isBuffer(videoBuffer) || videoBuffer.length < 200) {
    throw new Error('extractJpegFramesFromVideo: invalid or empty video buffer');
  }

  const o = { ...DEFAULTS, ...options };
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vid-ocr-'));
  const inputPath = path.join(tmpRoot, 'input.bin');
  const outPattern = path.join(tmpRoot, 'f_%03d.jpg');

  fs.writeFileSync(inputPath, videoBuffer);

  // ~2.5 fps over 10s → up to 25 frames; -frames:v caps at maxFrames.
  const fps = Math.min(5, Math.max(2, o.maxFrames / o.maxDurationSec));
  const vf = `fps=${fps},scale=min(iw\\,1920):-2:flags=lanczos`;

  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    inputPath,
    '-t',
    String(o.maxDurationSec),
    '-vf',
    vf,
    '-frames:v',
    String(o.maxFrames),
    outPattern,
  ];

  const proc = spawnSync('ffmpeg', args, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  try {
    fs.unlinkSync(inputPath);
  } catch {
    /* ignore */
  }

  if (proc.error) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    throw new Error(
      `ffmpeg spawn failed (${proc.error.message}). Is ffmpeg installed and on PATH?`
    );
  }

  if (proc.status !== 0) {
    const errText = `${proc.stderr || ''}${proc.stdout || ''}`.trim();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    throw new Error(`ffmpeg exited ${proc.status}: ${errText.slice(0, 800)}`);
  }

  const files = fs
    .readdirSync(tmpRoot)
    .filter(n => /^f_\d+\.jpg$/i.test(n))
    .sort((a, b) => {
      const na = parseInt(a.match(/\d+/)?.[0] || '0', 10);
      const nb = parseInt(b.match(/\d+/)?.[0] || '0', 10);
      return na - nb;
    });

  const buffers = files.map(f => fs.readFileSync(path.join(tmpRoot, f)));
  fs.rmSync(tmpRoot, { recursive: true, force: true });

  if (buffers.length === 0) {
    throw new Error('extractJpegFramesFromVideo: no JPEG frames produced (unsupported codec?)');
  }

  return buffers;
}

module.exports = { extractJpegFramesFromVideo, DEFAULTS };
