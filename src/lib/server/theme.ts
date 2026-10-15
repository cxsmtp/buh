import { currentFestivalTheme, lastFestivalRefresh, maybeRefreshFestivalDates, type CurrentFestivalTheme } from './festivalDates';
import { logEvent } from './log';
import { getSettings } from './settings';

/**
 * Today's storefront theme, with the admin's choice applied (Settings →
 * Themes). Worked out at most every 10 minutes (and again after the settings
 * change), since every page asks for it. Festival dates are refreshed from the
 * internet once a week by startFestivalRefresh.
 */

let cached: { key: string; at: number; value: CurrentFestivalTheme } | null = null;

export function storefrontTheme(now = new Date()): CurrentFestivalTheme {
  const s = getSettings('theme');
  const key = JSON.stringify([s.mode, s.themeId, s.disabledFestivals, now.toISOString().slice(0, 10)]);
  if (cached && cached.key === key && now.getTime() - cached.at < 10 * 60_000) return cached.value;
  const value = currentFestivalTheme({ mode: s.mode, themeId: s.themeId }, now, s.disabledFestivals);
  cached = { key, at: now.getTime(), value };
  return value;
}

/** Forget the cached pick (after new dates arrive). */
export function invalidateTheme() {
  cached = null;
}

let timer: NodeJS.Timeout | null = null;

/** Check daily; refresh the dates when the last refresh is a week old. Never throws. */
export function startFestivalRefresh() {
  if (timer || process.env.FESTIVAL_REFRESH_DISABLED === 'true') return;
  const tick = () =>
    void maybeRefreshFestivalDates()
      .then((r) => {
        if (r) invalidateTheme();
      })
      .catch((err) => logEvent('warn', 'festival_refresh_failed', { error: err instanceof Error ? err.message : String(err) }));
  setTimeout(tick, 90_000).unref();
  timer = setInterval(tick, 24 * 3600_000);
  timer.unref();
}

export { lastFestivalRefresh };
