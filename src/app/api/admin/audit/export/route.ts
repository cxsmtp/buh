import { auditOrThrow } from '@/lib/server/audit';
import { enforceLimit, requireAdmin } from '@/lib/server/guard';
import { assertSameOrigin, handleRouteError, HttpError } from '@/lib/server/http';
import { auditEntries, auditExport } from '@/lib/server/auditView';

/**
 * The audit log as shown (the same filters as ./route.ts), as Excel-safe CSV (?format=csv) or the
 * original signed JSON lines (?format=jsonl). Who exported what is written to the log first.
 */
export async function GET(req: Request) {
  try {
    const session = await requireAdmin(req);
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
    const shown = Object.fromEntries(Object.entries(filters).filter(([, v]) => v));
    auditOrThrow('audit.exported', { by: session.email, format, filters: shown });
    const entries = auditEntries(filters);
    const name = `audit-log${filters.from ? `_${filters.from}` : ''}${filters.to ? `_to_${filters.to}` : ''}.${format}`.replace(/[^A-Za-z0-9._-]/g, '');
    return new Response(auditExport(entries, format), {
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
