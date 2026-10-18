import fs from 'node:fs';
import { Readable } from 'node:stream';
import { auditOrThrow } from '@/lib/server/audit';
import { enforceLimit, requireAdmin } from '@/lib/server/guard';
import { assertSameOrigin, handleRouteError } from '@/lib/server/http';
import { logEvent } from '@/lib/server/log';
import { parsePeriod, writeAccountantZip } from '@/lib/server/reports';
import { getSettings } from '@/lib/server/settings';

/**
 * "Export for my accountant": ?from=YYYY-MM-DD&to=YYYY-MM-DD → one ZIP (sales, order items,
 * expenses, every bill, the summary, the audit log of the period and its check). Who exported which
 * period is written to the audit log first (if it can't be, there is no export). Built on the
 * server's disk one file at a time and streamed, then removed.
 */
export async function GET(req: Request) {
  try {
    const session = await requireAdmin(req);
    // A download link in the hub (same site); refused from anywhere else.
    assertSameOrigin(req);
    enforceLimit(`export:${session.email}`, 20, 10 * 60_000, 'Too many exports at once. Wait a few minutes.');
    const q = new URL(req.url).searchParams;
    const { from, to } = parsePeriod(q.get('from'), q.get('to'));
    auditOrThrow('report.exported', { by: session.email, from, to, what: 'accountant zip' });
    const shop = getSettings('brand').storeName || 'Beautiful UAE Home';
    const result = writeAccountantZip(from, to, shop);
    logEvent('info', 'report_exported', { from, to, orders: result.orders, expenses: result.expenses, bills: result.bills });
    const size = fs.statSync(result.file).size;
    const stream = fs.createReadStream(result.file);
    const done = () => fs.rm(result.file, { force: true }, () => undefined);
    stream.on('close', done);
    stream.on('error', done);
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Length': String(size),
        'Content-Disposition': `attachment; filename="${result.name}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (err) {
    return handleRouteError(err, 'admin/reports/export');
  }
}
