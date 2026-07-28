const fs = require('fs');
const path = require('path');

/**
 * Decode barcode from an image file.
 * Uses Gemini Vision as a reliable fallback for barcode reading.
 */
async function decodeBarcode(filePath) {
  const buffer = fs.readFileSync(filePath);
  const base64 = buffer.toString('base64');
  const mimeType = filePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';

  // Use Gemini to read the barcode number
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  const result = await model.generateContent([
    {
      inlineData: { mimeType, data: base64 },
    },
    {
      text: `This image contains a barcode (UPC, EAN, or other format). 
Read and return ONLY the numeric/alphanumeric code printed below or encoded in the barcode.
Return just the raw code string with no other text, no explanation, no formatting.
If you cannot read a barcode, return "UNREADABLE".`,
    },
  ]);

  const text = result.response.text().trim();
  if (!text || text === 'UNREADABLE' || text.length < 4) {
    throw new Error('Could not decode barcode');
  }

  // Clean up: remove spaces, dashes
  return text.replace(/[\s\-]/g, '');
}

module.exports = { decodeBarcode };
