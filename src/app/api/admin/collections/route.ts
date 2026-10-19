import { createCollection, listCollections } from '@/lib/server/collections';
import { requireAdmin } from '@/lib/server/guard';
import { allowFields, handleRouteError, json, readJsonBody } from '@/lib/server/http';

/** The shared selections (/c/<slug>), newest first, with their view and add-to-bag counters. */
export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    return json({ collections: listCollections() });
  } catch (err) {
    return handleRouteError(err, 'admin/collections');
  }
}

/** A new selection: { key, title, productIds, expiresOn? }. The same key again returns the first one. */
export async function POST(req: Request) {
  try {
    const session = await requireAdmin(req);
    const body = await readJsonBody(req, 16 * 1024);
    allowFields(body, ['key', 'title', 'productIds', 'expiresOn']);
    const { collection, replayed } = createCollection(body, session.email);
    return json({ collection, replayed }, replayed ? 200 : 201);
  } catch (err) {
    return handleRouteError(err, 'admin/collections/create');
  }
}
