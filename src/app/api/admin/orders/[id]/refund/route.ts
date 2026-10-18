import { requireAdmin } from '@/lib/server/guard';
import { allowFields, handleRouteError, HttpError, json, readJsonBody } from '@/lib/server/http';
import { getOrder } from '@/lib/server/orders';
import { refundCardOrder } from '@/lib/server/payments';

/**
 * "Cancel & refund AED X to the card": a full refund through Stripe (once: the idempotency key is
 * refund:<order>), recorded from Stripe's answer, and the order cancelled. The body must say the
 * amount the owner was shown, so a refund is never for a total they didn't see.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAdmin(req);
    const { id } = await params;
    const body = await readJsonBody(req, 1024);
    allowFields(body, ['amount']);
    if (!/^BUH-[A-Z0-9-]{4,40}$/.test(id)) throw new HttpError(404, 'Order not found.');
    const order = getOrder(id);
    if (!order) throw new HttpError(404, 'Order not found.');
    const shown = typeof body.amount === 'number' && Number.isFinite(body.amount) ? Math.round(body.amount * 100) : NaN;
    if (shown !== Math.round((order.card?.paidAmount ?? order.total) * 100)) throw new HttpError(409, `The amount to refund is AED ${order.card?.paidAmount ?? order.total}: refresh and try again.`);
    const { order: updated, outcome } = await refundCardOrder(id, session.email);
    return json({ order: updated, outcome });
  } catch (err) {
    return handleRouteError(err, 'admin/orders/refund');
  }
}
