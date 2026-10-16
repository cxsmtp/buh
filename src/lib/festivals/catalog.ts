/**
 * The festivals the storefront celebrates, and the look of each one.
 *
 * Plain data, no server imports: the admin screens and the storefront can use
 * it in the browser. Dates live elsewhere (src/lib/server/festivalDates.ts);
 * which theme shows today is decided by src/lib/festivals/select.ts.
 *
 * The UAE is home to many communities (Emirati and Arab, South Asian, Filipino,
 * Chinese and East Asian, Iranian, European, Orthodox Christian), so
 * the list is broad. Greetings are the ones each community uses itself.
 *
 * - `tier` 1 is a major, nationwide or large-community festival; it gets the
 *   full 3-week lead and 1-week tail. Tier 2 gets a short window (see select.ts).
 * - `priority` breaks ties when two festivals of the same tier overlap.
 * - `solemn` days (Good Friday, Commemoration Day) show a calm theme with no
 *   sales line and no party ornaments, only on the day itself.
 * - `parent` marks a day that sits inside a longer festival (Laylat al-Qadr in
 *   Ramadan): it is listed for the admin but never takes over the theme.
 *
 * Colours: a festival never brings its own colours. It picks one of a few
 * curated accents (FESTIVE_ACCENTS) that sit with the shop's palette
 * (src/lib/design/tokens.ts): Eid in deep emerald and gold, Diwali in saffron
 * and gold, Christmas in berry and gold, National Day in emerald with a quiet
 * nod to the flag, solemn days in stone grey. Each festival also has one
 * delicate motif (a crescent and stars, a diya, a snowflake…) drawn as a fine
 * line in the greeting band and the story ring. A test checks every accent's
 * contrast.
 */

/** The curated accents a festival may shift to. */
export interface FestiveAccent {
  /** Text and fine lines on light backgrounds: at least 4.5:1 on ivory and on `soft`. */
  accent: string;
  /** The greeting band's background: a soft tint. */
  soft: string;
  /** The motif and the story ring (decorative, beside gold). */
  glow: string;
  /** The phone's status bar while the festival's look is on. */
  bar: string;
}

export const FESTIVE_ACCENTS = {
  gold: { accent: '#82612c', soft: '#f2ebdf', glow: '#c2a36b', bar: '#2b2127' },
  emerald: { accent: '#2f6450', soft: '#e8efe9', glow: '#b99d5f', bar: '#1f3a31' },
  saffron: { accent: '#8d4f17', soft: '#f6eadb', glow: '#d0a052', bar: '#4a2a14' },
  berry: { accent: '#843140', soft: '#f5e6e6', glow: '#c4a065', bar: '#4a1c26' },
  rose: { accent: '#8a5659', soft: '#f4e8e5', glow: '#c49a98', bar: '#3e2a31' },
  midnight: { accent: '#3d4a6b', soft: '#e9ebf1', glow: '#bfa26a', bar: '#1e2436' },
  sage: { accent: '#4b6550', soft: '#e9efe7', glow: '#b3a26c', bar: '#26332a' },
  stone: { accent: '#5d585a', soft: '#eeebe8', glow: '#a39b95', bar: '#3a3436' },
} as const satisfies Record<string, FestiveAccent>;

export type FestiveAccentId = keyof typeof FESTIVE_ACCENTS;

/** The fine-line ornaments (drawn by src/components/store/FestiveMotif.tsx). */
export const MOTIFS = ['sparkle', 'crescent', 'lantern', 'diya', 'lotus', 'rangoli', 'snowflake', 'star', 'blossom', 'dove', 'olive', 'wheat', 'sun', 'flag', 'cloud', 'heart', 'sprout'] as const;
export type MotifId = (typeof MOTIFS)[number];

/** How a festival looks, as written in the catalogue. */
interface FestivalLook {
  palette: FestiveAccentId;
  motif: MotifId;
  /** A short, gracious greeting. */
  greeting: string;
  /** One quiet line under it. */
  headline: string;
  /** 1–3 short lines for the announcement bar (only the first is shown with the shop's own). */
  marquee: string[];
}

/** A festival's look with its colours worked out (what the storefront receives). */
export interface FestivalTheme extends FestivalLook {
  /** Accent for text and fine lines on light backgrounds (>= 4.5:1 on ivory). */
  accent: string;
  /** A soft tint of the accent for the greeting band. */
  accentSoft: string;
  /** The motif's and the story ring's colour. */
  glow: string;
  /** The status-bar colour. */
  bar: string;
}

export interface Festival {
  id: string;
  name: string;
  /** Default length in days, used when a source only gives the first day. */
  durationDays: number;
  /** Higher wins when festivals of the same tier overlap. */
  priority: number;
  /** 1 = major (21 days lead, 7 days tail); 2 = others (7 lead, 2 tail). */
  tier: 1 | 2;
  /** A day of remembrance: calm theme, shown only on the day, overrides others. */
  solemn?: boolean;
  /** Sits inside this festival; listed but never chosen on its own. */
  parent?: string;
  theme: FestivalTheme;
}

function look(l: FestivalLook): FestivalTheme {
  const a = FESTIVE_ACCENTS[l.palette];
  return { ...l, accent: a.accent, accentSoft: a.soft, glow: a.glow, bar: a.bar };
}

/** The shop's ink and gold (src/lib/design/tokens.ts). */
export const BRAND_INK = '#2b2127';
export const BRAND_GOLD = '#c2a36b';
export const BRAND_IVORY = '#faf6ef';

/** The everyday look: the shop's own gold. */
export const DEFAULT_THEME: FestivalTheme = look({
  palette: 'gold',
  motif: 'sparkle',
  greeting: 'Welcome',
  headline: 'Fine bed linen for every home in the Emirates',
  marquee: ['Free delivery across the UAE in 1–2 days'],
});

export const DEFAULT_THEME_ID = 'default';

type Entry = Omit<Festival, 'theme'> & { theme: FestivalLook };

const ENTRIES: Entry[] = [
  // ---- UAE national days ----------------------------------------------------
  {
    id: 'uae-national-day', name: 'UAE National Day (Eid Al Etihad)', durationDays: 2, priority: 100, tier: 1,
    theme: {
      palette: 'emerald', motif: 'flag',
      greeting: 'Happy Eid Al Etihad',
      headline: 'Celebrating the Union, and every home that makes it',
      marquee: ['Happy Eid Al Etihad to everyone who calls the UAE home'],
    },
  },
  {
    id: 'commemoration-day', name: 'Commemoration Day', durationDays: 1, priority: 100, tier: 1, solemn: true,
    theme: {
      palette: 'stone', motif: 'olive',
      greeting: 'Commemoration Day',
      headline: 'Today we honour the UAE’s martyrs',
      marquee: ['In remembrance of those who gave their lives for the nation'],
    },
  },
  {
    id: 'uae-flag-day', name: 'UAE Flag Day', durationDays: 1, priority: 55, tier: 2,
    theme: {
      palette: 'emerald', motif: 'flag',
      greeting: 'Happy Flag Day',
      headline: 'Raising the flag, at home and across the Emirates',
      marquee: ['Happy UAE Flag Day'],
    },
  },
  {
    id: 'emirati-womens-day', name: 'Emirati Women’s Day', durationDays: 1, priority: 50, tier: 2,
    theme: {
      palette: 'rose', motif: 'blossom',
      greeting: 'Happy Emirati Women’s Day',
      headline: 'Celebrating the women who make every house a home',
      marquee: ['Happy Emirati Women’s Day'],
    },
  },
  {
    id: 'uae-mothers-day', name: 'Mother’s Day', durationDays: 1, priority: 45, tier: 2,
    theme: {
      palette: 'rose', motif: 'blossom',
      greeting: 'Happy Mother’s Day',
      headline: 'Soft linen for the one who made home feel like home',
      marquee: ['Mother’s Day gift wrapping on every order'],
    },
  },

  // ---- Islamic calendar -----------------------------------------------------
  {
    id: 'ramadan', name: 'Ramadan', durationDays: 30, priority: 90, tier: 1,
    theme: {
      palette: 'emerald', motif: 'lantern',
      greeting: 'Ramadan Kareem',
      headline: 'Calm, restful bedding for the holy month',
      marquee: ['Ramadan Kareem from our family to yours', 'Evening delivery slots through Ramadan'],
    },
  },
  {
    id: 'laylat-al-qadr', name: 'Laylat al-Qadr', durationDays: 1, priority: 90, tier: 2, parent: 'ramadan',
    theme: {
      palette: 'midnight', motif: 'crescent',
      greeting: 'Laylat al-Qadr',
      headline: 'A blessed night of peace',
      marquee: ['Wishing you a blessed Laylat al-Qadr'],
    },
  },
  {
    id: 'eid-al-fitr', name: 'Eid al-Fitr', durationDays: 3, priority: 95, tier: 1,
    theme: {
      palette: 'emerald', motif: 'crescent',
      greeting: 'Eid Mubarak',
      headline: 'Fresh linen for Eid mornings and the guests who follow',
      marquee: ['Eid Mubarak from our home to yours', 'Eid gift sets, wrapped and delivered across the UAE'],
    },
  },
  {
    id: 'eid-al-adha', name: 'Arafat Day & Eid al-Adha', durationDays: 4, priority: 95, tier: 1,
    theme: {
      palette: 'emerald', motif: 'crescent',
      greeting: 'Eid al-Adha Mubarak',
      headline: 'Welcome family home this Eid',
      marquee: ['Eid al-Adha Mubarak', 'Guest-room linen, ready for the holidays'],
    },
  },
  {
    id: 'islamic-new-year', name: 'Islamic New Year', durationDays: 1, priority: 40, tier: 2,
    theme: {
      palette: 'midnight', motif: 'crescent',
      greeting: 'Happy Hijri New Year',
      headline: 'A fresh start for a new Hijri year',
      marquee: ['Happy Hijri New Year'],
    },
  },
  {
    id: 'isra-miraj', name: 'Isra and Mi’raj', durationDays: 1, priority: 35, tier: 2,
    theme: {
      palette: 'midnight', motif: 'star',
      greeting: 'Blessed Isra and Mi’raj',
      headline: 'Wishing you a peaceful night',
      marquee: ['Blessed Isra and Mi’raj'],
    },
  },
  {
    id: 'mawlid', name: 'The Prophet’s Birthday (Mawlid)', durationDays: 1, priority: 40, tier: 2,
    theme: {
      palette: 'emerald', motif: 'lantern',
      greeting: 'Mawlid Mubarak',
      headline: 'Peace and blessings to your home',
      marquee: ['Mawlid Mubarak'],
    },
  },

  // ---- South Asian ----------------------------------------------------------
  {
    id: 'diwali', name: 'Diwali', durationDays: 5, priority: 80, tier: 1,
    theme: {
      palette: 'saffron', motif: 'diya',
      greeting: 'Happy Diwali',
      headline: 'May your home be filled with light',
      marquee: ['Happy Diwali and a bright new year', 'Diwali gift boxes, wrapped by hand'],
    },
  },
  {
    id: 'holi', name: 'Holi', durationDays: 2, priority: 70, tier: 1,
    theme: {
      palette: 'rose', motif: 'rangoli',
      greeting: 'Happy Holi',
      headline: 'Colour for the bedroom, after the colours outside',
      marquee: ['Happy Holi', 'New prints for spring'],
    },
  },
  {
    id: 'onam', name: 'Onam', durationDays: 2, priority: 65, tier: 1,
    theme: {
      palette: 'saffron', motif: 'blossom',
      greeting: 'Happy Onam',
      headline: 'Kasavu whites and gold for the Onam home',
      marquee: ['Happy Onam', 'Crisp white and gold sets for the season'],
    },
  },
  {
    id: 'navratri-dussehra', name: 'Navratri & Dussehra', durationDays: 10, priority: 50, tier: 2,
    theme: {
      palette: 'rose', motif: 'lotus',
      greeting: 'Happy Navratri',
      headline: 'Nine nights of colour, and a restful tenth',
      marquee: ['Happy Navratri and Dussehra'],
    },
  },
  {
    id: 'raksha-bandhan', name: 'Raksha Bandhan', durationDays: 1, priority: 45, tier: 2,
    theme: {
      palette: 'rose', motif: 'rangoli',
      greeting: 'Happy Raksha Bandhan',
      headline: 'A thoughtful gift for a brother or sister',
      marquee: ['Happy Raksha Bandhan'],
    },
  },
  {
    id: 'ganesh-chaturthi', name: 'Ganesh Chaturthi', durationDays: 1, priority: 45, tier: 2,
    theme: {
      palette: 'saffron', motif: 'lotus',
      greeting: 'Happy Ganesh Chaturthi',
      headline: 'New beginnings for the home',
      marquee: ['Happy Ganesh Chaturthi'],
    },
  },
  {
    id: 'pongal', name: 'Pongal & Makar Sankranti', durationDays: 3, priority: 45, tier: 2,
    theme: {
      palette: 'saffron', motif: 'sun',
      greeting: 'Happy Pongal',
      headline: 'Harvest-season comfort for the home',
      marquee: ['Happy Pongal and Makar Sankranti'],
    },
  },
  {
    id: 'vishu', name: 'Vishu', durationDays: 1, priority: 40, tier: 2,
    theme: {
      palette: 'saffron', motif: 'blossom',
      greeting: 'Happy Vishu',
      headline: 'A golden start to the Malayalam new year',
      marquee: ['Vishu ashamsakal — Happy Vishu'],
    },
  },
  {
    id: 'vaisakhi', name: 'Vaisakhi', durationDays: 1, priority: 40, tier: 2,
    theme: {
      palette: 'saffron', motif: 'wheat',
      greeting: 'Happy Vaisakhi',
      headline: 'Celebrating the harvest and the new year',
      marquee: ['Happy Vaisakhi'],
    },
  },
  {
    id: 'gurpurab', name: 'Guru Nanak Gurpurab', durationDays: 1, priority: 45, tier: 2,
    theme: {
      palette: 'saffron', motif: 'diya',
      greeting: 'Gurpurab di lakh lakh vadhaiyan',
      headline: 'Wishing every home peace and light',
      marquee: ['Happy Guru Nanak Gurpurab'],
    },
  },

  // ---- East Asian and Iranian -------------------------------------------------
  {
    id: 'lunar-new-year', name: 'Lunar New Year', durationDays: 7, priority: 70, tier: 1,
    theme: {
      palette: 'berry', motif: 'cloud',
      greeting: 'Happy Lunar New Year',
      headline: 'New sheets for a lucky new year',
      marquee: ['Gong Xi Fa Cai · Happy Lunar New Year', 'Gift sets, wrapped for the season'],
    },
  },
  {
    id: 'nowruz', name: 'Nowruz', durationDays: 3, priority: 45, tier: 2,
    theme: {
      palette: 'sage', motif: 'sprout',
      greeting: 'Nowruz Mubarak',
      headline: 'Fresh linen for a fresh spring',
      marquee: ['Nowruz Mubarak — Happy Persian New Year'],
    },
  },

  // ---- Christian ------------------------------------------------------------
  {
    id: 'good-friday', name: 'Good Friday', durationDays: 2, priority: 100, tier: 1, solemn: true,
    theme: {
      palette: 'stone', motif: 'olive',
      greeting: 'Good Friday',
      headline: 'A day of quiet reflection',
      marquee: ['Thinking of everyone observing Good Friday'],
    },
  },
  {
    id: 'easter', name: 'Easter', durationDays: 4, priority: 75, tier: 1,
    theme: {
      palette: 'sage', motif: 'blossom',
      greeting: 'Happy Easter',
      headline: 'Spring-fresh linen for Easter at home',
      marquee: ['Happy Easter', 'Soft pastels for the season'],
    },
  },
  {
    id: 'orthodox-easter', name: 'Orthodox Easter', durationDays: 2, priority: 50, tier: 2,
    theme: {
      palette: 'sage', motif: 'olive',
      greeting: 'Happy Easter',
      headline: 'Wishing a joyful Pascha to every home',
      marquee: ['Christ is Risen · Happy Orthodox Easter'],
    },
  },
  {
    id: 'christmas', name: 'Christmas', durationDays: 2, priority: 80, tier: 1,
    theme: {
      palette: 'berry', motif: 'snowflake',
      greeting: 'Merry Christmas',
      headline: 'Wrap them in comfort this Christmas',
      marquee: ['Merry Christmas', 'Christmas gift wrapping on every order'],
    },
  },
  {
    id: 'orthodox-christmas', name: 'Orthodox Christmas', durationDays: 1, priority: 50, tier: 2,
    theme: {
      palette: 'berry', motif: 'star',
      greeting: 'Merry Christmas',
      headline: 'Warm wishes for Orthodox Christmas',
      marquee: ['Merry Orthodox Christmas'],
    },
  },

  // ---- Others -------------------------------------------------------------------
  {
    id: 'new-year', name: 'New Year', durationDays: 1, priority: 60, tier: 1,
    theme: {
      palette: 'midnight', motif: 'sparkle',
      greeting: 'Happy New Year',
      headline: 'New year, fresh sheets',
      marquee: ['Happy New Year from all of us'],
    },
  },
  {
    id: 'philippine-independence-day', name: 'Philippine Independence Day', durationDays: 1, priority: 40, tier: 2,
    theme: {
      palette: 'midnight', motif: 'sun',
      greeting: 'Maligayang Araw ng Kalayaan',
      headline: 'Happy Independence Day to our Filipino community',
      marquee: ['Happy Philippine Independence Day'],
    },
  },
  {
    id: 'valentines-day', name: 'Valentine’s Day', durationDays: 1, priority: 10, tier: 2,
    theme: {
      palette: 'berry', motif: 'heart',
      greeting: 'Happy Valentine’s Day',
      headline: 'A softer bedroom, made for two',
      marquee: ['Gift wrapping for Valentine’s Day'],
    },
  },
];

export const FESTIVALS: Festival[] = ENTRIES.map((e) => ({ ...e, theme: look(e.theme) }));

const BY_ID = new Map(FESTIVALS.map((f) => [f.id, f]));

export function getFestival(id: string): Festival | undefined {
  return BY_ID.get(id);
}

/** Theme for a festival id, or the default theme for 'default' / unknown ids. */
export function themeFor(id: string | undefined): FestivalTheme {
  return (id && BY_ID.get(id)?.theme) || DEFAULT_THEME;
}

/** Every theme id the admin can pick by hand, default first. */
export function themeIds(): string[] {
  return [DEFAULT_THEME_ID, ...FESTIVALS.map((f) => f.id)];
}

// ---- Contrast (WCAG 2.x) ---------------------------------------------------

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance of '#rrggbb'. */
export function luminance(hex: string): number {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`);
  const [r, g, b] = m.slice(1).map((h) => channel(parseInt(h, 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two '#rrggbb' colours (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
