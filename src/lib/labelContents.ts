import type { Order } from '@/types';

/**
 * The "Contents" line of the shop's own shipping label: what is in the parcel, from the order only.
 * A simple product (towels, cushions…) names its variant, since the title alone doesn't say which
 * ("Hammam Towel (Bath towel) × 2"); bed linen stays as it always was ("Jaipur Set × 1").
 */
export function labelContents(order: Pick<Order, 'items'>): string {
  const text = order.items.map((i) => `${i.title}${i.productType === 'simple' && i.profileName ? ` (${i.profileName})` : ''} × ${i.quantity}`).join('; ');
  return text.length > 110 ? `${text.slice(0, 107).trimEnd()}…` : text;
}
