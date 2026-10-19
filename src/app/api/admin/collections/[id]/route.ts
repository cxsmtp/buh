import { deleteCollection, updateCollection } from '@/lib/server/collections';
import { requireAdmin } from '@/lib/server/guard';
import { allowFields, handleRouteError, json, readJsonBody } from '@/lib/server/http';

type Ctx = { params: Promise<{ id: string }> };

/** Rename, change the products or the last day: { title?, productIds?, expiresOn? } (the link stays the same). */
export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const session = await requireAdmin(req);
    const { id } = await params;
    const body = await readJsonBody(req, 16 * 1024);
    allowFields(body, ['title', 'productIds', 'expiresOn']);
    return json({ collection: updateCollection(id, body, session.email) });
  } catch (err) {
    return handleRouteError(err, 'admin/collections/update');
  }
}

/** Delete a selection: its link then shows the shop's "not available" page. */
export async function DELETE(req: Request, { params }: Ctx) {
  try {
    const session = await requireAdmin(req);
    const { id } = await params;
    deleteCollection(id, session.email);
    return json({ ok: true });
  } catch (err) {
    return handleRouteError(err, 'admin/collections/delete');
  }
}
