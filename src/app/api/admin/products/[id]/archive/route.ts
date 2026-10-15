import { audit } from '@/lib/server/audit';
import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, HttpError, json, readJsonBody } from '@/lib/server/http';
import { setArchived } from '@/lib/server/products';

/** Remove a product from the shop ({ archived: true }) or bring it back hidden ({ archived: false }). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAdmin(req);
    const { id } = await params;
    const body = await readJsonBody(req, 256);
    if (typeof body.archived !== 'boolean') throw new HttpError(400, 'Give archived: true or false.');
    const product = setArchived(id, body.archived);
    audit(body.archived ? 'product.archived' : 'product.restored', { by: session.email, productId: id, title: product.title });
    return json({ product });
  } catch (err) {
    return handleRouteError(err, 'admin/products/archive');
  }
}
