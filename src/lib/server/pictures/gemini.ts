import { HttpError } from '../http';
import { logEvent } from '../log';
import { answerOf, generateContent, listGeminiModels, type GeminiPart } from '../gemini';
import { PLACE, type EditInput, type PictureModule } from './types';

/**
 * Google Gemini makes the picture: the prompt, then the product photo and the style photos as
 * inline images in that order, IMAGE out (asked again with TEXT and IMAGE for a model that wants
 * both: that second call is counted against the hour's limit too). Google adds its SynthID mark.
 */

/** Image models take 10–30 seconds. */
const TIMEOUT_MS = 90_000;
/** Gemini's picture (a 1K picture is 1–2 MB), base64 in JSON. */
const RESULT_MAX_BYTES = 10 * 1024 * 1024;

/** The picture in Gemini's answer (base64 inlineData), or null. */
function pictureOf(parts: GeminiPart[]): string | null {
  for (const p of parts) {
    if (p.thought) continue;
    const d = p.inlineData ?? (p.inline_data ? { mimeType: p.inline_data.mime_type, data: p.inline_data.data } : undefined);
    if (d && typeof d.data === 'string' && /^image\//.test(String(d.mimeType ?? ''))) return d.data;
  }
  return null;
}

async function edit({ key, model, product, references, prompt, aspect, again }: EditInput): Promise<Buffer> {
  const inline = (img: { mime: string; bytes: Buffer }) => ({ inlineData: { mimeType: img.mime, data: img.bytes.toString('base64') } });
  const request = (modalities: string[]) => ({
    contents: [{ role: 'user', parts: [{ text: prompt }, inline(product), ...references.map(inline)] }],
    generationConfig: {
      responseModalities: modalities,
      // gemini-2.5-flash-image takes the shape only; newer image models also take the size.
      imageConfig: /^gemini-2\./.test(model) ? { aspectRatio: aspect } : { aspectRatio: aspect, imageSize: '1K' },
    },
  });
  const opts = { timeoutMs: TIMEOUT_MS, maxBytes: Math.ceil(RESULT_MAX_BYTES * 1.4) + 512 * 1024, what: 'Gemini', place: PLACE };
  let data: unknown;
  try {
    data = await generateContent(key, model, request(['IMAGE']), opts);
  } catch (err) {
    // A model that only answers with text and pictures together: asked again that way.
    const detail = String((err as { details?: { detail?: string } }).details?.detail ?? '');
    if ((err as { details?: { code?: string } }).details?.code !== 'ai_error' || !/modalit/i.test(detail)) throw err;
    again();
    data = await generateContent(key, model, request(['TEXT', 'IMAGE']), opts);
  }
  const { parts, finishReason, blocked } = answerOf(data);
  if (blocked || /SAFETY|PROHIBITED|BLOCKLIST|SPII|RECITATION/.test(finishReason)) {
    logEvent('warn', 'gemini_stage_refused', { blocked, finishReason });
    throw new HttpError(502, 'Gemini would not style this photo. Try another photo or scene.', {}, { code: 'ai_refused' });
  }
  const b64 = pictureOf(parts);
  if (!b64) {
    logEvent('warn', 'gemini_stage_no_image', { finishReason, parts: parts.length });
    throw new HttpError(502, 'Gemini did not send a picture back. Please try again.', {}, { code: 'ai_no_image' });
  }
  if (b64.length > Math.ceil(RESULT_MAX_BYTES * 1.37) || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(b64)) {
    logEvent('warn', 'gemini_stage_bad_image', { length: b64.length });
    throw new HttpError(502, 'Gemini’s picture could not be used (not a whole PNG, JPEG or WebP, or too large). Nothing was saved; please try again.', {}, { code: 'ai_bad_image' });
  }
  return Buffer.from(b64, 'base64');
}

export const geminiPictures: PictureModule = {
  id: 'gemini',
  name: 'Gemini',
  maxImages: () => 6,
  async listModels(key) {
    const m = await listGeminiModels(key);
    return { models: m.image, suggested: m.suggested.image };
  },
  edit,
};
