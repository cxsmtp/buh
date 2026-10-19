import http from 'node:http';
import { SESSION_COOKIE, verifySessionToken } from './adminAuth';
import {
  DOOR_TTL_MS,
  GRANT_PATTERN,
  HUB_HEADER,
  HUB_ROUTE,
  LINK_PATTERN,
  currentLink,
  doorCookie,
  doorTokenFromCookieHeader,
  hasPendingReveal,
  hubHeaderValue,
  issueDoorToken,
  matchesLink,
  resetGrantExpiry,
  setLinkNotice,
  takeReveal,
  verifyDoorToken,
} from './adminLink';
import { PAY_ROUTE, openPayOrderId } from './bankPay';
import { logEvent } from './log';
import { takeAll } from './rateLimit';
import { SLOW_MS, addressOf, countsAsProbe, recordMiss, verdictFor } from './scannerGuard';

/**
 * The shop's front gate: every request passes here first, at the HTTP server itself,
 * before Next.js sees it (installed once at start, src/instrumentation.ts).
 *
 * The Admin Hub's door (src/lib/server/adminLink.ts):
 * - The private admin link (one 32-character path) and a password-reset email's
 *   own path (43 characters, open only while that reset is): the hub page (/hub inside), with the door cookie,
 *   Referrer-Policy: no-referrer, X-Robots-Tag: noindex, nofollow and no-store.
 * - Every admin address (/api/admin/…, /api/courier/dispatch, /test, /live and /sandbox-check,
 *   /api/ai-transform) without a valid door cookie, and the hub page's own name: the
 *   request is handed on as an address that does not exist, so Next.js answers it
 *   exactly as it answers any unknown address (the same 404 page, byte for byte, with
 *   the same headers). Nothing about it differs, so nothing can be learned.
 * - The shop's front page, only for a browser with the admin session cookie, right
 *   after the update that brought private links: sent once to the new link, so an
 *   owner who is signed in sees it.
 * A bank-transfer order's private page (/pay/<token>, and its upload at /api/pay/<token>,
 * src/lib/server/bankPay.ts) is not part of the hub's door: it passes as it is, with
 * no-referrer, noindex and no-store, and page views limited per address and per order. Only a
 * token that opens no order (unknown, expired, paid, cancelled) is handed on as an unknown
 * address, so it gets the shop's ordinary 404, byte for byte.
 * Done here rather than in a Next.js proxy: a proxy's rewrite leaves its own headers
 * on the answer (so a 404 would differ from an unknown address's), and a proxy that
 * runs for every request costs the storefront.
 *
 * Then the scanner slow-down (src/lib/server/scannerGuard.ts), with TRUST_PROXY=1.
 */

const INSTALLED = Symbol.for('buh.frontGate');
/** No page is at these addresses: Next.js answers them as unknown. */
export const NOWHERE_PAGE = '/_buh/nowhere';
export const NOWHERE_API = '/api/_buh/nowhere';

const ADMIN_APIS = ['/api/courier/dispatch', '/api/courier/test', '/api/courier/live', '/api/courier/sandbox-check', '/api/ai-transform'];

export function isAdminApi(path: string): boolean {
  return path === '/api/admin' || path.startsWith('/api/admin/') || ADMIN_APIS.includes(path) || ADMIN_APIS.some((p) => path.startsWith(`${p}/`));
}

/**
 * The path as routing will see it: dot segments resolved, %-escapes decoded, repeated
 * slashes folded. So /api//admin/x, /api/%61dmin/x and /x/../api/admin/x are all
 * recognised as admin addresses.
 */
export function normalizePath(rawUrl: string | undefined): { path: string; query: string } {
  const raw = rawUrl || '/';
  const q = raw.indexOf('?');
  let path = q === -1 ? raw : raw.slice(0, q);
  const query = q === -1 ? '' : raw.slice(q);
  if (/%|\/\/|\/\.|\\/.test(path)) {
    try {
      path = new URL(path.replace(/\\/g, '/'), 'http://x').pathname;
    } catch {
      // keep it as it came
    }
    try {
      path = decodeURIComponent(path);
    } catch {
      // a malformed escape: routing will not find it either
    }
    path = path.replace(/\/{2,}/g, '/');
  }
  return { path, query };
}

export type GateDecision =
  | { kind: 'pass' }
  | { kind: 'unknown'; url: string }
  | { kind: 'hub'; url: string; cookie: string; hubHeader: string }
  | { kind: 'pay'; orderId: string; api: boolean }
  | { kind: 'renew'; cookie: string };

function serializeCookie(c: ReturnType<typeof doorCookie>): string {
  return `${c.name}=${c.value}; Path=${c.path}; Max-Age=${c.maxAge}; HttpOnly; SameSite=Strict${c.secure ? '; Secure' : ''}`;
}

/** What to do with this request's address (pure apart from reading the link record). */
export function decide(rawUrl: string | undefined, cookieHeader: string | undefined, now = Date.now()): GateDecision {
  const { path, query } = normalizePath(rawUrl);
  // With a trailing slash, Next.js only redirects to the address without it (which comes back here).
  if (path.length > 1 && path.endsWith('/')) return { kind: 'pass' };
  const unknown = (api: boolean): GateDecision => ({ kind: 'unknown', url: `${api ? NOWHERE_API : NOWHERE_PAGE}${query}` });
  if (path === HUB_ROUTE || path.startsWith(`${HUB_ROUTE}/`) || path === '/_buh' || path.startsWith('/_buh/') || path.startsWith('/api/_buh')) return unknown(path.startsWith('/api/'));
  if (path.startsWith(`${PAY_ROUTE}/`) || path.startsWith(`/api${PAY_ROUTE}/`)) {
    const api = path.startsWith('/api/');
    const orderId = openPayOrderId(path.slice(api ? `/api${PAY_ROUTE}/`.length : `${PAY_ROUTE}/`.length), now);
    return orderId ? { kind: 'pay', orderId, api } : unknown(api);
  }
  if (path.startsWith('/api/')) {
    if (!isAdminApi(path)) return { kind: 'pass' };
    const door = verifyDoorToken(doorTokenFromCookieHeader(cookieHeader), now);
    if (!door.ok) return unknown(true);
    if (!door.renew) return { kind: 'pass' };
    const token = issueDoorToken(now);
    return token ? { kind: 'renew', cookie: serializeCookie(doorCookie(token)) } : { kind: 'pass' };
  }
  const segment = path.slice(1);
  if ((LINK_PATTERN.test(segment) || GRANT_PATTERN.test(segment)) && path === `/${segment}`) {
    const rec = currentLink();
    // The link: a door for 30 days. A reset email's grant: a door only while that reset is open.
    const ttl = LINK_PATTERN.test(segment) ? (matchesLink(segment, rec) ? DOOR_TTL_MS : 0) : Math.max(0, resetGrantExpiry(segment, now) - now);
    const token = ttl > 0 ? issueDoorToken(now, rec, ttl) : null;
    if (token) return { kind: 'hub', url: `${HUB_ROUTE}${query}`, cookie: serializeCookie(doorCookie(token, ttl)), hubHeader: hubHeaderValue(rec) };
  }
  return { kind: 'pass' };
}

type Emit = (event: string, ...args: unknown[]) => boolean;

function asList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : value === undefined || value === null ? [] : [String(value)];
}

/**
 * Make these response headers final: `set` replaces, `cookie` is added to whatever
 * Set-Cookie Next.js sends. Covers both ways Node writes headers (setHeader, and an
 * object passed to writeHead).
 */
function finalHeaders(res: http.ServerResponse, set: Record<string, string>, cookie?: string) {
  const withCookie = (value: unknown) => {
    const list = asList(value);
    return cookie && !list.includes(cookie) ? [...list, cookie] : list;
  };
  const rawSet = res.setHeader.bind(res);
  for (const [k, v] of Object.entries(set)) rawSet(k, v);
  if (cookie) rawSet('Set-Cookie', withCookie(undefined));
  res.setHeader = ((name: string, value: number | string | readonly string[]) => {
    const key = name.toLowerCase();
    if (key in set) return res;
    if (key === 'set-cookie') return rawSet(name, withCookie(value));
    return rawSet(name, value);
  }) as typeof res.setHeader;
  const rawWriteHead = res.writeHead.bind(res) as (...a: unknown[]) => http.ServerResponse;
  res.writeHead = ((...a: unknown[]) => {
    const headers = a.find((x, i) => i > 0 && x && typeof x === 'object' && !Array.isArray(x)) as Record<string, unknown> | undefined;
    if (headers) {
      for (const k of Object.keys(headers)) {
        const key = k.toLowerCase();
        if (key in set) delete headers[k];
        else if (key === 'set-cookie') {
          rawSet('Set-Cookie', withCookie([...asList(res.getHeader('set-cookie')), ...asList(headers[k])]));
          delete headers[k];
        }
      }
    }
    for (const [k, v] of Object.entries(set)) rawSet(k, v);
    return rawWriteHead(...a);
  }) as typeof res.writeHead;
}

const HUB_HEADERS = { 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex, nofollow', 'cache-control': 'no-store' };
/** Views of one order's private page: a customer opens it a few times; a guesser is stopped. */
export const PAY_VIEW_LIMITS = { perAddress: 60, perOrder: 60, windowMs: 15 * 60 * 1000 };

/** Right after the update that brought private links: send a signed-in owner opening the shop to the new link, once. */
async function revealFor(cookieHeader: string): Promise<string | null> {
  if (!hasPendingReveal()) return null;
  const token = /(?:^|;\s*)buh_admin=([^;]+)/.exec(cookieHeader)?.[1];
  const session = await verifySessionToken(token);
  if (!session || session.mustChangePassword) return null;
  // Only a session from before the link was made (signed in when the update came): one made
  // since came through the link already.
  const made = Date.parse(currentLink()?.createdAt ?? '');
  if (!(session.issuedAt < made)) return null;
  const segment = takeReveal();
  if (segment) setLinkNotice('moved');
  return segment;
}

export function installFrontGate(): void {
  const proto = http.Server.prototype as unknown as { emit: Emit; [INSTALLED]?: boolean };
  if (proto[INSTALLED]) return;
  proto[INSTALLED] = true;
  const original = proto.emit;
  proto.emit = function gatedEmit(this: http.Server, event: string, ...args: unknown[]) {
    if (event !== 'request') return original.call(this, event, ...args);
    const [req, res] = args as [http.IncomingMessage, http.ServerResponse];
    const go = () => original.call(this, event, ...args);
    const rawPath = req.url || '/';
    // Only this gate sets the hub's marker (checked first: a delete on every request would slow the headers object).
    if (req.headers[HUB_HEADER] !== undefined) delete req.headers[HUB_HEADER];

    // The scanner slow-down (real addresses only).
    const ip = addressOf(req.headers);
    let slow = false;
    if (ip) {
      const verdict = verdictFor(ip);
      if (verdict.action === 'block') {
        res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': String(verdict.retryAfterSec), 'Cache-Control': 'no-store' });
        res.end('Too many requests. Please try again later.\n');
        return true;
      }
      slow = verdict.action === 'slow';
      if (countsAsProbe(normalizePath(rawPath).path)) {
        res.on('finish', () => {
          // Not the owner's own misses (a deleted order): a valid door is one this shop issued.
          if (res.statusCode === 404 && !verifyDoorToken(doorTokenFromCookieHeader(typeof req.headers.cookie === 'string' ? req.headers.cookie : '')).ok) recordMiss(ip);
        });
      }
    }

    const cookieHeader = typeof req.headers.cookie === 'string' ? req.headers.cookie : '';
    let decision: GateDecision;
    try {
      decision = decide(rawPath, cookieHeader);
    } catch (err) {
      logEvent('error', 'front_gate_failed', { error: err instanceof Error ? err.message : String(err) });
      // Never the hub by mistake: an admin address that can't be checked is unknown.
      const { path } = normalizePath(rawPath);
      decision = isAdminApi(path) || path.startsWith(HUB_ROUTE) ? { kind: 'unknown', url: path.startsWith('/api/') ? NOWHERE_API : NOWHERE_PAGE } : { kind: 'pass' };
    }
    if (decision.kind === 'unknown') {
      req.url = decision.url;
    } else if (decision.kind === 'hub') {
      req.url = decision.url;
      req.headers[HUB_HEADER] = decision.hubHeader;
      finalHeaders(res, HUB_HEADERS, decision.cookie);
    } else if (decision.kind === 'renew') {
      finalHeaders(res, {}, decision.cookie);
    } else if (decision.kind === 'pay') {
      if (!decision.api) {
        const { perAddress, perOrder, windowMs } = PAY_VIEW_LIMITS;
        const refused = takeAll([...(ip ? [{ key: `pay-view:${ip}`, max: perAddress, windowMs }] : []), { key: `pay-view:order:${decision.orderId}`, max: perOrder, windowMs }]);
        if (refused) {
          res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': String(refused.result.retryAfterSec), ...HUB_HEADERS });
          res.end('Too many requests. Please try again in a few minutes.\n');
          return true;
        }
      }
      finalHeaders(res, HUB_HEADERS);
    }

    // The shop's front page, for a browser signed in to the hub: maybe the new link, once.
    if (decision.kind === 'pass' && (rawPath === '/' || rawPath.startsWith('/?')) && cookieHeader.includes(`${SESSION_COOKIE}=`) && req.method === 'GET') {
      void revealFor(cookieHeader)
        .catch(() => null)
        .then((segment) => {
          if (!segment) return slow ? setTimeout(go, SLOW_MS).unref() : go();
          res.writeHead(303, { Location: `/${segment}`, 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' });
          res.end();
        });
      return true;
    }
    if (slow) {
      setTimeout(go, SLOW_MS).unref();
      return true;
    }
    return go();
  };
}

