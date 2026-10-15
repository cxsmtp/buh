import { audit } from '@/lib/server/audit';
import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, json, readJsonBody } from '@/lib/server/http';
import { reorderProducts } from '@/lib/server/products';

/** The order products appear in the shop: { ids: [...] }. */
export async function PUT(req: Request) {
  try {
    const session = await requireAdmin(req);
    const body = await readJsonBody(req, 64 * 1024);
    reorderProducts(body.ids);
    audit('product.reordered', { by: session.email, count: Array.isArray(body.ids) ? body.ids.length : 0 });
    return json({ success: true });
  } catch (err) {
    return handleRouteError(err, 'admin/products/order');
  }
}
