import { audit } from '@/lib/server/audit';
import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, json, readJsonBody } from '@/lib/server/http';
import { updateProduct } from '@/lib/server/products';

/** Change any product fields (price, stock, visibility, photos…). */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAdmin(req);
    const { id } = await params;
    const body = await readJsonBody(req, 12 * 1024 * 1024);
    const product = updateProduct(id, body.product, session.email);
    audit('product.updated', { by: session.email, productId: id, fields: Object.keys((body.product as object) || {}) });
    return json({ product });
  } catch (err) {
    return handleRouteError(err, 'admin/products/update');
  }
}
