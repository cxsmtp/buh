import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, json, readJsonBody } from '@/lib/server/http';
import { addStyledPhotos } from '@/lib/server/stagePhoto';

/**
 * The Picture studio (Inventory → Make pictures): { urls: ["/api/images/<name>", …] } of styled
 * photos made for this product, added to its photos right after the one each was made from. Owner
 * only. Sending the same photo twice adds it once; what doesn't fit (8 photos) comes back in "full".
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAdmin(req);
    const { id } = await params;
    const body = await readJsonBody(req, 2 * 1024);
    return json({ success: true, ...addStyledPhotos(id, body, session.email) });
  } catch (err) {
    return handleRouteError(err, 'admin/products/styled-photos');
  }
}
