import { audit } from '@/lib/server/audit';
import { requireAdmin } from '@/lib/server/guard';
import { allowFields, handleRouteError, json, readJsonBody } from '@/lib/server/http';
import { deleteDraft, getDraft, saveDraft } from '@/lib/server/productDrafts';

/** The product editor's saved draft ('new', or a product id): { draft } or { draft: null }. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin(req);
    const { id } = await params;
    return json({ draft: getDraft(id) });
  } catch (err) {
    return handleRouteError(err, 'admin/products/drafts/get');
  }
}

/** Save the draft as the owner types: { draft: {...} } (photos already uploaded, at most 64 KB). */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAdmin(req);
    const { id } = await params;
    const body = await readJsonBody(req, 80 * 1024);
    allowFields(body, ['draft']);
    const draft = saveDraft(id, body.draft, session.email);
    return json({ updatedAt: draft.updatedAt });
  } catch (err) {
    return handleRouteError(err, 'admin/products/drafts/save');
  }
}

/** Throw the draft away (after publishing, or "Start over"). */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAdmin(req);
    const { id } = await params;
    deleteDraft(id);
    audit('product.draft_discarded', { by: session.email, productId: id.slice(0, 40) });
    return json({ success: true });
  } catch (err) {
    return handleRouteError(err, 'admin/products/drafts/delete');
  }
}
