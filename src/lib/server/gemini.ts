import http from 'node:http';
import { GEMINI_MODEL_ID } from '@/types';
import { HttpError } from './http';
import { logEvent } from './log';
import { safeFetch } from './outbound';

/**
 * Google Gemini (Settings → AI writing), from the server only, with the owner's own key:
 * - "Write from photo" when Gemini is the chosen writer (src/lib/server/aiWriting.ts);
 * - "Style in a bedroom" (src/lib/server/stagePhoto.ts);
 * - Test, which reads the models the key can use (Google's live list).
 *
 * One fixed host (generativelanguage.googleapis.com), through safeFetch: https only, no redirects,
 * public addresses only, a deadline and a cap on the reply's size. The key goes in the
 * x-goog-api-key header, never in the address (addresses end up in logs). Model ids are checked
 * against a strict pattern before they are put in the path.
 */

export const GEMINI_HOST = 'generativelanguage.googleapis.com';
export const GEMINI_BASE = `https://${GEMINI_HOST}/v1beta`;

export type GeminiReply = { status: number; ok: boolean; data: unknown };
export interface GeminiRequest {
  method: 'GET' | 'POST';
  /** Path after /v1beta, e.g. /models or /models/<id>:generateContent. */
  path: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxBytes: number;
}
type Transport = (req: GeminiRequest) => Promise<GeminiReply>;

let override: Transport | null = null;

/** Tests: answer instead of Google (null puts the real one back). */
export function _setGeminiTransport(fn: Transport | null) {
  override = fn;
}

/**
 * Tests only: BUH_TEST_GEMINI_API=http://127.0.0.1:<port>/ sends the calls to a stand-in on the same
 * machine (as BUH_TEST_ANTHROPIC_API does). Anything but a plain-http loopback address is ignored.
 */
function testApi(): URL | null {
  const v = process.env.BUH_TEST_GEMINI_API;
  if (!v) return null;
  try {
    const u = new URL(v);
    if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && u.port && u.pathname === '/' && !u.search) return u;
  } catch {
    // ignored below
  }
  logEvent('warn', 'gemini_test_api_ignored', {});
  return null;
}

function loopback(base: URL, req: GeminiRequest): Promise<GeminiReply> {
  return new Promise((resolve, reject) => {
    const headers = { ...req.headers, ...(req.body !== undefined ? { 'Content-Length': String(Buffer.byteLength(req.body)) } : {}) };
    const r = http.request(new URL(`/v1beta${req.path}`, base), { method: req.method, headers, timeout: req.timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size <= req.maxBytes) chunks.push(c);
      });
      res.on('end', () => {
        let data: unknown = null;
        if (size <= req.maxBytes) {
          try {
            data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            data = null;
          }
        }
        const status = res.statusCode ?? 0;
        resolve({ status, ok: status >= 200 && status < 300, data });
      });
      res.on('error', reject);
    });
    r.on('timeout', () => r.destroy(Object.assign(new Error('Request timed out.'), { code: 'ETIMEDOUT' })));
    r.on('error', reject);
    r.end(req.body);
  });
}

function send(req: GeminiRequest): Promise<GeminiReply> {
  if (override) return override(req);
  const test = testApi();
  if (test) return loopback(test, req);
  return safeFetch(`${GEMINI_BASE}${req.path}`, { method: req.method, headers: req.headers, body: req.body, timeoutMs: req.timeoutMs, maxBytes: req.maxBytes });
}

/** Google keys (and the key in hand), wherever they appear in a message from Google. */
export function scrubGemini(text: string, key: string): string {
  let out = text.replace(/AIza[A-Za-z0-9_-]{10,}/g, 'AIza[redacted]');
  if (key) out = out.split(key).join('[redacted]');
  return out.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200);
}

interface ErrorReply {
  error?: { code?: number; message?: string; status?: string; details?: Array<{ reason?: string }> };
}

/** One call to Gemini; Google's answer, or a readable reason (never the key). */
export async function geminiCall(key: string, req: Omit<GeminiRequest, 'headers'> & { headers?: Record<string, string> }, what = 'Gemini'): Promise<unknown> {
  const headers: Record<string, string> = { 'x-goog-api-key': key, ...(req.body !== undefined ? { 'content-type': 'application/json' } : {}), ...req.headers };
  let reply: GeminiReply;
  try {
    reply = await send({ ...req, headers });
  } catch (err) {
    const code = (err as { code?: string }).code;
    logEvent('warn', 'gemini_unreachable', { reason: code || 'network' });
    if (code === 'ETIMEDOUT') throw new HttpError(504, `${what} took too long to answer. Please try again.`, {}, { code: 'ai_timeout' });
    throw new HttpError(502, 'Could not reach Google Gemini. Check the shop’s internet connection and try again.', {}, { code: 'ai_unreachable' });
  }
  if (reply.ok) {
    if (!reply.data || typeof reply.data !== 'object') throw new HttpError(502, 'Gemini’s answer could not be read (it may have been too large). Please try again.', {}, { code: 'ai_bad_reply' });
    return reply.data;
  }
  const e = ((reply.data && typeof reply.data === 'object' ? reply.data : {}) as ErrorReply).error ?? {};
  const said = scrubGemini(String(e.message ?? ''), key);
  const reason = (e.details ?? []).map((d) => String(d?.reason ?? '')).join(' ');
  logEvent('warn', 'gemini_error', { status: reply.status, type: String(e.status ?? '').slice(0, 60) });
  if (reply.status === 401 || reply.status === 403 || /API_KEY_INVALID/.test(reason) || (reply.status === 400 && /api key/i.test(said))) {
    throw new HttpError(502, 'Google did not accept the Gemini API key. Check it in Settings → AI writing.', {}, { code: 'ai_key_refused', detail: said });
  }
  if (reply.status === 404) throw new HttpError(502, 'Google does not offer that Gemini model to this key. Press Test in Settings → AI writing and choose another.', {}, { code: 'ai_model_missing', detail: said });
  if (reply.status === 429) throw new HttpError(502, 'Google’s limit for your Gemini key was reached (or it needs billing switched on). Wait a minute and try again.', {}, { code: 'ai_busy', detail: said });
  if (reply.status >= 500) throw new HttpError(502, 'Gemini is busy right now. Please try again in a moment.', {}, { code: 'ai_busy', detail: said });
  throw new HttpError(502, `Gemini said: ${said || `error ${reply.status}`}`, {}, { code: 'ai_error', detail: said });
}

/** POST /models/<id>:generateContent. The model id is checked first (it goes in the path). */
export function generateContent(key: string, model: string, request: Record<string, unknown>, { timeoutMs, maxBytes, what }: { timeoutMs: number; maxBytes: number; what?: string }): Promise<unknown> {
  if (!GEMINI_MODEL_ID.test(model)) return Promise.reject(new HttpError(409, 'Choose a Gemini model first: press Test in Settings → AI writing.', {}, { code: 'ai_no_model' }));
  return geminiCall(key, { method: 'POST', path: `/models/${model}:generateContent`, body: JSON.stringify(request), timeoutMs, maxBytes }, what);
}

// ── the answer ─────────────────────────────────────────────────────────────

export interface GeminiPart {
  text?: string;
  thought?: boolean;
  inlineData?: { mimeType?: string; data?: string };
  inline_data?: { mime_type?: string; data?: string };
}
export interface GenerateReply {
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
}

/** The parts of the first answer, why it stopped, and whether Google blocked the request. */
export function answerOf(data: unknown): { parts: GeminiPart[]; finishReason: string; blocked: string } {
  const d = (data && typeof data === 'object' ? data : {}) as GenerateReply;
  const c = Array.isArray(d.candidates) ? d.candidates[0] : undefined;
  const parts = Array.isArray(c?.content?.parts) ? c!.content!.parts!.filter((p) => p && typeof p === 'object') : [];
  return { parts, finishReason: String(c?.finishReason ?? ''), blocked: String(d.promptFeedback?.blockReason ?? '') };
}

/** The answer's text (thoughts left out). */
export function textOf(parts: GeminiPart[]): string {
  return parts
    .filter((p) => !p.thought && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n');
}

// ── models ─────────────────────────────────────────────────────────────────

export const DEFAULT_IMAGE_MODEL = 'gemini-3.1-flash-image';

interface ListedModel {
  name?: string;
  baseModelId?: string;
  supportedGenerationMethods?: string[];
}

/** Not text writers: image, speech, live, embeddings, video and other special-purpose models. */
const NOT_WRITING = /image|banana|tts|audio|live|embed|veo|imagen|aqa|robotics|computer-use|learnlm|gemma|-search|deep-research/;
/** Image generators: "…-image" models (Nano Banana), plus Nano Banana names that do not say "image". */
const IMAGE = /image|nano-banana/;

/** "gemini-3.1-pro-preview" → [3, 1]; names without a version sort last. */
function version(id: string): number[] {
  const m = /^gemini-(?:[a-z-]*?)(\d+)(?:\.(\d+))?/.exec(id);
  return m ? [Number(m[1]), Number(m[2] ?? 0)] : [0, 0];
}
/** Newest first; at the same version a stable model before a preview or experiment, then the shorter name. */
function newestFirst(a: string, b: string): number {
  const [va, vb] = [version(a), version(b)];
  if (va[0] !== vb[0]) return vb[0] - va[0];
  if (va[1] !== vb[1]) return vb[1] - va[1];
  const pa = /preview|exp|latest/.test(a) ? 1 : 0;
  const pb = /preview|exp|latest/.test(b) ? 1 : 0;
  if (pa !== pb) return pa - pb;
  return a.length - b.length || a.localeCompare(b);
}

export interface ModelLists {
  writing: string[];
  image: string[];
  /** What to choose when the owner hasn't: the newest "pro" (else "flash") for writing; gemini-3.1-flash-image (else the newest image model). */
  suggested: { writing: string; image: string };
}

/** Google's list (GET /models) → the models the shop can use, each checked against the id pattern. */
export function parseModelList(data: unknown): ModelLists {
  const list = data && typeof data === 'object' && Array.isArray((data as { models?: unknown }).models) ? ((data as { models: unknown[] }).models as ListedModel[]) : [];
  const ids = new Set<string>();
  const usable: string[] = [];
  for (const m of list.slice(0, 1000)) {
    if (!m || typeof m !== 'object') continue;
    const id = String(m.name ?? '').replace(/^models\//, '');
    if (!GEMINI_MODEL_ID.test(id) || ids.has(id)) continue;
    if (!Array.isArray(m.supportedGenerationMethods) || !m.supportedGenerationMethods.includes('generateContent')) continue;
    ids.add(id);
    usable.push(id);
  }
  const writing = usable.filter((id) => !NOT_WRITING.test(id)).sort(newestFirst);
  // Nano Banana names count their own versions (2.1 came after Gemini 3.1 Flash Image): newest family first.
  const banana = (id: string) => (/nano-banana/.test(id) ? 0 : 1);
  const image = usable.filter((id) => IMAGE.test(id) && !/imagen/.test(id)).sort((a, b) => banana(a) - banana(b) || newestFirst(a, b));
  const pro = writing.find((id) => /-pro\b/.test(id));
  const flash = writing.find((id) => /-flash\b/.test(id));
  return {
    writing,
    image,
    suggested: {
      writing: pro ?? flash ?? writing[0] ?? '',
      image: image.includes(DEFAULT_IMAGE_MODEL) ? DEFAULT_IMAGE_MODEL : image[0] ?? DEFAULT_IMAGE_MODEL,
    },
  };
}

/** GET /models with the key: the models it can use (Settings → AI writing → Test). */
export async function listGeminiModels(key: string): Promise<ModelLists> {
  const data = await geminiCall(key, { method: 'GET', path: '/models?pageSize=1000', timeoutMs: 20_000, maxBytes: 2 * 1024 * 1024 });
  return parseModelList(data);
}
