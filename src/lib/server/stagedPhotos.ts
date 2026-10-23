import type { StagedPhoto } from '@/types';
import { HttpError } from './http';
import { imageExists } from './images';
import { kvGet, kvSet } from './kv';

/**
 * The record of photos made by "Style in a bedroom" (src/lib/server/stagePhoto.ts), by stored image
 * name, in the database (kv "staging:photos", so it is in every backup). A product saved with one of
 * these photos gets it marked as styled by the server, whatever the browser sends: a styled photo
 * can't be passed off as a real one.
 */

const KEY = 'staging:photos';
const KEEP = 2000;

/**
 * The check against the product photo (src/lib/server/pictureCheck.ts), kept with the record:
 * "matches"; "does_not_match" (another design, other colours, pillow covers missing or other bedding);
 * "not_checked" (the check was off or could not run); "approved" (not checked, and the owner looked
 * and confirmed it shows exactly the product). Records from before BUH-02.25.01 have none.
 */
export type PictureCheckState = 'matches' | 'does_not_match' | 'not_checked' | 'approved';

export type StagedRecord = Omit<StagedPhoto, 'staged'> & { check?: PictureCheckState; reason?: string };

/** An AI picture that may go on a product: it matched the product photo, or the owner confirmed it. */
export function pictureAllowed(rec: StagedRecord): boolean {
  return rec.check === undefined || rec.check === 'matches' || rec.check === 'approved';
}

export function stagedRecords(): Record<string, StagedRecord> {
  const data = kvGet<Record<string, StagedRecord>>(KEY)?.data;
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

export function recordStaged(name: string, rec: StagedRecord): void {
  const all = { ...stagedRecords(), [name]: rec };
  const names = Object.keys(all);
  // Over KEEP, the oldest records of files no longer stored go. A record whose file is still stored
  // is never dropped: the photo would lose its "styled" mark the next time a product is saved.
  let over = names.length - KEEP;
  for (const old of names) {
    if (over <= 0) break;
    if (old !== name && !imageExists(old)) {
      delete all[old];
      over--;
    }
  }
  kvSet(KEY, all);
}

export function forgetStaged(name: string): void {
  const all = stagedRecords();
  if (!(name in all)) return;
  delete all[name];
  kvSet(KEY, all);
}

/**
 * A product's styled photos: those it had already, and any photo the record knows, for the photos
 * it shows now (by address). Undefined when there are none.
 */
export function stagedPhotosFor(photos: string[], before: Record<string, unknown> | undefined): Record<string, StagedPhoto> | undefined {
  const made = stagedRecords();
  const out: Record<string, StagedPhoto> = {};
  for (const url of photos) {
    if (!url || url in out) continue;
    const name = url.startsWith('/api/images/') ? url.slice('/api/images/'.length) : '';
    const prior = before?.[url] as Partial<StagedPhoto> | undefined;
    const fresh = name ? made[name] : undefined;
    // The owner's must-have: a product shows only AI pictures of exactly that product. One the check
    // rejected, or that was never checked (and not confirmed by the owner), is refused here, whoever
    // sends it (the editor, quick add, the API). A picture the product already shows stays.
    if (fresh && !prior && !pictureAllowed(fresh)) {
      throw new HttpError(
        409,
        fresh.check === 'does_not_match'
          ? `An AI picture doesn’t match the product${fresh.reason ? ` (${fresh.reason})` : ''}, so it can’t be added. Make it again, or discard it.`
          : 'An AI picture was not checked against the product photo, so it can’t be added until you confirm it shows exactly this product.',
        {},
        { code: 'picture_not_verified', check: fresh.check }
      );
    }
    const rec = fresh ? fresh : prior?.staged === true ? prior : undefined;
    if (rec) out[url] = { staged: true, source: String(rec.source ?? '').slice(0, 80), preset: String(rec.preset ?? '').slice(0, 40), at: String(rec.at ?? '').slice(0, 40) };
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * The owner looked at an AI picture that could not be checked and confirms it shows exactly the
 * product (the design, the colours, the pillow covers, nothing else on the bed). One the check
 * rejected can never be confirmed: it is made again instead.
 */
export function approveStaged(name: string): StagedRecord {
  const all = stagedRecords();
  const rec = all[name];
  if (!rec) throw new HttpError(404, 'That is not a styled photo.');
  if (rec.check === 'does_not_match') throw new HttpError(409, 'This picture doesn’t match the product, so it can’t be added. Make it again.', {}, { code: 'picture_not_verified', check: rec.check });
  if (rec.check === 'not_checked') {
    all[name] = { ...rec, check: 'approved' };
    kvSet(KEY, all);
  }
  return all[name];
}
