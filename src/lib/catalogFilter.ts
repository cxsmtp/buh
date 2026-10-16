import type { Product } from '@/types';

/**
 * Browsing the shop: search, filters and sort, kept in the address bar so a filtered view can be
 * shared and Back works. Pure functions (no React, no browser): the storefront and the tests use
 * the same code. Facets are worked out from the products actually in the shop, so a filter only
 * appears when it would make a difference.
 *
 * Address bar keys: q (search), cat, size, color (comma-separated), min, max (AED, max exclusive),
 * stock=1 (in stock only), sale=1, new=1, sort (new | price-asc | price-desc; "featured" is left out).
 */

export type SortKey = 'featured' | 'new' | 'price-asc' | 'price-desc';
export const SORTS: Array<{ id: SortKey; label: string }> = [
  { id: 'featured', label: 'Featured' },
  { id: 'new', label: 'Newest' },
  { id: 'price-asc', label: 'Price: low to high' },
  { id: 'price-desc', label: 'Price: high to low' },
];

export interface Filters {
  q: string;
  cats: string[];
  sizes: string[];
  /** Colour families (blue, green, cream…), from each colour's swatch. */
  colors: string[];
  min: number | null;
  max: number | null;
  inStock: boolean;
  sale: boolean;
  newIn: boolean;
  sort: SortKey;
}

export const EMPTY_FILTERS: Filters = { q: '', cats: [], sizes: [], colors: [], min: null, max: null, inStock: false, sale: false, newIn: false, sort: 'featured' };

export interface Category {
  id: string;
  label: string;
  icon: string;
}

const MAX_LIST = 20;
const MAX_VALUE = 60;

function list(value: string | null): string[] {
  if (!value) return [];
  const seen = new Set<string>();
  for (const part of value.split(',')) {
    const v = part.trim().slice(0, MAX_VALUE);
    if (v && seen.size < MAX_LIST) seen.add(v);
  }
  return [...seen];
}

function amount(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 1_000_000 ? Math.round(n) : null;
}

/** Filters from a query string (anything unknown or malformed is ignored). */
export function parseFilters(search: string | URLSearchParams): Filters {
  const p = typeof search === 'string' ? new URLSearchParams(search) : search;
  const sort = p.get('sort');
  let min = amount(p.get('min'));
  let max = amount(p.get('max'));
  if (min !== null && max !== null && min >= max) [min, max] = [null, null];
  return {
    q: (p.get('q') || '').slice(0, 80),
    cats: list(p.get('cat')),
    sizes: list(p.get('size')),
    colors: list(p.get('color')).map((c) => c.toLowerCase()),
    min,
    max,
    inStock: p.get('stock') === '1',
    sale: p.get('sale') === '1',
    newIn: p.get('new') === '1',
    sort: SORTS.some((s) => s.id === sort) ? (sort as SortKey) : 'featured',
  };
}

const FILTER_KEYS = ['q', 'cat', 'size', 'color', 'min', 'max', 'stock', 'sale', 'new', 'sort'];

/**
 * The query string for these filters, keeping any other keys already there (e.g. ?p= for an open
 * product). Returns "" or "?…".
 */
export function filtersToSearch(f: Filters, base: string | URLSearchParams = ''): string {
  const p = new URLSearchParams(typeof base === 'string' ? base : base.toString());
  for (const k of FILTER_KEYS) p.delete(k);
  if (f.q.trim()) p.set('q', f.q.trim());
  if (f.cats.length) p.set('cat', f.cats.join(','));
  if (f.sizes.length) p.set('size', f.sizes.join(','));
  if (f.colors.length) p.set('color', f.colors.join(','));
  if (f.min !== null) p.set('min', String(f.min));
  if (f.max !== null) p.set('max', String(f.max));
  if (f.inStock) p.set('stock', '1');
  if (f.sale) p.set('sale', '1');
  if (f.newIn) p.set('new', '1');
  if (f.sort !== 'featured') p.set('sort', f.sort);
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** How many filters are on (search and sort not counted): the number on the Filter button. */
export function activeCount(f: Filters): number {
  return f.cats.length + f.sizes.length + f.colors.length + (f.min !== null || f.max !== null ? 1 : 0) + (f.inStock ? 1 : 0) + (f.sale ? 1 : 0) + (f.newIn ? 1 : 0);
}

export const isOnSale = (p: Product) => typeof p.compareAtPrice === 'number' && p.compareAtPrice > p.price;
const piecesOf = (p: Product, sizeId: string) => p.stockBySize?.[sizeId] ?? 0;

/** "King Size Bed (Most Popular)" → "King"; "Single / Twin Bed" → "Single". */
export function shortSize(name: string): string {
  const s = name.replace(/\(.*?\)/g, '').split('/')[0].replace(/\b(size|bed)\b/gi, '').replace(/\s+/g, ' ').trim();
  return s || name;
}

function fold(text: string): string {
  return text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** A colour family: what a shopper means by "blue" or "cream", worked out from a colour's swatch. */
export interface ColorFamily {
  id: string;
  label: string;
  swatch: string;
}

export const COLOR_FAMILIES: ColorFamily[] = [
  { id: 'cream', label: 'White & cream', swatch: '#f3eee2' },
  { id: 'grey', label: 'Grey', swatch: '#8a8a8a' },
  { id: 'black', label: 'Black', swatch: '#222222' },
  { id: 'red', label: 'Red & pink', swatch: '#b8474a' },
  { id: 'orange', label: 'Orange & terracotta', swatch: '#c0703c' },
  { id: 'yellow', label: 'Yellow & gold', swatch: '#d4a63a' },
  { id: 'green', label: 'Green', swatch: '#6f7755' },
  { id: 'blue', label: 'Blue & indigo', swatch: '#2b3a5a' },
  { id: 'purple', label: 'Purple', swatch: '#6b4a8a' },
];

/** The family of a #rrggbb colour (null when it isn't one). */
export function colorFamily(hex: string): ColorFamily | null {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return null;
  const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const chroma = max - min;
  const light = (max + min) / 2;
  const byId = (id: string) => COLOR_FAMILIES.find((f) => f.id === id)!;
  if (chroma < 0.06) return byId(light >= 0.8 ? 'cream' : light <= 0.2 ? 'black' : 'grey');
  let hue = max === r ? ((g - b) / chroma) % 6 : max === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4;
  hue = (hue * 60 + 360) % 360;
  // Pale, soft warm shades (oatmeal, ivory, sand) are what people call cream.
  if (light >= 0.75 && chroma < 0.2 && (hue < 70 || hue >= 330)) return byId('cream');
  if (hue < 10 || hue >= 330) return byId('red');
  if (hue < 38) return byId('orange');
  if (hue < 70) return byId('yellow');
  if (hue < 170) return byId('green');
  if (hue < 260) return byId('blue');
  return byId('purple');
}

const familiesOf = (p: Product) => new Set(p.colors.map((c) => colorFamily(c.hex)?.id).filter((x): x is string => Boolean(x)));

/** Every word typed is somewhere in the name, category, colours or material. */
export function matchesSearch(p: Product, q: string, categories: Category[] = []): boolean {
  const words = fold(q).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const label = categories.find((c) => c.id === p.category)?.label ?? '';
  const hay = fold([p.title, label, p.material, p.weave, ...p.colors.map((c) => c.name)].join(' '));
  return words.every((w) => hay.includes(w));
}

type Facet = 'cat' | 'size' | 'color' | 'price' | 'stock' | 'sale' | 'new' | 'q';

/** Does the product pass every filter (except the one named, for counting that facet's options)? */
export function matches(p: Product, f: Filters, categories: Category[] = [], except?: Facet): boolean {
  if (except !== 'q' && f.q && !matchesSearch(p, f.q, categories)) return false;
  if (except !== 'cat' && f.cats.length && !f.cats.includes(p.category)) return false;
  if (except !== 'color' && f.colors.length) {
    const fams = familiesOf(p);
    if (!f.colors.some((c) => fams.has(c))) return false;
  }
  if (except !== 'price') {
    if (f.min !== null && p.price < f.min) return false;
    if (f.max !== null && p.price >= f.max) return false;
  }
  if (except !== 'sale' && f.sale && !isOnSale(p)) return false;
  if (except !== 'new' && f.newIn && !p.isNewArrival) return false;
  const sizes = except === 'size' ? [] : f.sizes;
  const inStock = except === 'stock' ? false : f.inStock;
  if (sizes.length) {
    const offered = p.profiles.filter((s) => sizes.includes(s.id));
    if (!offered.length) return false;
    if (inStock && !offered.some((s) => piecesOf(p, s.id) > 0)) return false;
  } else if (inStock && !(p.stockCount > 0)) {
    return false;
  }
  return true;
}

function sortProducts(products: Product[], sort: SortKey): Product[] {
  const out = [...products];
  if (sort === 'new') out.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  else if (sort === 'price-asc') out.sort((a, b) => a.price - b.price);
  else if (sort === 'price-desc') out.sort((a, b) => b.price - a.price);
  return out; // Array.prototype.sort is stable: equal items keep the shop's own order
}

/** The products to show, in order. */
export function applyFilters(products: Product[], f: Filters, categories: Category[] = []): Product[] {
  return sortProducts(
    products.filter((p) => matches(p, f, categories)),
    f.sort
  );
}

export interface Option {
  id: string;
  label: string;
  count: number;
  selected: boolean;
  /** A colour's swatch. */
  hex?: string;
}

export interface PriceBand {
  min: number | null;
  max: number | null;
  label: string;
  count: number;
  selected: boolean;
}

export interface Facets {
  categories: Option[];
  sizes: Option[];
  colors: Option[];
  prices: PriceBand[];
  /** Toggles, with how many products each would leave; null when it would make no difference. */
  inStock: number | null;
  sale: number | null;
  newIn: number | null;
  /** The products matching everything (what "Show N" shows). */
  total: number;
}

function niceStep(raw: number): number {
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= raw) return m * pow;
  return 10 * pow;
}

export function priceLabel(min: number | null, max: number | null): string {
  if (min !== null && max !== null) return `AED ${min}–${max}`;
  if (max !== null) return `Under AED ${max}`;
  if (min !== null) return `AED ${min} and over`;
  return 'Any price';
}

/** Up to four price ranges with round edges, covering every price in the shop. */
export function priceBands(prices: number[]): Array<{ min: number | null; max: number | null }> {
  if (prices.length < 2) return [];
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  if (hi - lo < 1) return [];
  const step = niceStep((hi - lo) / 3);
  const edges: number[] = [];
  for (let e = (Math.floor(lo / step) + 1) * step; e <= hi; e += step) edges.push(e);
  if (!edges.length) return [];
  const bands: Array<{ min: number | null; max: number | null }> = [{ min: null, max: edges[0] }];
  for (let i = 1; i < edges.length; i++) bands.push({ min: edges[i - 1], max: edges[i] });
  bands.push({ min: edges[edges.length - 1], max: null });
  return bands.length <= 4 ? bands : [...bands.slice(0, 3), { min: bands[3].min, max: null }];
}

/** "relevant" toggles: only offered when they would change what is shown (or are already on). */
function toggleCount(products: Product[], on: boolean, test: (p: Product) => boolean): number | null {
  const n = products.filter(test).length;
  if (on) return n;
  return n > 0 && n < products.length ? n : null;
}

/**
 * The filter options worth showing for these products: each option's count is what the shop
 * would show with it chosen (keeping the other filters). Options with nothing behind them are
 * left out unless chosen; a facet with a single option is left out (it would filter nothing).
 */
export function computeFacets(products: Product[], f: Filters, categories: Category[] = []): Facets {
  const without = (facet: Facet) => products.filter((p) => matches(p, f, categories, facet));

  const catBase = without('cat');
  const categoriesOut: Option[] = categories
    .filter((c) => products.some((p) => p.category === c.id) || f.cats.includes(c.id))
    .map((c) => ({ id: c.id, label: c.label, count: catBase.filter((p) => p.category === c.id).length, selected: f.cats.includes(c.id) }));

  const sizeBase = without('size');
  const sizeMap = new Map<string, string>();
  for (const p of products) for (const s of p.profiles) if (!sizeMap.has(s.id)) sizeMap.set(s.id, shortSize(s.name));
  const sizes: Option[] = [...sizeMap].map(([id, label]) => ({
    id,
    label,
    count: sizeBase.filter((p) => p.profiles.some((s) => s.id === id && (!f.inStock || piecesOf(p, id) > 0))).length,
    selected: f.sizes.includes(id),
  }));

  const colorBase = without('color');
  const present = new Set<string>(f.colors);
  for (const p of products) for (const id of familiesOf(p)) present.add(id);
  const colors: Option[] = COLOR_FAMILIES.filter((fam) => present.has(fam.id)).map((fam) => ({
    id: fam.id,
    label: fam.label,
    hex: fam.swatch,
    count: colorBase.filter((p) => familiesOf(p).has(fam.id)).length,
    selected: f.colors.includes(fam.id),
  }));

  const priceBase = without('price');
  const bands = priceBands(products.map((p) => p.price));
  // A range chosen from a link that isn't one of today's bands still shows (so it can be cleared).
  if ((f.min !== null || f.max !== null) && !bands.some((b) => b.min === f.min && b.max === f.max)) bands.push({ min: f.min, max: f.max });
  const prices: PriceBand[] = bands.map((b) => ({
    ...b,
    label: priceLabel(b.min, b.max),
    count: priceBase.filter((p) => (b.min === null || p.price >= b.min) && (b.max === null || p.price < b.max)).length,
    selected: b.min === f.min && b.max === f.max,
  }));

  const relevant = (opts: Option[]) => {
    const kept = opts.filter((o) => o.count > 0 || o.selected);
    return kept.length > 1 || kept.some((o) => o.selected) ? kept : [];
  };
  const keptPrices = prices.filter((b) => b.count > 0 || b.selected);

  return {
    categories: relevant(categoriesOut),
    sizes: relevant(sizes),
    colors: relevant(colors),
    prices: keptPrices.length > 1 || keptPrices.some((b) => b.selected) ? keptPrices : [],
    inStock: toggleCount(without('stock'), f.inStock, (p) => (f.sizes.length ? p.profiles.some((s) => f.sizes.includes(s.id) && piecesOf(p, s.id) > 0) : p.stockCount > 0)),
    sale: toggleCount(without('sale'), f.sale, isOnSale),
    newIn: toggleCount(without('new'), f.newIn, (p) => Boolean(p.isNewArrival)),
    total: products.filter((p) => matches(p, f, categories)).length,
  };
}

export interface Chip {
  key: string;
  label: string;
  /** The filters without this one. */
  without: Filters;
}

/** The filters that are on, each removable on its own. */
export function activeChips(f: Filters, products: Product[], categories: Category[] = []): Chip[] {
  const chips: Chip[] = [];
  if (f.q.trim()) chips.push({ key: 'q', label: `“${f.q.trim()}”`, without: { ...f, q: '' } });
  for (const id of f.cats) chips.push({ key: `cat:${id}`, label: categories.find((c) => c.id === id)?.label ?? id, without: { ...f, cats: f.cats.filter((c) => c !== id) } });
  const sizeName = (id: string) => {
    for (const p of products) for (const s of p.profiles) if (s.id === id) return shortSize(s.name);
    return id;
  };
  for (const id of f.sizes) chips.push({ key: `size:${id}`, label: `Size: ${sizeName(id)}`, without: { ...f, sizes: f.sizes.filter((s) => s !== id) } });
  for (const id of f.colors) chips.push({ key: `color:${id}`, label: COLOR_FAMILIES.find((c) => c.id === id)?.label ?? id, without: { ...f, colors: f.colors.filter((c) => c !== id) } });
  if (f.min !== null || f.max !== null) chips.push({ key: 'price', label: priceLabel(f.min, f.max), without: { ...f, min: null, max: null } });
  if (f.inStock) chips.push({ key: 'stock', label: 'In stock', without: { ...f, inStock: false } });
  if (f.sale) chips.push({ key: 'sale', label: 'On sale', without: { ...f, sale: false } });
  if (f.newIn) chips.push({ key: 'new', label: 'New in', without: { ...f, newIn: false } });
  return chips;
}

/** Everything off except the search and the sort. */
export const clearFilters = (f: Filters): Filters => ({ ...EMPTY_FILTERS, q: f.q, sort: f.sort });

export interface Story {
  id: string;
  label: string;
  /** The first photo in it, for the round chip. */
  image: string;
  icon: string;
  /** The filters the story shows (from the current ones: search and sort stay). */
  apply: (f: Filters) => Filters;
  isActive: (f: Filters) => boolean;
}

export const productPhoto = (p: Product) => p.aiTransformedImage || p.featuredImage || p.galleryImages?.[0] || '';

/**
 * The round "story" chips at the top of the shop: All, New in and On sale (when there are such
 * products), then each category from Settings → Catalogue that has products, in the owner's order.
 */
export function buildStories(products: Product[], categories: Category[]): Story[] {
  const pick = (f: Filters, patch: Partial<Filters>): Filters => ({ ...f, cats: [], newIn: false, sale: false, ...patch });
  const stories: Story[] = [];
  const first = (test: (p: Product) => boolean) => productPhoto(products.find(test) ?? ({} as Product)) || '';
  stories.push({ id: 'all', label: 'All', icon: '✨', image: products[0] ? productPhoto(products[0]) : '', apply: (f) => pick(f, {}), isActive: (f) => !f.cats.length && !f.newIn && !f.sale });
  // A story that would show everything (every piece is new, or there is one category) is left out.
  const narrows = (test: (p: Product) => boolean) => {
    const n = products.filter(test).length;
    return n > 0 && n < products.length;
  };
  if (narrows((p) => Boolean(p.isNewArrival))) {
    stories.push({ id: 'new', label: 'New in', icon: '🌟', image: first((p) => Boolean(p.isNewArrival)), apply: (f) => pick(f, { newIn: true }), isActive: (f) => f.newIn && !f.cats.length && !f.sale });
  }
  if (narrows(isOnSale)) {
    stories.push({ id: 'sale', label: 'On sale', icon: '🏷️', image: first(isOnSale), apply: (f) => pick(f, { sale: true }), isActive: (f) => f.sale && !f.cats.length && !f.newIn });
  }
  for (const c of categories) {
    if (!narrows((p) => p.category === c.id)) continue;
    stories.push({
      id: `cat:${c.id}`,
      label: c.label,
      icon: c.icon,
      image: first((p) => p.category === c.id),
      apply: (f) => pick(f, { cats: [c.id] }),
      isActive: (f) => f.cats.length === 1 && f.cats[0] === c.id && !f.newIn && !f.sale,
    });
  }
  return stories;
}
