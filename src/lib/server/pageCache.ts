import { revalidatePath } from 'next/cache';
import { readFreshNow } from './live';

/**
 * The pages kept for 5 minutes (src/app/page.tsx, /shop/<category>, /gifts/<festival>; in memory,
 * next.config.ts isrFlushToDisk off).
 */

/** Call first when building a kept page: its settings and products are read fresh (not a copy up to 2 s old). */
export function buildingKeptPage(): void {
  readFreshNow();
}

/**
 * Rebuild the kept pages on their next visit after a product or a setting changes, so search
 * engines and shoppers see the change at once. Only works inside a request (a route handler);
 * elsewhere (timers, tests) it does nothing and the pages refresh within 5 minutes by themselves.
 * Never throws.
 */
export function refreshShopPages({ home = true }: { home?: boolean } = {}): void {
  try {
    revalidatePath('/gifts/[festival]', 'page');
    revalidatePath('/shop/[category]', 'page');
    if (home) revalidatePath('/');
  } catch {
    // outside a request: the 5-minute refresh applies
  }
}
