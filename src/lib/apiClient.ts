'use client';

/** Fired when a call comes back 401 (detail: { url }), so a page that cares (the hub) can ask to sign in again. */
export const UNAUTHORIZED_EVENT = 'buh:unauthorized';
/**
 * Fired when a call comes back as an unknown address (the HTML "not found" page, not a
 * JSON answer from a route; detail: { url }). The hub listens: for its own calls it means
 * the private link was changed, so it stops calling and says so.
 */
export const UNKNOWN_ADDRESS_EVENT = 'buh:unknown-address';

export interface ApiResult<T = Record<string, unknown>> {
  ok: boolean;
  status: number;
  data: T;
}

/**
 * POST JSON to one of our own routes. Never throws: network errors come back
 * as status 0 with a readable message, so every caller can show something.
 */
export function postJson<T = Record<string, unknown>>(url: string, body: unknown): Promise<ApiResult<T>> {
  return sendJson<T>('POST', url, body);
}

/** GET one of our own routes. Never throws (see postJson). */
export function getJson<T = Record<string, unknown>>(url: string): Promise<ApiResult<T>> {
  return sendJson<T>('GET', url);
}

export async function sendJson<T = Record<string, unknown>>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as T;
    // Which calls mean "signed out" is for the listener to decide (the shop has none).
    if (res.status === 401) window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT, { detail: { url } }));
    if (res.status === 404 && !(res.headers.get('content-type') || '').includes('json')) {
      window.dispatchEvent(new CustomEvent(UNKNOWN_ADDRESS_EVENT, { detail: { url } }));
    }
    return { ok: res.ok, status: res.status, data };
  } catch {
    return {
      ok: false,
      status: 0,
      data: { message: 'Could not reach the server. Check your connection and try again.' } as T,
    };
  }
}

/**
 * A stored link that is safe as an href, the same on the server and in the browser: a path on
 * this site ("/api/…", never "//host" or "/\host"), or an absolute http(s) address. Anything else
 * (javascript:, data:, vbscript:, …) gives undefined.
 */
export function safeLinkHref(url: string | undefined | null): string | undefined {
  if (!url || typeof url !== 'string') return undefined;
  if (/^\/(?![/\\])/.test(url)) return /[\s\u0000-\u001f]/.test(url) ? undefined : url;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

/** Only http(s) links may be rendered as hrefs (blocks javascript: URLs from stored data). */
export function safeHref(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}
