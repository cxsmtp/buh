/**
 * In-memory sliding-window rate limiter with a hard cap on tracked keys, so a
 * flood of distinct keys (spoofed phones, rotating IPs) cannot exhaust memory.
 * Per-process: run a single instance, or put a shared store behind this
 * interface before scaling out.
 *
 * Keys starting with "global:" are shop-wide counters. They live outside the
 * capped map, so a flood of other keys can never evict (and so reset) them.
 * Keys starting with "scan-" (the scanner slow-down's counts, made by any 404) have a
 * capped map of their own, so a flood of 404s can't evict sign-in or phone counters.
 */

const MAX_KEYS = 50_000;

interface Bucket {
  hits: number[];
}

const buckets = new Map<string, Bucket>();
const globalBuckets = new Map<string, Bucket>();
const scanBuckets = new Map<string, Bucket>();

function storeFor(key: string): Map<string, Bucket> {
  return key.startsWith('global:') ? globalBuckets : key.startsWith('scan-') ? scanBuckets : buckets;
}

export interface LimitResult {
  ok: boolean;
  remaining: number;
  retryAfterSec: number;
}

export interface LimitRule {
  key: string;
  max: number;
  windowMs: number;
}

function bucketFor(key: string, create: boolean): Bucket | undefined {
  const store = storeFor(key);
  let bucket = store.get(key);
  if (!bucket) {
    if (!create) return undefined;
    bucket = { hits: [] };
  } else if (store !== globalBuckets) {
    // Refresh insertion order so eviction drops the least recently used key.
    store.delete(key);
  }
  store.set(key, bucket);
  return bucket;
}

function prune(bucket: Bucket, windowMs: number, now: number) {
  const since = now - windowMs;
  while (bucket.hits.length && bucket.hits[0] <= since) bucket.hits.shift();
}

function evictIfFull(now: number, store: Map<string, Bucket> = buckets) {
  if (store === globalBuckets || store.size <= MAX_KEYS) return;
  // Prefer keys whose hits have all expired; only then the least recently used.
  for (const [key, bucket] of store) {
    const last = bucket.hits[bucket.hits.length - 1];
    if (last === undefined || now - last > 60 * 60 * 1000) store.delete(key);
    if (store.size <= MAX_KEYS * 0.9) return;
  }
  while (store.size > MAX_KEYS) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

function verdict(bucket: Bucket | undefined, rule: LimitRule, now: number): LimitResult {
  const hits = bucket?.hits ?? [];
  if (hits.length >= rule.max) {
    return { ok: false, remaining: 0, retryAfterSec: Math.max(1, Math.ceil((hits[0] + rule.windowMs - now) / 1000)) };
  }
  return { ok: true, remaining: rule.max - hits.length - 1, retryAfterSec: 0 };
}

/**
 * Check several limits as one: nothing is counted unless every limit allows
 * the request. So a request refused by one limit (say, per address) does not
 * use up another (say, the shop-wide cap or a phone number's allowance).
 * Returns the first refusing rule, or null when all passed and were counted.
 */
export function takeAll(rules: LimitRule[], now = Date.now()): { rule: LimitRule; result: LimitResult } | null {
  for (const rule of rules) {
    const bucket = bucketFor(rule.key, false);
    if (bucket) prune(bucket, rule.windowMs, now);
    const result = verdict(bucket, rule, now);
    if (!result.ok) return { rule, result };
  }
  for (const rule of rules) bucketFor(rule.key, true)!.hits.push(now);
  for (const store of new Set(rules.map((r) => storeFor(r.key)))) evictIfFull(now, store);
  return null;
}

export function rateLimit(key: string, max: number, windowMs: number, now = Date.now()): LimitResult {
  const refused = takeAll([{ key, max, windowMs }], now);
  if (refused) return refused.result;
  return { ok: true, remaining: max - (bucketFor(key, false)?.hits.length ?? 0), retryAfterSec: 0 };
}

/** Would one more hit be allowed? Counts nothing (pair it with recordHit once the thing really happened). */
export function peekLimit(key: string, max: number, windowMs: number, now = Date.now()): LimitResult {
  const bucket = bucketFor(key, false);
  if (bucket) prune(bucket, windowMs, now);
  return verdict(bucket, { key, max, windowMs }, now);
}

/** Count one hit, e.g. a test email that was actually sent. */
export function recordHit(key: string, now = Date.now()) {
  bucketFor(key, true)!.hits.push(now);
  evictIfFull(now, storeFor(key));
}

export function resetRateLimit(key: string) {
  storeFor(key).delete(key);
}

/** Test hook. */
export function _clearAllRateLimits() {
  buckets.clear();
  globalBuckets.clear();
  scanBuckets.clear();
}

/** Test hook: how many keys each store holds. */
export function _rateLimitSizes() {
  return { keys: buckets.size, global: globalBuckets.size, scan: scanBuckets.size };
}
