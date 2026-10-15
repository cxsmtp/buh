import { NextResponse } from 'next/server';
import { logEvent } from './log';
import { appUrl } from './runtimeConfig';

/**
 * An error whose message is safe to show to the caller. Anything else that
 * reaches handleRouteError is logged and answered with a generic message, so
 * stack traces, upstream bodies and secrets never leak into a response.
 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly headers: Record<string, string> = {},
    /** Extra safe fields for the client, e.g. { code: 'price_changed' }. */
    public readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return NextResponse.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

export function handleRouteError(err: unknown, route: string, shape: Record<string, unknown> = { success: false }) {
  if (err instanceof HttpError) {
    return json({ ...shape, ...err.details, message: err.message }, err.status, err.headers);
  }
  logEvent('error', 'route_error', { route, error: err instanceof Error ? err.message : String(err) });
  return json({ ...shape, message: 'Something went wrong. Please try again.' }, 500);
}

/**
 * Read a JSON object body with a hard size cap. Rejects the wrong content type
 * (415), oversized bodies (413) and anything that is not a JSON object (400)
 * before a handler ever sees it.
 */
export async function readJsonBody(req: Request, maxBytes = 16 * 1024): Promise<Record<string, unknown>> {
  const type = req.headers.get('content-type') || '';
  if (!/^application\/json\b/i.test(type)) {
    throw new HttpError(415, 'Expected an application/json body.');
  }
  const declared = Number(req.headers.get('content-length') || '0');
  if (declared > maxBytes) throw new HttpError(413, 'Request body is too large.');

  if (!req.body) throw new HttpError(400, 'Request body is required.');
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new HttpError(413, 'Request body is too large.');
    }
    chunks.push(value);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'Request body must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

/**
 * The caller's IP for rate limiting, or null when it cannot be known. Forwarded headers are only honoured when
 * TRUST_PROXY=1, because without a proxy in front anyone can set them. Behind
 * nginx we read X-Real-IP (set from $remote_addr), not the first
 * X-Forwarded-For entry, which the client controls.
 */
export function clientIp(req: Request): string | null {
  if (process.env.TRUST_PROXY === '1') {
    const real = req.headers.get('x-real-ip');
    if (real) return real.trim();
    const xff = req.headers.get('x-forwarded-for');
    if (xff) {
      const hops = xff.split(',').map((s) => s.trim()).filter(Boolean);
      if (hops.length) return hops[hops.length - 1];
    }
  }
  // Unknown: route handlers cannot see the socket. Callers skip per-IP limits
  // rather than lumping every visitor into one shared bucket.
  return null;
}

/**
 * CSRF guard for state-changing requests: the browser-supplied Origin (or,
 * failing that, Sec-Fetch-Site) must say the request came from this site.
 * Combined with SameSite=Strict session cookies this closes cross-site posts.
 */
export function assertSameOrigin(req: Request): void {
  const origin = req.headers.get('origin');
  // Host only: X-Forwarded-Host is client-controlled unless the proxy rewrites it,
  // and nginx here passes the real Host header through.
  const host = req.headers.get('host');
  const allowed = new Set<string>();
  if (host) allowed.add(host.toLowerCase());
  const url = appUrl();
  if (url) {
    try {
      allowed.add(new URL(url).host.toLowerCase());
    } catch {
      // ignore a malformed APP_URL; Host still applies
    }
  }

  // Origin first, then Referer. "null" (sandboxed frames, some redirects) is refused.
  const source = origin ?? req.headers.get('referer');
  if (source) {
    let sourceHost = '';
    try {
      sourceHost = source === 'null' ? '' : new URL(source).host.toLowerCase();
    } catch {
      // unparsable: treated as foreign below
    }
    if (!sourceHost || !allowed.has(sourceHost)) throw new HttpError(403, 'Cross-site request refused.');
    return;
  }
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') {
    throw new HttpError(403, 'Cross-site request refused.');
  }
}

/** Refuse a body carrying any field not on the list (a typo or a probe gets a clear 400, not silence). */
export function allowFields(body: Record<string, unknown>, allowed: readonly string[]): void {
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length) throw new HttpError(400, `Unexpected field: ${extra[0].slice(0, 40)}.`);
}

export function str(value: unknown, field: string, max: number, { required = true, trim = true } = {}): string {
  if (value === undefined || value === null || value === '') {
    if (required) throw new HttpError(400, `${field} is required.`);
    return '';
  }
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be text.`);
  const trimmed = trim ? value.trim() : value;
  if (trimmed.length > max) throw new HttpError(400, `${field} is too long.`);
  return trimmed;
}
