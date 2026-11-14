import { audit } from '@/lib/server/audit';
import { requireAdmin } from '@/lib/server/guard';
import { allowFields, handleRouteError, json, readJsonBody } from '@/lib/server/http';
import { reorderProducts, swapProducts } from '@/lib/server/products';

/** The order products appear in the shop: { ids: [...] } (the whole order), or { swap: [a, b] } (two products change places). */
export async function PUT(req: Request) {
  try {
    const session = await requireAdmin(req);
    const body = await readJsonBody(req, 64 * 1024);
    allowFields(body, ['ids', 'swap']);
    if (body.swap !== undefined) {
      const pair = Array.isArray(body.swap) && body.swap.length === 2 ? body.swap : [];
      swapProducts(pair[0], pair[1]);
      audit('product.reordered', { by: session.email, swapped: pair.map((x: unknown) => String(x).slice(0, 60)) });
      return json({ success: true });
    }
    reorderProducts(body.ids);
    audit('product.reordered', { by: session.email, count: Array.isArray(body.ids) ? body.ids.length : 0 });
    return json({ success: true });
  } catch (err) {
    return handleRouteError(err, 'admin/products/order');
  }
}
