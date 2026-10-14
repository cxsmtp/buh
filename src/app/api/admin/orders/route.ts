import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, json } from '@/lib/server/http';
import { listOrders, ORDER_STATUSES } from '@/lib/server/orders';

export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    const url = new URL(req.url);
    const status = url.searchParams.get('status') || undefined;
    const limit = Number(url.searchParams.get('limit') || 500);
    return json({ orders: listOrders({ status: status && ORDER_STATUSES.includes(status as never) ? status : undefined, limit }) });
  } catch (err) {
    return handleRouteError(err, 'admin/orders');
  }
}
