import { BILL_CSP } from '@/lib/csp';
import { handleRouteError } from '@/lib/server/http';
import { openDealId, readDealPhoto } from '@/lib/server/photoDeals';

/**
 * A photo deal's picture for the customer holding its private link (1 first). The front gate has
 * let only an open deal's token through; checked again here. Never cached, no referrer, sandboxed.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string; n: string }> }) {
  try {
    const { token, n } = await params;
    const id = openDealId(token);
    const photo = id && /^\d{1,2}$/.test(n) ? readDealPhoto(id, Number(n)) : null;
    if (!photo) return new Response('Not found', { status: 404 });
    return new Response(new Uint8Array(photo.bytes), {
      headers: { 'Content-Type': photo.mime, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': BILL_CSP },
    });
  } catch (err) {
    return handleRouteError(err, 'deal/photos');
  }
}
