import { requireAdmin } from '@/lib/server/guard';
import { allowFields, handleRouteError, json, readJsonBody } from '@/lib/server/http';
import { fillMissingSkus, productsWithoutSku } from '@/lib/server/products';

/**
 * Inventory → "Fill them in": an SKU for every product that has none (one audited step; SKUs
 * already there are never changed, and pressing it again does nothing). GET: how many have none.
 */
export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    return json({ missing: productsWithoutSku().length });
  } catch (err) {
    return handleRouteError(err, 'admin/products/sku-fill');
  }
}

export async function POST(req: Request) {
  try {
    const session = await requireAdmin(req);
    allowFields(await readJsonBody(req, 1024), []);
    const filled = fillMissingSkus(session.email);
    return json({ success: true, filled: filled.length, products: filled });
  } catch (err) {
    return handleRouteError(err, 'admin/products/sku-fill');
  }
}
