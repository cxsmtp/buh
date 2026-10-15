import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, json } from '@/lib/server/http';
import { currentProblems, diskSpace } from '@/lib/server/monitor';

/** For Settings → System: what needs attention, and disk space. */
export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    return json({ problems: currentProblems(), disk: diskSpace(), version: process.env.NEXT_PUBLIC_APP_VERSION ?? '' });
  } catch (err) {
    return handleRouteError(err, 'admin/health');
  }
}
