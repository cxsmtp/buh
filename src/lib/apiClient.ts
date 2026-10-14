'use client';

/** Fired when an admin call comes back 401, so the page can drop admin mode. */
export const ADMIN_SIGNED_OUT_EVENT = 'buh:admin-signed-out';

export interface ApiResult<T = Record<string, unknown>> {
  ok: boolean;
  status: number;
  data: T;
}

/**
 * POST JSON to one of our own routes. Never throws: network errors come back
 * as status 0 with a readable message, so every caller can show something.
 */
export async function postJson<T = Record<string, unknown>>(url: string, body: unknown): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as T;
    if (res.status === 401 && url.startsWith('/api/') && !url.startsWith('/api/admin/login')) {
      window.dispatchEvent(new Event(ADMIN_SIGNED_OUT_EVENT));
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
