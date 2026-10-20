import { writeGiftLines } from '@/lib/server/aiWriting';
import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, json, readJsonBody } from '@/lib/server/http';

/**
 * "Write gift lines for the next festivals" (product editor): one AI call for the next festivals in
 * the calendar (up to 3, switched-off ones left out) and an everyday line (src/lib/server/aiWriting.ts).
 * Nothing is saved: the editor shows them for the owner to edit and save with the product.
 * Body: { image: data URL } or { imageId } or { imageUrl }, plus { hints?, title? }.
 */
export async function POST(req: Request) {
  try {
    const session = await requireAdmin(req);
    const body = await readJsonBody(req, 9 * 1024 * 1024);
    const result = await writeGiftLines(body, session.email);
    return json({ success: true, ...result });
  } catch (err) {
    return handleRouteError(err, 'admin/products/gift-lines');
  }
}
