import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError } from '@/lib/server/http';
import { readReceipt } from '@/lib/server/orders';

/** The customer's bank-transfer receipt. Admin only; sandboxed so it can never run script. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin(req);
    const receipt = readReceipt((await params).id);
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
