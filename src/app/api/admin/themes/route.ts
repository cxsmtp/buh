import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, json } from '@/lib/server/http';
import { festivalEventsAround } from '@/lib/server/festivalDates';
import { upcomingFestivals } from '@/lib/festivals/select';
import { getSettings } from '@/lib/server/settings';
import { lastFestivalRefresh, storefrontTheme } from '@/lib/server/theme';

/** For Settings → Themes: what shows today and why, the coming festivals, and the last date refresh. */
export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    const s = getSettings('theme');
    const now = storefrontTheme();
    // The next 12 months of festivals regardless of the override, so the admin sees (and can switch off) any of them.
    const all = { upcoming: upcomingFestivals(now.today, festivalEventsAround(now.today), 60).filter((u) => u.daysToStart <= 366) };
    const refresh = lastFestivalRefresh();
    return json({
      today: now.today,
      pick: now.pick,
      upcoming: all.upcoming.map((u) => ({ ...u, disabled: s.disabledFestivals.includes(u.id) })),
      lastRefresh: refresh ? { at: refresh.fetchedAt, ok: refresh.ok, updated: refresh.updated.length, errors: refresh.errors.slice(0, 10) } : null,
    });
  } catch (err) {
    return handleRouteError(err, 'admin/themes');
  }
}
