import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, HttpError, json, readJsonBody } from '@/lib/server/http';
import { handOverOrder } from '@/lib/server/orders';

/**
 * "Handed over in person" (no courier): the order becomes delivered; for cash on delivery the cash
 * is recorded unless { cashReceived: false }. Body: { cashReceived?, note? }. Owner only, audited.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAdmin(req);
    const { id } = await params;
    if (!/^BUH-[A-Z0-9-]{4,40}$/.test(id)) throw new HttpError(404, 'Order not found.');
    const body = await readJsonBody(req, 1024);
    const { order, changed } = handOverOrder(id, body, session.email);
    return json({ order, changed });
  } catch (err) {
    return handleRouteError(err, 'admin/orders/handover');
  }
}
