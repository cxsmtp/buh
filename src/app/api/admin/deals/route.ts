import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, json, readJsonBody } from '@/lib/server/http';
import { createDeal, listDeals } from '@/lib/server/photoDeals';
import { siteUrl } from '@/lib/server/siteUrl';

/**
 * Photo deals (src/lib/server/photoDeals.ts): the owner's pictures, fixed price (delivery
 * included) and allowed payments behind a private link to send on WhatsApp. GET lists the latest
 * (with each open one's link); POST makes one. Owner only; the body is size-capped and allow-listed.
 */
export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    const base = await siteUrl();
    return json({ deals: listDeals().map((d) => (d.link ? { ...d, url: `${base}${d.link}` } : d)) });
  } catch (err) {
    return handleRouteError(err, 'admin/deals');
  }
}

export async function POST(req: Request) {
  try {
    const session = await requireAdmin(req);
    // Up to 12 pictures, resized in the browser (about 0.8 MB each as text).
    const body = await readJsonBody(req, 11 * 1024 * 1024);
    const deal = createDeal(body, session.email);
    const base = await siteUrl();
    return json({ deal: deal.link ? { ...deal, url: `${base}${deal.link}` } : deal }, 201);
  } catch (err) {
    return handleRouteError(err, 'admin/deals');
  }
}
