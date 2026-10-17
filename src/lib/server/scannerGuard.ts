import type http from 'node:http';
import { logEvent } from './log';
import { peekLimit, recordHit } from './rateLimit';

/**
 * Slows down, then shuts out for a while, an address that asks for many pages that
 * do not exist: the signature of a scanner looking for /wp-admin, /.env, /admin…
 *
 * - Only with TRUST_PROXY=1 (behind the shop's proxy, which sets the real address).
 *   Without it every visitor looks the same, so nothing is counted.
 * - Counted: 404 answers to pages and to the admin addresses. Not counted: the shop's
 *   own files (/_next/…, a missing photo, an icon), which an old page left open
 *   across an update can ask for by the dozen; the public APIs; a product that was
 *   taken down (/p/…, which a search engine or an old share can ask for); and a 404
 *   to a browser holding a valid door (the hub asking for an order that was deleted).
 *   A hub tab left open after the link was changed stops calling at its first unknown
 *   address (DOOR_CLOSED_EVENT in src/lib/apiClient.ts), well under the limit.
 * - 10 such 404s in a minute: every further request from that address waits 1 s.
 *   30 in a minute: 429 Too Many Requests for 10 minutes, for every address of the shop.
 *   A shopper never gets near that (a whole visit has no 404 at all).
 * - Memory stays bounded: the counts are kept by the shop's rate limiter, in a map of
 *   their own (capped at 50,000 addresses, the least recently seen dropped first), so
 *   404s can never push out the sign-in or phone counters.
 *
 * It works at the HTTP server itself (src/lib/server/frontGate.ts, installed once at start),
 * because only there is a 404 seen as a 404, for every kind of address.
 */

export const SCAN_WINDOW_MS = 60_000;
export const SLOW_AFTER = 10;
export const BLOCK_AFTER = 30;
export const BLOCK_MS = 10 * 60_000;
export const SLOW_MS = 1000;

/** Does a 404 at this path count as probing? */
export function countsAsProbe(path: string): boolean {
  if (path.startsWith('/_next/') || path.startsWith('/api/images/') || path.startsWith('/icons/') || path.startsWith('/p/')) return false;
  if (path.startsWith('/api/')) return path.startsWith('/api/admin') || path === '/api/courier/dispatch' || path === '/api/courier/test' || path === '/api/ai-transform';
  return true;
}

/** The visitor's address, as the proxy in front gives it (the same rule as clientIp in http.ts). */
export function addressOf(headers: http.IncomingHttpHeaders): string | null {
  if (process.env.TRUST_PROXY !== '1') return null;
  const real = headers['x-real-ip'];
  if (typeof real === 'string' && real.trim()) return real.trim().slice(0, 64);
  const xff = headers['x-forwarded-for'];
  const value = Array.isArray(xff) ? xff.join(',') : xff;
  if (value) {
    const hops = value.split(',').map((s) => s.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1].slice(0, 64);
  }
  return null;
}

/** What to do with a request from this address now. */
export function verdictFor(ip: string, now = Date.now()): { action: 'block'; retryAfterSec: number } | { action: 'slow' } | { action: 'pass' } {
  const blocked = peekLimit(`scan-block:${ip}`, 1, BLOCK_MS, now);
  if (!blocked.ok) return { action: 'block', retryAfterSec: blocked.retryAfterSec };
  const misses = peekLimit(`scan-404:${ip}`, SLOW_AFTER, SCAN_WINDOW_MS, now);
  return misses.ok ? { action: 'pass' } : { action: 'slow' };
}

/** Count a 404 from this address; true when that starts a block. */
export function recordMiss(ip: string, now = Date.now()): boolean {
  recordHit(`scan-404:${ip}`, now);
  if (peekLimit(`scan-404:${ip}`, BLOCK_AFTER, SCAN_WINDOW_MS, now).ok) return false;
  if (!peekLimit(`scan-block:${ip}`, 1, BLOCK_MS, now).ok) return false;
  recordHit(`scan-block:${ip}`, now);
  logEvent('warn', 'scanner_blocked', { ip, minutes: BLOCK_MS / 60_000 });
  return true;
}
