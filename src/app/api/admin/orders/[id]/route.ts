import { audit } from '@/lib/server/audit';
import { requireAdmin } from '@/lib/server/guard';
import { allowFields, handleRouteError, HttpError, json, readJsonBody } from '@/lib/server/http';
import { getOrder, orderEvents, updateOrderByAdmin } from '@/lib/server/orders';
import { cancelUnpaidCardOrder } from '@/lib/server/payments';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin(req);
    const { id } = await params;
    const order = getOrder(id);
    if (!order) throw new HttpError(404, 'Order not found.');
    return json({ order, events: orderEvents(id) });
  } catch (err) {
    return handleRouteError(err, 'admin/orders/get');
  }
}

const PATCH_FIELDS = ['status', 'paymentStatus', 'adminNotes', 'clearAttention', 'shipUnconfirmed'] as const;

/**
 * Change status, payment status or notes (a bank transfer is marked paid only through
 * ./bank, "Payment received"; a card payment only by Stripe). Cancelling returns the stock. An unpaid card order is
 * cancelled by stopping its payment at Stripe first (so it can't be paid afterwards).
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAdmin(req);
    const { id } = await params;
    const body = await readJsonBody(req, 8 * 1024);
    // What the hub sends (updateOrderByAdmin checks each value): nothing else is taken.
    allowFields(body, PATCH_FIELDS);
    const current = getOrder(id);
    const unpaidCard = current?.paymentMethod === 'online_card' && (current.card?.state === 'pending' || current.card?.state === 'failed');
    if (unpaidCard && body.status === 'cancelled' && Object.keys(body).length === 1) {
      const order = await cancelUnpaidCardOrder(id, session.email);
      audit('order.updated', { by: session.email, orderId: id, fields: ['status'] });
      return json({ order });
    }
    // Audited (before → after) inside updateOrderByAdmin, before anything is saved.
    const order = updateOrderByAdmin(id, body, session.email);
    return json({ order });
  } catch (err) {
    return handleRouteError(err, 'admin/orders/patch');
  }
}
