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
