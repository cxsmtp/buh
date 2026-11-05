import { BILL_CSP } from '@/lib/csp';
import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError } from '@/lib/server/http';
import { readDealPhoto } from '@/lib/server/photoDeals';

/** A photo deal's picture (1 first), for the hub. Owner only; sandboxed, never cached. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string; n: string }> }) {
  try {
    await requireAdmin(req);
    const { id, n } = await params;
    const photo = /^\d{1,2}$/.test(n) ? readDealPhoto(id, Number(n)) : null;
    if (!photo) return new Response('Not found', { status: 404 });
    return new Response(new Uint8Array(photo.bytes), {
      headers: { 'Content-Type': photo.mime, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': BILL_CSP },
    });
  } catch (err) {
    return handleRouteError(err, 'admin/deals/photos');
  }
}
