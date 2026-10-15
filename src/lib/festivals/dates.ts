/**
 * Calendar-date helpers for festivals. A date is a 'YYYY-MM-DD' string meaning
 * that day in the UAE (Asia/Dubai). Arithmetic is done on UTC midnights so a
 * day is always 24 hours; such strings also sort and compare as text.
 * Browser-safe.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** True for a real calendar date written 'YYYY-MM-DD'. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

export function toUtcMs(date: string): number {
  const m = ISO_DATE.exec(date);
  if (!m) throw new Error(`not a date: ${date}`);
  return Date.UTC(+m[1], +m[2] - 1, +m[3]);
}

export function fromUtcMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return fromUtcMs(toUtcMs(date) + days * DAY_MS);
}

/** Whole days from `a` to `b` (positive when b is later). */
export function daysBetween(a: string, b: string): number {
  return Math.round((toUtcMs(b) - toUtcMs(a)) / DAY_MS);
}

const DUBAI = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai', year: 'numeric', month: '2-digit', day: '2-digit' });

/** The calendar date in the UAE at this instant. */
export function dubaiDate(at: Date = new Date()): string {
  const parts = Object.fromEntries(DUBAI.formatToParts(at).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
