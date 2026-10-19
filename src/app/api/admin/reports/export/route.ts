import fs from 'node:fs';
import { Readable } from 'node:stream';
import { enforceLimit, requireAdmin } from '@/lib/server/guard';
import { assertSameOrigin, handleRouteError } from '@/lib/server/http';
import { logEvent } from '@/lib/server/log';
import { parsePeriod, prepareAccountantExport } from '@/lib/server/reports';
import { getSettings } from '@/lib/server/settings';

/**
 * "Export for my accountant": ?from=YYYY-MM-DD&to=YYYY-MM-DD → one ZIP (sales, order items,
 * refunds, expenses, every bill, the summary, the audit log of the period and its check). Who
 * exported which period is written to the audit log first (if it can't be, there is no export),
 * and a build that then fails is written too. One export at a time (429), refused (507) when the
 * disk is too full. Built on the server's disk one file at a time without holding up the shop,
 * then streamed and removed (src/lib/server/reports.ts: prepareAccountantExport).
 */
export async function GET(req: Request) {
  try {
    const session = await requireAdmin(req);
    // A download link in the hub (same site); refused from anywhere else.
    assertSameOrigin(req);
    enforceLimit(`export:${session.email}`, 20, 10 * 60_000, 'Too many exports at once. Wait a few minutes.');
    const q = new URL(req.url).searchParams;
    const { from, to } = parsePeriod(q.get('from'), q.get('to'));
    const result = await prepareAccountantExport(session.email, from, to, getSettings('brand').storeName || 'Beautiful UAE Home');
    logEvent('info', 'report_exported', { from, to, orders: result.orders, expenses: result.expenses, bills: result.bills });
    let stream: fs.ReadStream;
    let size: number;
    try {
      size = fs.statSync(result.file).size;
      stream = fs.createReadStream(result.file);
    } catch (err) {
      result.release();
      fs.rmSync(result.file, { force: true });
      throw err;
    }
    const finished = () => {
      result.release();
      fs.rm(result.file, { force: true }, () => undefined);
    };
    stream.on('close', finished);
    stream.on('error', finished);
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
