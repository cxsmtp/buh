import { auditOrThrow } from '@/lib/server/audit';
import { enforceLimit, requireReader } from '@/lib/server/guard';
import { assertSameOrigin, handleRouteError, json } from '@/lib/server/http';
import { parsePeriod } from '@/lib/server/reports';
import { vatReturn, vatReturnCsv } from '@/lib/server/vat';

/**
 * Money → VAT return: ?from=YYYY-MM-DD&to=YYYY-MM-DD (UAE dates; a quarter, or the FTA's tax period).
 * The totals as JSON, or with ?format=csv the CSV for the accountant (who exported which period is
 * written to the audit log first). The owner, or the accountant (read-only).
 */
export async function GET(req: Request) {
  try {
    const session = await requireReader(req);
    const q = new URL(req.url).searchParams;
    const { from, to } = parsePeriod(q.get('from'), q.get('to'));
    if (q.get('format') !== 'csv') return json({ vatReturn: vatReturn(from, to) });
    assertSameOrigin(req);
    enforceLimit(`export:${session.email}`, 20, 10 * 60_000, 'Too many exports at once. Wait a few minutes.');
    auditOrThrow('vat.return_exported', { by: session.email, role: session.role, from, to });
    return new Response(vatReturnCsv(from, to), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="vat-return_${from}_to_${to}.csv"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (err) {
    return handleRouteError(err, 'admin/vat/return');
  }
}
