import { DEFAULT_FAL_MODEL, FAL_MODELS, FAL_MODEL_ID, falModel } from '@/lib/pictureProviders';
import { HttpError } from '../http';
import { logEvent } from '../log';
import { isFalMediaHost, jsonOf, picFetch, scrubWords, unreachable, type PicReply } from './transport';
import { PLACE, type EditInput, type PictureModule } from './types';

/**
 * fal.ai makes the picture with the model the owner chose (src/lib/pictureProviders.ts), through
 * fal's queue API (fal.ai/docs: model-endpoints/queue): POST https://queue.fal.run/<model id> with
 * "Authorization: Key <key>" and the model's input as JSON (the product photo first, then the style
 * photos, as data URIs, which fal's CDN page says models accept), then the status_url is polled
 * until COMPLETED and the response_url read. sync_mode asks for the picture as a data URI; a picture
 * sent as an address is fetched only from fal's CDN (fal.media and its subdomains), never anywhere
 * else. Test asks fal's Platform API (api.fal.ai/v1/models) about the curated models with the key.
 */

const QUEUE = 'https://queue.fal.run';
const MODELS_API = 'https://api.fal.ai/v1/models';
/** The whole wait for one picture: fal queues, then the model runs. */
const DEADLINE_MS = 150_000;
const RESULT_MAX_BYTES = 10 * 1024 * 1024;
let pollMs = 1500;

/** Tests: how long to wait between status checks. */
export function _setFalPollMs(ms: number) {
  pollMs = ms;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface FalDetail {
  type?: string;
  msg?: string;
}

/** fal's errors in plain words (never the key). */
function failure(reply: PicReply, key: string): HttpError {
  const data = jsonOf(reply.body) ?? {};
  const detail = Array.isArray(data.detail) ? (data.detail as FalDetail[]) : [];
  const said = scrubWords(String(detail[0]?.msg ?? (typeof data.detail === 'string' ? data.detail : '') ?? data.error ?? ''), key);
  const type = String(detail[0]?.type ?? data.error_type ?? '');
  logEvent('warn', 'fal_pictures_error', { status: reply.status, type: type.slice(0, 60) });
  if (detail.some((d) => d?.type === 'content_policy_violation')) return new HttpError(502, 'fal.ai would not make this picture (its safety check). Try another photo or scene.', {}, { code: 'ai_refused', detail: said });
  if (reply.status === 402 || /balance|locked|credit/i.test(said)) return new HttpError(502, 'Your fal.ai credit is used up: add credit at fal.ai → Billing.', {}, { code: 'ai_no_balance', detail: said });
  if (reply.status === 401 || reply.status === 403) return new HttpError(502, `fal.ai did not accept the key. Check it in ${PLACE}.`, {}, { code: 'ai_key_refused', detail: said });
  if (reply.status === 404) return new HttpError(502, `fal.ai does not know that model. Choose another in ${PLACE}.`, {}, { code: 'ai_model_missing', detail: said });
  if (reply.status === 429) return new HttpError(502, 'fal.ai’s limit for your account was reached. Wait a minute and try again.', {}, { code: 'ai_busy', detail: said });
  if (reply.status === 504 || type === 'generation_timeout' || type === 'request_timeout') return new HttpError(504, 'fal.ai took too long. Please try again in a moment.', {}, { code: 'ai_timeout', detail: said });
  if (reply.status >= 500) return new HttpError(502, 'fal.ai is busy right now. Please try again in a moment.', {}, { code: 'ai_busy', detail: said });
  if (type === 'no_media_generated') return new HttpError(502, 'fal.ai did not send a picture back. Please try again.', {}, { code: 'ai_no_image', detail: said });
  return new HttpError(502, `fal.ai said: ${said || `error ${reply.status}`}`, {}, { code: 'ai_error', detail: said });
}

async function send(key: string, method: 'GET' | 'POST', url: string, body?: unknown, maxBytes = 2 * 1024 * 1024, timeoutMs = 30_000): Promise<Record<string, unknown>> {
  let reply: PicReply;
  try {
    reply = await picFetch({ method, url, headers: { authorization: `Key ${key}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), timeoutMs, maxBytes });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw unreachable(err, 'fal.ai');
  }
  if (!reply.ok) throw failure(reply, key);
  const data = jsonOf(reply.body);
  if (!data) throw new HttpError(502, 'fal.ai’s answer could not be read. Please try again.', {}, { code: 'ai_bad_reply' });
  return data;
}

/** A queue address fal sent back, used only when it is fal's own queue host over https. */
function queueUrl(v: unknown, fallback: string): string {
  if (typeof v !== 'string') return fallback;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && u.hostname === 'queue.fal.run' && !u.username && !u.password ? u.href : fallback;
  } catch {
    return fallback;
  }
}

/** The model's input: the prompt, the pictures in the field it takes, and its shape. */
export function falInput(model: string, prompt: string, images: string[], aspect: '4:5' | '1:1'): Record<string, unknown> {
  const m = falModel(model);
  const shape =
    m.size === 'image_size'
      ? { image_size: aspect === '1:1' ? { width: 1024, height: 1024 } : { width: 1024, height: 1280 } }
      : m.size === 'aspect_ratio_34'
      ? { aspect_ratio: aspect === '1:1' ? '1:1' : '3:4' }
      : { aspect_ratio: aspect };
  const known = FAL_MODELS.some((x) => x.id === model);
  return { prompt, ...(m.input === 'image_url' ? { image_url: images[0] } : { image_urls: images }), ...(known ? shape : {}), sync_mode: true };
}

/** The picture fal sent: a data URI (sync_mode), or an address on fal's CDN only. */
async function pictureFrom(output: Record<string, unknown>, key: string): Promise<Buffer> {
  const images = Array.isArray(output.images) ? output.images : output.image ? [output.image] : [];
  const url = String((images[0] as { url?: unknown } | undefined)?.url ?? '');
  if (!url) throw new HttpError(502, 'fal.ai did not send a picture back. Please try again.', {}, { code: 'ai_no_image' });
  const data = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
  if (data) return Buffer.from(data[2], 'base64');
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new HttpError(502, 'fal.ai’s picture could not be used. Nothing was saved; please try again.', {}, { code: 'ai_bad_image' });
  }
  if (u.protocol !== 'https:' || !isFalMediaHost(u.hostname)) {
    logEvent('warn', 'fal_result_host_refused', { host: u.hostname.slice(0, 80) });
    throw new HttpError(502, 'fal.ai sent the picture from an address the shop does not trust. Nothing was fetched.', {}, { code: 'ai_bad_reply' });
  }
  let reply: PicReply;
  try {
    // fal's CDN files are public: the key is not sent with this download.
    reply = await picFetch({ method: 'GET', url: u.href, headers: {}, timeoutMs: 60_000, maxBytes: RESULT_MAX_BYTES + 1 });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw unreachable(err, 'fal.ai');
  }
  if (!reply.ok) throw failure(reply, key);
  return reply.body;
}

async function edit({ key, model, product, references, prompt, aspect }: EditInput): Promise<Buffer> {
  if (!FAL_MODEL_ID.test(model)) throw new HttpError(409, `Choose a fal model in ${PLACE}.`, {}, { code: 'staging_off', reason: 'no_model' });
  const uri = (img: { mime: string; bytes: Buffer }) => `data:${img.mime};base64,${img.bytes.toString('base64')}`;
  const images = [product, ...references].slice(0, falModel(model).maxImages).map(uri);
  const started = Date.now();
  const submitted = await send(key, 'POST', `${QUEUE}/${model}`, falInput(model, prompt, images, aspect), 256 * 1024);
  const id = String(submitted.request_id ?? '');
  if (!/^[A-Za-z0-9-]{8,80}$/.test(id)) throw new HttpError(502, 'fal.ai’s answer could not be read. Please try again.', {}, { code: 'ai_bad_reply' });
  // The queue's addresses use the model's owner and app only (fal's queue docs).
  const app = model.split('/').slice(0, 2).join('/');
  const statusUrl = queueUrl(submitted.status_url, `${QUEUE}/${app}/requests/${id}/status`);
  const responseUrl = queueUrl(submitted.response_url, `${QUEUE}/${app}/requests/${id}`);
  for (;;) {
    if (Date.now() - started > DEADLINE_MS) throw new HttpError(504, 'fal.ai took too long (over two minutes). Please try again.', {}, { code: 'ai_timeout' });
    await sleep(pollMs);
    const st = await send(key, 'GET', statusUrl);
    const status = String(st.status ?? '');
    if (status === 'COMPLETED') break;
    if (status !== 'IN_QUEUE' && status !== 'IN_PROGRESS') throw new HttpError(502, 'fal.ai could not make the picture. Please try again.', {}, { code: 'ai_error' });
  }
  const output = await send(key, 'GET', responseUrl, undefined, Math.ceil(RESULT_MAX_BYTES * 1.4) + 256 * 1024, 60_000);
  return pictureFrom(output, key);
}

async function listModels(key: string) {
  const query = FAL_MODELS.map((m) => `endpoint_id=${encodeURIComponent(m.id)}`).join('&');
  const data = await send(key, 'GET', `${MODELS_API}?${query}`);
  const found = new Set((Array.isArray(data.models) ? data.models : []).map((m) => String((m as { endpoint_id?: unknown })?.endpoint_id ?? '')));
  // The curated models fal still lists (all of them when fal answers with none: the key worked).
  const models = FAL_MODELS.map((m) => m.id).filter((id) => !found.size || found.has(id));
  return { models, suggested: models.includes(DEFAULT_FAL_MODEL) ? DEFAULT_FAL_MODEL : models[0] ?? DEFAULT_FAL_MODEL };
}

export const falPictures: PictureModule = {
  id: 'fal',
  name: 'fal.ai',
  maxImages: (model) => falModel(model).maxImages,
  listModels,
  edit,
};
