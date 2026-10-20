import http from 'node:http';
import { HttpError } from '../http';
import { logEvent, maskAiKeys } from '../log';
import { safeRequest } from '../outbound';
import { testStandIn } from '../testStandIn';

/**
 * AI pictures: the one way the OpenAI and fal.ai modules reach the internet. Fixed hosts only
 * (api.openai.com; queue.fal.run, fal.run, api.fal.ai, and fal's CDN fal.media for results),
 * https only, through safeRequest (public addresses, no redirects, a deadline, a cap on the reply).
 * Google Gemini goes through src/lib/server/gemini.ts, as before.
 *
 * Tests: _setPicturesTransport answers instead; or BUH_TEST_OPENAI_API / BUH_TEST_FAL_API (loopback
 * only, test servers only, as the other stand-ins) send the calls to a stand-in on this machine.
 */

export interface PicReq {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: string | Buffer;
  timeoutMs: number;
  maxBytes: number;
}
export interface PicReply {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: Buffer;
}
type Transport = (req: PicReq) => Promise<PicReply>;

let override: Transport | null = null;

/** Tests: answer instead of OpenAI / fal (null puts the real one back). */
export function _setPicturesTransport(fn: Transport | null) {
  override = fn;
}

export const OPENAI_HOST = 'api.openai.com';
export const FAL_HOSTS = new Set(['queue.fal.run', 'fal.run', 'api.fal.ai']);

/** fal's CDN, where results are: fal.media and its subdomains (v3.fal.media, v3b.fal.media…). */
export function isFalMediaHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'fal.media' || h.endsWith('.fal.media');
}

function allowed(u: URL): 'openai' | 'fal' | null {
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return null;
  if (u.hostname === OPENAI_HOST) return 'openai';
  if (FAL_HOSTS.has(u.hostname) || isFalMediaHost(u.hostname)) return 'fal';
  return null;
}

function loopback(base: URL, path: string, req: PicReq): Promise<PicReply> {
  return new Promise((resolve, reject) => {
    const headers = { ...req.headers, ...(req.body !== undefined ? { 'Content-Length': String(Buffer.byteLength(req.body)) } : {}) };
    const r = http.request(new URL(path, base), { method: req.method, headers, timeout: req.timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size <= req.maxBytes) chunks.push(c);
      });
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        const head: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) head[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
        resolve({ status, ok: status >= 200 && status < 300, headers: head, body: Buffer.concat(chunks) });
      });
      res.on('error', reject);
    });
    r.on('timeout', () => r.destroy(Object.assign(new Error('Request timed out.'), { code: 'ETIMEDOUT' })));
    r.on('error', reject);
    r.end(req.body);
  });
}

/** One call to OpenAI or fal (any other address is refused before anything is sent). */
export async function picFetch(req: PicReq): Promise<PicReply> {
  let u: URL;
  try {
    u = new URL(req.url);
  } catch {
    throw new HttpError(502, 'A picture service sent an address the shop cannot use.', {}, { code: 'ai_bad_reply' });
  }
  const who = allowed(u);
  if (!who) {
    logEvent('warn', 'pictures_host_refused', { host: u.hostname.slice(0, 80) });
    throw new HttpError(502, 'A picture service sent an address the shop does not trust. Nothing was fetched.', {}, { code: 'ai_bad_reply' });
  }
  if (override) return override(req);
  const stand = testStandIn(who === 'openai' ? 'BUH_TEST_OPENAI_API' : 'BUH_TEST_FAL_API');
  if (stand) return loopback(stand, who === 'openai' ? `${u.pathname}${u.search}` : `/${u.hostname}${u.pathname}${u.search}`, req);
  const res = await safeRequest(u, { method: req.method, headers: req.headers, body: req.body, timeoutMs: req.timeoutMs, maxBytes: req.maxBytes });
  return { status: res.status, ok: res.ok, headers: res.headers, body: res.body };
}

export function jsonOf(body: Buffer): Record<string, unknown> | null {
  try {
    const v = JSON.parse(body.toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A provider's own words, safe to show: the key in hand and any other AI key taken out, one line, short. */
export function scrubWords(text: string, key: string): string {
  const out = key ? text.split(key).join('[redacted]') : text;
  return maskAiKeys(out).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200);
}

/** Network failures in plain words. */
export function unreachable(err: unknown, name: string): HttpError {
  const code = (err as { code?: string }).code;
  logEvent('warn', 'pictures_unreachable', { provider: name, reason: code || 'network' });
  if (code === 'ETIMEDOUT') return new HttpError(504, `${name} took too long to answer. Please try again.`, {}, { code: 'ai_timeout' });
  return new HttpError(502, `Could not reach ${name}. Check the shop’s internet connection and try again.`, {}, { code: 'ai_unreachable' });
}
