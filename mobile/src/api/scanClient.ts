import axios from 'axios';
import { API_BASE as DEFAULT_API_BASE } from '../config/api';

export type BackMultiResponse = {
  pendingScanId: string;
  ingredients: string[];
  rawIngredientsText?: string;
  confidence: number;
  isComplete?: boolean;
  missingSection?: string | null;
  notes?: string;
  imageCount?: number;
  suggestedAction?: 'auto_commit' | 'confirm' | 'recapture';
};

/**
 * POST /scan/back-multi/:pendingScanId — multipart field name `images` (repeat).
 * Cloud Vision DOCUMENT_TEXT_DETECTION + merge run on server.
 */
export async function uploadBackLabelBurst(
  pendingScanId: string,
  imageUris: string[],
  options?: { apiBase?: string },
): Promise<BackMultiResponse> {
  const base = (options?.apiBase ?? DEFAULT_API_BASE).replace(/\/$/, '');
  const form = new FormData();
  imageUris.forEach((uri, i) => {
    form.append(
      'images',
      { uri, name: `roi_${i}.jpg`, type: 'image/jpeg' } as unknown as Blob,
    );
  });

  const { data } = await axios.post<BackMultiResponse>(
    `${base}/scan/back-multi/${pendingScanId}`,
    form,
    {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 120_000,
    },
  );
  return data;
}
