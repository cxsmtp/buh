import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, HttpError, json } from '@/lib/server/http';
import { customerOrders } from '@/lib/server/orders';

const PARAMS = ['phone', 'before'];

/** One customer's orders (every one, newest first, 30 at a time): ?phone= as the customer list gives it, ?before= the `next` of the page before. */
export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    const params = new URL(req.url).searchParams;
    for (const k of params.keys()) if (!PARAMS.includes(k)) throw new HttpError(400, 'That request is not known.');
    // An unescaped "+" in an address arrives as a space: the numbers are stored with it.
    const phone = `+${(params.get('phone') ?? '').replace(/[\s+]+/g, '')}`;
    if (!/^\+\d{6,15}$/.test(phone)) throw new HttpError(400, 'That phone number is not known.');
    const before = params.get('before') ?? '';
    if (before.length > 80) throw new HttpError(400, 'That page is not known.');
    return json(customerOrders(phone, { before: before || undefined }));
  } catch (err) {
    return handleRouteError(err, 'admin/customers/orders');
  }
}
