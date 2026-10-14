import { audit } from '@/lib/server/audit';
import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, HttpError, json, readJsonBody } from '@/lib/server/http';
import { getOrder, orderEvents, updateOrderByAdmin } from '@/lib/server/orders';

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

/** Change status, payment status or notes. Cancelling returns the stock. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAdmin(req);
    const { id } = await params;
    const body = await readJsonBody(req, 8 * 1024);
    const order = updateOrderByAdmin(id, body, session.email);
    audit('order.updated', { by: session.email, orderId: id, fields: Object.keys(body) });
    return json({ order });
  } catch (err) {
    return handleRouteError(err, 'admin/orders/patch');
  }
}
