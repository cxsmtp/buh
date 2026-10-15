import { requireAdmin } from '@/lib/server/guard';
import { clientIp, handleRouteError } from '@/lib/server/http';
import { eventStream } from '@/lib/server/live';

/** Live updates for the admin hub: new and changed orders too. */
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    return eventStream(req, ['catalog', 'settings', 'orders', 'chats'], `admin:${clientIp(req) ?? 'unknown'}`);
  } catch (err) {
    return handleRouteError(err, 'admin/events');
  }
}
