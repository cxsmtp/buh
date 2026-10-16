import type { BedProfileMeasurement, Product } from '@/types';

/**
 * Stock levels as the Admin Hub shows them: sold out (0), low (at or below the
 * threshold from Settings → Catalogue, 2 by default) or fine. Each size's chip
 * is coloured by its own level; a product counts as low or sold out by its
 * total, for the filters and the badge on the Inventory tab.
 */

export const DEFAULT_LOW_STOCK = 2;

export type StockLevel = 'out' | 'low' | 'ok';

export function stockLevel(qty: number, low = DEFAULT_LOW_STOCK): StockLevel {
  return qty <= 0 ? 'out' : qty <= low ? 'low' : 'ok';
}

/** "King (180x200)" → "King": short enough for a chip on a phone. */
export function shortSizeName(s: BedProfileMeasurement): string {
  return (s.badge || s.name).replace(/\s*\(.*\)\s*$/, '').trim() || s.name;
}

type Listed = Product & { archived?: boolean };

/** Shown, not removed: what the owner sells right now. */
const onSale = (p: Listed) => !p.archived && p.active !== false;

const total = (p: Listed) => p.profiles.reduce((n, s) => n + Math.max(0, p.stockBySize[s.id] ?? 0), 0);

/** No piece left in any size: it cannot be bought. */
export function isSoldOut(p: Listed): boolean {
  return total(p) === 0;
}

/**
 * Running low: a few pieces left in all (at or below the threshold), not none. Most designs
 * are one or two pieces per size, so a single size at 1 is normal; the chips show each size.
 */
export function isLow(p: Listed, low = DEFAULT_LOW_STOCK): boolean {
  const t = total(p);
  return t > 0 && t <= low;
}

/** The products on sale that need the owner: sold out or running low. Drives the badge. */
export function stockAlerts(products: Listed[], low = DEFAULT_LOW_STOCK) {
  const live = products.filter(onSale);
  const soldOut = live.filter(isSoldOut);
  const running = live.filter((p) => isLow(p, low));
  return { soldOut, low: running, count: soldOut.length + running.length };
}

/** A fresh idempotency key for one change (works on plain http too, where randomUUID may be missing). */
export function newKey(prefix = 'm'): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `${prefix}-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
