/**
 * Google Cloud Vision — document OCR for label photos.
 * Uses API key auth (GOOGLE_CLOUD_VISION_API_KEY).
 */

const imagePreprocess = require('./imagePreprocessService');

class VisionService {
  isConfigured() {
    return Boolean(String(process.env.GOOGLE_CLOUD_VISION_API_KEY || '').trim());
  }

  /**
   * @param {Buffer} imageBuffer
   * @returns {Promise<{ text: string, lines: Array<{ text: string, ymin: number, xmin: number, ymax: number, xmax: number }> }>}
   */
  async detectDocumentLayout(imageBuffer) {
    const apiKey = String(process.env.GOOGLE_CLOUD_VISION_API_KEY || '').trim();
    if (!apiKey) {
      throw new Error('GOOGLE_CLOUD_VISION_API_KEY not set');
    }

    const ocrBuffer = await imagePreprocess.enhanceForOcr(imageBuffer);

    const url = `https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [
          {
            image: { content: ocrBuffer.toString('base64') },
            features: [{ type: 'DOCUMENT_TEXT_DETECTION', maxResults: 1 }],
          },
        ],
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Vision API HTTP ${res.status}: ${errBody.slice(0, 300)}`);
    }

    const data = await res.json();
    const response = data.responses?.[0];
    if (!response) {
      throw new Error('Vision API: empty response');
    }
    if (response.error?.message) {
      throw new Error(`Vision API: ${response.error.message}`);
    }

    const fta = response.fullTextAnnotation;
    const text =
      fta?.text?.trim() ||
      response.textAnnotations?.[0]?.description?.trim() ||
      '';

    if (!text) {
      throw new Error('Vision API: no text detected');
    }

    const lines = this._extractParagraphLines(fta);
    return { text, lines };
  }

  /**
   * @param {Buffer} imageBuffer
   * @returns {Promise<string>} Full document text in reading order
   */
  async detectDocumentText(imageBuffer) {
    const { text } = await this.detectDocumentLayout(imageBuffer);
    return text;
  }

  /**
   * One Vision paragraph ≈ one printed line on most labels.
   * @param {object} fullTextAnnotation
   * @returns {Array<{ text: string, ymin: number, xmin: number, ymax: number, xmax: number }>}
   */
  _extractParagraphLines(fullTextAnnotation) {
    const lines = [];
    if (!fullTextAnnotation?.pages?.length) return lines;

    for (const page of fullTextAnnotation.pages) {
      for (const block of page.blocks || []) {
        for (const paragraph of block.paragraphs || []) {
          const text = this._paragraphToText(paragraph);
          if (!text.trim()) continue;

          const box = this._boundingBoxExtents(paragraph.boundingBox);
          if (!box) continue;

          lines.push({ text: text.trim(), ...box });
        }
      }
    }

    return lines;
  }

  _paragraphToText(paragraph) {
    if (!paragraph?.words?.length) return '';

    const parts = [];
    for (const word of paragraph.words) {
      let w = '';
      for (const symbol of word.symbols || []) {
        w += symbol.text || '';
      }
      if (w) parts.push(w);
    }
    return parts.join(' ');
  }

  /** @returns {{ ymin: number, xmin: number, ymax: number, xmax: number } | null} */
  _boundingBoxExtents(boundingBox) {
    const verts = boundingBox?.vertices || boundingBox?.normalizedVertices || [];
    if (!verts.length) return null;

    const ys = verts.map(v => Number(v.y) || 0);
    const xs = verts.map(v => Number(v.x) || 0);
    return {
      ymin: Math.min(...ys),
      xmin: Math.min(...xs),
      ymax: Math.max(...ys),
      xmax: Math.max(...xs),
    };
  }
}

module.exports = new VisionService();
