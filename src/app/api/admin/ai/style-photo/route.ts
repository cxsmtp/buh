import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, json, readJsonBody } from '@/lib/server/http';
import { uploadStylePhoto } from '@/lib/server/stagePhoto';

/**
 * Settings → AI pictures → style photos ("Make them look like these"): { image: data URL }, shrunk
 * to about 1,024 px in the hub. Owner only. Checked, its metadata (EXIF, GPS) taken out, at most
 * 1.5 MB and 2,048 px, stored; the answer is its address, which the owner then saves in the list.
 */
export async function POST(req: Request) {
  try {
    const session = await requireAdmin(req);
    // 1.5 MB as base64 adds a third.
    const body = await readJsonBody(req, Math.ceil(2.1 * 1024 * 1024));
    return json({ success: true, ...uploadStylePhoto(body, session.email) }, 201);
  } catch (err) {
    return handleRouteError(err, 'admin/ai/style-photo');
  }
}
