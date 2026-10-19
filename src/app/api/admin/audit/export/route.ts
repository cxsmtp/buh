import { enforceLimit, requireReader } from '@/lib/server/guard';
import { assertSameOrigin, handleRouteError, HttpError } from '@/lib/server/http';
import { auditExportStream } from '@/lib/server/auditView';

/**
 * The audit log as shown (the same filters as ./route.ts), as Excel-safe CSV (?format=csv) or the
 * original signed JSON lines (?format=jsonl). Who exported what is written to the log first; it is
 * streamed, one export at a time (429 otherwise), and a failure half-way is written to the log too
 * (src/lib/server/auditView.ts: auditExportStream).
 */
export async function GET(req: Request) {
  try {
    const session = await requireReader(req);
    assertSameOrigin(req);
    enforceLimit(`export:${session.email}`, 20, 10 * 60_000, 'Too many exports at once. Wait a few minutes.');
    const q = new URL(req.url).searchParams;
    const format = q.get('format');
    if (format !== 'csv' && format !== 'jsonl') throw new HttpError(400, 'format must be csv or jsonl.');
    const filters = {
      from: q.get('from') ?? undefined,
      to: q.get('to') ?? undefined,
      action: q.get('action') ?? undefined,
      who: q.get('who') ?? undefined,
      order: q.get('order') ?? undefined,
    };
    const body = auditExportStream(session.email, format, filters);
    const name = `audit-log${filters.from ? `_${filters.from}` : ''}${filters.to ? `_to_${filters.to}` : ''}.${format}`.replace(/[^A-Za-z0-9._-]/g, '');
    return new Response(body, {
      headers: {
        'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
        'Content-Disposition': `attachment; filename="${name}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (err) {
    return handleRouteError(err, 'admin/audit/export');
  }
}
