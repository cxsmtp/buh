import type { CartItem, Product } from '@/types';

/**
 * Money in the browser, done like the server does it: in whole fils (1/100 AED),
 * so 3 × AED 99.99 is AED 299.97, not 299.96999999999997.
 */
export const toFils = (aed: number) => Math.round(aed * 100);

/** "490" or "299.97". */
export const formatAed = (fils: number) => (fils % 100 === 0 ? String(fils / 100) : (fils / 100).toFixed(2));

/**
 * A size's surcharge counts only when the product has more than one size (bigger sizes cost more).
 * With one size, the product's price is what the customer pays: a surcharge copied from the
 * shop's size presets must not turn AED 105 into AED 215.
 */
export const sizeDeltaFils = (product: Pick<Product, 'profiles'>, profile: { priceDelta?: number }) =>
  (product.profiles?.length ?? 0) > 1 ? toFils(profile.priceDelta || 0) : 0;

/** What one piece of this size costs, in fils. */
export const sizePriceFils = (product: Pick<Product, 'price' | 'profiles'>, profile: { priceDelta?: number }) => toFils(product.price) + sizeDeltaFils(product, profile);

/**
 * The price to show on a card: the cheapest size that can be bought (in stock), else the
 * cheapest of all; `varies` when the sizes cost different amounts ("From AED …").
 */
export function fromPrice(product: Pick<Product, 'price' | 'profiles' | 'stockBySize'>): { fils: number; varies: boolean } {
  const all = product.profiles?.length ? product.profiles : [{ id: '', priceDelta: 0 }];
  const prices = all.map((s) => ({ fils: sizePriceFils(product, s), inStock: (product.stockBySize?.[s.id] ?? 0) > 0 }));
  const pool = prices.some((x) => x.inStock) ? prices.filter((x) => x.inStock) : prices;
  const fils = Math.min(...pool.map((x) => x.fils));
  return { fils, varies: new Set(prices.map((x) => x.fils)).size > 1 };
}

/** "AED 105", or "From AED 170" when the sizes cost different amounts. */
export function priceLabel(product: Pick<Product, 'price' | 'profiles' | 'stockBySize'>): string {
  const { fils, varies } = fromPrice(product);
  return `${varies ? 'From ' : ''}AED ${formatAed(fils)}`;
}

/** The was-price for the same size as `priceLabel` (a sale's compare-at price plus that size's surcharge). */
export function wasLabel(product: Pick<Product, 'price' | 'compareAtPrice' | 'profiles' | 'stockBySize'>): string {
  const extra = fromPrice(product).fils - toFils(product.price);
  return `AED ${formatAed(toFils(product.compareAtPrice ?? 0) + extra)}`;
}

export const unitFils = (item: CartItem) => sizePriceFils(item.product, item.selectedProfile);

export const lineFils = (item: CartItem) => unitFils(item) * item.quantity;

export const cartFils = (items: CartItem[]) => items.reduce((sum, item) => sum + lineFils(item), 0);

/** Settings → Payments "Card payment fee (%)" when nothing is saved: 3.5 (the owner's choice). */
export const DEFAULT_CARD_FEE_PERCENT = 3.5;
export const MAX_CARD_FEE_PERCENT = 10;

/**
 * The card payment fee on an order, in whole fils: `round(baseFils × percent / 100)`, half up,
 * with the base being the items plus delivery. Integer maths only (the percent has at most 2
 * decimals, so it is a whole number of basis points), the same in the browser and on the server.
 * 0, a negative or an unreadable percent: no fee.
 */
export function cardFeeFils(baseFils: number, percent: number): number {
  const bp = Math.round(Number(percent) * 100);
  if (!Number.isFinite(bp) || bp <= 0 || !Number.isFinite(baseFils) || baseFils <= 0) return 0;
  return Math.floor((Math.round(baseFils) * bp + 5000) / 10000);
}

/** "3.5" or "2.25": the percent as the owner typed it, for labels. */
export const percentText = (percent: number) => String(Math.round(Number(percent) * 100) / 100);

/** UAE VAT: 5% (Settings → Payments → VAT; off unless the shop is VAT-registered). */
export const UAE_VAT_PERCENT = 5;

/**
 * The VAT inside a VAT-inclusive total, in whole fils: `round(total × rate / (100 + rate))`, half up,
 * integer maths only (5%: round(total × 5 / 105)). Negative totals (a reversal) round the same way.
 */
export function vatInsideFils(totalFils: number, ratePercent: number = UAE_VAT_PERCENT): number {
  const bp = Math.round(ratePercent * 100);
  if (!Number.isFinite(totalFils) || bp <= 0) return 0;
  const sign = totalFils < 0 ? -1 : 1;
  const t = Math.abs(Math.round(totalFils));
  return sign * Math.floor((2 * t * bp + 10000 + bp) / (2 * (10000 + bp)));
}

/** The VAT added on top of a VAT-exclusive price, in whole fils: `round(net × rate / 100)`, half up. */
export function vatOnTopFils(netFils: number, ratePercent: number = UAE_VAT_PERCENT): number {
  const bp = Math.round(ratePercent * 100);
  if (!Number.isFinite(netFils) || bp <= 0 || netFils <= 0) return 0;
  return Math.floor((Math.round(netFils) * bp + 5000) / 10000);
}
