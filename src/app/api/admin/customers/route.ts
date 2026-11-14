import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, HttpError, json } from '@/lib/server/http';
import { customersPage } from '@/lib/server/orders';

const PARAMS = ['q', 'offset', 'limit'];

/** A page of customers (60 unless ?limit=), newest order first: ?q= looks in name, phone, emirate and area; ?offset= the `next` of the page before. */
export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    const params = new URL(req.url).searchParams;
    for (const k of params.keys()) if (!PARAMS.includes(k)) throw new HttpError(400, 'That search is not known.');
    const q = params.get('q') ?? '';
    if (q.length > 60) throw new HttpError(400, 'That search is too long.');
    const number = (k: string) => {
      const v = params.get(k);
      if (v === null || v === '') return undefined;
      if (!/^\d{1,7}$/.test(v)) throw new HttpError(400, 'That page is not known.');
      return Number(v);
    };
    return json(customersPage({ q, offset: number('offset'), limit: number('limit') }));
  } catch (err) {
    return handleRouteError(err, 'admin/customers');
  }
}
