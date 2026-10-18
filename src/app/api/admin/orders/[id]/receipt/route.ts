import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError } from '@/lib/server/http';
import { readReceipt } from '@/lib/server/orders';

/**
 * The customer's bank-transfer screenshot (or PDF): the latest, or an earlier one with ?v=1, 2…
 * Admin only; sandboxed so it can never run script.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin(req);
    const v = new URL(req.url).searchParams.get('v');
    const receipt = readReceipt((await params).id, v === null ? undefined : /^\d{1,4}$/.test(v) ? Number(v) : -1);
    if (!receipt) return new Response('Not found', { status: 404 });
    return new Response(new Uint8Array(receipt.bytes), {
      headers: {
        'Content-Type': receipt.mime,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; img-src 'self'; object-src 'self'; sandbox",
      },
    });
  } catch (err) {
    return handleRouteError(err, 'admin/orders/receipt');
  }
}
