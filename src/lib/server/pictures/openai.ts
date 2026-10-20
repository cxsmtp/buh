import crypto from 'node:crypto';
import { DEFAULT_OPENAI_MODEL, OPENAI_IMAGE_MODEL_ID } from '@/lib/pictureProviders';
import { HttpError } from '../http';
import { logEvent } from '../log';
import { jsonOf, picFetch, scrubWords, unreachable, type PicReply } from './transport';
import { PLACE, type EditInput, type PictureModule } from './types';

/**
 * OpenAI makes the picture with a GPT Image model, through the Images API's edits endpoint
 * (platform.openai.com/docs/guides/image-generation): POST https://api.openai.com/v1/images/edits as
 * multipart/form-data with model, prompt, size, quality and the pictures as image[] (the product
 * first, then the style photos); the answer is data[0].b64_json. The key goes in the Authorization
 * header only. Test lists the account's models (GET /v1/models) that are GPT Image models.
 */

const BASE = 'https://api.openai.com/v1';
/** GPT Image edits can take up to 2 minutes (OpenAI's guide). */
const TIMEOUT_MS = 150_000;
/** A b64_json picture (1–3 MB as PNG) in JSON. */
const REPLY_MAX = 16 * 1024 * 1024;

/**
 * The size asked for: GPT Image 2 and 2.5 take any WIDTHxHEIGHT in multiples of 16 within their
 * limits, so 4:5 is 1024x1280; the earlier GPT Image 1 models take only their fixed sizes.
 */
export function openaiSize(model: string, aspect: '4:5' | '1:1'): string {
  if (aspect === '1:1') return '1024x1024';
  return /^gpt-image-1/.test(model) ? '1024x1536' : '1024x1280';
}

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/** multipart/form-data: text fields, then the pictures as image[] in order. */
export function multipart(fields: Record<string, string>, images: Array<{ mime: string; bytes: Buffer }>): { body: Buffer; type: string } {
  const boundary = `----buh${crypto.randomBytes(12).toString('hex')}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf8'));
  images.forEach((img, i) => {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image[]"; filename="image-${i + 1}.${EXT[img.mime] ?? 'png'}"\r\nContent-Type: ${img.mime}\r\n\r\n`, 'utf8'));
    parts.push(img.bytes, Buffer.from('\r\n'));
  });
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${boundary}` };
}

interface OpenAiError {
  error?: { message?: string; type?: string; code?: string | null };
}

/** OpenAI's errors in plain words (never the key). */
function failure(reply: PicReply, key: string): HttpError {
  const e = (jsonOf(reply.body) as OpenAiError | null)?.error ?? {};
  const said = scrubWords(String(e.message ?? ''), key);
  const code = String(e.code ?? '');
  logEvent('warn', 'openai_pictures_error', { status: reply.status, code: code.slice(0, 60), type: String(e.type ?? '').slice(0, 60) });
  if (reply.status === 401) return new HttpError(502, `OpenAI did not accept the API key. Check it in ${PLACE}.`, {}, { code: 'ai_key_refused', detail: said });
  if (reply.status === 403 && /verif/i.test(said)) return new HttpError(502, 'OpenAI needs your organisation verified before GPT Image works: platform.openai.com → Settings → Organization → Verify.', {}, { code: 'ai_key_refused', detail: said });
  if (reply.status === 403) return new HttpError(502, `OpenAI refused this key for pictures (${said || 'no access'}). Check the key’s project in ${PLACE}.`, {}, { code: 'ai_key_refused', detail: said });
  if (code === 'moderation_blocked' || code === 'content_policy_violation' || e.type === 'image_generation_user_error') {
    return new HttpError(502, 'OpenAI would not make this picture (its safety check). Try another photo or scene.', {}, { code: 'ai_refused', detail: said });
  }
  if (reply.status === 402 || code === 'insufficient_quota' || code === 'billing_hard_limit_reached') return new HttpError(502, 'Your OpenAI credit is used up: add credit at platform.openai.com → Billing.', {}, { code: 'ai_no_balance', detail: said });
  if (reply.status === 429) return new HttpError(502, 'OpenAI’s limit for your account was reached. Wait a minute and try again.', {}, { code: 'ai_busy', detail: said });
  if (reply.status === 404) return new HttpError(502, `OpenAI does not offer that image model to this key. Press Test in ${PLACE} and choose another.`, {}, { code: 'ai_model_missing', detail: said });
  if (reply.status >= 500) return new HttpError(502, 'OpenAI is busy right now. Please try again in a moment.', {}, { code: 'ai_busy', detail: said });
  return new HttpError(502, `OpenAI said: ${said || `error ${reply.status}`}`, {}, { code: 'ai_error', detail: said });
}

async function call(key: string, method: 'GET' | 'POST', path: string, body: Buffer | undefined, type: string | undefined, timeoutMs: number): Promise<Record<string, unknown>> {
  let reply: PicReply;
  try {
    reply = await picFetch({ method, url: `${BASE}${path}`, headers: { authorization: `Bearer ${key}`, accept: 'application/json', ...(type ? { 'content-type': type } : {}) }, body, timeoutMs, maxBytes: REPLY_MAX });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw unreachable(err, 'OpenAI');
  }
  if (!reply.ok) throw failure(reply, key);
  const data = jsonOf(reply.body);
  if (!data) throw new HttpError(502, 'OpenAI’s answer could not be read. Please try again.', {}, { code: 'ai_bad_reply' });
  return data;
}

async function listModels(key: string) {
  const data = await call(key, 'GET', '/models', undefined, undefined, 20_000);
  const ids = (Array.isArray(data.data) ? data.data : [])
    .map((m) => String((m as { id?: unknown })?.id ?? ''))
    .filter((id) => OPENAI_IMAGE_MODEL_ID.test(id));
  const models = [...new Set(ids)].sort((a, b) => b.localeCompare(a));
  return { models, suggested: models.includes(DEFAULT_OPENAI_MODEL) ? DEFAULT_OPENAI_MODEL : models[0] ?? DEFAULT_OPENAI_MODEL };
}

async function edit({ key, model, product, references, prompt, aspect }: EditInput): Promise<Buffer> {
  const { body, type } = multipart({ model, prompt, size: openaiSize(model, aspect), quality: 'medium', n: '1' }, [product, ...references]);
  const data = await call(key, 'POST', '/images/edits', body, type, TIMEOUT_MS);
  const first = Array.isArray(data.data) ? (data.data[0] as { b64_json?: unknown } | undefined) : undefined;
  const b64 = typeof first?.b64_json === 'string' ? first.b64_json : '';
  if (!b64) {
    logEvent('warn', 'openai_pictures_no_image', {});
    throw new HttpError(502, 'OpenAI did not send a picture back. Please try again.', {}, { code: 'ai_no_image' });
  }
  if (b64.length > REPLY_MAX || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new HttpError(502, 'OpenAI’s picture could not be used. Nothing was saved; please try again.', {}, { code: 'ai_bad_image' });
  return Buffer.from(b64, 'base64');
}

export const openaiPictures: PictureModule = {
  id: 'openai',
  name: 'OpenAI',
  // The edits endpoint takes several input pictures; the shop sends at most 6 (the product and 5 style photos).
  maxImages: () => 6,
  listModels,
  edit,
};
