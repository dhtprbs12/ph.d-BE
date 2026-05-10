/**
 * GOOGLE CLOUD VISION SERVICE
 *
 * Thin wrapper around Cloud Vision's `images:annotate` REST endpoint
 * (DOCUMENT_TEXT_DETECTION). Used by the multi-frame burst-capture
 * pipeline to OCR each rotated photo of a cylindrical / curved
 * pet-food package independently. The merged ingredient list is then
 * reconstructed by Gemini in a separate text-only call (see
 * GeminiService._mergeRawTextWithGemini).
 *
 * Why not the @google-cloud/vision SDK:
 *   - It defaults to service-account auth, which would require us to
 *     mount a JSON credential file on Railway. API-key auth via the
 *     plain REST endpoint is materially simpler for a solo backend
 *     and is officially supported by Cloud Vision.
 *   - We only need one feature (DOCUMENT_TEXT_DETECTION), so the SDK
 *     surface is overkill.
 *
 * Why DOCUMENT_TEXT_DETECTION (not TEXT_DETECTION):
 *   - DOCUMENT_TEXT_DETECTION is tuned for dense / structured text
 *     blocks and preserves reading order / line breaks, which is
 *     what an ingredient panel actually is. TEXT_DETECTION is for
 *     scattered text in scenes (signs, posters).
 */

const VISION_ENDPOINT = 'https://vision.googleapis.com/v1/images:annotate';

class CloudVisionService {
  constructor() {
    this.apiKey = process.env.GOOGLE_CLOUD_VISION_API_KEY || null;
    if (!this.apiKey) {
      console.warn(
        '⚠️ GOOGLE_CLOUD_VISION_API_KEY not set. Multi-frame OCR will fall back to Gemini per-frame OCR.'
      );
    }
  }

  isAvailable() {
    return Boolean(this.apiKey);
  }

  /**
   * OCR a single image buffer with Cloud Vision DOCUMENT_TEXT_DETECTION.
   * Returns the raw text block (newline-separated) plus the array of
   * detected blocks with bounding boxes (kept in case the merge step
   * later wants to do spatial filtering).
   *
   * @param {Buffer} imageBuffer
   * @param {object} [options]
   * @param {string[]} [options.languageHints]  Optional ISO-639-1 hints,
   *   e.g. ['en']. Only set when you're confident about the language —
   *   wrong hints hurt accuracy more than no hint.
   * @returns {Promise<{ rawText: string, blocks: Array<{text:string, confidence:number, bbox: any}> }>}
   */
  async detectDocumentText(imageBuffer, options = {}) {
    if (!this.apiKey) {
      throw new Error('Cloud Vision API key not configured');
    }

    const body = {
      requests: [
        {
          image: { content: imageBuffer.toString('base64') },
          features: [{ type: 'DOCUMENT_TEXT_DETECTION', maxResults: 1 }],
          imageContext: options.languageHints
            ? { languageHints: options.languageHints }
            : undefined,
        },
      ],
    };

    const url = `${VISION_ENDPOINT}?key=${encodeURIComponent(this.apiKey)}`;
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(`Cloud Vision network error: ${err.message}`);
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(
        `Cloud Vision HTTP ${res.status}: ${errBody.slice(0, 300) || res.statusText}`
      );
    }

    const json = await res.json();
    const response = json?.responses?.[0];

    if (response?.error) {
      throw new Error(
        `Cloud Vision API error: ${response.error.message || JSON.stringify(response.error)}`
      );
    }

    // fullTextAnnotation.text is the rebuilt document with newline
    // breaks at row boundaries — that's exactly what the merge step
    // wants. textAnnotations[0] would also work but is paragraph-
    // joined, which loses the visual line structure of an ingredient
    // panel.
    const rawText = response?.fullTextAnnotation?.text || '';

    const blocks = [];
    const pages = response?.fullTextAnnotation?.pages || [];
    for (const page of pages) {
      for (const block of page.blocks || []) {
        const blockText = (block.paragraphs || [])
          .map(p =>
            (p.words || [])
              .map(w => (w.symbols || []).map(s => s.text || '').join(''))
              .join(' ')
          )
          .join('\n');
        blocks.push({
          text: blockText,
          confidence: block.confidence ?? null,
          bbox: block.boundingBox || null,
        });
      }
    }

    return { rawText, blocks };
  }
}

module.exports = new CloudVisionService();
