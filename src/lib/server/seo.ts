import { getFestival, type Festival } from '@/lib/festivals/catalog';
import { addDays, dubaiDate } from '@/lib/festivals/dates';
import { productPhoto } from '@/lib/catalogFilter';
import { toFils } from '@/lib/money';
import { cutAtWord, fitDescription, fitTitle, plainText, snippetProblems, TITLE_MAX } from '@/lib/seo/text';
import { GIFT_PAGE_DEFAULT_ON, type FestivalPageMode, type SeoOverview, type SeoPageText, type SeoPageView, type SeoSettings } from '@/lib/seo/types';
import type { Product } from '@/types';
import { getDb } from './db';
import { festivalEventsAround } from './festivalDates';
import { variantSku, parentSku } from './marketplace';
import { listProducts, type StoredProduct } from './products';
import { appUrl } from './runtimeConfig';
import { getSettings } from './settings';
import { GIFT_FESTIVALS } from './seoSettings';

/**
 * Search (SEO): what Google, Bing and the rest are shown, worked out from the catalogue, the
 * festival calendar and the settings, so it stays current by itself. White-hat only: every word
 * on a page is visible to shoppers, nothing is invented (no ratings, no reviews, no dates that are
 * not in the calendar), and the owner can override every title and description.
 *
 * Pages:
 * - /                 the shop; its title and description switch to the live festival, then back.
 * - /shop/<category>  one page per catalogue category (evergreen).
 * - /gifts/<festival> one page per festival (evergreen URL, so it keeps what it has earned):
 *   "live" from `leadDays` before the festival until it ends (indexed, linked from the home page,
 *   in the sitemap with a high priority); outside that window it stays at the same address,
 *   indexed, with the next dates. Switched off: noindex, out of the sitemap, never linked.
 * - /p/<id>           every product on sale.
 *
 * Every function takes `now`, so tests can stand on any day.
 */

export type FestivalPageStatus = 'live' | 'waiting' | 'off';

export interface FestivalPageState {
  id: string;
  name: string;
  /** The short name used in copy ("Eid al-Adha", "UAE National Day"). */
  giftName: string;
  mode: FestivalPageMode;
  status: FestivalPageStatus;
  /** The festival's next (or current) days; absent when the calendar has none. */
  start?: string;
  end?: string;
  liveFrom?: string;
  liveUntil?: string;
  /** When the page last changed state (for the sitemap's lastmod). */
  changedOn: string;
  priority: number;
}

/** Names as people search for them. */
const GIFT_NAMES: Record<string, string> = {
  'uae-national-day': 'UAE National Day',
  'eid-al-adha': 'Eid al-Adha',
  'uae-mothers-day': 'Mother’s Day',
  mawlid: 'Mawlid',
  pongal: 'Pongal',
  'navratri-dussehra': 'Navratri',
  gurpurab: 'Gurpurab',
  'isra-miraj': 'Isra and Mi’raj',
};

export function giftName(f: Pick<Festival, 'id' | 'name'>): string {
  return GIFT_NAMES[f.id] ?? f.name;
}

export const shopName = () => getSettings('brand').storeName || 'Beautiful UAE Home';
const seo = (): SeoSettings => getSettings('seo');

// ── festival pages ──────────────────────────────────────────────────────────

let eventsMemo: { today: string; at: number; events: ReturnType<typeof festivalEventsAround> } | null = null;
/** The calendar around today, worked out at most every 10 minutes (every landing page asks). */
function eventsFor(today: string) {
  if (eventsMemo && eventsMemo.today === today && Date.now() - eventsMemo.at < 10 * 60_000) return eventsMemo.events;
  let events: ReturnType<typeof festivalEventsAround> = [];
  try {
    events = festivalEventsAround(today);
  } catch {
    events = [];
  }
  eventsMemo = { today, at: Date.now(), events };
  return events;
}

/** Whether this festival has a gift page at all, and how it is run. */
export function festivalPageMode(id: string, s: SeoSettings = seo()): FestivalPageMode {
  const own = s.festivals[id]?.mode;
  if (own) return own;
  if (!GIFT_PAGE_DEFAULT_ON.includes(id)) return 'off';
  // Festivals switched off in Settings → Festival themes have no page unless switched on here.
  return getSettings('theme').disabledFestivals.includes(id) ? 'off' : 'auto';
}

export function festivalPageState(id: string, now: Date = new Date(), s: SeoSettings = seo()): FestivalPageState | null {
  const f = getFestival(id);
  if (!f || f.solemn || f.parent) return null;
  const today = dubaiDate(now);
  const mode = festivalPageMode(id, s);
  const mine = eventsFor(today).filter((e) => e.id === id).sort((a, b) => (a.start < b.start ? -1 : 1));
  const next = mine.find((e) => e.end >= today);
  const previous = [...mine].reverse().find((e) => e.end < today);
  const liveFrom = next ? addDays(next.start, -s.leadDays) : undefined;
  const inWindow = Boolean(next && liveFrom && today >= liveFrom && today <= next.end);
  const status: FestivalPageStatus = mode === 'off' ? 'off' : mode === 'live' || inWindow ? 'live' : 'waiting';
  const changedOn = status === 'live' && inWindow && liveFrom ? liveFrom : previous ? addDays(previous.end, 1) : today;
  return {
    id,
    name: f.name,
    giftName: giftName(f),
    mode,
    status,
    ...(next ? { start: next.start, end: next.end, liveFrom, liveUntil: next.end } : {}),
    changedOn,
    priority: status === 'live' ? 0.9 : 0.5,
  };
}

/** Every festival that may have a page, with its state today. */
export function festivalPages(now: Date = new Date(), s: SeoSettings = seo()): FestivalPageState[] {
  return GIFT_FESTIVALS.map((f) => festivalPageState(f.id, now, s)).filter((x): x is FestivalPageState => x !== null);
}

/** Live festival pages: the one running now first, then the nearest; ties by the festival's importance. */
export function liveFestivalPages(now: Date = new Date(), s: SeoSettings = seo()): FestivalPageState[] {
  const today = dubaiDate(now);
  const running = (p: FestivalPageState) => (p.start && p.start <= today ? 0 : 1);
  return festivalPages(now, s)
    .filter((p) => p.status === 'live')
    .sort((a, b) => running(a) - running(b) || (a.start ?? '9999') .localeCompare(b.start ?? '9999') || (getFestival(b.id)!.priority - getFestival(a.id)!.priority));
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** "8 November 2026", "8–12 November 2026", "30 November – 2 December 2026". */
export function dateText(start: string, end: string): string {
  const [ys, ms, ds] = start.split('-').map(Number);
  const [ye, me, de] = end.split('-').map(Number);
  if (start === end) return `${ds} ${MONTHS[ms - 1]} ${ys}`;
  if (ys === ye && ms === me) return `${ds}–${de} ${MONTHS[ms - 1]} ${ys}`;
  if (ys === ye) return `${ds} ${MONTHS[ms - 1]} – ${de} ${MONTHS[me - 1]} ${ys}`;
  return `${ds} ${MONTHS[ms - 1]} ${ys} – ${de} ${MONTHS[me - 1]} ${ye}`;
}

// ── delivery facts (from Settings → Delivery, never invented) ────────────────

const ALL_EMIRATES = 7;
export function deliveryArea(): { short: string; long: string; days: string } {
  const d = getSettings('delivery');
  const days = d.standardDays || '1–2 days';
  const list = d.emirates;
  if (list.length >= ALL_EMIRATES) return { short: 'Dubai, Abu Dhabi, Sharjah and all the UAE', long: 'all seven emirates: Dubai, Abu Dhabi, Sharjah, Ajman, Ras Al Khaimah, Fujairah and Umm Al Quwain', days };
  if (!list.length) return { short: 'the UAE', long: 'the UAE', days };
  const names = list.length <= 3 ? list.join(', ').replace(/, ([^,]*)$/, ' and $1') : `${list.slice(0, 3).join(', ')} and more`;
  return { short: names, long: list.join(', ').replace(/, ([^,]*)$/, ' and $1'), days };
}

/** The first title that fits in 60 characters, else the last one fitted. */
function firstFitting(candidates: string[], shop: string): string {
  for (const c of candidates) if (c.length <= TITLE_MAX) return c;
  return fitTitle(candidates[candidates.length - 1].replace(` | ${shop}`, ''), shop);
}

// ── texts: defaults and the owner's own ─────────────────────────────────────

export function festivalDefaults(p: FestivalPageState): Required<SeoPageText> {
  const shop = shopName();
  const area = deliveryArea();
  const g = p.giftName;
  const when = p.start && p.end ? dateText(p.start, p.end) : '';
  return {
    title: firstFitting([`${g} gift bedsheets & bed sets in the UAE | ${shop}`, `${g} gift bedsheets & bed sets | ${shop}`, `${g} gifts: bed linen | ${shop}`, `${g} gifts | ${shop}`], shop),
    description: fitDescription(`${g} gifts from ${shop}${when ? ` for ${when}` : ''}: bedsheets, duvet covers and bed sets, delivered to ${area.short} in ${area.days}.`),
    h1: `${g} gifts: bedsheets and bed sets`,
    intro: `Bed linen is a gift that is used every day.${when ? ` ${g} is on ${when}.` : ''} Here are our pieces for ${g}, delivered to ${area.long} in ${area.days}.`,
  };
}

export function festivalTexts(p: FestivalPageState, s: SeoSettings = seo()): Required<SeoPageText> {
  const d = festivalDefaults(p);
  const own = s.festivals[p.id] ?? {};
  return { title: own.title || d.title, description: own.description || d.description, h1: own.h1 || d.h1, intro: own.intro || d.intro };
}

export interface CategoryPage {
  id: string;
  label: string;
  path: string;
}

export function categoryPages(): CategoryPage[] {
  return getSettings('catalog').categories.map((c) => ({ id: c.id, label: c.label, path: `/shop/${c.id}` }));
}

export function categoryDefaults(c: CategoryPage, products: Product[] = productsIn(c.id)): Required<SeoPageText> {
  const shop = shopName();
  const area = deliveryArea();
  const n = products.length;
  const from = n ? Math.min(...products.map((p) => p.price)) : 0;
  return {
    title: firstFitting([`${c.label} online in the UAE | ${shop}`, `${c.label} in the UAE | ${shop}`, `${c.label} | ${shop}`], shop),
    description: fitDescription(
      n
        ? `${c.label} from ${shop}: ${n} ${n === 1 ? 'design' : 'designs'} from AED ${from}, delivered to ${area.short} in ${area.days}.`
        : `${c.label} from ${shop}, delivered to ${area.short} in ${area.days}. New pieces are on their way.`,
    ),
    h1: c.label,
    intro: `${n ? `${n} ${n === 1 ? 'piece' : 'pieces'}` : 'Our pieces'} in ${c.label}, delivered to ${area.long} in ${area.days}.`,
  };
}

export function categoryTexts(c: CategoryPage, s: SeoSettings = seo(), products?: Product[]): Required<SeoPageText> {
  const d = categoryDefaults(c, products);
  const own = s.categories[c.id] ?? {};
  return { title: own.title || d.title, description: own.description || d.description, h1: own.h1 || d.h1, intro: own.intro || d.intro };
}

/** The home page's title and description: the owner's, else the live festival's, else the everyday ones. */
export function homeTexts(now: Date = new Date(), s: SeoSettings = seo()): { title: string; description: string; festival: FestivalPageState | null } {
  const shop = shopName();
  const area = deliveryArea();
  const festival = liveFestivalPages(now, s)[0] ?? null;
  const g = festival?.giftName;
  const title =
    s.home.title ||
    (g
      ? firstFitting([`${g} gift bedsheets & bed sets in the UAE | ${shop}`, `${g} gift bedsheets & bed sets | ${shop}`, `${g} gifts: bedsheets | ${shop}`], shop)
      : firstFitting([`${shop} | Bedsheets & bed sets in the UAE`, `${shop} | Bed linen in the UAE`], shop));
  const description =
    s.home.description ||
    fitDescription(
      g
        ? `${g} gifts: bedsheets, duvet covers and bed sets from ${shop}, delivered to ${area.short} in ${area.days}.`
        : `Hand block and machine printed bedsheets, duvet covers and bed sets, fitted for deep UAE mattresses. Delivered to ${area.short} in ${area.days}.`,
    );
  return { title, description, festival };
}

// ── products ────────────────────────────────────────────────────────────────

export function productsIn(categoryId: string): StoredProduct[] {
  return listProducts().filter((p) => p.category === categoryId);
}

export function productTitle(p: Pick<Product, 'title' | 'seoTitle'>): string {
  return p.seoTitle || fitTitle(p.title, shopName());
}

export function productDescription(p: Pick<Product, 'title' | 'seoDescription' | 'shortDescription' | 'description' | 'category'>): string {
  if (p.seoDescription) return p.seoDescription;
  const from = plainText(p.shortDescription || '') || plainText(p.description || '');
  if (from) return fitDescription(from);
  const label = getSettings('catalog').categories.find((c) => c.id === p.category)?.label;
  return fitDescription(`${p.title}${label ? `, ${label.toLowerCase()}` : ''} from ${shopName()}, delivered across the UAE.`);
}

/** The photo's alt text: what it shows (the name, and its colours when there are some). */
export function productAlt(p: Pick<Product, 'title' | 'colors'>): string {
  const colours = p.colors.map((c) => c.name).filter(Boolean).slice(0, 3);
  return cutAtWord(`${p.title}${colours.length ? ` in ${colours.join(', ').replace(/, ([^,]*)$/, ' and $1')}` : ''}`, 125);
}

const abs = (base: string, u: string) => (!u ? '' : u.startsWith('http') ? u : `${base}${u}`);

/** The photos a page may show (styled photos only while the shop labels them, as in the feeds). */
export function productImages(p: Product, base: string): string[] {
  const label = getSettings('ai').labelStyledPhotos !== false;
  const all = [productPhoto(p), p.featuredImage, ...(p.galleryImages ?? [])].filter((u) => u && (label || !p.stagedPhotos?.[u]));
  return [...new Set(all)].slice(0, 6).map((u) => abs(base, u));
}

// ── structured data (schema.org JSON-LD) ────────────────────────────────────

/** JSON for a <script type="application/ld+json">: < and line separators escaped, so nothing in a product name can end the script. */
export function jsonLdString(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

const aedText = (fils: number) => (fils / 100).toFixed(2);

function dayRange(text: string): { min: number; max: number } | null {
  const nums = (text.match(/\d+/g) ?? []).map(Number).filter((n) => n >= 0 && n < 60);
  if (!nums.length) return null;
  return { min: Math.min(...nums), max: Math.max(...nums) };
}

/** Delivery to the UAE: standard delivery is free (orders.ts DELIVERY_FEE), in the days Settings → Delivery says. */
function shippingDetails() {
  const days = dayRange(getSettings('delivery').standardDays);
  return {
    '@type': 'OfferShippingDetails',
    shippingRate: { '@type': 'MonetaryAmount', value: '0.00', currency: 'AED' },
    shippingDestination: { '@type': 'DefinedRegion', addressCountry: 'AE' },
    ...(days
      ? {
          deliveryTime: {
            '@type': 'ShippingDeliveryTime',
            handlingTime: { '@type': 'QuantitativeValue', minValue: 0, maxValue: 1, unitCode: 'DAY' },
            transitTime: { '@type': 'QuantitativeValue', minValue: days.min, maxValue: days.max, unitCode: 'DAY' },
          },
        }
      : {}),
  };
}

/**
 * A product, as schema.org: one Offer per size (its own SKU, price from fils, in stock or not).
 * Never a rating or review: the shop has none to show. No priceValidUntil (the shop sets no end date).
 */
export function productJsonLd(p: Product, base: string) {
  const url = `${base}/p/${encodeURIComponent(p.id)}`;
  const shop = shopName();
  const category = getSettings('catalog').categories.find((c) => c.id === p.category)?.label;
  const offers = p.profiles.map((s) => ({
    '@type': 'Offer',
    sku: variantSku(p, s.id),
    name: s.name,
    url,
    priceCurrency: 'AED',
    price: aedText(toFils(p.price) + toFils(s.priceDelta || 0)),
    availability: (p.stockBySize?.[s.id] ?? 0) > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
    itemCondition: 'https://schema.org/NewCondition',
    seller: { '@type': 'Organization', name: shop },
    shippingDetails: shippingDetails(),
  }));
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    '@id': `${url}#product`,
    name: p.title,
    description: plainText(p.description || p.shortDescription || '').slice(0, 5000) || productDescription(p),
    sku: parentSku(p),
    image: productImages(p, base),
    url,
    brand: { '@type': 'Brand', name: shop },
    ...(category ? { category } : {}),
    ...(p.material ? { material: p.material } : {}),
    ...(p.colors.length ? { color: p.colors.map((c) => c.name).join(', ') } : {}),
    offers,
  };
}

export function breadcrumbJsonLd(base: string, items: Array<{ name: string; path: string }>) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: it.name, item: `${base}${it.path}` })),
  };
}

export function itemListJsonLd(base: string, name: string, products: Product[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name,
    numberOfItems: products.length,
    itemListElement: products.slice(0, 50).map((p, i) => ({ '@type': 'ListItem', position: i + 1, url: `${base}/p/${encodeURIComponent(p.id)}`, name: p.title })),
  };
}

/**
 * The shop itself: an Organization and a WebSite (no SearchAction: the shop's search is inside the
 * app, not a page a search engine can open), and an OnlineStore with only what the owner entered
 * (phone, WhatsApp, address, social accounts); nothing is made up.
 */
export function siteJsonLd(base: string) {
  const brand = getSettings('brand');
  const store = getSettings('store');
  const shop = shopName();
  const sameAs = [
    store.instagramHandle ? `https://www.instagram.com/${store.instagramHandle.replace(/^@/, '')}` : '',
    /^https:\/\//.test(store.facebookUrl) ? store.facebookUrl : '',
    store.tiktokHandle ? `https://www.tiktok.com/@${store.tiktokHandle.replace(/^@/, '')}` : '',
  ].filter(Boolean);
  const logo = brand.logoType === 'image' && brand.logoImageUrl ? abs(base, brand.logoImageUrl) : `${base}/icons/icon-512.png`;
  const phone = /^\+?\d[\d ]{6,20}$/.test(store.whatsappNumber) ? store.whatsappNumber.replace(/\s+/g, '') : '';
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'OnlineStore',
      '@id': `${base}/#organization`,
      name: shop,
      url: `${base}/`,
      logo,
      ...(brand.tagline ? { slogan: brand.tagline } : {}),
      ...(phone ? { telephone: phone, contactPoint: { '@type': 'ContactPoint', telephone: phone, contactType: 'customer service', areaServed: 'AE' } } : {}),
      ...(store.storeAddress ? { address: { '@type': 'PostalAddress', streetAddress: store.storeAddress, addressCountry: 'AE' } } : {}),
      areaServed: { '@type': 'Country', name: 'United Arab Emirates' },
      ...(sameAs.length ? { sameAs } : {}),
    },
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      '@id': `${base}/#website`,
      name: shop,
      url: `${base}/`,
      inLanguage: 'en',
      publisher: { '@id': `${base}/#organization` },
    },
  ];
}

// ── landing pages' products ─────────────────────────────────────────────────

/** A festival page's products: those with a gift line for it first (with the line), then the rest by fit (featured, in stock). */
export function festivalProducts(id: string): Array<{ product: StoredProduct; giftLine: string }> {
  const fit = (p: StoredProduct) => (p.stockCount > 0 ? 0 : 4) + (p.isFeatured ? 0 : 1) + (p.isNewArrival ? 0 : 1);
  return listProducts()
    .map((p, i) => ({ product: p, giftLine: p.giftLines?.[id] ?? '', i }))
    .sort((a, b) => (a.giftLine ? 0 : 1) - (b.giftLine ? 0 : 1) || fit(a.product) - fit(b.product) || a.i - b.i)
    .map(({ product, giftLine }) => ({ product, giftLine }));
}

// ── links between the pages ─────────────────────────────────────────────────

/**
 * Links for the foot of a landing page (and the home page): the categories that have products,
 * and the festival pages that are not switched off, live ones first (with their dates).
 * `liveOnly`: the home page links the live festivals only.
 */
export function exploreLinks(now: Date = new Date(), { liveOnly = false, exclude = '' } = {}): { categories: Array<{ href: string; label: string; note?: string }>; festivals: Array<{ href: string; label: string; note?: string }> } {
  const products = listProducts();
  const categories = categoryPages()
    .filter((c) => c.path !== exclude && products.some((p) => p.category === c.id))
    .map((c) => ({ href: c.path, label: c.label }));
  const live = liveFestivalPages(now);
  const waiting = liveOnly ? [] : festivalPages(now).filter((f) => f.status === 'waiting' && f.start).sort((a, b) => a.start!.localeCompare(b.start!)).slice(0, 8);
  const festivals = [...live, ...waiting]
    .filter((f) => `/gifts/${f.id}` !== exclude)
    .map((f) => ({ href: `/gifts/${f.id}`, label: `${f.giftName} gifts`, ...(f.start && f.end ? { note: dateText(f.start, f.end) } : {}) }));
  return { categories, festivals };
}

// ── sitemap ─────────────────────────────────────────────────────────────────

export interface SitemapEntry {
  url: string;
  lastModified?: string;
  changeFrequency: 'daily' | 'weekly' | 'monthly';
  priority: number;
  images?: string[];
}

function productDates(): Map<string, string> {
  const rows = getDb().prepare('SELECT id, updated_at FROM products').all() as Array<{ id: string; updated_at: string | null }>;
  return new Map(rows.map((r) => [r.id, r.updated_at ?? '']));
}

/**
 * Every page a search engine should know: the shop, its category pages, the festival pages that
 * are not switched off (a high priority and a fresh date while live), and every product on sale.
 * Never: hidden or removed products, shared selections (/c), private pages (pay, invoice), the
 * APIs or anything of the Admin Hub.
 */
export function sitemapEntries(base: string, now: Date = new Date()): SitemapEntry[] {
  const s = seo();
  const dates = productDates();
  const products = listProducts();
  const latest = [...dates.values()].filter(Boolean).sort().pop();
  const out: SitemapEntry[] = [{ url: `${base}/`, changeFrequency: 'daily', priority: 1, ...(latest ? { lastModified: latest } : {}) }];
  for (const c of categoryPages()) {
    const inIt = products.filter((p) => p.category === c.id);
    const last = inIt.map((p) => dates.get(p.id) ?? '').filter(Boolean).sort().pop();
    out.push({ url: `${base}${c.path}`, changeFrequency: 'weekly', priority: 0.8, ...(last ? { lastModified: last } : {}) });
  }
  for (const f of festivalPages(now, s)) {
    if (f.status === 'off') continue;
    out.push({ url: `${base}/gifts/${f.id}`, changeFrequency: f.status === 'live' ? 'daily' : 'monthly', priority: f.priority, lastModified: f.changedOn });
  }
  for (const p of products) {
    const d = dates.get(p.id);
    out.push({ url: `${base}/p/${encodeURIComponent(p.id)}`, changeFrequency: 'weekly', priority: 0.7, ...(d ? { lastModified: d } : {}), images: productImages(p, base).slice(0, 3) });
  }
  return out;
}

// ── the Admin Hub's view ────────────────────────────────────────────────────

const problemsOf = (title: string, description: string) => snippetProblems({ title, description });

export function seoOverview(base: string, now: Date = new Date(), extra: { indexNow: SeoOverview['indexNow'] }): SeoOverview {
  const s = seo();
  const pages: SeoPageView[] = [];
  const home = homeTexts(now, s);
  pages.push({ kind: 'home', id: '', path: '/', url: `${base}/`, title: home.title, description: home.description, status: home.festival ? 'live' : 'evergreen', problems: problemsOf(home.title, home.description), custom: Boolean(s.home.title || s.home.description), own: s.home, name: 'Home page' });
  for (const c of categoryPages()) {
    const list = productsIn(c.id);
    const t = categoryTexts(c, s, list);
    const own = s.categories[c.id] ?? {};
    pages.push({ kind: 'category', id: c.id, path: c.path, url: `${base}${c.path}`, title: t.title, description: t.description, status: 'evergreen', problems: [...problemsOf(t.title, t.description), ...(list.length ? [] : ['No products'])], custom: Boolean(own.title || own.description || own.h1 || own.intro), defaults: categoryDefaults(c, list), own, name: c.label });
  }
  const schedule: SeoOverview['schedule'] = [];
  for (const f of festivalPages(now, s)) {
    const t = festivalTexts(f, s);
    const own = s.festivals[f.id] ?? {};
    const path = `/gifts/${f.id}`;
    pages.push({ kind: 'festival', id: f.id, path, url: `${base}${path}`, title: t.title, description: t.description, status: f.status, liveFrom: f.liveFrom, liveUntil: f.liveUntil, problems: problemsOf(t.title, t.description), custom: Boolean(own.title || own.description || own.h1 || own.intro), defaults: festivalDefaults(f), own: { title: own.title, description: own.description, h1: own.h1, intro: own.intro }, mode: f.mode, name: f.giftName });
    if (f.start && f.end) schedule.push({ id: f.id, name: f.giftName, start: f.start, end: f.end, liveFrom: f.liveFrom!, liveUntil: f.liveUntil!, status: f.status, mode: f.mode, path });
  }
  schedule.sort((a, b) => a.start.localeCompare(b.start));
  const products = listProducts();
  const titles = new Map<string, number>();
  for (const p of products) {
    const t = productTitle(p);
    titles.set(t.toLowerCase(), (titles.get(t.toLowerCase()) ?? 0) + 1);
  }
  for (const p of products) {
    const title = productTitle(p);
    const description = productDescription(p);
    const problems = problemsOf(title, description);
    if (!plainText(p.shortDescription || '') && !plainText(p.description || '') && !p.seoDescription) problems.push('No description written');
    if ((titles.get(title.toLowerCase()) ?? 0) > 1) problems.push('Same title as another product');
    if (!productPhoto(p)) problems.push('No photo');
    pages.push({ kind: 'product', id: p.id, path: `/p/${p.id}`, url: `${base}/p/${encodeURIComponent(p.id)}`, title, description, status: 'evergreen', problems, custom: Boolean(p.seoTitle || p.seoDescription), own: { title: p.seoTitle, description: p.seoDescription }, defaults: { title: fitTitle(p.title, shopName()), description: productDescription({ ...p, seoDescription: undefined }), h1: p.title, intro: '' }, name: p.title });
  }
  const productPages = pages.filter((p) => p.kind === 'product');
  const count = (label: string) => productPages.filter((p) => p.problems.includes(label)).length;
  const health: SeoOverview['health'] = [
    { id: 'descriptions', label: 'Products with a description', ok: count('No description written') === 0, detail: count('No description written') ? `${count('No description written')} without one: Google then shows whatever it finds.` : 'Every product has one.' },
    { id: 'duplicates', label: 'Titles all different', ok: count('Same title as another product') === 0, detail: count('Same title as another product') ? `${count('Same title as another product')} products share a title with another.` : 'No two products share a title.' },
    { id: 'titles', label: 'Titles fit Google (15–60 characters)', ok: !pages.some((p) => p.problems.some((x) => x.startsWith('Title'))), detail: `${pages.filter((p) => p.problems.some((x) => x.startsWith('Title'))).length} of ${pages.length} pages need a look.` },
    { id: 'descriptionLength', label: 'Descriptions fit Google (50–155 characters)', ok: !pages.some((p) => p.problems.some((x) => x.startsWith('Description'))), detail: `${pages.filter((p) => p.problems.some((x) => x.startsWith('Description'))).length} of ${pages.length} pages need a look.` },
    { id: 'photos', label: 'Every product has a photo (with alt text from its name)', ok: count('No photo') === 0, detail: count('No photo') ? `${count('No photo')} without a photo.` : 'Yes.' },
    { id: 'address', label: 'Shop address set (NEXT_PUBLIC_APP_URL)', ok: Boolean(appUrl()), detail: appUrl() ? base : 'Not set: links use the address each visitor typed.' },
    { id: 'google', label: 'Google Search Console verified', ok: Boolean(s.googleVerification), detail: s.googleVerification ? 'Code saved: it is on the home page.' : 'Paste the code from Search Console below.' },
    { id: 'bing', label: 'Bing Webmaster Tools verified', ok: Boolean(s.bingVerification), detail: s.bingVerification ? 'Code saved: it is on the home page.' : 'Optional: paste the msvalidate.01 code below.' },
  ];
  const sample = products.find((p) => productPhoto(p)) ?? products[0];
  return {
    base,
    sitemapUrl: `${base}/sitemap.xml`,
    robotsUrl: `${base}/robots.txt`,
    pages,
    schedule,
    health,
    productJsonLd: sample ? JSON.stringify(productJsonLd(sample, base), null, 2) : null,
    indexNow: extra.indexNow,
    settings: s,
  };
}

export { dubaiDate };
