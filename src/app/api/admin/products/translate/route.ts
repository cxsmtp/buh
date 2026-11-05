import { translateProduct } from '@/lib/server/aiWriting';
import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, json, readJsonBody } from '@/lib/server/http';

/**
 * "Translate to Arabic" (product editor): the product's English name and descriptions in UAE Arabic,
 * with its photo for context (src/lib/server/aiWriting.ts). Nothing is saved: the owner checks and
 * saves. Body: { imageId | imageUrl | image, title, shortDescription?, description? }.
 */
export async function POST(req: Request) {
  try {
    const session = await requireAdmin(req);
    const body = await readJsonBody(req, 9 * 1024 * 1024);
    return json({ success: true, ...(await translateProduct(body, session.email)) });
  } catch (err) {
    return handleRouteError(err, 'admin/products/translate');
  }
}
