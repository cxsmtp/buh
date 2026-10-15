import { audit } from '@/lib/server/audit';
import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, json, readJsonBody } from '@/lib/server/http';
import { createProduct, listProducts } from '@/lib/server/products';

/** Every product, hidden and archived ones included (archived are marked). */
export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    return json({ products: listProducts({ includeHidden: true, includeArchived: true }) });
  } catch (err) {
    return handleRouteError(err, 'admin/products');
  }
}

export async function POST(req: Request) {
  try {
    const session = await requireAdmin(req);
    // Up to 10 photos as data URLs (each stored as a file, max 3 MB).
    const body = await readJsonBody(req, 12 * 1024 * 1024);
    const product = createProduct(body.product);
    audit('product.created', { by: session.email, productId: product.id, title: product.title });
    return json({ product }, 201);
  } catch (err) {
    return handleRouteError(err, 'admin/products/create');
  }
}
