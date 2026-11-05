import { requireAdmin } from '@/lib/server/guard';
import { allowFields, handleRouteError, HttpError, json, readJsonBody } from '@/lib/server/http';
import { cancelDeal } from '@/lib/server/photoDeals';

/** Stop a photo deal's link ({ action: 'cancel' }): owner only, audited, idempotent. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAdmin(req);
    const { id } = await params;
    const body = await readJsonBody(req, 256);
    allowFields(body, ['action']);
    if (body.action !== 'cancel') throw new HttpError(400, 'Unknown action.');
    if (!/^DEAL-[A-Z0-9-]{4,40}$/.test(id)) throw new HttpError(404, 'Deal not found.');
    return json({ deal: cancelDeal(id, session.email) });
  } catch (err) {
    return handleRouteError(err, 'admin/deals/cancel');
  }
}
