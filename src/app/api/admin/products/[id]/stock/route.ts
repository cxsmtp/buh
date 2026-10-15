import { audit } from '@/lib/server/audit';
import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, HttpError, json, readJsonBody } from '@/lib/server/http';
import { adjustStock } from '@/lib/server/products';

/** Add or remove pieces of one size: { sizeId, delta } (the + / − buttons). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAdmin(req);
    const { id } = await params;
    const body = await readJsonBody(req, 1024);
    if (typeof body.sizeId !== 'string' || typeof body.delta !== 'number') throw new HttpError(400, 'Give sizeId and delta.');
    const product = adjustStock(id, body.sizeId, body.delta);
    audit('product.stock_adjusted', { by: session.email, productId: id, sizeId: body.sizeId, delta: body.delta, now: product.stockBySize[body.sizeId] });
    return json({ product });
  } catch (err) {
    return handleRouteError(err, 'admin/products/stock');
  }
}
