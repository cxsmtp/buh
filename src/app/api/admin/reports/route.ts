import { requireReader } from '@/lib/server/guard';
import { handleRouteError, json } from '@/lib/server/http';
import { buildReport, parsePeriod, vatStatus, yearStartMonth } from '@/lib/server/reports';

/**
 * Money → Reports: ?from=YYYY-MM-DD&to=YYYY-MM-DD (UAE dates): sales, refunds, payment methods,
 * expenses by category, profit and the VAT threshold. Without dates: only the settings and the
 * VAT status (for the hub's first view).
 */
export async function GET(req: Request) {
  try {
    await requireReader(req);
    const q = new URL(req.url).searchParams;
    const settings = { yearStartMonth: yearStartMonth() };
    if (!q.has('from') && !q.has('to')) return json({ settings, vat: vatStatus() });
    const { from, to } = parsePeriod(q.get('from'), q.get('to'));
    return json({ settings, report: buildReport(from, to) });
  } catch (err) {
    return handleRouteError(err, 'admin/reports');
  }
}
