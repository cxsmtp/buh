import { DOCUMENT_HEADERS } from '@/lib/server/documentHeaders';
import { requireReader } from '@/lib/server/guard';
import { handleRouteError } from '@/lib/server/http';
import { getOrder } from '@/lib/server/orders';
import { orderDocumentHtml } from '@/lib/server/taxDocument';

/** An order's receipt or tax invoice, printable (the owner, or the accountant: read-only). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireReader(req);
    const order = getOrder((await params).id);
    if (!order) return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    return new Response(orderDocumentHtml(order), { headers: DOCUMENT_HEADERS });
  } catch (err) {
    return handleRouteError(err, 'admin/orders/invoice');
  }
}
