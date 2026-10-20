import { FESTIVALS } from '@/lib/festivals/catalog';
import { cleanSeoText, verificationCode } from '@/lib/seo/text';
import { MAX_LEAD_DAYS, MIN_LEAD_DAYS, SEO_LIMITS, type FestivalPageMode, type SeoFestivalPage, type SeoPageText, type SeoSettings } from '@/lib/seo/types';
import { HttpError } from './http';

/**
 * Settings → Search (SEO): the validator (an allow-list; every text one plain line, capped). Kept
 * apart from settings.ts so that file only names it. Unknown festivals and fields are dropped;
 * category ids are kept as given (a category may be added later), capped at 60 entries.
 */

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});

/** Festivals that may have a gift page: not remembrance days, not days inside another festival. */
export const GIFT_FESTIVALS = FESTIVALS.filter((f) => !f.solemn && !f.parent);
const GIFT_IDS = new Set(GIFT_FESTIVALS.map((f) => f.id));
const MODES: FestivalPageMode[] = ['auto', 'off', 'live'];
const CATEGORY_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

function pageText(v: unknown, field: string, keys: Array<keyof SeoPageText> = ['title', 'description', 'h1', 'intro']): SeoPageText {
  const o = obj(v);
  const out: SeoPageText = {};
  for (const k of Object.keys(o)) if (!keys.includes(k as keyof SeoPageText) && k !== 'mode') throw new HttpError(400, `${field}: unexpected field ${k.slice(0, 30)}.`);
  for (const k of keys) {
    const raw = o[k];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'string') throw new HttpError(400, `${field} ${k} must be text.`);
    if (raw.length > SEO_LIMITS[k] + 100) throw new HttpError(400, `${field} ${k}: at most ${SEO_LIMITS[k]} characters.`);
    const t = cleanSeoText(raw, SEO_LIMITS[k]);
    if (t) out[k] = t;
  }
  return out;
}

export function validateSeoSettings(input: Obj, current: SeoSettings): SeoSettings {
  const allowed = ['leadDays', 'festivals', 'categories', 'home', 'googleVerification', 'bingVerification', 'indexNow'];
  const extra = Object.keys(input).find((k) => !allowed.includes(k));
  if (extra) throw new HttpError(400, `Unexpected field: ${extra.slice(0, 40)}.`);

  const lead = input.leadDays === undefined ? current.leadDays : Number(input.leadDays);
  if (!Number.isInteger(lead) || lead < MIN_LEAD_DAYS || lead > MAX_LEAD_DAYS) throw new HttpError(400, `Days before a festival: a whole number from ${MIN_LEAD_DAYS} to ${MAX_LEAD_DAYS}.`);

  let festivals = current.festivals;
  if (input.festivals !== undefined) {
    festivals = {};
    for (const [id, v] of Object.entries(obj(input.festivals))) {
      if (!GIFT_IDS.has(id)) continue;
      const o = obj(v);
      const mode = o.mode === undefined || o.mode === null ? 'auto' : o.mode;
      if (!MODES.includes(mode as FestivalPageMode)) throw new HttpError(400, 'A festival page is automatic, off or always live.');
      // A mode given is kept, "auto" too: it switches on a festival that has no page by default.
      const page: SeoFestivalPage = { ...pageText(o, 'Festival page'), ...(o.mode !== undefined && o.mode !== null ? { mode: mode as FestivalPageMode } : {}) };
      if (Object.keys(page).length) festivals[id] = page;
    }
  }

  let categories = current.categories;
  if (input.categories !== undefined) {
    categories = {};
    const entries = Object.entries(obj(input.categories));
    if (entries.length > 60) throw new HttpError(400, 'Too many category pages.');
    for (const [id, v] of entries) {
      if (!CATEGORY_ID.test(id)) continue;
      const page = pageText(v, 'Category page');
      if (Object.keys(page).length) categories[id] = page;
    }
  }

  const home = input.home === undefined ? current.home : pageText(input.home, 'Home page', ['title', 'description']);

  const code = (v: unknown, now: string, name: string) => {
    if (v === undefined) return now;
    if (v === null) return '';
    const c = verificationCode(v);
    if (c === null) throw new HttpError(400, `${name}: paste the code from the content="…" part of the meta tag (letters, digits, - and _ only).`);
    return c;
  };

  return {
    leadDays: lead,
    festivals,
    categories,
    home,
    googleVerification: code(input.googleVerification, current.googleVerification, 'Google verification code'),
    bingVerification: code(input.bingVerification, current.bingVerification, 'Bing verification code'),
    indexNow: typeof input.indexNow === 'boolean' ? input.indexNow : current.indexNow,
  };
}
