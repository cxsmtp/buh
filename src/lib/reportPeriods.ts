/**
 * Report periods for the accountant, as UAE calendar dates (Asia/Dubai, UTC+4 all year): a month,
 * a quarter or a financial year (the calendar year unless the owner set another start month), or
 * any dates. Used by the hub (to fill the dates) and the server (which checks them again).
 */

export interface ReportPeriod {
  from: string;
  to: string;
  label: string;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const MONTH_NAMES = MONTHS;

const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Today in the UAE (YYYY-MM-DD). */
export function dubaiToday(now = Date.now()): string {
  return new Date(now + 4 * 3600_000).toISOString().slice(0, 10);
}

/** The UAE date of a moment (an ISO time). */
export function dubaiDateOf(iso: string): string {
  return new Date(Date.parse(iso) + 4 * 3600_000).toISOString().slice(0, 10);
}

/** month: 1–12. */
export function monthPeriod(year: number, month: number): ReportPeriod {
  return { from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month)}-${pad(lastDay(year, month))}`, label: `${MONTHS[month - 1]} ${year}` };
}

/** Months from a start (1–12) in a year, n months long (may run into the next year). */
function span(year: number, startMonth: number, months: number): { from: string; to: string } {
  const endIndex = startMonth - 1 + months - 1;
  const endYear = year + Math.floor(endIndex / 12);
  const endMonth = (endIndex % 12) + 1;
  return { from: `${year}-${pad(startMonth)}-01`, to: `${endYear}-${pad(endMonth)}-${pad(lastDay(endYear, endMonth))}` };
}

/** The financial year that starts in `startYear` (FY 2026, or FY 2026–27 when it doesn't start in January). */
export function financialYear(startYear: number, yearStartMonth = 1): ReportPeriod {
  const { from, to } = span(startYear, yearStartMonth, 12);
  return { from, to, label: yearStartMonth === 1 ? `FY ${startYear}` : `FY ${startYear}–${String(startYear + 1).slice(2)}` };
}

/** Quarter q (1–4) of the financial year starting in `startYear`. */
export function quarterPeriod(startYear: number, q: number, yearStartMonth = 1): ReportPeriod {
  const first = yearStartMonth - 1 + (q - 1) * 3;
  const year = startYear + Math.floor(first / 12);
  const { from, to } = span(year, (first % 12) + 1, 3);
  return { from, to, label: `Q${q} ${financialYear(startYear, yearStartMonth).label}` };
}

/** The financial year (its start year) a date falls in. */
export function financialYearOf(date: string, yearStartMonth = 1): number {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  return m >= yearStartMonth ? y : y - 1;
}

/** The month, quarter or financial year containing a date. */
export function periodContaining(kind: 'month' | 'quarter' | 'year', date: string, yearStartMonth = 1): ReportPeriod {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  if (kind === 'month') return monthPeriod(y, m);
  const fy = financialYearOf(date, yearStartMonth);
  if (kind === 'year') return financialYear(fy, yearStartMonth);
  const monthsIn = (m - yearStartMonth + 12) % 12;
  return quarterPeriod(fy, Math.floor(monthsIn / 3) + 1, yearStartMonth);
}

/** The 12 months ending on a date (inclusive): the window for the VAT registration threshold. */
export function twelveMonthsTo(date: string): { from: string; to: string } {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  // The same day a year earlier, plus one (29 February falls back to the 28th).
  const back = new Date(Date.UTC(y - 1, m - 1, Math.min(d, lastDay(y - 1, m)) + 1));
  return { from: back.toISOString().slice(0, 10), to: date };
}
