import { requireAdmin } from '@/lib/server/guard';
import { allowFields, handleRouteError, HttpError, json, readJsonBody, str } from '@/lib/server/http';
import { getSettings } from '@/lib/server/settings';
import { peekSkuNumber, skuPrefix, suggestSku } from '@/lib/server/sku';

/**
 * The SKU the shop would give a product now (product editor, as the owner types the name): nothing
 * is taken or saved. Body: { title, category, productId? }. The save itself has the last word.
 */
export async function POST(req: Request) {
  try {
    await requireAdmin(req);
    const body = await readJsonBody(req, 4 * 1024);
    allowFields(body, ['title', 'category', 'productId']);
    const title = str(body.title, 'Title', 160, { required: false });
    const category = str(body.category, 'Category', 40);
    if (!getSettings('catalog').categories.some((c) => c.id === category)) throw new HttpError(400, 'Unknown category.');
    const productId = str(body.productId, 'Product', 80, { required: false });
    return json({ sku: suggestSku(title, category, productId), prefix: skuPrefix(), next: peekSkuNumber() });
  } catch (err) {
    return handleRouteError(err, 'admin/products/sku-suggest');
  }
}
