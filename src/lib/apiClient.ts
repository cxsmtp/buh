'use client';

/** Fired when a call comes back 401 (detail: { url }), so a page that cares (the hub) can ask to sign in again. */
export const UNAUTHORIZED_EVENT = 'buh:unauthorized';
/**
 * Fired when an admin call comes back as an unknown address (the shop's HTML 404 page,
 * not a JSON answer): this browser's door no longer opens the hub, because the private
 * link was changed. The hub stops calling, so an open tab can't count as a scanner.
 */
export const DOOR_CLOSED_EVENT = 'buh:door-closed';

const ADMIN_CALL = /^\/api\/(?:admin(?:\/|$|\?)|courier\/(?:dispatch|test)(?:$|\?)|ai-transform(?:$|\?))/;

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
    if (res.status === 404 && ADMIN_CALL.test(url) && !(res.headers.get('content-type') || '').includes('json')) {
      window.dispatchEvent(new CustomEvent(DOOR_CLOSED_EVENT, { detail: { url } }));
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
