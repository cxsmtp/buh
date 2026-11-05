import { courierChargesView, syncJeeblyCharges } from '@/lib/server/courierCharges';
import { requireAdmin, requireReader } from '@/lib/server/guard';
import { allowFields, handleRouteError, HttpError, json, readJsonBody } from '@/lib/server/http';
import { rateLimit } from '@/lib/server/rateLimit';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Money → Courier charges: what Jeebly charged per shipment (?from&to: dated in that period). */
export async function GET(req: Request) {
  try {
    await requireReader(req);
    const q = new URL(req.url).searchParams;
    const from = q.get('from') ?? undefined;
    const to = q.get('to') ?? undefined;
    if ((from && !DATE.test(from)) || (to && !DATE.test(to))) throw new HttpError(400, 'Dates must be YYYY-MM-DD.');
    return json(courierChargesView({ from, to }));
  } catch (err) {
    return handleRouteError(err, 'admin/money/courier-charges');
  }
}

/** "Check Jeebly now": ask Jeebly about up to 50 shipments with no charge yet. */
export async function POST(req: Request) {
  try {
    const session = await requireAdmin(req);
    const body = await readJsonBody(req, 1024);
    allowFields(body, []);
    if (!rateLimit(`courier-charges:sync:${session.email}`, 6, 60 * 60_000).ok) throw new HttpError(429, 'Checked Jeebly 6 times this hour: the shop keeps checking by itself every 15 minutes.');
    const result = await syncJeeblyCharges({ max: 50, force: true });
    return json({ ...result, ...courierChargesView() });
  } catch (err) {
    return handleRouteError(err, 'admin/money/courier-charges/sync');
  }
}
