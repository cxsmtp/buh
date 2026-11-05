import { requireAdmin } from '@/lib/server/guard';
import { allowFields, handleRouteError, HttpError, json, readJsonBody } from '@/lib/server/http';
import { getOrder, recreateOrder } from '@/lib/server/orders';

/** Recreate a cancelled cash-on-delivery order as a new one (the same again if asked twice). Owner only; audited. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAdmin(req);
    const { id } = await params;
    const body = await readJsonBody(req, 256);
    allowFields(body, []);
    if (!/^BUH-[A-Z0-9-]{4,40}$/.test(id) || !getOrder(id)) throw new HttpError(404, 'Order not found.');
    const { order, created } = recreateOrder(id, session.email);
    return json({ order, created }, created ? 201 : 200);
  } catch (err) {
    return handleRouteError(err, 'admin/orders/recreate');
  }
}
