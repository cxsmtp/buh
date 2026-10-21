import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, json, readJsonBody } from '@/lib/server/http';
import { editWhileWorking } from '@/lib/server/autoAdd';
import { getProduct, updateProduct } from '@/lib/server/products';

/** Change any product fields (price, stock, visibility, photos…). */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAdmin(req);
    const { id } = await params;
    const body = await readJsonBody(req, 12 * 1024 * 1024);
    // A product the AI is still making (quick add): only show or hide is taken (src/lib/server/autoAdd.ts).
    if (editWhileWorking(id, body.product) === 'kept') return json({ product: getProduct(id) });
    // Audited (price and the rest, before → after) inside updateProduct, before it is saved.
    const product = updateProduct(id, body.product, session.email);
    return json({ product });
  } catch (err) {
    return handleRouteError(err, 'admin/products/update');
  }
}
