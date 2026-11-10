import { requireAdmin } from '@/lib/server/guard';
import { allowFields, handleRouteError, HttpError, json, readJsonBody } from '@/lib/server/http';
import { cancelDeal, updateDeal } from '@/lib/server/photoDeals';
import { siteUrl } from '@/lib/server/siteUrl';

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

/**
 * Edit a photo deal until it is ordered: { note?, forWhom?, pieces?, amount?, payments?, days?,
 * keep?, photos? } (allow-listed in updateDeal). Owner only, audited; the link stays the same.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAdmin(req);
    const { id } = await params;
    if (!/^DEAL-[A-Z0-9-]{4,40}$/.test(id)) throw new HttpError(404, 'Deal not found.');
    // Up to 12 new pictures, resized in the browser (about 0.8 MB each as text).
    const body = await readJsonBody(req, 11 * 1024 * 1024);
    const deal = updateDeal(id, body, session.email);
    const base = await siteUrl();
    return json({ deal: deal.link ? { ...deal, url: `${base}${deal.link}` } : deal });
  } catch (err) {
    return handleRouteError(err, 'admin/deals/update');
  }
}
