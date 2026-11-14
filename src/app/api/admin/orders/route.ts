import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, json } from '@/lib/server/http';
import { invoicesOf } from '@/lib/server/invoices';
import { hubTotals, listHubOrders, listOrders, ORDER_STATUSES } from '@/lib/server/orders';

/**
 * The hub's orders: every open order (not delivered, not cancelled) however many the shop has, the
 * newest finished ones, `older` (where the finished ones continue: /api/admin/orders/search) and
 * the totals counted over every order (header sales, badges, to-dos, money highlights).
 * With ?status= or ?limit=: the newest orders (of that status), as before.
 */
export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    const url = new URL(req.url);
    const status = url.searchParams.get('status') || undefined;
    const limit = url.searchParams.get('limit');
    const hub = !status && !limit ? listHubOrders() : null;
    const orders = hub ? hub.orders : listOrders({ status: status && ORDER_STATUSES.includes(status as never) ? status : undefined, limit: Number(limit || 500) || 500 });
    // Each order's PDF invoice, once issued (one query).
    const invoices = invoicesOf(orders.map((o) => o.id));
    const withInvoices = orders.map((o) => (invoices.has(o.id) ? { ...o, invoice: invoices.get(o.id) } : o));
    return json(hub ? { orders: withInvoices, older: hub.older, totals: hubTotals() } : { orders: withInvoices });
  } catch (err) {
    return handleRouteError(err, 'admin/orders');
  }
}
