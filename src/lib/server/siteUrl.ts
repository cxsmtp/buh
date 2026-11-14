import { headers } from 'next/headers';
import { appUrl } from './runtimeConfig';

/** The shop's public address: NEXT_PUBLIC_APP_URL, else the request's host. */
export async function siteUrl(): Promise<string> {
  const configured = appUrl();
  if (configured) return configured.replace(/\/$/, '');
  const h = await headers();
  const host = (h.get('host') || 'localhost').replace(/[^\w.:-]/g, '');
  return `${h.get('x-forwarded-proto') === 'http' ? 'http' : 'https'}://${host}`;
}

/**
 * The address for a link that signs someone in (a password-reset email): never taken from a
 * request's Host header, which the sender chooses (found by the review: a forged Host put the
 * owner's reset link on someone else's site). The configured address, or this computer's own
 * (localhost, 127.0.0.1) for a shop run on the owner's laptop; otherwise null, and no link is sent.
 */
export async function trustedSiteUrl(): Promise<string | null> {
  const configured = appUrl();
  if (configured) return configured.replace(/\/$/, '');
  const h = await headers();
  const host = h.get('host') || '';
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/.test(host)) return null;
  return `${h.get('x-forwarded-proto') === 'https' ? 'https' : 'http'}://${host}`;
}
