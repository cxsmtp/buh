import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, HttpError, json, readJsonBody } from '@/lib/server/http';
import { handOverInPerson } from '@/lib/server/jeeblyOps';

/**
 * "Handed over in person" (no courier): the order becomes delivered; for cash on delivery the cash
 * is recorded unless { cashReceived: false }. Body: { cashReceived?, note?, cancelCourier?,
 * courierCancelled? }. Booked with Jeebly: { cancelCourier: true } cancels the booking with Jeebly
 * first (its answer audited) and hands over only if Jeebly confirms; { courierCancelled: true } is
 * the owner saying they cancelled it in the courier's portal. Owner only, audited.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAdmin(req);
    const { id } = await params;
    if (!/^BUH-[A-Z0-9-]{4,40}$/.test(id)) throw new HttpError(404, 'Order not found.');
    const body = await readJsonBody(req, 1024);
    const { order: saved, changed } = await handOverInPerson(id, body, session.email);
    return json({ order: saved, changed });
  } catch (err) {
    return handleRouteError(err, 'admin/orders/handover');
  }
}
