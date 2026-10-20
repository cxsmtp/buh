import { getFestival } from '@/lib/festivals/catalog';
import { daysBetween } from '@/lib/festivals/dates';
import { stripEmoji } from '@/lib/marquee';
import type { Product } from '@/types';
import { currentFestivalTheme, FESTIVAL_IDS } from './festivalDates';
import { HttpError } from './http';
import { logEvent } from './log';
import { storefrontTheme } from './theme';
import { getSettings } from './settings';

/**
 * Gift lines per festival ("Write from photo" → gift line; the shop's product card and page).
 *
 * A product keeps one short gift line per festival (`giftLines: { [festivalId]: text, everyday? }`,
 * in its JSON like every other field, so backups carry it). The shop shows the line for the
 * festival its theme shows right now (the same pick as the storefront theme: the admin's override
 * and switched-off festivals applied), else the everyday line, else nothing: lines change by
 * themselves as festivals come and go.
 *
 * Which festivals get a line: the one themed now, then the next ones starting within 45 days.
 * Days of remembrance (solemn) and festivals inside another (Laylat al-Qadr in Ramadan) never do.
 */

export const GIFT_LINE_MAX = 160;
export const GIFT_WITHIN_DAYS = 45;
export const EVERYDAY = 'everyday';

export interface GiftFestival {
  id: string;
  name: string;
  start: string;
  end: string;
  /** The festival's own greeting and headline (the theme's mood), as facts for the AI. */
  mood: string;
  /** True for the festival the shop is themed for today. */
  now: boolean;
}

const giftable = (id: string | undefined) => {
  const f = id ? getFestival(id) : undefined;
  return f && !f.solemn && !f.parent ? f : undefined;
};

/**
 * The storefront's pick, with the theme settings the storefront uses: today's is the storefront's
 * own cached one (every catalogue read asks for it); another day's (tests, `now`) is worked out.
 */
function theme(now?: Date) {
  if (!now) return storefrontTheme();
  const s = getSettings('theme');
  return currentFestivalTheme({ mode: s.mode, themeId: s.themeId }, now, s.disabledFestivals);
}

/** The festival the shop is themed for now, if a gift line suits it. */
export function themedFestivalId(now?: Date): string | null {
  try {
    return giftable(theme(now).pick.festivalId)?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * The festivals a gift line can be written for: the one themed now first, then the next ones
 * starting within 45 days (switched-off festivals left out), at most `n`.
 */
export function giftFestivals(now?: Date, n = 4): GiftFestival[] {
  let t: ReturnType<typeof theme>;
  try {
    t = theme(now);
  } catch {
    return [];
  }
  const disabled = new Set(getSettings('theme').disabledFestivals);
  const out: GiftFestival[] = [];
  const add = (id: string, start: string, end: string, isNow: boolean) => {
    const f = giftable(id);
    if (!f || disabled.has(id) || out.some((x) => x.id === id)) return;
    out.push({ id, name: f.name, start, end, mood: `${f.theme.greeting} ${f.theme.headline}`.trim(), now: isNow });
  };
  const current = t.pick.festivalId;
  if (current) {
    const e = t.upcoming.find((u) => u.id === current);
    add(current, e?.start ?? t.today, e?.end ?? t.today, true);
  }
  for (const u of t.upcoming) if (daysBetween(t.today, u.start) <= GIFT_WITHIN_DAYS) add(u.id, u.start, u.end, false);
  return out.slice(0, n);
}

/** What a gift line is written for when the owner hasn't chosen: the themed festival, else the next one, else everyday. */
export function defaultGiftTarget(now?: Date): GiftFestival | null {
  return giftFestivals(now, 1)[0] ?? null;
}

/** One gift line: plain text, one line, no markup or emoji, at most 160 characters. */
export function cleanGiftLine(v: unknown): string {
  if (typeof v !== 'string') return '';
  const s = stripEmoji(v.replace(/<[^>]*>/g, ' ').replace(/[<>{}`*_#]/g, ' ').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2066-\u2069]+/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length <= GIFT_LINE_MAX) return s;
  const cut = s.slice(0, GIFT_LINE_MAX);
  const at = cut.lastIndexOf(' ');
  return (at > GIFT_LINE_MAX / 2 ? cut.slice(0, at) : cut).replace(/[\s,;:–—-]+$/, '').trim();
}

/** A product's gift lines as saved: known festival ids (or "everyday") only, each line cleaned; empty ones dropped. */
export function cleanGiftLines(v: unknown): Record<string, string> | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'Gift lines must be a list by festival.');
  const out: Record<string, string> = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    // A festival a later (or earlier) release renamed or removed: dropped, so the product still saves.
    if (k !== EVERYDAY && !FESTIVAL_IDS.includes(k)) {
      logEvent('warn', 'gift_line_unknown_festival', { festival: k.slice(0, 40) });
      continue;
    }
    if (raw !== undefined && raw !== null && typeof raw !== 'string') throw new HttpError(400, 'A gift line must be text.');
    if (typeof raw === 'string' && raw.trim().length > GIFT_LINE_MAX + 40) throw new HttpError(400, `A gift line: at most ${GIFT_LINE_MAX} characters.`);
    const line = cleanGiftLine(raw);
    if (line) out[k] = line;
  }
  return Object.keys(out).length ? out : undefined;
}

/** The line the shop shows today: the themed festival's, else the everyday one, else none. */
export function giftLineFor(p: Pick<Product, 'giftLines'>, now?: Date): string {
  const lines = p.giftLines;
  if (!lines) return '';
  const id = themedFestivalId(now);
  return (id && lines[id]) || lines[EVERYDAY] || '';
}
