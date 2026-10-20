/**
 * Settings → Search (SEO), as stored (settings key "seo"). Browser-safe types and defaults: the
 * Admin Hub edits these, the server validates them (src/lib/server/seoSettings.ts).
 *
 * Every text left empty means "automatic": the shop writes it from the catalogue, the festival
 * calendar and Settings → Delivery, and keeps it current by itself.
 */

/** auto: live from `leadDays` before the festival until it ends; off: no page (noindex); live: always live. */
export type FestivalPageMode = 'auto' | 'off' | 'live';

export interface SeoPageText {
  /** The browser tab and Google's blue link. */
  title?: string;
  /** Google's grey lines under the link. */
  description?: string;
  /** The page's heading. */
  h1?: string;
  /** The short paragraph under the heading. */
  intro?: string;
}

export interface SeoFestivalPage extends SeoPageText {
  mode?: FestivalPageMode;
}

export interface SeoSettings {
  /** Days before a festival its gift page goes live (and is linked from the home page). */
  leadDays: number;
  /** Per festival id: on/off/forced and the owner's own texts. Absent: automatic. */
  festivals: Record<string, SeoFestivalPage>;
  /** Per category id: the owner's own texts. Absent: automatic. */
  categories: Record<string, SeoPageText>;
  /** The home page's own title and description (absent: automatic, switching with the festivals). */
  home: Pick<SeoPageText, 'title' | 'description'>;
  /** Google Search Console's HTML-tag code (the content="…" value). */
  googleVerification: string;
  /** Bing Webmaster Tools' msvalidate.01 code. */
  bingVerification: string;
  /** Tell Bing (and Yandex, Seznam, Naver) about new and changed pages at once. Off by default. */
  indexNow: boolean;
}

export const DEFAULT_LEAD_DAYS = 45;
export const MIN_LEAD_DAYS = 7;
export const MAX_LEAD_DAYS = 90;

export const DEFAULT_SEO: SeoSettings = {
  leadDays: DEFAULT_LEAD_DAYS,
  festivals: {},
  categories: {},
  home: {},
  googleVerification: '',
  bingVerification: '',
  indexNow: false,
};

/**
 * Festivals that get a gift page unless the owner switches it off: the major ones where people
 * give gifts for the home. The others (Flag Day, Isra and Mi'raj, …) can be switched on.
 * Remembrance days (solemn) and days inside another festival never get one.
 */
export const GIFT_PAGE_DEFAULT_ON: readonly string[] = [
  'uae-national-day',
  'ramadan',
  'eid-al-fitr',
  'eid-al-adha',
  'diwali',
  'holi',
  'onam',
  'lunar-new-year',
  'easter',
  'christmas',
  'new-year',
  'uae-mothers-day',
  'valentines-day',
];

/** Limits for the owner's texts. */
export const SEO_LIMITS = { title: 70, description: 200, h1: 90, intro: 600 } as const;

/** What the Admin Hub's "What Google sees" lists for each page. */
export interface SeoPageView {
  kind: 'home' | 'category' | 'festival' | 'product';
  /** Category or festival id, product id; '' for home. */
  id: string;
  path: string;
  url: string;
  title: string;
  description: string;
  status: 'live' | 'waiting' | 'off' | 'evergreen';
  /** Waiting until (festival pages). */
  liveFrom?: string;
  liveUntil?: string;
  problems: string[];
  /** True when the owner wrote the title or description. */
  custom: boolean;
  /** Festival and category pages: the texts the shop would write by itself (shown as placeholders, and for Reset). */
  defaults?: Required<SeoPageText>;
  /** The owner's texts as saved (empty: automatic). */
  own?: SeoPageText;
  mode?: FestivalPageMode;
  name?: string;
}

export interface SeoOverview {
  base: string;
  sitemapUrl: string;
  robotsUrl: string;
  pages: SeoPageView[];
  schedule: Array<{ id: string; name: string; start: string; end: string; liveFrom: string; liveUntil: string; status: SeoPageView['status']; mode: FestivalPageMode; path: string }>;
  health: Array<{ id: string; label: string; ok: boolean; detail: string }>;
  productJsonLd: string | null;
  indexNow: { on: boolean; keyUrl: string | null; last: Array<{ at: string; urls: number; ok: boolean; status: number | string }> };
  settings: SeoSettings;
}
