import { auditOrThrow } from '@/lib/server/audit';
import { requireAdmin } from '@/lib/server/guard';
import { allowFields, handleRouteError, json, readJsonBody } from '@/lib/server/http';
import { setYearStartMonth, yearStartMonth } from '@/lib/server/reports';

/** The month the financial year starts in: { yearStartMonth: 1–12 } (January, the calendar year, by default). Audited first. */
export async function PUT(req: Request) {
  try {
    const session = await requireAdmin(req);
    const body = await readJsonBody(req, 512);
    allowFields(body, ['yearStartMonth']);
    const before = yearStartMonth();
    const m = body.yearStartMonth;
    if (!Number.isInteger(m) || (m as number) < 1 || (m as number) > 12) return json({ success: false, message: 'The financial year starts in a month from 1 (January) to 12 (December).' }, 400);
    if (m !== before) auditOrThrow('settings.updated', { by: session.email, key: 'reports', changes: { yearStartMonth: { from: before, to: m } } });
    return json({ settings: { yearStartMonth: setYearStartMonth(m) } });
  } catch (err) {
    return handleRouteError(err, 'admin/reports/settings');
  }
}
