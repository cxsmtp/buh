import http from 'node:http';
import { AI_MODELS, type AiModel, type AiSettings } from '@/types';
import { stripEmoji } from '@/lib/marquee';
import { FABRIC_COLOURS as NAMED } from '@/data/fabricColours';
import { audit } from './audit';
import { HttpError } from './http';
import { parseImageDataUrl } from './imageInput';
import { IMAGE_NAME, readImage } from './images';
import { logEvent } from './log';
import { safeFetch } from './outbound';
import { rateLimit } from './rateLimit';
import { getSettings, withStoredSecrets } from './settings';

/**
 * "Write from photo" (Admin Hub → Inventory → product editor): the product's photo goes to
 * Anthropic's Messages API, from the server only, with the owner's own key (Settings → AI
 * writing), and comes back as a suggested name, short and full description, colours and weave.
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

export const LIMITS = { title: 60, shortDescription: 140, description: 900, colors: 4, motif: 80 } as const;

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
  try {
    const u = new URL(v);
    if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && u.port && u.pathname === '/' && !u.search) return u;
  } catch {
    // ignored below
  }
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
  let out = text.replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-[redacted]');
  if (key) out = out.split(key).join('[redacted]');
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
  description: string;
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
  const description = clamp(plain(raw.description, { lines: true }).split('\n\n').slice(0, 3).join('\n\n'), LIMITS.description, { sentence: true });
  if (!title && !shortDescription && !description) throw new HttpError(502, 'The AI’s answer was empty. Please try again.', {}, { code: 'ai_bad_reply' });
  const seen = new Set<string>();
  const colors = (Array.isArray(raw.colors) ? raw.colors : [])
    .map(color)
    .filter((c): c is { name: string; hex: string } => Boolean(c) && !seen.has(c!.name.toLowerCase()) && Boolean(seen.add(c!.name.toLowerCase())))
    .slice(0, LIMITS.colors);
  const w = typeof raw.weave === 'string' ? raw.weave.trim().toLowerCase() : '';
  const weave = (w && weaves.find((x) => x.toLowerCase() === w)) || null;
  return { title, shortDescription, description, colors, weave, motif: clamp(plain(raw.motif), LIMITS.motif) };
}

// ── the request ─────────────────────────────────────────────────────────────

export interface Hints {
  category?: string;
  material?: string;
  threadCount?: number;
  weave?: string;
  colors?: string[];
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
  return out;
}

const SYSTEM = `You write product copy for Beautiful UAE Home, a small luxury home-linen boutique in the United Arab Emirates (bed sheets, duvet covers, hand block prints).
Look closely at the photo: the pattern and motif, the colours, the texture and any sheen, and the style (for example hand block print, Mughal, floral, geometric, minimal hotel white).
Write elegant, warm, unhurried copy in British English (colour, centre), for customers in the UAE.
Rules:
- Describe only what is visible in the photo.
- Never state a thread count, material, fibre, certification, country of origin, or washing or care instructions unless the owner's notes give them; then use them exactly as given.
- No brand names, no awards, no superlatives you can't see (no "best", "finest in the world").
- No emoji, no prices, no discounts, no hashtags, no markdown.
Answer with one JSON object only, with no text before or after it.`;

function userText(hints: Hints, weaves: string[]): string {
  const notes = Object.keys(hints).length ? JSON.stringify(hints) : 'none';
  return `The owner's notes about this product (facts you may use as given): ${notes}
The shop's weaves: ${JSON.stringify(weaves)}

Return exactly this JSON:
{"title": "an elegant product name, at most 60 characters",
 "shortDescription": "one line for the product card, at most 140 characters",
 "description": "2 or 3 short paragraphs separated by a blank line, at most 900 characters in all",
 "colors": [{"name": "a plain colour name you can see, e.g. Indigo", "hex": "#rrggbb"}],
 "weave": "one of the shop's weaves if the photo clearly shows it, otherwise null",
 "motif": "the main motif in a few words"}
Give at most 4 colours, the main ones first.`;
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

/** Settings → AI writing, or a readable reason why "Write from photo" can't run yet. */
function readySettings(): AiSettings {
  const ai = getSettings('ai');
  if (!ai.anthropicApiKey) throw new HttpError(409, 'Add your AI key in Settings → AI writing, then switch it on.', {}, { code: 'ai_off' });
  if (!ai.enabled) throw new HttpError(409, 'AI writing is switched off. Switch it on in Settings → AI writing.', {}, { code: 'ai_off' });
  return ai;
}

/** For the editor's button: ready, or why not (no key, or switched off). */
export function aiStatus(): { ready: boolean; reason: 'no_key' | 'off' | null; model: AiModel } {
  const ai = getSettings('ai');
  const reason = !ai.anthropicApiKey ? 'no_key' : !ai.enabled ? 'off' : null;
  return { ready: !reason, reason, model: ai.model };
}

const BODY_FIELDS = new Set(['image', 'imageId', 'imageUrl', 'hints']);

/** POST /api/admin/products/describe, after the admin check and the size-capped read. */
export async function describeProduct(body: Record<string, unknown>, actor: string): Promise<Suggestion & { model: AiModel }> {
  for (const k of Object.keys(body)) if (!BODY_FIELDS.has(k)) throw new HttpError(400, `Unexpected field: ${k.slice(0, 30)}.`);
  const ai = readySettings();
  const image = resolveImage(body);
  const hints = cleanHints(body.hints);
  enforceLimit(`ai-describe:${actor}`, DESCRIBE_LIMIT.max, DESCRIBE_LIMIT.windowMs, 'That is 20 descriptions this hour. Please wait a while before the next one.');
  const weaves = getSettings('catalog').weaves;
  const source = image.kind === 'url' ? { type: 'url', url: image.url } : { type: 'base64', media_type: image.mime, data: image.bytes.toString('base64') };
  const { text, stopReason } = await callAnthropic(ai.anthropicApiKey, ai.model, {
    max_tokens: MAX_TOKENS,
    // Short copy: little thinking needed (and every thinking token counts against max_tokens).
    output_config: { effort: 'low' },
    system: SYSTEM,
    messages: [{ role: 'user', content: [{ type: 'image', source }, { type: 'text', text: userText(hints, weaves) }] }],
  });
  let suggestion: Suggestion;
  try {
    suggestion = parseSuggestion(text, weaves);
  } catch (err) {
    logEvent('warn', 'anthropic_bad_reply', { stopReason, length: text.length });
    if (stopReason === 'max_tokens') throw new HttpError(502, 'The AI’s answer was cut short. Please try again.', {}, { code: 'ai_bad_reply' });
    throw err;
  }
  audit('product.ai_described', { by: actor, model: ai.model, photo: image.kind, ...(image.kind === 'url' ? {} : { photoBytes: image.bytes.length }), hints: Object.keys(hints), suggested: { titleLength: suggestion.title.length, colors: suggestion.colors.length, weave: suggestion.weave } });
  return { ...suggestion, model: ai.model };
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
