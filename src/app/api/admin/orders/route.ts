import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, json } from '@/lib/server/http';
import { invoicesOf } from '@/lib/server/invoices';
import { listOrders, ORDER_STATUSES } from '@/lib/server/orders';

export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    const url = new URL(req.url);
    const status = url.searchParams.get('status') || undefined;
    const limit = Number(url.searchParams.get('limit') || 500);
    const orders = listOrders({ status: status && ORDER_STATUSES.includes(status as never) ? status : undefined, limit });
    // Each order's PDF invoice, once issued (one query).
    const invoices = invoicesOf(orders.map((o) => o.id));
    return json({ orders: orders.map((o) => (invoices.has(o.id) ? { ...o, invoice: invoices.get(o.id) } : o)) });
  } catch (err) {
    return handleRouteError(err, 'admin/orders');
  }
}
