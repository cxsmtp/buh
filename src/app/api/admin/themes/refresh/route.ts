import { audit } from '@/lib/server/audit';
import { refreshFestivalDates } from '@/lib/server/festivalDates';
import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, json } from '@/lib/server/http';
import { invalidateTheme } from '@/lib/server/theme';

/** "Refresh dates now": download the public holiday calendars again. */
export async function POST(req: Request) {
  try {
    const session = await requireAdmin(req);
    const result = await refreshFestivalDates();
    invalidateTheme();
    audit('festival.dates_refreshed', { by: session.email, ok: result.ok, updated: result.updated.length, errors: result.errors.length });
    return json({ ok: result.ok, updated: result.updated, errors: result.errors.slice(0, 10) });
  } catch (err) {
    return handleRouteError(err, 'admin/themes/refresh');
  }
}
