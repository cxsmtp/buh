import type { Order } from '@/types';

/** Default packaging allowance per parcel (Settings → Couriers). */
export const DEFAULT_PACKAGING_GRAMS = 200;
/** A size's packed weight: whole grams. */
export const WEIGHT_GRAMS_MIN = 1;
export const WEIGHT_GRAMS_MAX = 50_000;

export interface ShipmentWeight {
  /** Total grams (items + packaging), or null when a size has no weight. */
  grams: number | null;
  /** Kilograms to one decimal (2.6), or null. */
  kg: number | null;
  /** What Jeebly is booked with: whole kilograms, rounded up, at least 1 (null when unknown). */
  jeeblyKg: number | null;
  /** "Title (Size)" of each line with no weight. */
  missing: string[];
  /** "2 × King set 1.2 kg + packaging 0.2 kg = 2.6 kg → 3 kg for Jeebly" (or what is missing). */
  breakdown: string;
}

const kgText = (g: number) => `${Math.round(g / 100) / 10} kg`;

/**
 * The parcel's weight from the sizes' packed weights copied onto the order (weightGrams, a
 * snapshot taken when it was placed) plus the packaging allowance. Unknown, not guessed, when any
 * line has no weight.
 */
export function shipmentWeight(order: Pick<Order, 'items'>, packagingGrams = DEFAULT_PACKAGING_GRAMS): ShipmentWeight {
  const pack = Math.max(0, Math.round(Number(packagingGrams) || 0));
  const missing = order.items.filter((i) => !(Number(i.weightGrams) > 0)).map((i) => `${i.title} (${i.profileName})`);
  if (missing.length || !order.items.length) {
    return { grams: null, kg: null, jeeblyKg: null, missing, breakdown: missing.length ? `Add weights to these sizes: ${missing.join(', ')}` : 'No items.' };
  }
  const grams = order.items.reduce((s, i) => s + i.quantity * Math.round(Number(i.weightGrams)), 0) + pack;
  const jeeblyKg = Math.max(1, Math.ceil(grams / 1000));
  const parts = order.items.map((i) => `${i.quantity} × ${i.profileName} ${kgText(Math.round(Number(i.weightGrams)))}`);
  if (pack) parts.push(`packaging ${kgText(pack)}`);
  return {
    grams,
    kg: Math.round(grams / 100) / 10,
    jeeblyKg,
    missing: [],
    breakdown: `${parts.join(' + ')} = ${kgText(grams)} → ${jeeblyKg} kg for Jeebly`,
  };
}
