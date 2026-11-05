import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, HttpError, json, readJsonBody } from '@/lib/server/http';
import { editOrderDetails, getOrder } from '@/lib/server/orders';

/**
 * Edit an order before its label: { customer?: {…}, lines?: [{ quantity?, unitPrice? }], deliveryFee? }.
 * Owner only; size-capped; every field allow-listed and checked on the server (orders.ts
 * editOrderDetails); the totals worked out there; audited before it is reported done.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAdmin(req);
    const { id } = await params;
    const body = await readJsonBody(req, 16 * 1024);
    if (!/^BUH-[A-Z0-9-]{4,40}$/.test(id) || !getOrder(id)) throw new HttpError(404, 'Order not found.');
    return json(editOrderDetails(id, body, session.email));
  } catch (err) {
    return handleRouteError(err, 'admin/orders/details');
  }
}
