import { requireAdmin } from '@/lib/server/guard';
import { allowFields, handleRouteError, json, readJsonBody, str } from '@/lib/server/http';
import { updateProduct } from '@/lib/server/products';

/**
 * Settings → Search (SEO) → a product's own title and description for Google (empty: made by the
 * shop). Body { id, seoTitle, seoDescription }. Saved like any product change (audited). Owner only.
 */
export async function PUT(req: Request) {
  try {
    const session = await requireAdmin(req);
    const body = await readJsonBody(req, 8 * 1024);
    allowFields(body, ['id', 'seoTitle', 'seoDescription']);
    const id = str(body.id, 'Product', 80);
    const product = updateProduct(id, { seoTitle: body.seoTitle ?? '', seoDescription: body.seoDescription ?? '' }, session.email);
    return json({ success: true, product: { id: product.id, seoTitle: product.seoTitle ?? '', seoDescription: product.seoDescription ?? '' } });
  } catch (err) {
    return handleRouteError(err, 'admin/seo/product');
  }
}
