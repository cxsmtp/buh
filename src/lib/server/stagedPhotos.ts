import type { StagedPhoto } from '@/types';
import { kvGet, kvSet } from './kv';

/**
 * The record of photos made by "Style in a bedroom" (src/lib/server/stagePhoto.ts), by stored image
 * name, in the database (kv "staging:photos", so it is in every backup). A product saved with one of
 * these photos gets it marked as styled by the server, whatever the browser sends: a styled photo
 * can't be passed off as a real one.
 */

const KEY = 'staging:photos';
const KEEP = 2000;

export type StagedRecord = Omit<StagedPhoto, 'staged'>;

export function stagedRecords(): Record<string, StagedRecord> {
  const data = kvGet<Record<string, StagedRecord>>(KEY)?.data;
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

export function recordStaged(name: string, rec: StagedRecord): void {
  const all = { ...stagedRecords(), [name]: rec };
  const names = Object.keys(all);
  // The newest KEEP (a styled photo older than that is on its product by now, or was never used).
  for (const old of names.slice(0, Math.max(0, names.length - KEEP))) delete all[old];
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
    const rec = name && made[name] ? made[name] : prior?.staged === true ? prior : undefined;
    if (rec) out[url] = { staged: true, source: String(rec.source ?? '').slice(0, 80), preset: String(rec.preset ?? '').slice(0, 40), at: String(rec.at ?? '').slice(0, 40) };
  }
  return Object.keys(out).length ? out : undefined;
}
