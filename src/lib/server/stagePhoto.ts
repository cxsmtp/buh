import { GEMINI_MODEL_ID, type StagedPhoto } from '@/types';
import { STAGING_EXTRA_MAX, stagingPreset } from '@/lib/staging';
import { audit } from './audit';
import { getDb } from './db';
import { answerOf, generateContent, type GeminiPart } from './gemini';
import { HttpError } from './http';
import { parseImageDataUrl } from './imageInput';
import { IMAGE_NAME, cleanImage, deleteImage, readImage, saveImageBytes } from './images';
import { logEvent } from './log';
import { rateLimit } from './rateLimit';
import { getSettings } from './settings';
import { forgetStaged, recordStaged, stagedRecords } from './stagedPhotos';

/**
 * "Style in a bedroom" (product editor → Photos): one of the product's photos goes to Google Gemini
 * (an image model, the owner's own key from Settings → AI writing) with a fixed prompt that keeps
 * the product exactly as photographed and changes only the room around it. The picture that comes
 * back is checked (a whole PNG, JPEG or WebP, size and pixel limits), its metadata is taken out, and
 * it is stored as a NEW photo, recorded as styled (src/lib/server/stagedPhotos.ts). The original is
 * never touched. The owner looks at both side by side and adds it to the product, or discards it.
 *
 * - 10 an hour per admin (each one is a paid call on the owner's Google account).
 * - Each one is in the audit log (preset, model, sizes; never image data, never the key).
 */

export const STAGE_LIMIT = { max: 10, windowMs: 60 * 60 * 1000 };
/** The photo sent: at most 4 MB (the shop's own uploads are at most 3 MB). */
export const SOURCE_MAX_BYTES = 4 * 1024 * 1024;
/** The picture Gemini sends back (a 1K picture is 1–2 MB). */
export const RESULT_MAX_BYTES = 10 * 1024 * 1024;
/** Image models take 10–30 seconds; the editor waits as long. */
const TIMEOUT_MS = 90_000;
const ASPECTS = new Set(['4:5', '1:1']);
const BODY_FIELDS = new Set(['imageId', 'image', 'preset', 'extra', 'aspect']);

/** The owner's extra words: plain text, one line, at most 200 characters. */
export function cleanExtra(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new HttpError(400, 'Extra words must be text.');
  const s = v
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2066-\u2069]+/g, ' ')
    .replace(/[<>{}`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > STAGING_EXTRA_MAX) throw new HttpError(400, `Extra words: at most ${STAGING_EXTRA_MAX} characters.`);
  return s;
}

/** The fixed prompt: the product stays exactly as photographed; only the setting changes. */
export function stagingPrompt(scene: string, extra: string, aspect: string): string {
  return [
    'Edit this photograph of a bedding product (a bed sheet or duvet cover set) from a home-linen shop.',
    'Keep the product itself exactly as it is in the photo:',
    '- the same pattern and motif, in the same places, at the same print scale;',
    '- the same colours and shades: do not recolour, brighten, saturate or fade the fabric;',
    '- the same stitching, piping, borders, edges, folds of the fabric where visible, and texture;',
    '- the same number of pieces (sheets, pillowcases, covers): add none and remove none.',
    `Change only what is around it: show the bedding neatly made on a bed in ${scene}. You may change the bed, the room, the lighting and the props.`,
    'No text, letters or numbers anywhere, no logos, no watermarks, no people or parts of people, no pets.',
    `A realistic photograph for a high-end catalogue, ${aspect === '1:1' ? 'square' : 'portrait 4:5'} framing, with the bedding as the clear subject.`,
    ...(extra ? [`The owner's note about the setting (it never changes the product): ${extra}`] : []),
  ].join('\n');
}

export interface StageResult {
  url: string;
  staged: StagedPhoto;
  model: string;
  width: number;
  height: number;
}

/** For the editor's button: ready, or why not (no Gemini key yet). */
export function stagingStatus(): { ready: boolean; reason: 'no_key' | null; model: string } {
  const ai = getSettings('ai');
  return { ready: Boolean(ai.geminiApiKey), reason: ai.geminiApiKey ? null : 'no_key', model: ai.geminiImageModel };
}

/** The picture in Gemini's answer (base64 inlineData), or null. */
function pictureOf(parts: GeminiPart[]): string | null {
  for (const p of parts) {
    if (p.thought) continue;
    const d = p.inlineData ?? (p.inline_data ? { mimeType: p.inline_data.mime_type, data: p.inline_data.data } : undefined);
    if (d && typeof d.data === 'string' && /^image\//.test(String(d.mimeType ?? ''))) return d.data;
  }
  return null;
}

/** POST /api/admin/products/stage-photo, after the admin check and the size-capped read. */
export async function stagePhoto(body: Record<string, unknown>, actor: string): Promise<StageResult> {
  for (const k of Object.keys(body)) if (!BODY_FIELDS.has(k)) throw new HttpError(400, `Unexpected field: ${k.slice(0, 30)}.`);
  const ai = getSettings('ai');
  if (!ai.geminiApiKey) throw new HttpError(409, 'Add your Gemini API key in Settings → AI writing (aistudio.google.com → Get API key).', {}, { code: 'staging_off' });
  if (!GEMINI_MODEL_ID.test(ai.geminiImageModel)) throw new HttpError(409, 'Choose a Gemini image model: press Test in Settings → AI writing.', {}, { code: 'staging_off' });
  const preset = stagingPreset(body.preset);
  if (!preset) throw new HttpError(400, 'Choose a style.');
  const extra = cleanExtra(body.extra);
  const aspect = body.aspect === undefined ? '4:5' : String(body.aspect);
  if (!ASPECTS.has(aspect)) throw new HttpError(400, 'Shape: 4:5 or 1:1.');

  // The photo: one of the product's stored photos, or one just taken (a data URL).
  let source = '';
  let photo: { mime: string; bytes: Buffer };
  if (typeof body.imageId === 'string') {
    const name = body.imageId.replace(/^\/api\/images\//, '');
    if (!IMAGE_NAME.test(name)) throw new HttpError(400, 'Choose one of the product’s photos.');
    const img = readImage(name);
    if (!img) throw new HttpError(404, 'That photo is no longer stored. Upload it again.');
    if (img.bytes.length > SOURCE_MAX_BYTES) throw new HttpError(413, 'The photo is too large (at most 4 MB).');
    source = name;
    photo = img;
  } else if (body.image !== undefined) {
    photo = parseImageDataUrl(body.image, SOURCE_MAX_BYTES);
  } else {
    throw new HttpError(400, 'Choose a photo first (PNG, JPEG or WebP).');
  }

  const r = rateLimit(`ai-stage:${actor}`, STAGE_LIMIT.max, STAGE_LIMIT.windowMs);
  if (!r.ok) throw new HttpError(429, 'That is 10 styled photos this hour. Please wait a while before the next one.', { 'Retry-After': String(r.retryAfterSec) });

  const model = ai.geminiImageModel;
  const request = (modalities: string[]) => ({
    contents: [{ role: 'user', parts: [{ text: stagingPrompt(preset.scene, extra, aspect) }, { inlineData: { mimeType: photo.mime, data: photo.bytes.toString('base64') } }] }],
    generationConfig: {
      responseModalities: modalities,
      // gemini-2.5-flash-image takes the shape only; newer image models also take the size.
      imageConfig: /^gemini-2\./.test(model) ? { aspectRatio: aspect } : { aspectRatio: aspect, imageSize: '1K' },
    },
  });
  const opts = { timeoutMs: TIMEOUT_MS, maxBytes: Math.ceil(RESULT_MAX_BYTES * 1.4) + 512 * 1024, what: 'Gemini' };
  let data: unknown;
  try {
    data = await generateContent(ai.geminiApiKey, model, request(['IMAGE']), opts);
  } catch (err) {
    // A model that only answers with text and pictures together: asked again that way.
    const detail = String((err as { details?: { detail?: string } }).details?.detail ?? '');
    if ((err as { details?: { code?: string } }).details?.code !== 'ai_error' || !/modalit/i.test(detail)) throw err;
    data = await generateContent(ai.geminiApiKey, model, request(['TEXT', 'IMAGE']), opts);
  }

  const { parts, finishReason, blocked } = answerOf(data);
  if (blocked || /SAFETY|PROHIBITED|BLOCKLIST|SPII|RECITATION/.test(finishReason)) {
    logEvent('warn', 'gemini_stage_refused', { blocked, finishReason });
    throw new HttpError(502, 'Gemini would not style this photo. Try another photo or style.', {}, { code: 'ai_refused' });
  }
  const b64 = pictureOf(parts);
  if (!b64) {
    logEvent('warn', 'gemini_stage_no_image', { finishReason, parts: parts.length });
    throw new HttpError(502, 'Gemini did not send a picture back. Please try again.', {}, { code: 'ai_no_image' });
  }
  const clean = b64.length <= Math.ceil(RESULT_MAX_BYTES * 1.37) && /^[A-Za-z0-9+/_-]+={0,2}$/.test(b64) ? cleanImage(Buffer.from(b64, 'base64'), RESULT_MAX_BYTES) : null;
  if (!clean) {
    logEvent('warn', 'gemini_stage_bad_image', { length: b64.length });
    throw new HttpError(502, 'Gemini’s picture could not be used (not a whole PNG, JPEG or WebP, or too large). Nothing was saved; please try again.', {}, { code: 'ai_bad_image' });
  }

  const url = saveImageBytes(clean.bytes, clean.mime);
  const name = url.slice('/api/images/'.length);
  const at = new Date().toISOString();
  recordStaged(name, { source, preset: preset.id, at });
  audit('product.photo_staged', { by: actor, model, preset: preset.id, source: source || 'upload', sourceBytes: photo.bytes.length, result: name, resultBytes: clean.bytes.length, width: clean.width, height: clean.height, extraLength: extra.length, aspect });
  return { url, staged: { staged: true, source, preset: preset.id, at }, model, width: clean.width, height: clean.height };
}

/**
 * "Discard": a styled photo that no product (and no editor draft) uses is deleted. Only photos this
 * feature made can be deleted here; anything else is refused.
 */
export function discardStagedPhoto(body: Record<string, unknown>, actor: string): { deleted: boolean } {
  for (const k of Object.keys(body)) if (k !== 'url') throw new HttpError(400, `Unexpected field: ${k.slice(0, 30)}.`);
  const name = typeof body.url === 'string' ? body.url.replace(/^\/api\/images\//, '') : '';
  if (!IMAGE_NAME.test(name)) throw new HttpError(400, 'Which styled photo?');
  if (!(name in stagedRecords())) throw new HttpError(404, 'That is not a styled photo.');
  const db = getDb();
  const used =
    (db.prepare('SELECT COUNT(*) FROM products WHERE instr(data, ?) > 0').pluck().get(name) as number) +
    (db.prepare('SELECT COUNT(*) FROM product_drafts WHERE instr(data, ?) > 0').pluck().get(name) as number);
  if (used) throw new HttpError(409, 'That styled photo is on a product (or its draft): remove it there instead.');
  const deleted = deleteImage(name);
  forgetStaged(name);
  audit('product.photo_staged_discarded', { by: actor, result: name });
  return { deleted };
}
