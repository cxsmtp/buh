import { clearLinkNotice } from '@/lib/server/adminLink';
import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, json } from '@/lib/server/http';

/** "I've bookmarked it": the hub stops showing the admin link notice. */
export async function DELETE(req: Request) {
  try {
    await requireAdmin(req);
    clearLinkNotice();
    return json({ success: true });
  } catch (err) {
    return handleRouteError(err, 'admin/link/notice');
  }
}
