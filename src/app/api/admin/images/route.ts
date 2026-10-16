import { audit } from '@/lib/server/audit';
import { requireAdmin } from '@/lib/server/guard';
import { allowFields, handleRouteError, json, readJsonBody } from '@/lib/server/http';
import { saveImageDataUrl } from '@/lib/server/images';

/**
 * Upload one product photo: { image: "data:image/jpeg;base64,…" }, already shrunk on the
 * phone. Checked like every other image (PNG, JPEG or WebP by its real bytes, at most 3 MB)
 * and stored by its hash; the answer is its URL, which a product or a draft then uses.
 */
export async function POST(req: Request) {
  try {
    const session = await requireAdmin(req);
    const body = await readJsonBody(req, Math.ceil(4.2 * 1024 * 1024));
    allowFields(body, ['image']);
    const url = saveImageDataUrl(typeof body.image === 'string' ? body.image : '');
    audit('image.uploaded', { by: session.email, url });
    return json({ url }, 201);
  } catch (err) {
    return handleRouteError(err, 'admin/images');
  }
}
