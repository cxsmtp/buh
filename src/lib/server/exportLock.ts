import { HttpError } from './http';

/**
 * One export at a time (the accountant's ZIP, the audit log's CSV or JSON lines), for the whole
 * shop: each reads every bill or every month of the log, and two at once would only slow the shop
 * and use the disk twice. A second one is told to wait (429). A download nobody reads to the end
 * frees the lock after 15 minutes.
 */
let busy: object | null = null;

/** Take the lock or refuse (429). Call the returned release() when the export is done or failed (more calls do nothing). */
export function takeExportLock(maxMs = 15 * 60_000): () => void {
  if (busy) throw new HttpError(429, 'An export is already being prepared. Please wait for it to finish and try again.', {}, { code: 'export_busy' });
  const mine = {};
  busy = mine;
  const release = () => {
    clearTimeout(timer);
    if (busy === mine) busy = null;
  };
  const timer = setTimeout(release, maxMs);
  timer.unref?.();
  return release;
}
