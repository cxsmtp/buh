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
