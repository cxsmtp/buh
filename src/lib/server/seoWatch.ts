import { indexNowOn, pingIndexNow } from './indexNow';
import { kvGet, kvSet } from './kv';
import { logEvent } from './log';
import { liveFestivalPages } from './seo';

/**
 * When a festival's gift page goes live (and IndexNow is on), tell IndexNow once: the page and
 * the home page (whose title now names the festival). Checked every hour; each festival's season
 * is told once (kv `seo:pinged-live`).
 */

const DONE_KV = 'seo:pinged-live';

export async function pingNewlyLiveFestivals(now: Date = new Date()): Promise<string[]> {
  if (!indexNowOn()) return [];
  const done = new Set(kvGet<string[]>(DONE_KV)?.data ?? []);
  const fresh = liveFestivalPages(now).filter((f) => !done.has(`${f.id}@${f.start ?? 'always'}`));
  if (!fresh.length) return [];
  const r = await pingIndexNow([...fresh.map((f) => `/gifts/${f.id}`), '/'], now);
  if (r.sent) {
    for (const f of fresh) done.add(`${f.id}@${f.start ?? 'always'}`);
    kvSet(DONE_KV, [...done].slice(-200));
  }
  return fresh.map((f) => f.id);
}

let timer: NodeJS.Timeout | null = null;

export function startSeoWatch() {
  if (timer || process.env.SEO_WATCH_DISABLED === 'true') return;
  const tick = () => void pingNewlyLiveFestivals().catch((err) => logEvent('warn', 'seo_watch_failed', { error: err instanceof Error ? err.message : String(err) }));
  setTimeout(tick, 120_000).unref();
  timer = setInterval(tick, 3600_000);
  timer.unref();
}
