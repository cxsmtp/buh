import http from 'node:http';
import { AI_MODELS, DEEPSEEK_MODEL_ID, GEMINI_MODEL_ID, deepseekReadsPhotos, type AiModel, type AiProvider, type AiSettings } from '@/types';
import { COPY_LIMITS, composeDescription, highlightLines } from '@/lib/productCopy';
import { stripEmoji } from '@/lib/marquee';
import { FABRIC_COLOURS as NAMED } from '@/data/fabricColours';
import { audit } from './audit';
import { HttpError } from './http';
import { parseImageDataUrl } from './imageInput';
import { IMAGE_NAME, readImage } from './images';
import { testStandIn } from './testStandIn';
import { logEvent, maskAiKeys } from './log';
import { safeFetch } from './outbound';
import { rateLimit } from './rateLimit';
import { answerOf, generateContent, listGeminiModels, textOf, type ModelLists } from './gemini';
import { chatAnswer, deepseekCall, listDeepSeekModels, type DeepSeekModels } from './deepseek';
import { DEEPSEEK_KEY, DEEPSEEK_KEY_HINT, GEMINI_KEY, GEMINI_KEY_HINT, getSettings, validateAiPrompt, withStoredSecrets } from './settings';
import { EVERYDAY, cleanGiftLine, defaultGiftTarget, giftFestivals, type GiftFestival } from './giftLines';
import { DEFAULT_AI_PROMPT, giftPromptText, writingSystem, writingUser, type AiPromptSettings } from '@/lib/aiPrompt';

/**
 * "Write from photo" (Admin Hub → Inventory → product editor): the product's photo goes to
 * Anthropic's Messages API, Google Gemini (src/lib/server/gemini.ts) or DeepSeek
 * (src/lib/server/deepseek.ts), as chosen in Settings → AI writing, from the server only, with the
 * owner's own key, and comes back as a suggested name, short description, design and comfort
 * paragraphs, highlights, a gift note, the full description made of them (src/lib/productCopy.ts),
 * colours and weave. All three use the same rules and the same checks.
 * Nothing is saved here: the editor shows the suggestions for the owner to edit or ignore.
 *
 * - One fixed address (api.anthropic.com), through safeFetch: https only, no redirects, public
 *   addresses only, a 30-second deadline and a cap on the reply's size.
 * - The key never leaves the server: not in a reply, not in a log (log.ts masks sk-ant-… too).
 * - Every field of the answer is checked and cut to size here; the browser never sees raw text.
 * - 20 descriptions an hour per admin; each one is in the audit log (which model, which kind of
 *   photo, no image data).
 */

export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
/** Room for the JSON answer (about 400 tokens) and the model's own brief thinking. */
const MAX_TOKENS = 4096;
const TIMEOUT_MS = 60_000;
/** Anthropic takes images up to 5 MB; the shop's own uploads are at most 3 MB. */
const IMAGE_MAX_BYTES = Math.floor(3.5 * 1024 * 1024);
export const DESCRIBE_LIMIT = { max: 20, windowMs: 60 * 60 * 1000 };
const TEST_LIMIT = { max: 10, windowMs: 10 * 60 * 1000 };

export const LIMITS = COPY_LIMITS;

/** 429 with Retry-After when the limit is reached (as guard.ts's enforceLimit, without its cookie imports). */
function enforceLimit(key: string, max: number, windowMs: number, message: string) {
  const r = rateLimit(key, max, windowMs);
  if (!r.ok) throw new HttpError(429, message, { 'Retry-After': String(r.retryAfterSec) });
}

// ── transport ───────────────────────────────────────────────────────────────

type Reply = { status: number; ok: boolean; data: unknown };
type Transport = (body: string, headers: Record<string, string>) => Promise<Reply>;

let override: Transport | null = null;

/** Tests: answer instead of Anthropic (null puts the real one back). */
export function _setAnthropicTransport(fn: Transport | null) {
  override = fn;
}

/**
 * Tests only: BUH_TEST_ANTHROPIC_API=http://127.0.0.1:<port>/ sends the calls to a stand-in on the
 * same machine (as BUH_TEST_STRIPE_API does for Stripe). Anything but a plain-http loopback address
 * is ignored, so a shipped server can't be pointed anywhere else with it.
 */
function testApi(): URL | null {
  const v = process.env.BUH_TEST_ANTHROPIC_API;
  if (!v) return null;
  const u = testStandIn('BUH_TEST_ANTHROPIC_API');
  if (u) return u;
  logEvent('warn', 'anthropic_test_api_ignored', {});
  return null;
}

function loopbackPost(base: URL, body: string, headers: Record<string, string>): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL('/v1/messages', base), { method: 'POST', headers: { ...headers, 'Content-Length': String(Buffer.byteLength(body)) }, timeout: TIMEOUT_MS }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        let data: unknown = null;
        try {
          data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          data = null;
        }
        const status = res.statusCode ?? 0;
        resolve({ status, ok: status >= 200 && status < 300, data });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('Request timed out.'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end(body);
  });
}

const send: Transport = (body, headers) => {
  if (override) return override(body, headers);
  const test = testApi();
  if (test) return loopbackPost(test, body, headers);
  return safeFetch(ANTHROPIC_URL, { method: 'POST', headers, body, timeoutMs: TIMEOUT_MS, maxBytes: 256 * 1024 });
};

/** Anthropic API keys (and the key in hand), wherever they appear in a message. */
function scrub(text: string, key: string): string {
  let out = key ? text.split(key).join('[redacted]') : text;
  out = maskAiKeys(out.replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-[redacted]'));
  return out.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200);
}

interface MessageReply {
  content?: Array<{ type?: string; text?: string }>;
  stop_reason?: string;
  error?: { type?: string; message?: string };
}

/** One Messages API call; the text of the answer, or a readable reason (never the key). */
async function callAnthropic(key: string, model: AiModel, request: Record<string, unknown>): Promise<{ text: string; stopReason: string }> {
  const headers: Record<string, string> = {
    'x-api-key': key,
    'anthropic-version': ANTHROPIC_VERSION,
    'content-type': 'application/json',
  };
  // A false positive from a safety check is retried on the model Anthropic recommends (Sonnet and Opus).
  const fallbacks = model !== 'claude-haiku-5-5';
  if (fallbacks) headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
  const body = JSON.stringify({ model, ...request, ...(fallbacks ? { fallbacks: 'default' } : {}) });
  let reply: Reply;
  try {
    reply = await send(body, headers);
  } catch (err) {
    const code = (err as { code?: string }).code;
    logEvent('warn', 'anthropic_unreachable', { reason: code || 'network' });
    if (code === 'ETIMEDOUT') throw new HttpError(504, 'Anthropic took too long to answer (over a minute). Please try again.', {}, { code: 'ai_timeout' });
    throw new HttpError(502, 'Could not reach Anthropic. Check the shop’s internet connection and try again.', {}, { code: 'ai_unreachable' });
  }
  const data = (reply.data && typeof reply.data === 'object' ? reply.data : {}) as MessageReply;
  if (!reply.ok) {
    const said = scrub(String(data.error?.message ?? ''), key);
    logEvent('warn', 'anthropic_error', { status: reply.status, type: String(data.error?.type ?? '').slice(0, 60) });
    if (reply.status === 401 || reply.status === 403) {
      throw new HttpError(502, 'Anthropic did not accept the API key. Check it in Settings → AI writing.', {}, { code: 'ai_key_refused', detail: said });
    }
    if (reply.status === 429) throw new HttpError(502, 'Anthropic’s limit for your account was reached. Wait a minute and try again.', {}, { code: 'ai_busy', detail: said });
    if (reply.status === 529 || reply.status >= 500) throw new HttpError(502, 'Anthropic is busy right now. Please try again in a moment.', {}, { code: 'ai_busy', detail: said });
    throw new HttpError(502, `Anthropic said: ${said || `error ${reply.status}`}`, {}, { code: 'ai_error', detail: said });
  }
  const stopReason = String(data.stop_reason ?? '');
  if (stopReason === 'refusal') throw new HttpError(502, 'The AI would not describe this photo. Try another photo, or write the text yourself.', {}, { code: 'ai_refused' });
  const text = (Array.isArray(data.content) ? data.content : []).filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
  return { text, stopReason };
}

// ── the answer, checked ─────────────────────────────────────────────────────

export interface Suggestion {
  title: string;
  shortDescription: string;
  /** The full description: design, comfort, closing, highlights and gift note (src/lib/productCopy.ts). */
  description: string;
  /** What it looks like and which bedrooms and decor it suits ('' from an older-style answer). */
  design: string;
  /** How it looks to feel and when it is nice to use ('' from an older-style answer). */
  comfort: string;
  closing: string;
  /** 3–5 short lines a shopper scans. */
  highlights: string[];
  /** One line on giving it for the festival asked for (giftFor), or an everyday one, else ''. */
  giftLine: string;
  colors: Array<{ name: string; hex: string }>;
  weave: string | null;
  motif: string;
}

/** Plain text: no markup, no emoji, no control characters; line breaks kept only when asked. */
function plain(v: unknown, { lines = false } = {}): string {
  if (typeof v !== 'string') return '';
  let s = v.replace(/<[^>]*>/g, ' ').replace(/[<>]/g, ' ').replace(/\r\n?/g, '\n');
  s = s.replace(lines ? /[\u0000-\u0009\u000b-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2066-\u2069]+/g : /[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2066-\u2069]+/g, ' ');
  s = s.replace(/[*_#`]+/g, '');
  if (!lines) return stripEmoji(s).replace(/\s+/g, ' ').trim();
  // Paragraphs (a blank line between them) kept; each one on a single line.
  return s
    .split(/\n\s*\n/)
    .map((p) => stripEmoji(p).replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');
}

/** Cut to the limit at a word (or, for longer text, at the end of a sentence). */
function clamp(s: string, max: number, { sentence = false } = {}): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  if (sentence) {
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'), cut.endsWith('.') ? cut.length - 1 : -1);
    if (end > max * 0.5) return cut.slice(0, end + 1).trim();
  }
  const at = cut.lastIndexOf(' ');
  return (at > max * 0.5 ? cut.slice(0, at) : cut).replace(/[\s,;:–—-]+$/, '').trim();
}


function color(v: unknown): { name: string; hex: string } | null {
  const o = typeof v === 'string' ? { name: v } : v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  const name = clamp(plain(o.name), 40);
  if (!name || !/\p{L}/u.test(name)) return null;
  const pretty = name.charAt(0).toUpperCase() + name.slice(1);
  const given = typeof o.hex === 'string' ? o.hex.trim() : '';
  const word = name.toLowerCase().split(/\s+/).reverse().find((w) => NAMED[w]);
  const hex = /^#[0-9a-fA-F]{6}$/.test(given) ? given.toLowerCase() : word ? NAMED[word] : '#ffffff';
  return { name: pretty, hex };
}

/** The model's text → the suggestion, every field checked and cut to size. Throws 502 if it is not the JSON asked for. */
export function parseSuggestion(text: string, weaves: string[]): Suggestion {
  const body = text.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '');
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  let raw: Record<string, unknown> | null = null;
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(body.slice(start, end + 1));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
    } catch {
      raw = null;
    }
  }
  if (!raw) throw new HttpError(502, 'The AI’s answer could not be read. Please try again.', {}, { code: 'ai_bad_reply' });
  const title = clamp(plain(raw.title), LIMITS.title);
  const shortDescription = clamp(plain(raw.shortDescription), LIMITS.shortDescription);
  const design = clamp(plain(raw.design), LIMITS.design, { sentence: true });
  const comfort = clamp(plain(raw.comfort), LIMITS.comfort, { sentence: true });
  const closing = clamp(plain(raw.closing), LIMITS.closing, { sentence: true });
  const highlights = highlightLines((Array.isArray(raw.highlights) ? raw.highlights : []).map((h) => plain(h)))
    .map((h) => clamp(h, LIMITS.highlight))
    .filter(Boolean)
    .slice(0, LIMITS.highlights);
  const giftLine = cleanGiftLine(raw.giftLine ?? raw.giftNote);
  // The full description from the parts; an older-style answer (one "description") still works.
  const description =
    design || comfort
      ? composeDescription({ design, comfort, closing, highlights })
      : clamp(plain(raw.description, { lines: true }).split('\n\n').slice(0, 3).join('\n\n'), LIMITS.description, { sentence: true });
  if (!title && !shortDescription && !description) throw new HttpError(502, 'The AI’s answer was empty. Please try again.', {}, { code: 'ai_bad_reply' });
  const seen = new Set<string>();
  const colors = (Array.isArray(raw.colors) ? raw.colors : [])
    .map(color)
    .filter((c): c is { name: string; hex: string } => Boolean(c) && !seen.has(c!.name.toLowerCase()) && Boolean(seen.add(c!.name.toLowerCase())))
    .slice(0, LIMITS.colors);
  const w = typeof raw.weave === 'string' ? raw.weave.trim().toLowerCase() : '';
  const weave = (w && weaves.find((x) => x.toLowerCase() === w)) || null;
  return { title, shortDescription, description, design, comfort, closing, highlights, giftLine, colors, weave, motif: clamp(plain(raw.motif), LIMITS.motif) };
}

// ── the request ─────────────────────────────────────────────────────────────

export interface Hints {
  category?: string;
  material?: string;
  threadCount?: number;
  weave?: string;
  colors?: string[];
  /** The product's own sizes and what is in each set, as the editor has them (facts). */
  sizes?: string[];
}

/** The owner's hints, allow-listed and cut to size (anything else is dropped). */
export function cleanHints(v: unknown): Hints {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const catalog = getSettings('catalog');
  const out: Hints = {};
  const cat = typeof o.category === 'string' ? catalog.categories.find((c) => c.id === o.category) : undefined;
  if (cat) out.category = cat.label;
  const material = clamp(plain(o.material), 120);
  if (material) out.material = material;
  const tc = Number(o.threadCount);
  if (Number.isInteger(tc) && tc > 0 && tc <= 3000) out.threadCount = tc;
  const weave = typeof o.weave === 'string' ? catalog.weaves.find((w) => w === o.weave) : undefined;
  if (weave) out.weave = weave;
  const colors = (Array.isArray(o.colors) ? o.colors : []).map((c) => clamp(plain(c), 40)).filter(Boolean).slice(0, 12);
  if (colors.length) out.colors = colors;
  const sizes = (Array.isArray(o.sizes) ? o.sizes : []).map((c) => clamp(plain(c), 200)).filter(Boolean).slice(0, 8);
  if (sizes.length) out.sizes = sizes;
  return out;
}

/**
 * The rules every writer gets, with the shop's default instructions (src/lib/aiPrompt.ts): the
 * owner's own instructions first, then the fixed honesty rules. The copy is there to help a shopper
 * choose and buy, and it must be true: nothing that can't be seen or that the owner did not write down.
 */
export const SYSTEM = writingSystem(DEFAULT_AI_PROMPT);

/** The request text: the owner's facts, the gift line asked for, then the answer format (always last). */
export function userText(hints: Hints, weaves: string[], prompt: AiPromptSettings = DEFAULT_AI_PROMPT, gift: string = giftPromptText(null)): string {
  return writingUser(hints as Record<string, unknown>, weaves, prompt, gift);
}

export type ImageSource = { kind: 'upload' | 'stored'; mime: string; bytes: Buffer } | { kind: 'url'; url: string };

/** The photo: a data URL (PNG, JPEG or WebP), a stored product photo (/api/images/<name>), or an https address. */
export function resolveImage(body: Record<string, unknown>): ImageSource {
  if (body.image !== undefined) {
    const { mime, bytes } = parseImageDataUrl(body.image, IMAGE_MAX_BYTES);
    return { kind: 'upload', mime, bytes };
  }
  if (typeof body.imageId === 'string') {
    const name = body.imageId.replace(/^\/api\/images\//, '');
    if (!IMAGE_NAME.test(name)) throw new HttpError(400, 'Choose one of the product’s photos.');
    const img = readImage(name);
    if (!img) throw new HttpError(404, 'That photo is no longer stored. Upload it again.');
    return { kind: 'stored', mime: img.mime, bytes: img.bytes };
  }
  if (typeof body.imageUrl === 'string' && body.imageUrl.length <= 2000) {
    let u: URL | null = null;
    try {
      u = new URL(body.imageUrl);
    } catch {
      u = null;
    }
    if (u && u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443')) return { kind: 'url', url: u.href };
  }
  throw new HttpError(400, 'Choose a photo first (PNG, JPEG or WebP).');
}

/** The chosen writer's key. */
const writerKey = (ai: AiSettings) => (ai.provider === 'gemini' ? ai.geminiApiKey : ai.provider === 'deepseek' ? ai.deepseekApiKey : ai.anthropicApiKey);
/** The model "Write from photo" uses: Claude's, or the Gemini / DeepSeek one chosen after Test. */
const writerModel = (ai: AiSettings): string => (ai.provider === 'gemini' ? ai.geminiModel : ai.provider === 'deepseek' ? ai.deepseekModel : ai.model);
/** DeepSeek's text-only models (deepseek-v4-pro) can't do "Write from photo". */
export const textOnlyMessage = (model: string) => `${model} can't read photos: choose deepseek-flash in Settings → AI writing.`;

/** Settings → AI writing, or a readable reason why "Write from photo" can't run yet. */
function readySettings(): AiSettings {
  const ai = getSettings('ai');
  if (!writerKey(ai)) throw new HttpError(409, 'Add your AI key in Settings → AI writing, then switch it on.', {}, { code: 'ai_off' });
  if (!ai.enabled) throw new HttpError(409, 'AI writing is switched off. Switch it on in Settings → AI writing.', {}, { code: 'ai_off' });
  if (ai.provider === 'gemini' && !GEMINI_MODEL_ID.test(ai.geminiModel)) throw new HttpError(409, 'Choose a Gemini writing model: press Test in Settings → AI writing, pick one and save.', {}, { code: 'ai_off' });
  if (ai.provider === 'deepseek' && !DEEPSEEK_MODEL_ID.test(ai.deepseekModel)) throw new HttpError(409, 'Choose a DeepSeek model: press Test in Settings → AI writing, pick one and save.', {}, { code: 'ai_off' });
  if (ai.provider === 'deepseek' && !deepseekReadsPhotos(ai.deepseekModel)) throw new HttpError(409, textOnlyMessage(ai.deepseekModel), {}, { code: 'ai_text_only' });
  return ai;
}

/** For the editor's button: ready, or why not (no key, switched off, no model chosen yet, or a DeepSeek model that can't read photos). */
export function aiStatus(): { ready: boolean; reason: 'no_key' | 'off' | 'no_model' | 'text_only' | null; provider: AiProvider; model: string } {
  const ai = getSettings('ai');
  const noModel = (ai.provider === 'gemini' && !GEMINI_MODEL_ID.test(ai.geminiModel)) || (ai.provider === 'deepseek' && !DEEPSEEK_MODEL_ID.test(ai.deepseekModel));
  const reason = !writerKey(ai) ? 'no_key' : !ai.enabled ? 'off' : noModel ? 'no_model' : ai.provider === 'deepseek' && !deepseekReadsPhotos(ai.deepseekModel) ? 'text_only' : null;
  return { ready: !reason, reason, provider: ai.provider, model: writerModel(ai) };
}

const BODY_FIELDS = new Set(['image', 'imageId', 'imageUrl', 'hints', 'giftFor', 'prompt']);

type StoredPhoto = { kind: 'upload' | 'stored'; mime: string; bytes: Buffer };
/** The writer's text, and whether it stopped for length (so a broken answer says "cut short"). */
interface Answer {
  text: string;
  cutShort: boolean;
}

/** The photo and the request text to the chosen writer; its answer's text (each writer's refusals and errors made readable). */
async function ask(ai: AiSettings, image: ImageSource, user: string, system: string): Promise<Answer> {
  if (ai.provider === 'gemini' && image.kind !== 'url') return askGemini(ai, image, user, system);
  if (ai.provider === 'deepseek' && image.kind !== 'url') return askDeepSeek(ai, image, user, system);
  const source = image.kind === 'url' ? { type: 'url', url: image.url } : { type: 'base64', media_type: image.mime, data: image.bytes.toString('base64') };
  const { text, stopReason } = await callAnthropic(ai.anthropicApiKey, ai.model, {
    max_tokens: MAX_TOKENS,
    // Short copy: little thinking needed (and every thinking token counts against max_tokens).
    output_config: { effort: 'low' },
    system,
    messages: [{ role: 'user', content: [{ type: 'image', source }, { type: 'text', text: user }] }],
  });
  return { text, cutShort: stopReason === 'max_tokens' };
}

/**
 * Gemini: the same rules (system instruction), the photo as inlineData, JSON asked for with
 * responseMimeType.
 */
async function askGemini(ai: AiSettings, image: StoredPhoto, user: string, system: string): Promise<Answer> {
  const data = await generateContent(
    ai.geminiApiKey,
    ai.geminiModel,
    {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ inlineData: { mimeType: image.mime, data: image.bytes.toString('base64') } }, { text: user }] }],
      // Room for the JSON (about 600 tokens) and the model's own thinking.
      generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 8192 },
    },
    { timeoutMs: TIMEOUT_MS, maxBytes: 256 * 1024 }
  );
  const { parts, finishReason, blocked } = answerOf(data);
  if (blocked || /SAFETY|PROHIBITED|BLOCKLIST|SPII|RECITATION/.test(finishReason)) {
    logEvent('warn', 'gemini_refused', { blocked, finishReason });
    throw new HttpError(502, 'The AI would not describe this photo. Try another photo, or write the text yourself.', {}, { code: 'ai_refused' });
  }
  return { text: textOf(parts), cutShort: finishReason === 'MAX_TOKENS' };
}

/**
 * DeepSeek (OpenAI-style chat completions): the same rules as the system message, the photo as an
 * image_url data URL, JSON asked for with response_format, thinking off (a short JSON task: faster
 * and cheaper).
 */
async function askDeepSeek(ai: AiSettings, image: StoredPhoto, user: string, system: string): Promise<Answer> {
  const data = await deepseekCall(ai.deepseekApiKey, {
    method: 'POST',
    path: '/chat/completions',
    body: JSON.stringify({
      model: ai.deepseekModel,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.bytes.toString('base64')}` } }, { type: 'text', text: user }] },
      ],
      response_format: { type: 'json_object' },
      thinking: { type: 'disabled' },
      max_tokens: 2048,
      stream: false,
    }),
    timeoutMs: TIMEOUT_MS,
    maxBytes: 256 * 1024,
  });
  const { text, finishReason } = chatAnswer(data);
  if (finishReason === 'content_filter') {
    logEvent('warn', 'deepseek_refused', { finishReason });
    throw new HttpError(502, 'The AI would not describe this photo. Try another photo, or write the text yourself.', {}, { code: 'ai_refused' });
  }
  // DeepSeek's JSON mode can now and then send an empty answer: worth another try.
  if (!text.trim()) {
    logEvent('warn', 'deepseek_empty_reply', { finishReason });
    throw new HttpError(502, finishReason === 'length' ? 'The AI’s answer was cut short. Please try again.' : 'DeepSeek sent back an empty answer. Please try again.', {}, { code: 'ai_bad_reply' });
  }
  return { text, cutShort: finishReason === 'length' };
}

/** Parsed, or a readable reason: "cut short" when the writer stopped for length. */
function parsed<T>(answer: Answer, ai: AiSettings, parse: (text: string) => T): T {
  try {
    return parse(answer.text);
  } catch (err) {
    logEvent('warn', `${ai.provider}_bad_reply`, { cutShort: answer.cutShort, length: answer.text.length });
    if (answer.cutShort) throw new HttpError(502, 'The AI’s answer was cut short. Please try again.', {}, { code: 'ai_bad_reply' });
    throw err;
  }
}

/** The festival a gift line is written for: the one asked for (it must be one the calendar offers now), else the themed or next one, else everyday. */
function giftTarget(v: unknown, now: Date): GiftFestival | null {
  if (v === undefined || v === null || v === '') return defaultGiftTarget(now);
  if (v === EVERYDAY) return null;
  const f = typeof v === 'string' ? giftFestivals(now, 8).find((x) => x.id === v) : undefined;
  if (!f) throw new HttpError(400, 'Choose one of the festivals offered for the gift line.');
  return f;
}

/** The gift-line facts for the prompt: the festival's name, dates and the shop's own mood for it. */
export function giftPrompt(f: GiftFestival | null): string {
  return giftPromptText(f);
}

/**
 * The prompt to use: the saved one (Settings → AI writing → Prompt), or, for "Try on a photo", the
 * owner's unsaved one, checked exactly as a save would check it (and never saved here).
 */
function promptFor(body: Record<string, unknown>): { prompt: AiPromptSettings; tried: boolean } {
  if (body.prompt === undefined) return { prompt: getSettings('aiPrompt'), tried: false };
  return { prompt: validateAiPrompt(body.prompt, DEFAULT_AI_PROMPT), tried: true };
}

/** POST /api/admin/products/describe, after the admin check and the size-capped read. */
export async function describeProduct(body: Record<string, unknown>, actor: string, now: Date = new Date()): Promise<Suggestion & { model: string; provider: AiProvider; giftFor: string }> {
  for (const k of Object.keys(body)) if (!BODY_FIELDS.has(k)) throw new HttpError(400, `Unexpected field: ${k.slice(0, 30)}.`);
  const ai = readySettings();
  const image = resolveImage(body);
  if (ai.provider === 'gemini' && image.kind === 'url') throw new HttpError(400, 'With Gemini, use a photo uploaded to the shop (add it again from the gallery).');
  if (ai.provider === 'deepseek' && image.kind === 'url') throw new HttpError(400, 'With DeepSeek, use a photo uploaded to the shop (add it again from the gallery).');
  const hints = cleanHints(body.hints);
  const gift = giftTarget(body.giftFor, now);
  const { prompt, tried } = promptFor(body);
  enforceLimit(`ai-describe:${actor}`, DESCRIBE_LIMIT.max, DESCRIBE_LIMIT.windowMs, 'That is 20 descriptions this hour. Please wait a while before the next one.');
  const weaves = getSettings('catalog').weaves;
  const answer = await ask(ai, image, userText(hints, weaves, prompt, giftPrompt(gift)), writingSystem(prompt));
  const suggestion = parsed(answer, ai, (t) => parseSuggestion(t, weaves));
  const model = writerModel(ai);
  const giftFor = gift?.id ?? EVERYDAY;
  audit('product.ai_described', { by: actor, provider: ai.provider, model, photo: image.kind, ...(image.kind === 'url' ? {} : { photoBytes: image.bytes.length }), hints: Object.keys(hints), giftFor, ...(tried ? { promptTried: true } : {}), suggested: { titleLength: suggestion.title.length, descriptionLength: suggestion.description.length, highlights: suggestion.highlights.length, colors: suggestion.colors.length, weave: suggestion.weave } });
  return { ...suggestion, model, provider: ai.provider, giftFor };
}

/** The gift lines in an answer: { giftLines: { id: line } }, festivals asked for only, each line cleaned. */
export function parseGiftLines(text: string, ids: string[]): Record<string, string> {
  const body = text.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '');
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  let raw: unknown = null;
  try {
    raw = start >= 0 && end > start ? JSON.parse(body.slice(start, end + 1)) : null;
  } catch {
    raw = null;
  }
  const map = raw && typeof raw === 'object' ? ((raw as { giftLines?: unknown }).giftLines ?? raw) : null;
  if (!map || typeof map !== 'object' || Array.isArray(map)) throw new HttpError(502, 'The AI’s answer could not be read. Please try again.', {}, { code: 'ai_bad_reply' });
  const out: Record<string, string> = {};
  for (const id of ids) {
    const line = cleanGiftLine((map as Record<string, unknown>)[id]);
    if (line) out[id] = line;
  }
  if (!Object.keys(out).length) throw new HttpError(502, 'The AI’s answer was empty. Please try again.', {}, { code: 'ai_bad_reply' });
  return out;
}

const GIFT_FIELDS = new Set(['image', 'imageId', 'imageUrl', 'hints', 'title']);

/**
 * "Write gift lines for the next festivals": one call (counted as one description) for the next
 * festivals in the calendar (up to 3, switched-off ones left out) and an everyday line, as a JSON
 * map. Nothing is saved: the editor shows them for the owner to edit.
 */
export async function writeGiftLines(body: Record<string, unknown>, actor: string, now: Date = new Date()): Promise<{ giftLines: Record<string, string>; festivals: GiftFestival[]; model: string; provider: AiProvider }> {
  for (const k of Object.keys(body)) if (!GIFT_FIELDS.has(k)) throw new HttpError(400, `Unexpected field: ${k.slice(0, 30)}.`);
  const ai = readySettings();
  const image = resolveImage(body);
  if (ai.provider !== 'anthropic' && image.kind === 'url') throw new HttpError(400, 'Use a photo uploaded to the shop (add it again from the gallery).');
  const hints = cleanHints(body.hints);
  const title = clamp(plain(body.title), LIMITS.title);
  const festivals = giftFestivals(now, 3);
  enforceLimit(`ai-describe:${actor}`, DESCRIBE_LIMIT.max, DESCRIBE_LIMIT.windowMs, 'That is 20 descriptions this hour. Please wait a while before the next one.');
  const ids = [...festivals.map((f) => f.id), EVERYDAY];
  const list = festivals.map((f) => `- "${f.id}": ${f.name} (${f.start === f.end ? f.start : `${f.start} to ${f.end}`}; the shop's mood for it: "${f.mood}")`).join('\n');
  const user = `The owner's notes about this product (facts you may use as given): ${Object.keys(hints).length ? JSON.stringify(hints) : 'none'}
${title ? `Its name in the shop: ${JSON.stringify(title)}\n` : ''}Write one short gift line (at most 140 characters) for each festival below, on giving this product or having it at home for that festival, from what the photo shows. No discounts, no urgency, no invented facts.
${list || '(no festival in the next weeks)'}
- "${EVERYDAY}": an everyday gift idea (a housewarming, a wedding, a new home).

Return exactly this JSON:
{"giftLines": {${ids.map((id) => `"${id}": "the line"`).join(', ')}}}`;
  const answer = await ask(ai, image, user, writingSystem(getSettings('aiPrompt')));
  const giftLines = parsed(answer, ai, (t) => parseGiftLines(t, ids));
  const model = writerModel(ai);
  audit('product.ai_gift_lines', { by: actor, provider: ai.provider, model, photo: image.kind, festivals: ids, written: Object.keys(giftLines) });
  return { giftLines, festivals, model, provider: ai.provider };
}

/**
 * Settings → AI writing → Test: a tiny text call with the key typed (or the saved one) and the
 * model chosen. Ok, or Anthropic's reason (without the key).
 */
export async function testAiSettings(input: unknown, actor: string): Promise<{ ok: true; model: AiModel }> {
  const typed = withStoredSecrets('ai', input) as Partial<AiSettings>;
  const key = typeof typed.anthropicApiKey === 'string' ? typed.anthropicApiKey.trim() : '';
  const model = (AI_MODELS as readonly string[]).includes(String(typed.model)) ? (typed.model as AiModel) : getSettings('ai').model;
  if (!key) throw new HttpError(400, 'Type your Anthropic API key first (console.anthropic.com → API keys).', {}, { code: 'ai_off' });
  if (!/^sk-ant-[A-Za-z0-9_-]{20,300}$/.test(key)) throw new HttpError(400, 'An Anthropic API key starts with sk-ant- (console.anthropic.com → API keys).');
  enforceLimit(`ai-test:${actor}`, TEST_LIMIT.max, TEST_LIMIT.windowMs, 'Too many tests. Please wait a few minutes.');
  await callAnthropic(key, model, { max_tokens: 64, output_config: { effort: 'low' }, messages: [{ role: 'user', content: 'Reply with the word OK.' }] });
  audit('settings.ai_tested', { by: actor, model, ok: true });
  return { ok: true, model };
}

/**
 * Settings → AI writing → Test for Gemini: Google's list of the models the key (typed, or the
 * saved one) can use, for the two lists (writing, images). A refused key says so (without the key).
 */
export async function testGeminiSettings(input: unknown, actor: string): Promise<{ ok: true; models: ModelLists }> {
  const typed = withStoredSecrets('ai', input) as Partial<AiSettings>;
  const key = typeof typed.geminiApiKey === 'string' ? typed.geminiApiKey.trim() : '';
  if (!key) throw new HttpError(400, 'Type your Gemini API key first (aistudio.google.com → Get API key).', {}, { code: 'ai_off' });
  if (!GEMINI_KEY.test(key)) throw new HttpError(400, GEMINI_KEY_HINT);
  enforceLimit(`ai-test:${actor}`, TEST_LIMIT.max, TEST_LIMIT.windowMs, 'Too many tests. Please wait a few minutes.');
  const models = await listGeminiModels(key);
  audit('settings.ai_tested', { by: actor, provider: 'gemini', ok: true, writingModels: models.writing.length, imageModels: models.image.length });
  return { ok: true, models };
}

/**
 * Settings → AI writing → Test for DeepSeek: DeepSeek's list of the models the key (typed, or the
 * saved one) can use, photo readers first. A refused key or an empty balance says so (without the key).
 */
export async function testDeepSeekSettings(input: unknown, actor: string): Promise<{ ok: true; models: DeepSeekModels }> {
  const typed = withStoredSecrets('ai', input) as Partial<AiSettings>;
  const key = typeof typed.deepseekApiKey === 'string' ? typed.deepseekApiKey.trim() : '';
  if (!key) throw new HttpError(400, 'Type your DeepSeek API key first (platform.deepseek.com → API keys).', {}, { code: 'ai_off' });
  if (!DEEPSEEK_KEY.test(key)) throw new HttpError(400, DEEPSEEK_KEY_HINT);
  enforceLimit(`ai-test:${actor}`, TEST_LIMIT.max, TEST_LIMIT.windowMs, 'Too many tests. Please wait a few minutes.');
  const models = await listDeepSeekModels(key);
  audit('settings.ai_tested', { by: actor, provider: 'deepseek', ok: true, models: models.all.length, photoModels: models.vision.length });
  return { ok: true, models };
}
