import { kvGet, kvSet } from './kv';
import { logEvent } from './log';

/**
 * Exchange rates from AED, for showing visitors abroad an approximate price in
 * their own currency (they always pay in AED). Fetched at most daily from a
 * free public source and kept in the database; if the source is down, the
 * last rates are used (and nothing is shown when there have never been any).
 */

const SOURCE = 'https://open.er-api.com/v6/latest/AED';
const MAX_AGE_MS = 24 * 3600_000;
/** Currencies of the shop's likely visitors; others are not shown. */
export const CURRENCIES = [
  'USD', 'EUR', 'GBP', 'INR', 'PKR', 'PHP', 'BDT', 'LKR', 'NPR', 'SAR', 'OMR', 'QAR', 'KWD', 'BHD', 'EGP', 'JOD',
  'CNY', 'RUB', 'CAD', 'AUD', 'CHF', 'TRY', 'IRR', 'ZAR', 'NGN', 'KES', 'SGD', 'MYR', 'IDR', 'JPY', 'KRW', 'UAH',
];

export interface Rates {
  base: 'AED';
  rates: Record<string, number>;
  fetchedAt: string;
}

let inFlight: Promise<void> | null = null;

async function refresh(fetcher: (url: string) => Promise<unknown>): Promise<void> {
  try {
    const body = (await fetcher(SOURCE)) as { result?: string; rates?: Record<string, unknown> };
    if (body?.result !== 'success' || !body.rates) throw new Error('unexpected reply');
    const rates: Record<string, number> = {};
    for (const c of CURRENCIES) {
      const r = body.rates[c];
      if (typeof r === 'number' && Number.isFinite(r) && r > 0 && r < 1e7) rates[c] = r;
    }
    if (Object.keys(rates).length < 5) throw new Error('too few rates');
    kvSet('fx', { base: 'AED', rates, fetchedAt: new Date().toISOString() } satisfies Rates);
  } catch (err) {
    logEvent('warn', 'fx_refresh_failed', { error: err instanceof Error ? err.message : String(err) });
    // Keep the old rates; try again in an hour rather than on every request.
    const old = kvGet<Rates>('fx')?.data;
    if (old) kvSet('fx', { ...old, retryAfter: Date.now() + 3600_000 });
  }
}

const defaultFetcher = async (url: string) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > 200_000) throw new Error('reply too large');
  return JSON.parse(text);
};

/** The current rates (refreshing in the background when a day old). */
export function getRates(fetcher: (url: string) => Promise<unknown> = defaultFetcher): Rates | null {
  const stored = kvGet<Rates & { retryAfter?: number }>('fx')?.data ?? null;
  const stale = !stored || Date.now() - Date.parse(stored.fetchedAt) > MAX_AGE_MS;
  const waiting = stored?.retryAfter && Date.now() < stored.retryAfter;
  if (stale && !waiting && !inFlight && process.env.FX_DISABLED !== 'true') {
    inFlight = refresh(fetcher).finally(() => (inFlight = null));
  }
  return stored ? { base: 'AED', rates: stored.rates, fetchedAt: stored.fetchedAt } : null;
}

/** Test hook: wait for a background refresh. */
export function _fxInFlight() {
  return inFlight;
}
