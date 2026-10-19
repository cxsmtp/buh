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

// ── images made on the server (Style in a bedroom) ──────────────────────────

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** PNG chunks kept: the picture and how its colours are meant (text, dates, EXIF and the rest go). */
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'pHYs']);

function stripPng(bytes: Buffer): Buffer | null {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(PNG_SIG)) return null;
  const out: Buffer[] = [PNG_SIG];
  let i = 8;
  let first = true;
  let ended = false;
  let sawData = false;
  while (i + 12 <= bytes.length) {
    const len = bytes.readUInt32BE(i);
    const type = bytes.toString('latin1', i + 4, i + 8);
    if (len > bytes.length - i - 12 || !/^[A-Za-z]{4}$/.test(type)) return null;
    if (first && type !== 'IHDR') return null;
    first = false;
    if (type === 'IDAT') sawData = true;
    if (PNG_KEEP.has(type)) out.push(bytes.subarray(i, i + 12 + len));
    i += 12 + len;
    if (type === 'IEND') {
      ended = true;
      break;
    }
  }
  return ended && sawData ? Buffer.concat(out) : null;
}

function stripJpeg(bytes: Buffer): Buffer | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const out: Buffer[] = [bytes.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd9) return null; // the end before any picture data
    const len = bytes.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > bytes.length) return null;
    if (marker === 0xda) {
      // Start of scan: the picture data runs to the end marker; copied as it is.
      const rest = bytes.subarray(i);
      if (rest.length < 4 || rest[rest.length - 2] !== 0xff || rest[rest.length - 1] !== 0xd9) return null;
      out.push(rest);
      return Buffer.concat(out);
    }
    // APP1–APP13 and APP15 (EXIF, XMP, C2PA…) and comments go; JFIF (APP0) and Adobe (APP14, colour) stay.
    const metadata = (marker >= 0xe1 && marker <= 0xef && marker !== 0xee) || marker === 0xfe;
    if (!metadata) out.push(bytes.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  return null;
}

function stripWebp(bytes: Buffer): Buffer | null {
  if (bytes.length < 30 || bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WEBP') return null;
  const end = Math.min(bytes.length, 8 + bytes.readUInt32LE(4));
  const chunks: Buffer[] = [];
  let i = 12;
  let picture = false;
  while (i + 8 <= end) {
    const type = bytes.toString('latin1', i, i + 4);
    const len = bytes.readUInt32LE(i + 4);
    const size = 8 + len + (len % 2);
    if (8 + len > end - i) return null;
    if (type === 'VP8 ' || type === 'VP8L' || type === 'ANMF') picture = true;
    if (type === 'VP8X') {
      const c = Buffer.from(bytes.subarray(i, i + 8 + len));
      c[8] &= ~0x0c; // no EXIF, no XMP
      chunks.push(c, Buffer.alloc(size - 8 - len));
    } else if (type !== 'EXIF' && type !== 'XMP ') {
      chunks.push(bytes.subarray(i, Math.min(end, i + size)));
    }
    i += size;
  }
  if (!picture) return null;
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(4 + body.length, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}

/**
 * An image the server received from elsewhere (not uploaded by a person): checked to be a whole PNG,
 * JPEG or WebP by its structure (not only its first bytes), with its metadata taken out (text,
 * EXIF, XMP, comments), at most maxBytes and 64 to 4096 pixels a side. Null when it is not such an
 * image. (The shop has no image library to re-encode with: the picture data is kept as it came.)
 */
export function cleanImage(bytes: Buffer, maxBytes: number): { mime: string; bytes: Buffer; width: number; height: number } | null {
  if (!bytes.length || bytes.length > maxBytes) return null;
  const mime = bytes.subarray(0, 8).equals(PNG_SIG)
    ? 'image/png'
    : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    ? 'image/jpeg'
    : bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP'
    ? 'image/webp'
    : '';
  if (!mime) return null;
  const clean = mime === 'image/png' ? stripPng(bytes) : mime === 'image/jpeg' ? stripJpeg(bytes) : stripWebp(bytes);
  if (!clean) return null;
  const d = imageDimensions(clean);
  if (!d || d.width < 64 || d.height < 64 || d.width > 4096 || d.height > 4096) return null;
  return { mime, bytes: clean, width: d.width, height: d.height };
}

/** Store image bytes already checked (cleanImage) under their SHA-256, as uploads are. */
export function saveImageBytes(bytes: Buffer, mime: string): string {
  const ext = EXT[mime];
  if (!ext) throw new HttpError(400, 'Upload a PNG, JPEG or WebP image.');
  const name = `${crypto.createHash('sha256').update(bytes).digest('hex')}.${ext}`;
  const file = path.join(imagesDir(), name);
  if (!fs.existsSync(file)) fs.writeFileSync(file, bytes, { mode: 0o600 });
  return `/api/images/${name}`;
}

/** Remove a stored image (the caller checks nothing uses it). */
export function deleteImage(name: string): boolean {
  if (!IMAGE_NAME.test(name)) return false;
  try {
    fs.unlinkSync(path.join(imagesDir(), name));
    return true;
  } catch {
    return false;
  }
}
