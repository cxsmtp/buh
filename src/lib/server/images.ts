import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './dataDir';
import { HttpError } from './http';
import { imageDimensions, parseImageDataUrl } from './imageInput';

/** The logo is drawn into the app's icons: at most this many pixels on a side (a phone photo is ~4000). */
export const LOGO_MAX_SIDE = 4096;

/**
 * Uploaded images (product photos, logo) are stored as files named by their
 * SHA-256, and served from /api/images/<name>. Pages then carry a short URL
 * instead of megabytes of base64, and the same photo is stored once.
 */

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
export const IMAGE_NAME = /^[a-f0-9]{64}\.(png|jpg|webp)$/;
export const MIME_BY_EXT: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

function imagesDir(): string {
  const dir = path.join(dataDir(), 'images');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function saveImageDataUrl(dataUrl: string, maxBytes = 3 * 1024 * 1024): string {
  const { mime, bytes } = parseImageDataUrl(dataUrl, maxBytes);
  const name = `${crypto.createHash('sha256').update(bytes).digest('hex')}.${EXT[mime]}`;
  const file = path.join(imagesDir(), name);
  if (!fs.existsSync(file)) fs.writeFileSync(file, bytes, { mode: 0o600 });
  return `/api/images/${name}`;
}

export function readImage(name: string): { bytes: Buffer; mime: string } | null {
  if (!IMAGE_NAME.test(name)) return null;
  try {
    return { bytes: fs.readFileSync(path.join(imagesDir(), name)), mime: MIME_BY_EXT[name.split('.')[1]] };
  } catch {
    return null;
  }
}

/**
 * An image reference a person may save on a product or the logo: one of our
 * stored images, an https URL, or a data URL (stored, and replaced by its URL).
 */
export function acceptImageRef(value: unknown, field: string, { required = false, maxSide = 0 } = {}): string {
  if (value === undefined || value === null || value === '') {
    if (required) throw new HttpError(400, `${field} is required.`);
    return '';
  }
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be an image.`);
  // maxSide: refuse an image bigger than this (read from its header), e.g. the logo.
  const checkSize = (bytes: Buffer) => {
    if (!maxSide) return;
    const d = imageDimensions(bytes);
    if (!d || d.width > maxSide || d.height > maxSide || d.width < 1 || d.height < 1) {
      throw new HttpError(400, `${field} must be at most ${maxSide} × ${maxSide} pixels.`);
    }
  };
  if (value.startsWith('data:')) {
    if (maxSide) checkSize(parseImageDataUrl(value, 3 * 1024 * 1024).bytes);
    return saveImageDataUrl(value);
  }
  if (value.startsWith('/api/images/') && IMAGE_NAME.test(value.slice('/api/images/'.length))) {
    // An image already stored: refused only if it is readably too big (an older logo whose size
    // can't be read must not block saving the other branding; it is drawn as letters anyway).
    if (maxSide) {
      const img = readImage(value.slice('/api/images/'.length));
      const d = img ? imageDimensions(img.bytes) : null;
      if (d) checkSize(img!.bytes);
    }
    return value;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, `${field} must be an https image URL or an uploaded image.`);
  }
  if (url.protocol !== 'https:' || value.length > 2000) {
    throw new HttpError(400, `${field} must be an https image URL or an uploaded image.`);
  }
  return url.href;
}
