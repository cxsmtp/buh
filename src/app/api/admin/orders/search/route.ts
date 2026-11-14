import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, HttpError, json } from '@/lib/server/http';
import { invoicesOf } from '@/lib/server/invoices';
import { searchOrders } from '@/lib/server/orders';

const PARAMS = ['q', 'status', 'kind', 'before', 'limit'];

/**
 * Find any order, however old: ?q= (order number, customer name or phone), ?status= (one status,
 * or "finished": delivered or cancelled), ?kind=card|photo, a page at a time (?before= the `next`
 * of the page before). The owner only; nothing is changed.
 */
export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    const params = new URL(req.url).searchParams;
    for (const k of params.keys()) if (!PARAMS.includes(k)) throw new HttpError(400, 'That search is not known.');
    const get = (k: string, max: number) => {
      const v = params.get(k) ?? '';
      if (v.length > max) throw new HttpError(400, 'That search is too long.');
      return v || undefined;
    };
    const kind = get('kind', 10);
    if (kind !== undefined && kind !== 'card' && kind !== 'photo') throw new HttpError(400, 'That kind of order is not known.');
    const limit = get('limit', 3);
    if (limit !== undefined && !/^\d{1,3}$/.test(limit)) throw new HttpError(400, 'That page size is not known.');
    const { orders, next } = searchOrders({ q: get('q', 60), status: get('status', 30), kind, before: get('before', 80), limit: limit ? Number(limit) : undefined });
    const invoices = invoicesOf(orders.map((o) => o.id));
    return json({ orders: orders.map((o) => (invoices.has(o.id) ? { ...o, invoice: invoices.get(o.id) } : o)), next });
  } catch (err) {
    return handleRouteError(err, 'admin/orders/search');
  }
}
