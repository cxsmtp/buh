import { countCollectionEvent } from '@/lib/server/collections';
import { enforceIpLimit, enforceLimit } from '@/lib/server/guard';
import { allowFields, assertSameOrigin, handleRouteError, HttpError, json, readJsonBody } from '@/lib/server/http';

/**
 * A shared selection's two counters: { kind: 'view' } once per visit, { kind: 'bag' } for each add to
 * bag. Public, so: from the shop's own pages only, a tiny body, and limited per address and overall.
 * Nothing about the visitor is stored.
 */
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    assertSameOrigin(req);
    // Only the shop's own pages count: a browser always sends Origin (or Referer) on this POST.
    if (!req.headers.get('origin') && !req.headers.get('referer')) throw new HttpError(403, 'Not allowed.');
    const body = await readJsonBody(req, 256);
    allowFields(body, ['kind']);
    if (body.kind !== 'view' && body.kind !== 'bag') throw new HttpError(400, 'kind must be view or bag.');
    enforceIpLimit(req, 'collection-count', 60, 10 * 60 * 1000, 'Too many requests.');
    enforceLimit('global:collection-count', 300, 60 * 1000, 'Too many requests.');
    const { slug } = await params;
    enforceLimit(`collection-count:${slug.slice(0, 80)}`, 120, 60 * 1000, 'Too many requests.');
    return json({ counted: countCollectionEvent(slug, body.kind) });
  } catch (err) {
    return handleRouteError(err, 'collections/count');
  }
}
