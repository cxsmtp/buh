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
 * Colours: `accent` is used for text, buttons and borders, so it must reach a
 * contrast of at least 3:1 on white and on the brand navy (#0f1c2e); a test
 * checks every theme. `accentSoft` is a light tint for backgrounds, and
 * `gradient` is the banner background (white text sits on it).
 */

export interface FestivalTheme {
  /** Accent for text, buttons, borders: >= 3:1 on white and on navy. */
  accent: string;
  /** A soft tint of the accent for backgrounds and chips. */
  accentSoft: string;
  /** Banner background, from -> to. */
  gradient: [string, string];
  /** 1–3 emoji or a short symbol string. */
  ornament: string;
  greeting: string;
  /** Short storefront banner line. */
  headline: string;
  /** 1–3 short lines for the scrolling bar. */
  marquee: string[];
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

export const BRAND_NAVY = '#0f1c2e';
export const BRAND_GOLD = '#c5a059';

/**
 * The everyday look. The brand gold (#c5a059) is only 2.5:1 on white, so it is
 * the soft tint here and a deeper gold carries text and buttons.
 */
export const DEFAULT_THEME: FestivalTheme = {
  accent: '#8c6a2a',
  accentSoft: '#f6efe1',
  gradient: [BRAND_NAVY, '#1e3350'],
  ornament: '✦',
  greeting: 'Welcome',
  headline: 'Fine bed linen for every home in the Emirates',
  marquee: ['Free delivery across the UAE on orders over AED 300', 'Pure cotton, made to last'],
};

export const DEFAULT_THEME_ID = 'default';

export const FESTIVALS: Festival[] = [
  // ---- UAE national days ----------------------------------------------------
  {
    id: 'uae-national-day', name: 'UAE National Day (Eid Al Etihad)', durationDays: 2, priority: 100, tier: 1,
    theme: {
      accent: '#00843d', accentSoft: '#e6f3ec', gradient: ['#00732f', '#0f1c2e'], ornament: '🇦🇪',
      greeting: 'Happy Eid Al Etihad',
      headline: 'Celebrating the Union with homes dressed in their finest',
      marquee: ['Happy Eid Al Etihad to everyone who calls the UAE home', 'Gift sets ready for National Day visits'],
    },
  },
  {
    id: 'commemoration-day', name: 'Commemoration Day', durationDays: 1, priority: 100, tier: 1, solemn: true,
    theme: {
      accent: '#647080', accentSoft: '#eef0f3', gradient: ['#2b333d', '#0f1c2e'], ornament: '🕊️',
      greeting: 'Commemoration Day',
      headline: 'Today we honour the UAE’s martyrs',
      marquee: ['In remembrance of those who gave their lives for the nation'],
    },
  },
  {
    id: 'uae-flag-day', name: 'UAE Flag Day', durationDays: 1, priority: 55, tier: 2,
    theme: {
      accent: '#00843d', accentSoft: '#e6f3ec', gradient: ['#00732f', '#1b1b1b'], ornament: '🇦🇪',
      greeting: 'Happy Flag Day',
      headline: 'Raising the flag, at home and across the Emirates',
      marquee: ['Happy UAE Flag Day'],
    },
  },
  {
    id: 'emirati-womens-day', name: 'Emirati Women’s Day', durationDays: 1, priority: 50, tier: 2,
    theme: {
      accent: '#a94a75', accentSoft: '#f8eaf0', gradient: ['#7a2f52', '#0f1c2e'], ornament: '🌸',
      greeting: 'Happy Emirati Women’s Day',
      headline: 'Celebrating the women who make every house a home',
      marquee: ['Happy Emirati Women’s Day'],
    },
  },
  {
    id: 'uae-mothers-day', name: 'Mother’s Day', durationDays: 1, priority: 45, tier: 2,
    theme: {
      accent: '#b0466a', accentSoft: '#fbecf1', gradient: ['#8a3352', '#0f1c2e'], ornament: '💐',
      greeting: 'Happy Mother’s Day',
      headline: 'Soft linen for the one who made home feel like home',
      marquee: ['Mother’s Day gift wrapping on every order'],
    },
  },

  // ---- Islamic calendar -----------------------------------------------------
  {
    id: 'ramadan', name: 'Ramadan', durationDays: 30, priority: 90, tier: 1,
    theme: {
      accent: '#1d7a6c', accentSoft: '#e5f3f0', gradient: ['#0f3d3a', '#0f1c2e'], ornament: '🌙✨',
      greeting: 'Ramadan Kareem',
      headline: 'Calm, restful bedding for the holy month',
      marquee: ['Ramadan Kareem from our family to yours', 'Evening delivery slots through Ramadan'],
    },
  },
  {
    id: 'laylat-al-qadr', name: 'Laylat al-Qadr', durationDays: 1, priority: 90, tier: 2, parent: 'ramadan',
    theme: {
      accent: '#5068b0', accentSoft: '#ebeff8', gradient: ['#1b2550', '#0f1c2e'], ornament: '🌙',
      greeting: 'Laylat al-Qadr',
      headline: 'A blessed night of peace',
      marquee: ['Wishing you a blessed Laylat al-Qadr'],
    },
  },
  {
    id: 'eid-al-fitr', name: 'Eid al-Fitr', durationDays: 3, priority: 95, tier: 1,
    theme: {
      accent: '#2e7d5b', accentSoft: '#e8f4ee', gradient: ['#14513a', '#0f1c2e'], ornament: '🌙🎁',
      greeting: 'Eid Mubarak',
      headline: 'Fresh linen for Eid mornings and the guests who follow',
      marquee: ['Eid Mubarak', 'Eid gift sets, wrapped and delivered across the UAE'],
    },
  },
  {
    id: 'eid-al-adha', name: 'Arafat Day & Eid al-Adha', durationDays: 4, priority: 95, tier: 1,
    theme: {
      accent: '#14766e', accentSoft: '#e4f3f1', gradient: ['#0d4a45', '#0f1c2e'], ornament: '🌙🕋',
      greeting: 'Eid Mubarak',
      headline: 'Welcome family home this Eid al-Adha',
      marquee: ['Eid al-Adha Mubarak', 'Guest-room linen, ready for the holidays'],
    },
  },
  {
    id: 'islamic-new-year', name: 'Islamic New Year', durationDays: 1, priority: 40, tier: 2,
    theme: {
      accent: '#566aa6', accentSoft: '#edf0f8', gradient: ['#25305a', '#0f1c2e'], ornament: '🌙',
      greeting: 'Happy Hijri New Year',
      headline: 'A fresh start for a new Hijri year',
      marquee: ['Happy Hijri New Year'],
    },
  },
  {
    id: 'isra-miraj', name: 'Isra and Mi’raj', durationDays: 1, priority: 35, tier: 2,
    theme: {
      accent: '#4a63b0', accentSoft: '#ecf0fa', gradient: ['#1c2756', '#0f1c2e'], ornament: '✨',
      greeting: 'Blessed Isra and Mi’raj',
      headline: 'Wishing you a peaceful night',
      marquee: ['Blessed Isra and Mi’raj'],
    },
  },
  {
    id: 'mawlid', name: 'The Prophet’s Birthday (Mawlid)', durationDays: 1, priority: 40, tier: 2,
    theme: {
      accent: '#3c8a5a', accentSoft: '#eaf5ee', gradient: ['#1d5236', '#0f1c2e'], ornament: '🌙',
      greeting: 'Mawlid Mubarak',
      headline: 'Peace and blessings to your home',
      marquee: ['Mawlid Mubarak'],
    },
  },

  // ---- South Asian ----------------------------------------------------------
  {
    id: 'diwali', name: 'Diwali', durationDays: 5, priority: 80, tier: 1,
    theme: {
      accent: '#b85600', accentSoft: '#fdf0e2', gradient: ['#7a2e00', '#2a0f2e'], ornament: '🪔✨',
      greeting: 'Happy Diwali',
      headline: 'Light up the home with linen worth gifting',
      marquee: ['Happy Diwali and a bright new year', 'Diwali gift boxes, wrapped by hand'],
    },
  },
  {
    id: 'holi', name: 'Holi', durationDays: 2, priority: 70, tier: 1,
    theme: {
      accent: '#c0307a', accentSoft: '#fcebf4', gradient: ['#9c1f63', '#4a2a8a'], ornament: '🎨🌸',
      greeting: 'Happy Holi',
      headline: 'Colour for the bedroom, after the colours outside',
      marquee: ['Happy Holi', 'Bright new prints for spring'],
    },
  },
  {
    id: 'onam', name: 'Onam', durationDays: 2, priority: 65, tier: 1,
    theme: {
      accent: '#2f7d32', accentSoft: '#f7f1df', gradient: ['#1e5a20', '#6b4e0e'], ornament: '🌼🛶',
      greeting: 'Happy Onam',
      headline: 'Kasavu whites and gold for the Onam home',
      marquee: ['Happy Onam', 'Crisp white and gold sets for the season'],
    },
  },
  {
    id: 'navratri-dussehra', name: 'Navratri & Dussehra', durationDays: 10, priority: 50, tier: 2,
    theme: {
      accent: '#b8336a', accentSoft: '#fbeaf1', gradient: ['#8a1f4c', '#5a1f7a'], ornament: '🪷',
      greeting: 'Happy Navratri',
      headline: 'Nine nights of colour, and a restful tenth',
      marquee: ['Happy Navratri and Dussehra'],
    },
  },
  {
    id: 'raksha-bandhan', name: 'Raksha Bandhan', durationDays: 1, priority: 45, tier: 2,
    theme: {
      accent: '#c0407a', accentSoft: '#fcecf3', gradient: ['#922d5b', '#0f1c2e'], ornament: '🪢',
      greeting: 'Happy Raksha Bandhan',
      headline: 'A thoughtful gift for a brother or sister',
      marquee: ['Happy Raksha Bandhan'],
    },
  },
  {
    id: 'ganesh-chaturthi', name: 'Ganesh Chaturthi', durationDays: 1, priority: 45, tier: 2,
    theme: {
      accent: '#c25100', accentSoft: '#fdeee0', gradient: ['#8f3a00', '#0f1c2e'], ornament: '🌺',
      greeting: 'Happy Ganesh Chaturthi',
      headline: 'New beginnings for the home',
      marquee: ['Happy Ganesh Chaturthi'],
    },
  },
  {
    id: 'pongal', name: 'Pongal & Makar Sankranti', durationDays: 3, priority: 45, tier: 2,
    theme: {
      accent: '#a86200', accentSoft: '#fdf3e0', gradient: ['#7a4600', '#2f5a1e'], ornament: '🌾☀️',
      greeting: 'Happy Pongal',
      headline: 'Harvest-season comfort for the home',
      marquee: ['Happy Pongal and Makar Sankranti'],
    },
  },
  {
    id: 'vishu', name: 'Vishu', durationDays: 1, priority: 40, tier: 2,
    theme: {
      accent: '#9a7000', accentSoft: '#fdf6dc', gradient: ['#6b4e00', '#1e5a20'], ornament: '🌼',
      greeting: 'Happy Vishu',
      headline: 'A golden start to the Malayalam new year',
      marquee: ['Vishu ashamsakal — Happy Vishu'],
    },
  },
  {
    id: 'vaisakhi', name: 'Vaisakhi', durationDays: 1, priority: 40, tier: 2,
    theme: {
      accent: '#c06000', accentSoft: '#fdf0e0', gradient: ['#8a4200', '#0f1c2e'], ornament: '🌾',
      greeting: 'Happy Vaisakhi',
      headline: 'Celebrating the harvest and the new year',
      marquee: ['Happy Vaisakhi'],
    },
  },
  {
    id: 'gurpurab', name: 'Guru Nanak Gurpurab', durationDays: 1, priority: 45, tier: 2,
    theme: {
      accent: '#b35c00', accentSoft: '#fdf0e2', gradient: ['#7a3e00', '#0f1c2e'], ornament: '🪔',
      greeting: 'Gurpurab di lakh lakh vadhaiyan',
      headline: 'Wishing every home peace and light',
      marquee: ['Happy Guru Nanak Gurpurab'],
    },
  },

  // ---- East Asian and Iranian -------------------------------------------------
  {
    id: 'lunar-new-year', name: 'Lunar New Year', durationDays: 7, priority: 70, tier: 1,
    theme: {
      accent: '#cc2a38', accentSoft: '#fdeaea', gradient: ['#9a1020', '#5a0a12'], ornament: '🧧🏮',
      greeting: 'Gong Xi Fa Cai · Happy Lunar New Year',
      headline: 'New sheets for a lucky new year',
      marquee: ['Happy Lunar New Year', 'Red and gold gift sets, wrapped for the season'],
    },
  },
  {
    id: 'nowruz', name: 'Nowruz', durationDays: 3, priority: 45, tier: 2,
    theme: {
      accent: '#3a8a3e', accentSoft: '#ecf6ec', gradient: ['#25602a', '#0f1c2e'], ornament: '🌱🌷',
      greeting: 'Nowruz Mubarak',
      headline: 'Fresh linen for a fresh spring',
      marquee: ['Nowruz Mubarak — Happy Persian New Year'],
    },
  },

  // ---- Christian ------------------------------------------------------------
  {
    id: 'good-friday', name: 'Good Friday', durationDays: 2, priority: 100, tier: 1, solemn: true,
    theme: {
      accent: '#5f6b7a', accentSoft: '#eff1f4', gradient: ['#2e3540', '#0f1c2e'], ornament: '✝',
      greeting: 'Good Friday',
      headline: 'A day of quiet reflection',
      marquee: ['Thinking of everyone observing Good Friday'],
    },
  },
  {
    id: 'easter', name: 'Easter', durationDays: 4, priority: 75, tier: 1,
    theme: {
      accent: '#7a5bb5', accentSoft: '#f2eefa', gradient: ['#4f3a80', '#0f1c2e'], ornament: '🌷🐣',
      greeting: 'Happy Easter',
      headline: 'Spring-fresh linen for Easter at home',
      marquee: ['Happy Easter', 'Soft pastels for the season'],
    },
  },
  {
    id: 'orthodox-easter', name: 'Orthodox Easter', durationDays: 2, priority: 50, tier: 2,
    theme: {
      accent: '#b8463c', accentSoft: '#fbeceb', gradient: ['#7a2620', '#0f1c2e'], ornament: '🥚🌿',
      greeting: 'Christ is Risen · Happy Easter',
      headline: 'Wishing a joyful Pascha to every home',
      marquee: ['Happy Orthodox Easter'],
    },
  },
  {
    id: 'christmas', name: 'Christmas', durationDays: 2, priority: 80, tier: 1,
    theme: {
      accent: '#c23b45', accentSoft: '#fbeaec', gradient: ['#7a1a24', '#0f3d2a'], ornament: '🎄✨',
      greeting: 'Merry Christmas',
      headline: 'Wrap them in comfort this Christmas',
      marquee: ['Merry Christmas', 'Christmas gift wrapping on every order'],
    },
  },
  {
    id: 'orthodox-christmas', name: 'Orthodox Christmas', durationDays: 1, priority: 50, tier: 2,
    theme: {
      accent: '#ba4249', accentSoft: '#fbeaec', gradient: ['#7a1e26', '#0f1c2e'], ornament: '⭐',
      greeting: 'Merry Christmas',
      headline: 'Warm wishes for Orthodox Christmas',
      marquee: ['Merry Orthodox Christmas'],
    },
  },

  // ---- Others -------------------------------------------------------------------
  {
    id: 'new-year', name: 'New Year', durationDays: 1, priority: 60, tier: 1,
    theme: {
      accent: '#8c6a1f', accentSoft: '#f7f0de', gradient: ['#0f1c2e', '#3a2a5a'], ornament: '🎆',
      greeting: 'Happy New Year',
      headline: 'New year, fresh sheets',
      marquee: ['Happy New Year from all of us'],
    },
  },
  {
    id: 'philippine-independence-day', name: 'Philippine Independence Day', durationDays: 1, priority: 40, tier: 2,
    theme: {
      accent: '#2a6acb', accentSoft: '#e9f0fb', gradient: ['#0038a8', '#7a0f1e'], ornament: '🇵🇭',
      greeting: 'Maligayang Araw ng Kalayaan',
      headline: 'Happy Independence Day to our Filipino community',
      marquee: ['Maligayang Araw ng Kalayaan — Happy Philippine Independence Day'],
    },
  },
  {
    id: 'valentines-day', name: 'Valentine’s Day', durationDays: 1, priority: 10, tier: 2,
    theme: {
      accent: '#b83a5a', accentSoft: '#fbecf0', gradient: ['#8a2a44', '#0f1c2e'], ornament: '🌹',
      greeting: 'Happy Valentine’s Day',
      headline: 'A softer bedroom, made for two',
      marquee: ['Gift wrapping for Valentine’s Day'],
    },
  },
];

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
