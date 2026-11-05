import { requireAdmin } from '@/lib/server/guard';
import { allowFields, handleRouteError, HttpError, json, readJsonBody } from '@/lib/server/http';
import { getOrder, moveCredit } from '@/lib/server/orders';

/**
 * Move this paid order's money onto another order instead of refunding it ({ toOrderId, amount }
 * in AED): this order is cancelled if it isn't yet, the other collects that much less on delivery.
 * Owner only; checked against both orders on the server and audited before it is reported done.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAdmin(req);
    const { id } = await params;
    const body = await readJsonBody(req, 256);
    allowFields(body, ['toOrderId', 'amount']);
    if (!/^BUH-[A-Z0-9-]{4,40}$/.test(id) || !getOrder(id)) throw new HttpError(404, 'Order not found.');
    return json(moveCredit(id, body.toOrderId, body.amount, session.email));
  } catch (err) {
    return handleRouteError(err, 'admin/orders/credit');
  }
}
