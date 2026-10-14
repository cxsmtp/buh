/**
 * In-memory sliding-window rate limiter with a hard cap on tracked keys, so a
 * flood of distinct keys (spoofed phones, rotating IPs) cannot exhaust memory.
 * Per-process: run a single instance, or put a shared store behind this
 * interface before scaling out.
 */

const MAX_KEYS = 50_000;

interface Bucket {
  hits: number[];
}

const buckets = new Map<string, Bucket>();

export interface LimitResult {
  ok: boolean;
  remaining: number;
  retryAfterSec: number;
}

export function rateLimit(key: string, max: number, windowMs: number, now = Date.now()): LimitResult {
  let bucket = buckets.get(key);
  if (bucket) {
    // Refresh insertion order so eviction drops the least recently used key.
    buckets.delete(key);
  } else {
    bucket = { hits: [] };
  }
  buckets.set(key, bucket);

  const since = now - windowMs;
  while (bucket.hits.length && bucket.hits[0] <= since) bucket.hits.shift();

  if (bucket.hits.length >= max) {
    return { ok: false, remaining: 0, retryAfterSec: Math.max(1, Math.ceil((bucket.hits[0] + windowMs - now) / 1000)) };
  }
  bucket.hits.push(now);

  if (buckets.size > MAX_KEYS) {
    const oldest = buckets.keys().next().value;
    if (oldest !== undefined) buckets.delete(oldest);
  }
  return { ok: true, remaining: max - bucket.hits.length, retryAfterSec: 0 };
}

export function resetRateLimit(key: string) {
  buckets.delete(key);
}

/** Test hook. */
export function _clearAllRateLimits() {
  buckets.clear();
}
