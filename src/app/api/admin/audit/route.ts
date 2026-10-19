import { requireReader } from '@/lib/server/guard';
import { handleRouteError, json } from '@/lib/server/http';
import { auditPage, verificationText } from '@/lib/server/auditView';

/**
 * Money → Audit log (read-only): ?from&to (UAE dates), action (a prefix such as "payment."), who,
 * order (an order or expense number), page. Newest first, 50 a page, with the chain check of every
 * month ("The log is intact", or where it breaks). The entries are redacted when written.
 */
export async function GET(req: Request) {
  try {
    await requireReader(req);
    const q = new URL(req.url).searchParams;
    const page = auditPage({
      from: q.get('from') ?? undefined,
      to: q.get('to') ?? undefined,
      action: q.get('action') ?? undefined,
      who: q.get('who') ?? undefined,
      order: q.get('order') ?? undefined,
      page: Number(q.get('page')) || 1,
    });
    return json({ ...page, verificationText: verificationText(page.verification) });
  } catch (err) {
    return handleRouteError(err, 'admin/audit');
  }
}
