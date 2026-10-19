import { aiStatus, describeProduct } from '@/lib/server/aiWriting';
import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, json, readJsonBody } from '@/lib/server/http';

/** Whether "Write from photo" can run (the editor explains how to switch it on when not). */
export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    return json(aiStatus());
  } catch (err) {
    return handleRouteError(err, 'admin/products/describe/status');
  }
}

/**
 * "Write from photo": a suggested name, short and full description, colours and weave for a
 * product photo (src/lib/server/aiWriting.ts). Nothing is saved; the editor shows the suggestions.
 * Body: { image: data URL } or { imageId: "<name>" } or { imageUrl: "https://…" }, plus { hints }.
 */
export async function POST(req: Request) {
  try {
    const session = await requireAdmin(req);
    // A phone photo as a data URL (the shop's own uploads are at most 3 MB).
    const body = await readJsonBody(req, 9 * 1024 * 1024);
    const suggestion = await describeProduct(body, session.email);
    return json({ success: true, suggestion });
  } catch (err) {
    return handleRouteError(err, 'admin/products/describe');
  }
}
