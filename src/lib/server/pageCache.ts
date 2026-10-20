import { revalidatePath } from 'next/cache';
import { readFreshNow } from './live';

/**
 * The pages kept for a while (src/app/page.tsx 5 minutes; /shop/<category> and /gifts/<festival>
 * a minute, as they show prices and stock), in memory (next.config.ts isrFlushToDisk off).
 *
 * A change made inside a request (a save) rebuilds them on their next visit. A change made
 * outside one (a timer returning stock, the other copy of the shop during an update) bumps the
 * change counters: the first request that notices (products.ts listProducts, settings.ts
 * getSettings) rebuilds them; failing that, the minute runs out.
 */

/** Call first when building a kept page: its settings and products are read fresh (not a copy up to 2 s old). */
export function buildingKeptPage(): void {
  readFreshNow();
}

/**
 * Rebuild the kept pages on their next visit after a product or a setting changes, so search
 * engines and shoppers see the change at once. Only works inside a request (a route handler);
 * elsewhere (timers, tests) it does nothing and the counters (above) or the time limit refresh them.
 * Never throws.
 */
export function refreshShopPages({ home = true }: { home?: boolean } = {}): void {
  try {
    revalidatePath('/gifts/[festival]', 'page');
    revalidatePath('/shop/[category]', 'page');
    if (home) revalidatePath('/');
  } catch {
    // outside a request: the change counters or the time limit refresh them
  }
}
