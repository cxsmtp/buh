import { BILL_CSP } from '@/lib/csp';
import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError } from '@/lib/server/http';
import { readPhotoOrderPhoto } from '@/lib/server/orders';

/** A photo the customer uploaded with an order from a photo (1 first). Owner only; sandboxed, never cached. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string; n: string }> }) {
  try {
    await requireAdmin(req);
    const { id, n } = await params;
    const photo = /^\d{1,2}$/.test(n) ? readPhotoOrderPhoto(id, Number(n)) : null;
    if (!photo) return new Response('Not found', { status: 404 });
    return new Response(new Uint8Array(photo.bytes), {
      headers: {
        'Content-Type': photo.mime,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        // Sandboxed, the image and nothing else (also set for this path in next.config.ts).
        'Content-Security-Policy': BILL_CSP,
      },
    });
  } catch (err) {
    return handleRouteError(err, 'admin/orders/photos');
  }
}
