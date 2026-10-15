import type Database from 'better-sqlite3';
import { DEFAULT_THEME, FESTIVALS, getFestival, themeFor, type FestivalTheme } from '@/lib/festivals/catalog';
import { addDays, daysBetween, dubaiDate, isIsoDate } from '@/lib/festivals/dates';
import { pickTheme, upcomingFestivals, type FestivalEvent, type ThemeOverride, type ThemePick, type UpcomingFestival } from '@/lib/festivals/select';
import { getDb } from './db';
import { logEvent } from './log';

/**
 * When each festival falls, as UAE calendar dates ('YYYY-MM-DD', Asia/Dubai).
 *
 * Two layers:
 *  1. OFFLINE, always available: Islamic dates from the Umm al-Qura calendar
 *     built into Intl, Lunar New Year from Intl's Chinese calendar, Nowruz
 *     from the Persian calendar, Easter by
 *     the Gregorian and Julian computus, fixed dates for the rest, and a
 *     researched table (2026–2032) for the Hindu and Sikh lunisolar festivals.
 *  2. FETCHED, refreshed from Google's public holiday calendars (iCalendar, no
 *     key). A fetched date replaces the offline one only if it lies within
 *     ±15 days of it, which catches a wrong keyword match. UAE official dates
 *     are applied last, so they win for the Islamic festivals.
 *
 * Storage: two small tables (migration 3 in db.ts) in shop.db, so backups
 * include them.
 */

type DB = Database.Database;

export interface CalendarEntry {
  id: string;
  /** Gregorian year of the first day. */
  year: number;
  start: string;
  /** Inclusive. */
  end: string;
  /** 'offline' or the feed it came from, e.g. 'google:islamic'. */
  source: string;
}

// ---------------------------------------------------------------------------
// Offline computation
// ---------------------------------------------------------------------------

function utcNoon(date: string): Date {
  return new Date(`${date}T12:00:00Z`);
}

function partsFormatter(calendar: string, month: 'numeric' | 'long') {
  const fmt = new Intl.DateTimeFormat(`en-u-ca-${calendar}`, { timeZone: 'UTC', month, day: 'numeric' });
  return (date: string): { month: string; day: number } => {
    let m = '';
    let d = 0;
    for (const p of fmt.formatToParts(utcNoon(date))) {
      if (p.type === 'month') m = p.value;
      else if (p.type === 'day') d = Number(p.value);
    }
    return { month: m, day: d };
  };
}

// Month numbers: Islamic 1 Muharram … 3 Rabi al-Awwal, 7 Rajab, 9 Ramadan,
// 10 Shawwal, 12 Dhu al-Hijjah. Chinese leap months come back as e.g. '6bis'.
const islamicDay = partsFormatter('islamic-umalqura', 'numeric');
const chineseDay = partsFormatter('chinese', 'numeric');
const persianDay = partsFormatter('persian', 'numeric');

/**
 * First day of `year` on which `test` holds. (An Islamic date can fall twice
 * in one Gregorian year, about once every 33 years; the first one is kept.)
 */
function firstDayOfYear(year: number, test: (date: string) => boolean): string | undefined {
  for (let d = `${year}-01-01`; d.startsWith(`${year}-`); d = addDays(d, 1)) if (test(d)) return d;
  return undefined;
}

function islamic(year: number, month: number, day: number): string | undefined {
  return firstDayOfYear(year, (d) => {
    const x = islamicDay(d);
    return x.day === day && x.month === String(month);
  });
}

/** Easter Sunday, Gregorian calendar (anonymous Gregorian computus). */
export function westernEaster(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Orthodox Easter Sunday (Julian computus), as a Gregorian date. Valid 1900–2099. */
export function orthodoxEaster(year: number): string {
  const a = year % 4;
  const b = year % 7;
  const c = year % 19;
  const d = (19 * c + 15) % 30;
  const e = (2 * a + 4 * b - d + 34) % 7;
  const month = Math.floor((d + e + 114) / 31);
  const day = ((d + e + 114) % 31) + 1;
  const julian = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return addDays(julian, 13); // Julian -> Gregorian, 1900–2099
}

/**
 * Hindu and Sikh lunisolar festivals: a built-in FALLBACK table, replaced by
 * the fetched calendar whenever it is available. Dates are the main day as
 * observed in India (New Delhi panchang); `startOffset` turns it into the
 * first day of the shop's window.
 *
 * Researched October 2026 by web search (the reference sites themselves were
 * not reachable from the build machine, so each year was cross-checked against
 * several listings and against the lunar phase / tithi):
 *  - Diwali (Lakshmi Puja): drikpanchang.com/diwali, publicholidays.com/diwali,
 *    universaltimedate.com/holidays/diwali, astrosage panchang (2031: 14 Nov, New Delhi),
 *    drikpanchang Diwali muhurat 2032.
 *  - Holi (Holika Dahan, the evening before Rangwali Holi): dekhopanchang.com
 *    festivals/holi, universaltimedate.com/holidays/holi, calendar.uga.edu, when-is.com
 *    (2026: Holika Dahan 3 Mar, colours 4 Mar after the lunar eclipse; 2032 from the
 *    Phalguna full moon, single-source).
 *  - Onam (Thiruvonam): drikpanchang.com/festivals/onam, oneindia.com (2026),
 *    tapioca.co.in (2027–2030), qppstudio.net weekdays; 2031–2032 computed from the
 *    Thiruvonam star in Chingam and matched to qppstudio's weekdays (estimate).
 *  - Navratri (day 1) to Dussehra: universaltimedate.com, calendardate.com,
 *    drikpanchang.com/navratri (2031 adhik Bhadrapada: 16–25 Oct; 2032 Ghatasthapana
 *    4 Oct), vedpanchang.com (Dussehra 2031, 2032), drikpanchang Vijayadashami 2029.
 *  - Raksha Bandhan: publicholidays.in, calendardate.com, dekhopanchang.com (2031).
 *  - Ganesh Chaturthi: publicholidays.in, timeanddate.com, dekhopanchang.com,
 *    drikpanchang.com/festivals/ganesh-chaturthi (2031, 2032).
 *  - Guru Nanak Gurpurab (Kartik Purnima): calendar-yearly.com, dekhopanchang.com,
 *    qppstudio.net (cross-checked: 15–16 days after Diwali every year).
 *  - Vishu: drikpanchang.com/festivals/vishu (2026, 2029), prokerala.com (2027);
 *    other years from the Mesha Sankranti pattern (±1 day).
 *  - Vaisakhi: officeholidays.com, publicholidays.in, universaltimedate.com
 *    (2031–2032 estimated, ±1 day).
 *  - Thai Pongal: universaltimedate.com/holidays/pongal, drikpanchang.com/festivals/pongal,
 *    qppstudio.net weekdays (2031–2032 estimated, ±1 day).
 * Beyond the table, solar festivals (Vishu, Vaisakhi, Pongal) fall back to
 * their usual day; the lunar ones are only known once the feed has them.
 */
interface TableFestival {
  /** Main day per year, or [first day, last day] for a span. */
  dates: Record<number, string | [string, string]>;
  /** Days from the main day to the first day of the window. */
  startOffset: number;
  /** Usual day ('MM-DD') for years outside the table (solar festivals only). */
  usualDay?: string;
}

const LUNISOLAR_TABLE: Record<string, TableFestival> = {
  diwali: {
    startOffset: -2, // Dhanteras … Bhai Dooj, 5 days around Lakshmi Puja
    dates: { 2026: '2026-11-08', 2027: '2027-10-29', 2028: '2028-10-17', 2029: '2029-11-05', 2030: '2030-10-26', 2031: '2031-11-14', 2032: '2032-11-02' },
  },
  holi: {
    startOffset: 0, // Holika Dahan, then the day of colours
    dates: { 2026: '2026-03-03', 2027: '2027-03-21', 2028: '2028-03-10', 2029: '2029-02-28', 2030: '2030-03-19', 2031: '2031-03-08', 2032: '2032-03-26' },
  },
  onam: {
    startOffset: -1, // Uthradom ("first Onam"), then Thiruvonam
    dates: { 2026: '2026-08-26', 2027: '2027-09-12', 2028: '2028-09-01', 2029: '2029-08-22', 2030: '2030-09-09', 2031: '2031-08-30', 2032: '2032-08-19' },
  },
  'navratri-dussehra': {
    startOffset: 0,
    dates: {
      2026: ['2026-10-11', '2026-10-20'], 2027: ['2027-09-30', '2027-10-09'], 2028: ['2028-09-19', '2028-09-27'],
      2029: ['2029-10-09', '2029-10-16'], 2030: ['2030-09-28', '2030-10-06'], 2031: ['2031-10-16', '2031-10-25'],
      2032: ['2032-10-04', '2032-10-13'],
    },
  },
  'raksha-bandhan': {
    startOffset: 0,
    dates: { 2026: '2026-08-28', 2027: '2027-08-17', 2028: '2028-08-05', 2029: '2029-08-23', 2030: '2030-08-13', 2031: '2031-08-03', 2032: '2032-08-20' },
  },
  'ganesh-chaturthi': {
    startOffset: 0,
    dates: { 2026: '2026-09-14', 2027: '2027-09-04', 2028: '2028-08-23', 2029: '2029-09-11', 2030: '2030-09-01', 2031: '2031-09-20', 2032: '2032-09-08' },
  },
  gurpurab: {
    startOffset: 0,
    dates: { 2026: '2026-11-24', 2027: '2027-11-14', 2028: '2028-11-02', 2029: '2029-11-21', 2030: '2030-11-10', 2031: '2031-11-28', 2032: '2032-11-17' },
  },
  vishu: {
    startOffset: 0,
    usualDay: '04-14',
    dates: { 2026: '2026-04-15', 2027: '2027-04-15', 2028: '2028-04-14', 2029: '2029-04-14', 2030: '2030-04-14', 2031: '2031-04-15', 2032: '2032-04-14' },
  },
  vaisakhi: {
    startOffset: 0,
    usualDay: '04-14',
    dates: { 2026: '2026-04-14', 2027: '2027-04-14', 2028: '2028-04-13', 2029: '2029-04-14', 2030: '2030-04-14', 2031: '2031-04-14', 2032: '2032-04-13' },
  },
  pongal: {
    startOffset: 0, // Thai Pongal, Mattu Pongal, Kaanum Pongal
    usualDay: '01-14',
    dates: { 2026: '2026-01-14', 2027: '2027-01-15', 2028: '2028-01-15', 2029: '2029-01-14', 2030: '2030-01-14', 2031: '2031-01-15', 2032: '2032-01-15' },
  },
};

/**
 * Intl's Chinese calendar (ICU) is a day out when the new moon falls within
 * minutes of midnight China time: 2027 (new moon 23:56 on 6 Feb) and 2030
 * (00:07 on 3 Feb). These are the published Lunar New Year dates (Hong Kong
 * Observatory's calendar; checked against ICU for 2026–2035).
 */
const LUNAR_NEW_YEAR_FIX: Record<number, string> = { 2027: '2027-02-06', 2030: '2030-02-03' };

/** Fixed Gregorian dates ('MM-DD' of the first day). */
const FIXED: Record<string, string> = {
  'new-year': '01-01',
  'orthodox-christmas': '01-07',
  'valentines-day': '02-14',
  'uae-mothers-day': '03-21',
  'philippine-independence-day': '06-12',
  'emirati-womens-day': '08-28',
  'uae-flag-day': '11-03',
  'commemoration-day': '11-30',
  'uae-national-day': '12-02',
  christmas: '12-24', // Christmas Eve and Christmas Day
};

function span(id: string, start: string | undefined, end?: string): Omit<CalendarEntry, 'source'> | null {
  const f = getFestival(id);
  if (!f || !start) return null;
  return { id, year: Number(start.slice(0, 4)), start, end: end ?? addDays(start, f.durationDays - 1) };
}

const offlineCache = new Map<number, CalendarEntry[]>();

/** Every festival's dates for one year from offline sources only. */
export function offlineFestivalDates(year: number): CalendarEntry[] {
  const cached = offlineCache.get(year);
  if (cached) return cached;
  const out: Array<Omit<CalendarEntry, 'source'> | null> = [];

  // Islamic (Umm al-Qura)
  const ramadan = islamic(year, 9, 1);
  if (ramadan) {
    // Ramadan ends the day before 1 Shawwal (29 or 30 days).
    let eid = addDays(ramadan, 28);
    while (islamicDay(eid).month !== '10') eid = addDays(eid, 1);
    out.push(span('ramadan', ramadan, addDays(eid, -1)));
  }
  out.push(span('laylat-al-qadr', islamic(year, 9, 27))); // observed the night before 27 Ramadan
  out.push(span('eid-al-fitr', islamic(year, 10, 1)));
  out.push(span('eid-al-adha', islamic(year, 12, 9))); // Arafat Day, then Eid
  out.push(span('islamic-new-year', islamic(year, 1, 1)));
  out.push(span('mawlid', islamic(year, 3, 12)));
  out.push(span('isra-miraj', islamic(year, 7, 27)));

  // Chinese and Persian calendars
  out.push(span('lunar-new-year', LUNAR_NEW_YEAR_FIX[year] ?? firstDayOfYear(year, (d) => { const x = chineseDay(d); return x.month === '1' && x.day === 1; })));
  out.push(span('nowruz', firstDayOfYear(year, (d) => { const x = persianDay(d); return x.month === '1' && x.day === 1; })));

  // Easter
  const easter = westernEaster(year);
  out.push(span('good-friday', addDays(easter, -2)));
  out.push(span('easter', addDays(easter, -2))); // Good Friday … Easter Monday
  out.push(span('orthodox-easter', orthodoxEaster(year)));

  for (const [id, mmdd] of Object.entries(FIXED)) out.push(span(id, `${year}-${mmdd}`));

  for (const [id, t] of Object.entries(LUNISOLAR_TABLE)) {
    const entry = t.dates[year];
    if (Array.isArray(entry)) out.push(span(id, addDays(entry[0], t.startOffset), entry[1]));
    else if (entry) out.push(span(id, addDays(entry, t.startOffset)));
    else if (t.usualDay) out.push(span(id, addDays(`${year}-${t.usualDay}`, t.startOffset)));
  }

  const list = out
    .filter((e): e is Omit<CalendarEntry, 'source'> => !!e && e.year === year)
    .map((e) => ({ ...e, source: 'offline' }));
  offlineCache.set(year, list);
  return list;
}

// ---------------------------------------------------------------------------
// iCalendar parsing
// ---------------------------------------------------------------------------

export const MAX_ICS_BYTES = 2 * 1024 * 1024;

export interface IcsEvent {
  summary: string;
  /** UAE calendar date of the first day. */
  start: string;
  /** Inclusive last day, when the source gives one. */
  end?: string;
}

function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? ' ' : c)).trim();
}

/** 'YYYYMMDD' or 'YYYYMMDDTHHMMSS[Z]' -> UAE date, or null if unparsable. */
function icsDate(value: string, params: string): string | null {
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (dateOnly) {
    const d = `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`;
    return isIsoDate(d) ? d : null;
  }
  if (/VALUE=DATE(;|$)/i.test(params)) return null; // says DATE but is not one
  const dt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
  if (!dt) return null;
  const local = `${dt[1]}-${dt[2]}-${dt[3]}`;
  if (!isIsoDate(local) || +dt[4] > 23 || +dt[5] > 59 || +dt[6] > 60) return null;
  // UTC times are moved to the UAE date; local (TZID) and floating times keep
  // their own calendar date, which is what holiday calendars mean.
  if (dt[7] === 'Z') return dubaiDate(new Date(Date.UTC(+dt[1], +dt[2] - 1, +dt[3], +dt[4], +dt[5], Math.min(+dt[6], 59))));
  return local;
}

/**
 * A small, strict iCalendar reader: VEVENTs with a SUMMARY and a DTSTART.
 * Lines are unfolded (RFC 5545 §3.1); anything it cannot read is skipped.
 * Throws only if the input is over 2 MB.
 */
export function parseIcs(text: string): IcsEvent[] {
  if (typeof text !== 'string') return [];
  if (text.length > MAX_ICS_BYTES) throw new Error('calendar is larger than 2 MB');

  const lines: string[] = [];
  for (const raw of text.split(/\r\n|\n|\r/)) {
    if ((raw.startsWith(' ') || raw.startsWith('\t')) && lines.length) lines[lines.length - 1] += raw.slice(1);
    else lines.push(raw);
  }

  const events: IcsEvent[] = [];
  let depth = 0; // nested components inside the VEVENT (VALARM …)
  let current: { summary?: string; start?: string; end?: string; endIsDate?: boolean } | null = null;

  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    const head = line.slice(0, colon);
    const value = line.slice(colon + 1).trim();
    const semi = head.indexOf(';');
    const name = (semi === -1 ? head : head.slice(0, semi)).toUpperCase();
    const params = semi === -1 ? '' : head.slice(semi + 1);

    if (name === 'BEGIN') {
      if (current) depth++;
      else if (value.toUpperCase() === 'VEVENT') current = {};
      continue;
    }
    if (name === 'END') {
      if (current && depth > 0) depth--;
      else if (current && value.toUpperCase() === 'VEVENT') {
        if (current.summary && current.start) {
          let end: string | undefined;
          if (current.end) {
            // An all-day DTEND is exclusive; a date-time DTEND is the last instant.
            end = current.endIsDate ? addDays(current.end, -1) : current.end;
            if (end < current.start) end = current.start;
          }
          events.push({ summary: current.summary, start: current.start, end });
        }
        current = null;
      }
      continue;
    }
    if (!current || depth > 0) continue;

    if (name === 'SUMMARY') current.summary = unescapeText(value).slice(0, 200);
    else if (name === 'DTSTART') current.start = icsDate(value, params) ?? undefined;
    else if (name === 'DTEND') {
      current.end = icsDate(value, params) ?? undefined;
      current.endIsDate = /^\d{8}$/.test(value);
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Feeds and matching
// ---------------------------------------------------------------------------

interface MatchRule {
  id: string;
  re: RegExp;
  not?: RegExp;
  /** Days from the event's date to the first day of the festival window. */
  startOffset: number;
}

const ISLAMIC_RULES: MatchRule[] = [
  { id: 'ramadan', re: /\bramadh?an\b/i, not: /\b(end|last|eve|laylat|lailat|night)\b/i, startOffset: 0 },
  { id: 'laylat-al-qadr', re: /\b(laylat|lailat|laylatul|lailatul)[- ]?(al[- ]?)?qadr\b|night of (power|destiny|decree)|shab[- ]e[- ]qadr/i, startOffset: 0 },
  { id: 'eid-al-fitr', re: /\beid[- ]?(al|ul|el)?[- ]?fitr\b|\bramzan id\b|\bid[- ]ul[- ]fitr\b/i, not: /\beve\b/i, startOffset: 0 },
  // Arafat Day opens the Eid al-Adha window; Eid itself is the day after.
  { id: 'eid-al-adha', re: /\barafa[th]\b/i, startOffset: 0 },
  { id: 'eid-al-adha', re: /\beid[- ]?(al|ul|el)?[- ]?ad[h]?a\b|\bbakri?[- ]?e?id\b|\bbakrid\b|\b(id|eid)[- ]?ul[- ]?zuha\b/i, not: /\beve\b/i, startOffset: -1 },
  { id: 'islamic-new-year', re: /\b(islamic|hijri) new year\b|\bal[- ]hijra\b|\bhijri year\b|\bamun jadid\b/i, startOffset: 0 },
  { id: 'mawlid', re: /\bmawlid\b|\bmilad[- ]?(un|al)[- ]?nabi\b|\bprophet('s| muhammad'?s)? birthday\b|\bbirthday of (the )?prophet\b|\beid[- ]e[- ]milad\b/i, startOffset: 0 },
  { id: 'isra-miraj', re: /\bisra\b|\bmi'?[’]?raj\b/i, startOffset: 0 },
];

/** The Google public holiday calendars, applied in this order (later wins). */
export const FESTIVAL_FEEDS: Array<{ name: string; url: string; rules: MatchRule[] }> = [
  {
    name: 'google:indian',
    url: 'https://calendar.google.com/calendar/ical/en.indian%23holiday%40group.v.calendar.google.com/public/basic.ics',
    rules: [
      { id: 'diwali', re: /\b(diwali|deepavali)\b/i, not: /chaturdashi|choti|chhoti|padwa|pratipada/i, startOffset: -2 },
      { id: 'holi', re: /\bholika dahan/i, startOffset: 0 },
      { id: 'holi', re: /\bholi\b/i, not: /\bholika\b/i, startOffset: -1 }, // \b keeps "Holiday" out
      { id: 'onam', re: /\bfirst onam\b|\buthradom\b/i, startOffset: 0 },
      { id: 'onam', re: /\b(thiru)?onam\b/i, not: /\bfirst onam\b/i, startOffset: -1 },
      { id: 'navratri-dussehra', re: /\bnava?ratri\b/i, not: /chaitra|ashtami|navami|saptami/i, startOffset: 0 },
      { id: 'navratri-dussehra', re: /\b(dussehra|dasara|dasera|vijaya ?dashami)\b/i, startOffset: -9 },
      { id: 'raksha-bandhan', re: /\braksha ?bandhan\b|\brakhi\b/i, startOffset: 0 },
      { id: 'ganesh-chaturthi', re: /\bganesh(a)? chaturthi\b|\bvinayaka? chaturthi\b|\bvinayaka chavithi\b/i, startOffset: 0 },
      { id: 'gurpurab', re: /\bguru nanak\b|\bgurpurab\b|\bgurpurb\b/i, startOffset: 0 },
      { id: 'vishu', re: /\bvishu\b/i, startOffset: 0 },
      { id: 'vaisakhi', re: /\b(vaisakhi|baisakhi)\b/i, startOffset: 0 },
      { id: 'pongal', re: /\bpongal\b/i, not: /bhogi|mattu|kaanum|kanum/i, startOffset: 0 },
      { id: 'pongal', re: /\bmakara? sankranti\b/i, startOffset: 0 },
    ],
  },
  {
    name: 'google:islamic',
    url: 'https://calendar.google.com/calendar/ical/en.islamic%23holiday%40group.v.calendar.google.com/public/basic.ics',
    rules: ISLAMIC_RULES,
  },
  {
    name: 'google:christian',
    url: 'https://calendar.google.com/calendar/ical/en.christian%23holiday%40group.v.calendar.google.com/public/basic.ics',
    rules: [
      { id: 'good-friday', re: /\bgood friday\b/i, not: /orthodox/i, startOffset: 0 },
      { id: 'easter', re: /\bgood friday\b/i, not: /orthodox/i, startOffset: 0 },
      { id: 'easter', re: /\beaster( sunday| day)?$/i, not: /orthodox/i, startOffset: -2 },
      { id: 'easter', re: /\beaster monday\b/i, not: /orthodox/i, startOffset: -3 },
      { id: 'christmas', re: /\bchristmas eve\b/i, not: /orthodox/i, startOffset: 0 },
      { id: 'christmas', re: /\bchristmas( day)?$/i, not: /orthodox/i, startOffset: -1 },
    ],
  },
  {
    // Calendar id not verified from the build machine; an unreachable feed is harmless.
    name: 'google:orthodox',
    url: 'https://calendar.google.com/calendar/ical/en.orthodox_christianity%23holiday%40group.v.calendar.google.com/public/basic.ics',
    rules: [
      { id: 'orthodox-easter', re: /\b(easter|pascha)\b/i, not: /monday|saturday|friday|eve\b/i, startOffset: 0 },
      { id: 'orthodox-easter', re: /\bgood friday\b|\bholy friday\b/i, startOffset: 2 },
      { id: 'orthodox-christmas', re: /\bchristmas\b/i, not: /\beve\b/i, startOffset: 0 },
    ],
  },
  {
    // Calendar id not verified from the build machine; an unreachable feed is harmless.
    name: 'google:china',
    url: 'https://calendar.google.com/calendar/ical/en.china%23holiday%40group.v.calendar.google.com/public/basic.ics',
    rules: [{ id: 'lunar-new-year', re: /\b(chinese|lunar) new year\b|\bspring festival\b/i, not: /\beve\b/i, startOffset: 0 }],
  },
  {
    // UAE official dates: last, so they override the others for Islamic festivals.
    name: 'google:uae',
    url: 'https://calendar.google.com/calendar/ical/en.ae%23holiday%40group.v.calendar.google.com/public/basic.ics',
    rules: ISLAMIC_RULES,
  },
];

/** A fetched date further than this from the offline one is a wrong match. */
export const SANITY_DAYS = 15;

interface Accepted {
  id: string;
  year: number;
  start: string;
  source: string;
}

/**
 * Match a feed's events to festivals. For each festival and year, rules are
 * tried in order; among a rule's matches the one nearest the offline date wins.
 * A match is accepted only within ±SANITY_DAYS of the offline date.
 */
export function matchFeedEvents(
  events: IcsEvent[],
  rules: MatchRule[],
  source: string,
  years: { min: number; max: number },
): { accepted: Accepted[]; rejected: string[] } {
  type Cand = { rule: number; start: string; summary: string };
  const byKey = new Map<string, Cand[]>();
  for (const ev of events) {
    const seenIds = new Set<string>();
    rules.forEach((r, i) => {
      if (seenIds.has(r.id) || !r.re.test(ev.summary) || r.not?.test(ev.summary)) return;
      seenIds.add(r.id);
      const start = addDays(ev.start, r.startOffset);
      const year = Number(start.slice(0, 4));
      if (year < years.min || year > years.max) return;
      const key = `${r.id}|${year}`;
      byKey.set(key, [...(byKey.get(key) ?? []), { rule: i, start, summary: ev.summary }]);
    });
  }

  const accepted: Accepted[] = [];
  const rejected: string[] = [];
  for (const [key, cands] of byKey) {
    const [id, yearText] = key.split('|');
    const year = Number(yearText);
    const offline = offlineStart(id, year);
    if (!offline) {
      rejected.push(`${id} ${year}: no offline date to check "${cands[0].summary}" against; not used`);
      continue;
    }
    const near = cands
      .map((c) => ({ ...c, off: Math.abs(daysBetween(offline, c.start)) }))
      .sort((a, b) => a.rule - b.rule || a.off - b.off);
    const ok = near.find((c) => c.off <= SANITY_DAYS);
    if (ok) accepted.push({ id, year, start: ok.start, source });
    else {
      const best = [...near].sort((a, b) => a.off - b.off)[0];
      rejected.push(`${id} ${year}: "${best.summary}" on ${best.start} is ${best.off} days from the expected ${offline}; kept ${offline}`);
    }
  }
  return { accepted, rejected };
}

/** Offline first day of a festival in a year. */
function offlineStart(id: string, year: number): string | undefined {
  return offlineFestivalDates(year).find((e) => e.id === id)?.start;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const ready = new WeakSet<DB>();

/**
 * The festival tables come from migration 3 in db.ts; this also creates them
 * on a database handed in directly (tests), and is a no-op otherwise.
 */
export function ensureFestivalTable(db: DB = getDb()): DB {
  if (ready.has(db)) return db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS festival_dates (
      festival_id TEXT,
      year        INTEGER,
      start       TEXT,
      end         TEXT,
      source      TEXT,
      PRIMARY KEY (festival_id, year)
    );
    CREATE TABLE IF NOT EXISTS festival_meta (
      key    TEXT PRIMARY KEY,
      value  TEXT NOT NULL
    );
  `);
  ready.add(db);
  return db;
}

function storedRows(years: number[]): CalendarEntry[] {
  const db = ensureFestivalTable();
  const rows = db
    .prepare(`SELECT festival_id AS id, year, start, end, source FROM festival_dates WHERE year IN (${years.map(() => '?').join(',')})`)
    .all(...years) as CalendarEntry[];
  return rows.filter((r) => getFestival(r.id) && isIsoDate(r.start) && isIsoDate(r.end) && r.end >= r.start);
}

/**
 * The merged calendar for `year` and the next year: fetched dates where we
 * have them, offline dates otherwise. Sorted by start.
 */
export function festivalCalendar(year: number): CalendarEntry[] {
  const years = [year, year + 1];
  const merged = new Map<string, CalendarEntry>();
  for (const y of years) for (const e of offlineFestivalDates(y)) merged.set(`${e.id}|${y}`, e);
  for (const r of storedRows(years)) merged.set(`${r.id}|${r.year}`, r);

  // Ramadan runs until the day before Eid al-Fitr, whichever source each came from.
  for (const y of years) {
    const ramadan = merged.get(`ramadan|${y}`);
    const eid = [merged.get(`eid-al-fitr|${y}`), merged.get(`eid-al-fitr|${y + 1}`)].find(
      (e) => e && ramadan && daysBetween(ramadan.start, e.start) >= 28 && daysBetween(ramadan.start, e.start) <= 31,
    );
    if (ramadan && eid) merged.set(`ramadan|${y}`, { ...ramadan, end: addDays(eid.start, -1) });
  }
  return [...merged.values()].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

export type Fetcher = (url: string) => Promise<string>;

export interface RefreshResult {
  /** True when every feed was downloaded and read. */
  ok: boolean;
  fetchedAt: string;
  /** Festival dates that changed, e.g. 'diwali 2027: 2027-10-27'. */
  updated: string[];
  /** Feeds that could not be downloaded or read. */
  errors: string[];
  /** Matches that failed the ±15-day check (the offline date was kept). */
  rejected: string[];
}

/** Global fetch with a 15 s timeout and a 2 MB cap. */
export const defaultFetcher: Fetcher = async (url) => {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(15_000),
    headers: { accept: 'text/calendar, text/plain;q=0.5' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > MAX_ICS_BYTES) throw new Error('response is larger than 2 MB');
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_ICS_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error('response is larger than 2 MB');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
};

function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/\s+/g, ' ').slice(0, 160);
}

/**
 * Download every feed, match its events and store the dates that pass the
 * sanity check. One feed failing does not stop the others. Never throws.
 */
export async function refreshFestivalDates(fetcher: Fetcher = defaultFetcher, now: Date = new Date()): Promise<RefreshResult> {
  const fetchedAt = now.toISOString();
  const result: RefreshResult = { ok: false, fetchedAt, updated: [], errors: [], rejected: [] };
  try {
    const thisYear = Number(dubaiDate(now).slice(0, 4));
    const years = { min: thisYear - 1, max: thisYear + 5 };
    const chosen = new Map<string, Accepted>(); // later feeds override earlier ones

    const downloads = await Promise.all(
      FESTIVAL_FEEDS.map(async (feed) => {
        try {
          return { feed, text: await fetcher(feed.url) };
        } catch (err) {
          return { feed, error: errorText(err) };
        }
      }),
    );

    for (const d of downloads) {
      if ('error' in d) {
        result.errors.push(`${d.feed.name}: ${d.error}`);
        continue;
      }
      try {
        const events = parseIcs(d.text ?? '');
        if (!events.length) throw new Error('no events in the calendar');
        const { accepted, rejected } = matchFeedEvents(events, d.feed.rules, d.feed.name, years);
        for (const a of accepted) chosen.set(`${a.id}|${a.year}`, a);
        result.rejected.push(...rejected);
      } catch (err) {
        result.errors.push(`${d.feed.name}: ${errorText(err)}`);
      }
    }

    const db = ensureFestivalTable();
    const read = db.prepare('SELECT start, end, source FROM festival_dates WHERE festival_id = ? AND year = ?');
    const write = db.prepare(`
      INSERT INTO festival_dates (festival_id, year, start, end, source) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (festival_id, year) DO UPDATE SET start = excluded.start, end = excluded.end, source = excluded.source`);
    db.transaction(() => {
      for (const a of chosen.values()) {
        const f = getFestival(a.id)!;
        let end = addDays(a.start, f.durationDays - 1);
        if (a.id === 'navratri-dussehra') end = addDays(a.start, 9);
        const before = read.get(a.id, a.year) as { start: string; end: string; source: string } | undefined;
        const offline = offlineStart(a.id, a.year);
        if (!before ? a.start !== offline : before.start !== a.start || before.end !== end) result.updated.push(`${a.id} ${a.year}: ${a.start}`);
        write.run(a.id, a.year, a.start, end, a.source);
      }
    })();

    result.ok = result.errors.length === 0;
    db.prepare('INSERT INTO festival_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(
      'lastRefresh',
      JSON.stringify(result),
    );
    logEvent(result.ok ? 'info' : 'warn', 'festival_dates_refreshed', {
      updated: result.updated.length,
      errors: result.errors,
      rejected: result.rejected.length,
    });
  } catch (err) {
    result.ok = false;
    result.errors.push(`refresh: ${errorText(err)}`);
    logEvent('error', 'festival_dates_refresh_failed', { error: errorText(err) });
  }
  return result;
}

/** The last refresh's result, or null if none has run. */
export function lastFestivalRefresh(): RefreshResult | null {
  try {
    const row = ensureFestivalTable().prepare("SELECT value FROM festival_meta WHERE key = 'lastRefresh'").get() as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as RefreshResult) : null;
  } catch {
    return null;
  }
}

let inFlight: Promise<RefreshResult> | null = null;

/**
 * Refresh if the last attempt is older than `maxAgeMs` (default 7 days).
 * Safe to call on every request or from a timer: one refresh at a time.
 * Returns null when no refresh was needed.
 */
export async function maybeRefreshFestivalDates(
  opts: { maxAgeMs?: number; fetcher?: Fetcher; now?: Date } = {},
): Promise<RefreshResult | null> {
  const now = opts.now ?? new Date();
  const last = lastFestivalRefresh();
  const age = last ? now.getTime() - Date.parse(last.fetchedAt) : Infinity;
  if (age < (opts.maxAgeMs ?? 7 * 86_400_000)) return null;
  if (!inFlight) inFlight = refreshFestivalDates(opts.fetcher ?? defaultFetcher, now).finally(() => (inFlight = null));
  return inFlight;
}

// ---------------------------------------------------------------------------
// Today's theme
// ---------------------------------------------------------------------------

export interface CurrentFestivalTheme {
  today: string;
  pick: ThemePick;
  theme: FestivalTheme;
  upcoming: UpcomingFestival[];
}

/** Events from last year to two years ahead, enough for any lead or tail window. */
export function festivalEventsAround(today: string): FestivalEvent[] {
  const y = Number(today.slice(0, 4));
  return [...festivalCalendar(y - 1), ...festivalCalendar(y + 1)].map(({ id, start, end }) => ({ id, start, end }));
}

/** The theme for the storefront right now, with the admin's override applied. */
export function currentFestivalTheme(override?: ThemeOverride, now: Date = new Date(), disabled: string[] = []): CurrentFestivalTheme {
  const today = dubaiDate(now);
  let events: FestivalEvent[] = [];
  try {
    // Festivals the admin switched off never take over the theme.
    events = festivalEventsAround(today).filter((e) => !disabled.includes(e.id));
  } catch (err) {
    logEvent('error', 'festival_calendar_failed', { error: errorText(err) });
  }
  const pick = pickTheme({ today, events, override });
  return { today, pick, theme: pick.festivalId ? themeFor(pick.festivalId) : DEFAULT_THEME, upcoming: upcomingFestivals(today, events, 8) };
}

/** Every festival id the catalogue knows (for validating an admin's choice). */
export const FESTIVAL_IDS = FESTIVALS.map((f) => f.id);
