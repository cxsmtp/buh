/**
 * A page that was open (or an installed app that was resumed) across an update can ask for a piece
 * of the shop the new version no longer has (the card form's code, a page's code): the request
 * fails and the screen would break. The page is loaded again once, by itself, which brings the new
 * version; the bag and the details typed at checkout are saved in the browser, so nothing is lost.
 * Never in a loop: at most one automatic reload a minute, remembered for this tab.
 */
const KEY = 'buh:chunk-reload';
const AGAIN_AFTER_MS = 60_000;

/** Was this a piece of the shop's code that could not be fetched (not a bug in it)? */
export function isChunkLoadError(error: unknown): boolean {
  const e = error as { name?: unknown; message?: unknown } | null;
  const text = `${typeof e?.name === 'string' ? e.name : ''} ${typeof e?.message === 'string' ? e.message : String(error ?? '')}`;
  return /ChunkLoadError|Loading (CSS )?chunk|Failed to load chunk|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i.test(text);
}

/** May the page reload itself now (not if it already did within the last minute)? Notes that it did. */
export function mayReloadNow(storage: Pick<Storage, 'getItem' | 'setItem'> | null, now = Date.now()): boolean {
  if (!storage) return false;
  try {
    const last = Number(storage.getItem(KEY)) || 0;
    if (last && now - last < AGAIN_AFTER_MS) return false;
    storage.setItem(KEY, String(now));
    return true;
  } catch {
    // No storage (private mode): we could not remember, so never reload by ourselves.
    return false;
  }
}

/** Reload once for a chunk that failed to load. Returns whether the page is reloading. */
export function reloadOnceForChunk(error: unknown): boolean {
  if (typeof window === 'undefined' || !isChunkLoadError(error)) return false;
  let storage: Storage | null = null;
  try {
    storage = window.sessionStorage;
  } catch {
    storage = null;
  }
  if (!mayReloadNow(storage)) return false;
  window.location.reload();
  return true;
}
