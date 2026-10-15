import { DEFAULT_THEME_ID, getFestival, type Festival } from './catalog';
import { addDays, daysBetween, isIsoDate } from './dates';

/**
 * Which festival theme the storefront shows today. Pure and browser-safe: the
 * server passes in the dates (see src/lib/server/festivalDates.ts) and the
 * admin's choice.
 *
 * WINDOWS. The shop owner asked for each festival to show from 3 weeks before
 * it starts until 1 week after it ends. That is what tier-1 (major) festivals
 * get. With ~30 festivals for all the UAE's communities, 3-week windows on
 * every one would overlap constantly and the store would change look every
 * few days, so tier-2 festivals deliberately get a shorter window: 7 days
 * before and 2 days after. Solemn days (Good Friday, Commemoration Day) show
 * only on the day itself: a calm page "counting down" to a day of mourning
 * would be wrong.
 *
 * CHOOSING, among the festivals whose window contains today:
 *   1. a solemn day that is happening today, out of respect, over anything;
 *   2. else a festival happening today: lower tier first, then higher priority
 *      (so a tier-2 festival still shows on its own days inside a tier-1
 *      festival's lead or tail, but never during a running tier-1 festival);
 *   3. else lower tier first; then an upcoming festival (nearest first) before
 *      one that has just ended (most recent first); then higher priority.
 * Ramadan flows into Eid al-Fitr: during Ramadan the Ramadan theme shows, but
 * from the last 3 days of Ramadan, Eid al-Fitr is preferred if its lead window
 * has started (it always has, 21 days ahead), so the store is dressed for Eid
 * before the moon is sighted.
 *
 * Days that sit inside a longer festival (`parent`, e.g. Laylat al-Qadr in
 * Ramadan) never take over; they are listed by upcomingFestivals only.
 */

export interface FestivalEvent {
  id: string;
  start: string; // 'YYYY-MM-DD', UAE date
  end: string; // inclusive
}

export type ThemeMode = 'auto' | 'manual' | 'off';

export interface ThemeOverride {
  mode: ThemeMode;
  themeId?: string;
}

export type Phase = 'upcoming' | 'during' | 'after' | 'none';

export interface ThemePick {
  themeId: string;
  festivalId?: string;
  phase: Phase;
  /** Days from today to the festival's first day (negative once it has started). */
  daysToStart?: number;
  reason: string;
}

export const TIER1_LEAD_DAYS = 21;
export const TIER1_TAIL_DAYS = 7;
export const TIER2_LEAD_DAYS = 7;
export const TIER2_TAIL_DAYS = 2;

/** How many days before the start and after the end a festival's theme shows. */
export function festivalWindow(f: Festival): { leadDays: number; tailDays: number } {
  if (f.solemn) return { leadDays: 0, tailDays: 0 };
  return f.tier === 1
    ? { leadDays: TIER1_LEAD_DAYS, tailDays: TIER1_TAIL_DAYS }
    : { leadDays: TIER2_LEAD_DAYS, tailDays: TIER2_TAIL_DAYS };
}

/** Days before the end of Ramadan from which Eid al-Fitr takes over. */
const RAMADAN_HANDOVER_DAYS = 3;

interface Candidate {
  festival: Festival;
  event: FestivalEvent;
  phase: 'upcoming' | 'during' | 'after';
  /** Days to the start (upcoming) or since the end (after); 0 during. */
  distance: number;
}

function phaseOf(today: string, e: FestivalEvent): 'upcoming' | 'during' | 'after' {
  if (today < e.start) return 'upcoming';
  if (today > e.end) return 'after';
  return 'during';
}

function inWindow(today: string, events: FestivalEvent[]): Candidate[] {
  const out: Candidate[] = [];
  for (const event of events) {
    const festival = getFestival(event.id);
    if (!festival || festival.parent) continue;
    if (!isIsoDate(event.start) || !isIsoDate(event.end) || event.end < event.start) continue;
    const { leadDays, tailDays } = festivalWindow(festival);
    if (today < addDays(event.start, -leadDays) || today > addDays(event.end, tailDays)) continue;
    const phase = phaseOf(today, event);
    const distance = phase === 'upcoming' ? daysBetween(today, event.start) : phase === 'after' ? daysBetween(event.end, today) : 0;
    out.push({ festival, event, phase, distance });
  }
  return out;
}

function pick(c: Candidate, today: string, reason: string): ThemePick {
  return { themeId: c.festival.id, festivalId: c.festival.id, phase: c.phase, daysToStart: daysBetween(today, c.event.start), reason };
}

const byTierThenPriority = (a: Candidate, b: Candidate) =>
  a.festival.tier - b.festival.tier || b.festival.priority - a.festival.priority;

export function pickTheme(input: { today: string; events: FestivalEvent[]; override?: ThemeOverride }): ThemePick {
  const { today, events, override } = input;

  if (override?.mode === 'off') return { themeId: DEFAULT_THEME_ID, phase: 'none', reason: 'Festival themes are switched off by the admin.' };
  if (override?.mode === 'manual') {
    const id = override.themeId;
    if (id === DEFAULT_THEME_ID) return { themeId: DEFAULT_THEME_ID, phase: 'none', reason: 'The admin chose the everyday theme.' };
    const f = id ? getFestival(id) : undefined;
    if (f) return { themeId: f.id, festivalId: f.id, phase: 'none', reason: `The admin chose the ${f.name} theme.` };
    return { themeId: DEFAULT_THEME_ID, phase: 'none', reason: 'The admin’s chosen theme is unknown, so the everyday theme shows.' };
  }

  if (!isIsoDate(today)) return { themeId: DEFAULT_THEME_ID, phase: 'none', reason: 'No valid date for today.' };
  const candidates = inWindow(today, events);

  // 1. A solemn day happening today.
  const solemn = candidates.filter((c) => c.phase === 'during' && c.festival.solemn).sort(byTierThenPriority);
  if (solemn.length) return pick(solemn[0], today, `${solemn[0].festival.name} is today; a calm theme out of respect.`);

  // 2. A festival happening today.
  const during = candidates.filter((c) => c.phase === 'during').sort(byTierThenPriority);
  if (during.length) {
    const chosen = during[0];
    if (chosen.festival.id === 'ramadan' && daysBetween(today, chosen.event.end) < RAMADAN_HANDOVER_DAYS) {
      const eid = candidates.find((c) => c.festival.id === 'eid-al-fitr' && c.phase === 'upcoming');
      if (eid) return pick(eid, today, 'The last days of Ramadan: the store is dressed for Eid al-Fitr.');
    }
    return pick(chosen, today, `${chosen.festival.name} is on today.`);
  }

  // 3. In a lead or tail window.
  const rest = candidates.sort(
    (a, b) =>
      a.festival.tier - b.festival.tier ||
      (a.phase === b.phase ? 0 : a.phase === 'upcoming' ? -1 : 1) ||
      a.distance - b.distance ||
      b.festival.priority - a.festival.priority,
  );
  if (rest.length) {
    const c = rest[0];
    return pick(
      c,
      today,
      c.phase === 'upcoming'
        ? `${c.festival.name} starts in ${c.distance} day${c.distance === 1 ? '' : 's'}.`
        : `${c.festival.name} ended ${c.distance} day${c.distance === 1 ? '' : 's'} ago.`,
    );
  }

  return { themeId: DEFAULT_THEME_ID, phase: 'none', reason: 'No festival is near; the everyday theme shows.' };
}

export interface UpcomingFestival {
  id: string;
  name: string;
  tier: 1 | 2;
  start: string;
  end: string;
  /** Negative while it is running. */
  daysToStart: number;
  phase: 'upcoming' | 'during';
  /** First day its theme can show (start minus its lead). */
  themeFrom: string;
  /** Last day its theme can show (end plus its tail). */
  themeUntil: string;
}

/** The next `n` festivals that have not ended yet (running ones first), for the admin. */
export function upcomingFestivals(today: string, events: FestivalEvent[], n = 10): UpcomingFestival[] {
  const out: UpcomingFestival[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    const f = getFestival(e.id);
    if (!f || !isIsoDate(e.start) || !isIsoDate(e.end) || e.end < today) continue;
    const key = `${e.id}@${e.start}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { leadDays, tailDays } = festivalWindow(f);
    out.push({
      id: f.id,
      name: f.name,
      tier: f.tier,
      start: e.start,
      end: e.end,
      daysToStart: daysBetween(today, e.start),
      phase: today < e.start ? 'upcoming' : 'during',
      themeFrom: f.parent ? e.start : addDays(e.start, -leadDays),
      themeUntil: f.parent ? e.end : addDays(e.end, tailDays),
    });
  }
  out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0) || (getFestival(b.id)!.priority - getFestival(a.id)!.priority));
  return out.slice(0, Math.max(0, n));
}
