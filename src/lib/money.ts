import type { CartItem } from '@/types';

/**
 * Money in the browser, done like the server does it: in whole fils (1/100 AED),
 * so 3 × AED 99.99 is AED 299.97, not 299.96999999999997.
 */
export const toFils = (aed: number) => Math.round(aed * 100);

/** "490" or "299.97". */
export const formatAed = (fils: number) => (fils % 100 === 0 ? String(fils / 100) : (fils / 100).toFixed(2));

export const unitFils = (item: CartItem) => toFils(item.product.price) + toFils(item.selectedProfile.priceDelta || 0);

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
