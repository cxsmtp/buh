import { indexNowKey, indexNowOn } from '@/lib/server/indexNow';

/**
 * The IndexNow key file (src/lib/server/indexNow.ts): the key as plain text while IndexNow is on
 * (Settings → Search (SEO)), so Bing can check the pings come from this site. Off: not found.
 */
export const dynamic = 'force-dynamic';

export function GET() {
  try {
    if (!indexNowOn()) return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
    return new Response(indexNowKey(), { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600', 'X-Robots-Tag': 'noindex' } });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}
