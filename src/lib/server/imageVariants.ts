import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './dataDir';
import { diskRoomProblem } from './diskRoom';
import { imageDimensions } from './imageInput';
import { IMAGE_NAME, readImage } from './images';
import { logEvent } from './log';

/**
 * Smaller copies of the shop's own photos, so a phone card downloads a photo the size of the card
 * instead of the 1600 px original: /api/images/<name>?w=240|540|1080.
 *
 * - Only these widths (anything else gets the original), only for a photo that is stored.
 * - Made on the first request, never bigger than the original (a photo already that small is
 *   served as it is), in the original's format, with its metadata left out.
 * - Kept in DATA_DIR/cache/images, named by the original's content hash and the width. The folder
 *   is not part of any backup: it can be deleted at any time and fills itself again. It holds at
 *   most CACHE_MAX_BYTES (the oldest copies go first) and is not written when the disk is nearly full.
 * - The resizer (sharp) comes with Next.js as an optional package. If it is not there, or a photo
 *   cannot be read by it, the original is served: the shop looks the same, only heavier.
 */

export const IMAGE_WIDTHS = [240, 540, 1080] as const;
export type ImageWidth = (typeof IMAGE_WIDTHS)[number];

export const CACHE_MAX_BYTES = 300 * 1024 * 1024;
const MIN_FREE_BYTES = 200 * 1024 * 1024;
/** A photo larger than this on a side is not resized here (uploads are at most 4096). */
const MAX_SIDE = 4096;

/** The width asked for, if it is one we make. */
export function variantWidth(v: unknown): ImageWidth | null {
  const n = typeof v === 'string' && /^\d{1,4}$/.test(v) ? Number(v) : NaN;
  return (IMAGE_WIDTHS as readonly number[]).includes(n) ? (n as ImageWidth) : null;
}

export function variantsDir(): string {
  const dir = path.join(dataDir(), 'cache', 'images');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

type Resize = (bytes: Buffer, width: number, format: 'png' | 'jpg' | 'webp') => Promise<Buffer>;

let resizer: Promise<Resize | null> | null = null;
/** The resizer, loaded once (null when the package is not there). */
function loadResizer(): Promise<Resize | null> {
  resizer ??= import('sharp')
    .then((m) => {
      const sharp = m.default;
      // One photo at a time on one thread, nothing kept in memory between photos: a small server stays responsive.
      sharp.cache(false);
      sharp.concurrency(1);
      const resize: Resize = async (bytes, width, format) => {
        // rotate(): a phone photo's "this way up" note is applied, then left out with the rest of the metadata.
        const img = sharp(bytes, { limitInputPixels: MAX_SIDE * MAX_SIDE, failOn: 'error' }).rotate().resize({ width, withoutEnlargement: true });
        if (format === 'jpg') return img.jpeg({ quality: 80, mozjpeg: true }).toBuffer();
        if (format === 'webp') return img.webp({ quality: 80 }).toBuffer();
        return img.png({ compressionLevel: 9 }).toBuffer();
      };
      return resize;
    })
    .catch((err) => {
      logEvent('warn', 'image_resizer_unavailable', { error: err instanceof Error ? err.message : String(err) });
      return null;
    });
  return resizer;
}

/** Test hook: put another resizer in (or none), or go back to the real one (undefined). */
export function _setImageResizer(r: Resize | null | undefined) {
  resizer = r === undefined ? null : Promise.resolve(r);
  useOriginal.clear();
}

// One piece of work per copy, and one resize at a time (the rest wait their turn).
const making = new Map<string, Promise<Buffer | null>>();
let queue: Promise<unknown> = Promise.resolve();

// Copies that could not be made, or were no lighter: the original is sent, without trying again
// on each request (until the shop restarts).
const useOriginal = new Set<string>();
function noteUseOriginal(key: string) {
  if (useOriginal.size >= 5000) useOriginal.clear();
  useOriginal.add(key);
}

/** Keep the folder under its cap: the copies made longest ago go first. */
function trimCache(dir: string, maxBytes = CACHE_MAX_BYTES): void {
  try {
    const files = fs.readdirSync(dir).flatMap((f) => {
      try {
        const st = fs.statSync(path.join(dir, f));
        return st.isFile() ? [{ f, size: st.size, at: st.mtimeMs }] : [];
      } catch {
        return [];
      }
    });
    let total = files.reduce((n, x) => n + x.size, 0);
    if (total <= maxBytes) return;
    for (const x of files.sort((a, b) => a.at - b.at)) {
      if (total <= maxBytes * 0.8) break;
      try {
        fs.unlinkSync(path.join(dir, x.f));
        total -= x.size;
      } catch {
        // gone already
      }
    }
  } catch {
    // the folder is not readable: nothing to trim
  }
}
export const _trimImageCache = trimCache;

async function make(name: string, width: ImageWidth, original: Buffer, file: string): Promise<Buffer | null> {
  const resize = await loadResizer();
  if (!resize) return null;
  let bytes: Buffer;
  try {
    bytes = await resize(original, width, name.split('.')[1] as 'png' | 'jpg' | 'webp');
  } catch (err) {
    logEvent('warn', 'image_resize_failed', { name, width, error: err instanceof Error ? err.message : String(err) });
    noteUseOriginal(path.basename(file));
    return null;
  }
  const dir = path.dirname(file);
  // A copy that came out no lighter than the original is not worth sending: an empty file is kept
  // in its place, so the photo is not resized again on every request.
  if (!bytes.length || bytes.length >= original.length) {
    noteUseOriginal(path.basename(file));
    try {
      fs.writeFileSync(file, Buffer.alloc(0), { mode: 0o600 });
    } catch {
      // remembered in memory only
    }
    return null;
  }
  if (!diskRoomProblem(dir, bytes.length, MIN_FREE_BYTES)) {
    try {
      const tmp = `${file}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
      fs.writeFileSync(tmp, bytes, { mode: 0o600 });
      fs.renameSync(tmp, file);
      trimCache(dir);
    } catch (err) {
      logEvent('warn', 'image_cache_write_failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }
  return bytes;
}

/**
 * A stored photo at this width: the kept copy, a new one, or the original itself (when it is
 * already that small, or no copy could be made). Null: no such photo.
 */
export async function readImageVariant(name: string, width: ImageWidth): Promise<{ bytes: Buffer; mime: string; resized: boolean } | null> {
  if (!IMAGE_NAME.test(name) || !(IMAGE_WIDTHS as readonly number[]).includes(width)) return null;
  const image = readImage(name);
  if (!image) return null;
  const asIs = { ...image, resized: false };
  const file = path.join(variantsDir(), `${name.slice(0, 64)}-w${width}.${name.split('.')[1]}`);
  if (useOriginal.has(path.basename(file))) return asIs;
  try {
    const kept = fs.readFileSync(file);
    // An empty file: a copy was tried and was no lighter than the original.
    return kept.length ? { bytes: kept, mime: image.mime, resized: true } : asIs;
  } catch {
    // not made yet
  }
  // Never bigger than the original; a size that cannot be read, or an oversized photo, is left alone.
  const d = imageDimensions(image.bytes);
  if (!d || d.width <= width || d.width > MAX_SIDE || d.height > MAX_SIDE) return asIs;
  const key = path.basename(file);
  let work = making.get(key);
  if (!work) {
    work = (queue = queue.then(
      () => make(name, width, image.bytes, file),
      () => make(name, width, image.bytes, file)
    )) as Promise<Buffer | null>;
    making.set(key, work);
    void work.finally(() => making.delete(key)).catch(() => undefined);
  }
  const bytes = await work.catch(() => null);
  return bytes ? { bytes, mime: image.mime, resized: true } : asIs;
}
