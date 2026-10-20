import crypto from 'node:crypto';
import { audit } from './audit';
import { kvGet, kvSet } from './kv';
import { logEvent } from './log';
import { safeFetch } from './outbound';
import { rateLimit } from './rateLimit';
import { shopUrl } from './runtimeConfig';
import { getSettings } from './settings';

/**
 * IndexNow (Settings → Search (SEO), off by default): tells Bing, Yandex, Seznam and Naver about
 * new and changed pages at once, instead of waiting for their next crawl. (Google does not take
 * IndexNow, and its sitemap "ping" was retired: Google reads the sitemap submitted once in Search
 * Console.)
 *
 * - The key is made once (32 random hex characters, kv `seo:indexnow-key`) and served at
 *   /indexnow-key.txt only while IndexNow is on; each ping names that file (keyLocation). The key is
 *   public by design (it only proves the pings come from this site); it is not a secret.
 * - Pings go to one fixed address (api.indexnow.org) through safeFetch (https only, no redirects,
 *   public addresses only, timeouts), only for this shop's own address (NEXT_PUBLIC_APP_URL; never
 *   the Host a visitor sent), gathered for 10 seconds into one ping, at most 20 pings an hour.
 * - Every ping is in the audit log, and the last 10 are shown in the hub.
 */

export const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';
export const KEY_PATH = '/indexnow-key.txt';
const KEY_KV = 'seo:indexnow-key';
const LOG_KV = 'seo:indexnow-log';
const MAX_PER_HOUR = 20;
const MAX_URLS = 100;
const GATHER_MS = 10_000;

export type IndexNowSender = (url: string, body: string) => Promise<{ status: number; ok: boolean }>;

const defaultSender: IndexNowSender = async (url, body) => {
  const res = await safeFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body, timeoutMs: 10_000, maxBytes: 16 * 1024 });
  return { status: res.status, ok: res.ok };
};

let sender: IndexNowSender = defaultSender;
/** Tests: a stand-in for the network. */
export function _setIndexNowSender(s: IndexNowSender | null) {
  sender = s ?? defaultSender;
}

/** The site's IndexNow key (made the first time it is needed). */
export function indexNowKey(): string {
  const saved = kvGet<string>(KEY_KV)?.data;
  if (typeof saved === 'string' && /^[a-f0-9]{32}$/.test(saved)) return saved;
  const key = crypto.randomBytes(16).toString('hex');
  kvSet(KEY_KV, key);
  return key;
}

export const indexNowOn = () => getSettings('seo').indexNow === true;

export interface PingRecord {
  at: string;
  urls: number;
  ok: boolean;
  status: number | string;
}

export function lastPings(): PingRecord[] {
  const v = kvGet<PingRecord[]>(LOG_KV)?.data;
  return Array.isArray(v) ? v.slice(0, 10) : [];
}

function remember(r: PingRecord) {
  kvSet(LOG_KV, [r, ...lastPings()].slice(0, 10));
}

/**
 * Tell IndexNow about these pages (paths like /p/abc or full URLs on this shop). Never throws.
 * Returns what happened, for tests and the hub.
 */
export async function pingIndexNow(paths: string[], now: Date = new Date()): Promise<{ sent: boolean; reason?: string; status?: number | string; urls?: string[] }> {
  if (!indexNowOn()) return { sent: false, reason: 'off' };
  const base = shopUrl();
  if (!base || !base.startsWith('https://')) return { sent: false, reason: 'The shop’s https address (NEXT_PUBLIC_APP_URL) is not set.' };
  const host = new URL(base).host;
  const urls = [...new Set(paths.map((p) => (p.startsWith('http') ? p : `${base}${p.startsWith('/') ? p : `/${p}`}`)))].filter((u) => {
    try {
      return new URL(u).host === host;
    } catch {
      return false;
    }
  }).slice(0, MAX_URLS);
  if (!urls.length) return { sent: false, reason: 'nothing to send' };
  if (!rateLimit('seo:indexnow', MAX_PER_HOUR, 3600_000, now.getTime()).ok) {
    logEvent('warn', 'indexnow_rate_limited', { urls: urls.length });
    return { sent: false, reason: 'rate limited' };
  }
  const key = indexNowKey();
  const body = JSON.stringify({ host, key, keyLocation: `${base}${KEY_PATH}`, urlList: urls });
  let status: number | string = 0;
  let ok = false;
  try {
    const res = await sender(INDEXNOW_ENDPOINT, body);
    status = res.status;
    ok = res.ok;
  } catch (err) {
    status = (err as { code?: string })?.code || 'error';
  }
  remember({ at: now.toISOString(), urls: urls.length, ok, status });
  audit('seo.indexnow_ping', { urls: urls.length, paths: urls.slice(0, 20).map((u) => new URL(u).pathname), ok, status });
  logEvent(ok ? 'info' : 'warn', 'indexnow_ping', { urls: urls.length, status });
  return { sent: true, status, urls };
}

let queued = new Set<string>();
let timer: NodeJS.Timeout | null = null;

/** Gather changed pages for 10 seconds, then one ping (does nothing while IndexNow is off). */
export function queueIndexNow(paths: string[]): void {
  try {
    if (!indexNowOn()) return;
  } catch {
    return;
  }
  for (const p of paths) queued.add(p);
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const batch = [...queued];
    queued = new Set();
    void pingIndexNow(batch).catch(() => {});
  }, GATHER_MS);
  timer.unref?.();
}
