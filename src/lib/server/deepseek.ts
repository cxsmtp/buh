import http from 'node:http';
import { DEEPSEEK_DEFAULT_MODEL, DEEPSEEK_MODEL_ID, deepseekReadsPhotos } from '@/types';
import { HttpError } from './http';
import { testStandIn } from './testStandIn';
import { logEvent, maskAiKeys } from './log';
import { safeFetch } from './outbound';

/**
 * DeepSeek (Settings → AI writing), from the server only, with the owner's own key:
 * - "Write from photo" when DeepSeek is the chosen writer (src/lib/server/aiWriting.ts);
 * - Test, which reads the models the key can use (DeepSeek's live list).
 * DeepSeek makes no pictures: "Style in a bedroom" stays Gemini only.
 *
 * One fixed host (api.deepseek.com), through safeFetch: https only, no redirects, public addresses
 * only, a deadline and a cap on the reply's size. The key goes in the Authorization header only.
 * Model ids are checked against a strict pattern before they are sent.
 */

export const DEEPSEEK_HOST = 'api.deepseek.com';
export const DEEPSEEK_BASE = `https://${DEEPSEEK_HOST}`;

export type DeepSeekReply = { status: number; ok: boolean; data: unknown };
export interface DeepSeekRequest {
  method: 'GET' | 'POST';
  /** /chat/completions or /models. */
  path: '/chat/completions' | '/models';
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxBytes: number;
}
type Transport = (req: DeepSeekRequest) => Promise<DeepSeekReply>;

let override: Transport | null = null;

/** Tests: answer instead of DeepSeek (null puts the real one back). */
export function _setDeepSeekTransport(fn: Transport | null) {
  override = fn;
}

/**
 * Tests only: BUH_TEST_DEEPSEEK_API=http://127.0.0.1:<port>/ sends the calls to a stand-in on the
 * same machine (as BUH_TEST_GEMINI_API does). Anything but a plain-http loopback address is ignored.
 */
function testApi(): URL | null {
  const v = process.env.BUH_TEST_DEEPSEEK_API;
  if (!v) return null;
  const u = testStandIn('BUH_TEST_DEEPSEEK_API');
  if (u) return u;
  logEvent('warn', 'deepseek_test_api_ignored', {});
  return null;
}

function loopback(base: URL, req: DeepSeekRequest): Promise<DeepSeekReply> {
  return new Promise((resolve, reject) => {
    const headers = { ...req.headers, ...(req.body !== undefined ? { 'Content-Length': String(Buffer.byteLength(req.body)) } : {}) };
    const r = http.request(new URL(req.path, base), { method: req.method, headers, timeout: req.timeoutMs }, (res) => {
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

function send(req: DeepSeekRequest): Promise<DeepSeekReply> {
  if (override) return override(req);
  const test = testApi();
  if (test) return loopback(test, req);
  return safeFetch(`${DEEPSEEK_BASE}${req.path}`, { method: req.method, headers: req.headers, body: req.body, timeoutMs: req.timeoutMs, maxBytes: req.maxBytes });
}

/** The key in hand and any other AI key, wherever they appear in a message from DeepSeek. */
export function scrubDeepSeek(text: string, key: string): string {
  const out = key ? text.split(key).join('[redacted]') : text;
  return maskAiKeys(out).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200);
}

interface ErrorReply {
  error?: { message?: string; type?: string; code?: string | number };
}

/** One call to DeepSeek; its answer, or a readable reason (never the key). */
export async function deepseekCall(key: string, req: Omit<DeepSeekRequest, 'headers'>): Promise<unknown> {
  const headers: Record<string, string> = { authorization: `Bearer ${key}`, accept: 'application/json', ...(req.body !== undefined ? { 'content-type': 'application/json' } : {}) };
  let reply: DeepSeekReply;
  try {
    reply = await send({ ...req, headers });
  } catch (err) {
    const code = (err as { code?: string }).code;
    logEvent('warn', 'deepseek_unreachable', { reason: code || 'network' });
    if (code === 'ETIMEDOUT') throw new HttpError(504, 'DeepSeek took too long to answer. Please try again.', {}, { code: 'ai_timeout' });
    throw new HttpError(502, 'Could not reach DeepSeek. Check the shop’s internet connection and try again.', {}, { code: 'ai_unreachable' });
  }
  if (reply.ok) {
    if (!reply.data || typeof reply.data !== 'object') throw new HttpError(502, 'DeepSeek’s answer could not be read. Please try again.', {}, { code: 'ai_bad_reply' });
    return reply.data;
  }
  const e = ((reply.data && typeof reply.data === 'object' ? reply.data : {}) as ErrorReply).error ?? {};
  const said = scrubDeepSeek(String(e.message ?? ''), key);
  logEvent('warn', 'deepseek_error', { status: reply.status, type: String(e.type ?? '').slice(0, 60) });
  if (reply.status === 401 || reply.status === 403) throw new HttpError(502, 'DeepSeek did not accept the API key. Check it in Settings → AI writing.', {}, { code: 'ai_key_refused', detail: said });
  if (reply.status === 402) throw new HttpError(502, 'Your DeepSeek balance is empty: top up at platform.deepseek.com.', {}, { code: 'ai_no_balance', detail: said });
  if (reply.status === 429) throw new HttpError(502, 'DeepSeek’s limit for your account was reached. Wait a minute and try again.', {}, { code: 'ai_busy', detail: said });
  if (reply.status >= 500) throw new HttpError(502, 'DeepSeek is busy right now. Please try again in a moment.', {}, { code: 'ai_busy', detail: said });
  throw new HttpError(502, `DeepSeek said: ${said || `error ${reply.status}`}`, {}, { code: 'ai_error', detail: said });
}

// ── the answer ─────────────────────────────────────────────────────────────

interface ChatReply {
  choices?: Array<{ message?: { content?: unknown; reasoning_content?: unknown }; finish_reason?: string }>;
}

/** The first choice's text (the reasoning, if any, left out) and why it stopped. */
export function chatAnswer(data: unknown): { text: string; finishReason: string } {
  const d = (data && typeof data === 'object' ? data : {}) as ChatReply;
  const c = Array.isArray(d.choices) ? d.choices[0] : undefined;
  const content = c?.message?.content;
  return { text: typeof content === 'string' ? content : '', finishReason: String(c?.finish_reason ?? '') };
}

// ── models ─────────────────────────────────────────────────────────────────

export interface DeepSeekModels {
  /** Every model the key can use (ids checked), photo readers first. */
  all: string[];
  /** The ones that read photos ("Write from photo" needs one). */
  vision: string[];
  /** What to choose when the owner hasn't: deepseek-flash, else the first photo reader. */
  suggested: string;
}

/** DeepSeek's list (GET /models, OpenAI format) → the models the shop can use, each id checked. */
export function parseDeepSeekModels(data: unknown): DeepSeekModels {
  const list = data && typeof data === 'object' && Array.isArray((data as { data?: unknown }).data) ? ((data as { data: unknown[] }).data as Array<{ id?: unknown }>) : [];
  const ids: string[] = [];
  for (const m of list.slice(0, 500)) {
    const id = m && typeof m === 'object' ? String(m.id ?? '') : '';
    if (DEEPSEEK_MODEL_ID.test(id) && !ids.includes(id)) ids.push(id);
  }
  const vision = ids.filter(deepseekReadsPhotos);
  const all = [...vision, ...ids.filter((id) => !deepseekReadsPhotos(id))];
  return { all, vision, suggested: vision.includes(DEEPSEEK_DEFAULT_MODEL) ? DEEPSEEK_DEFAULT_MODEL : vision[0] ?? DEEPSEEK_DEFAULT_MODEL };
}

/** GET /models with the key: the models it can use (Settings → AI writing → Test). */
export async function listDeepSeekModels(key: string): Promise<DeepSeekModels> {
  const data = await deepseekCall(key, { method: 'GET', path: '/models', timeoutMs: 20_000, maxBytes: 256 * 1024 });
  return parseDeepSeekModels(data);
}
