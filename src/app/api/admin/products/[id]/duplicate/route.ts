import { requireAdmin } from '@/lib/server/guard';
import { allowFields, handleRouteError, json, readJsonBody, str } from '@/lib/server/http';
import { duplicateProduct } from '@/lib/server/products';

/** Copy a product for a colour variant: { key }. Hidden, no stock; the same key returns the same copy. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAdmin(req);
    const { id } = await params;
    const body = await readJsonBody(req, 512);
    allowFields(body, ['key']);
    const { product, replayed } = duplicateProduct(id, str(body.key, 'key', 80), session.email);
    return json({ product, replayed }, replayed ? 200 : 201);
  } catch (err) {
    return handleRouteError(err, 'admin/products/duplicate');
  }
}
