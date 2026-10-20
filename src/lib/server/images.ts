import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { dataDir } from './dataDir';
import { HttpError } from './http';
import { imageDimensions, parseImageDataUrl } from './imageInput';
import { markChanged } from './dataChanges';

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
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    markChanged('photos'); // a file beside the database: the next backup must take it
  }
  return `/api/images/${name}`;
}

/** Whether a stored image with this name is on disk. */
export function imageExists(name: string): boolean {
  return IMAGE_NAME.test(name) && fs.existsSync(path.join(imagesDir(), name));
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
    // Only a photo that is really stored (a dangling address would show a broken picture).
    if (!imageExists(value.slice('/api/images/'.length))) throw new HttpError(400, `${field}: that photo is no longer stored. Upload it again.`);
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

/**
 * Provenance (keepProvenance, styled photos only): the C2PA manifest and the XMP packet saying the
 * picture was made with AI (IPTC DigitalSourceType) stay, so Google, Meta and others can label it.
 */
const XMP_KEYWORD = 'XML:com.adobe.xmp';
const XMP_JPEG_NS = 'http://ns.adobe.com/xap/1.0/\0';
const XMP_JPEG_EXT_NS = 'http://ns.adobe.com/xmp/extension/\0';
export const AI_SOURCE_TYPE = 'http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia';
/** The minimal XMP packet added when the picture came without one saying how it was made. */
export const AI_XMP = [
  '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>',
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
  `<rdf:Description rdf:about="" xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" Iptc4xmpExt:DigitalSourceType="${AI_SOURCE_TYPE}"/>`,
  '</rdf:RDF></x:xmpmeta>',
  '<?xpacket end="r"?>',
].join('');
/** An XMP packet kept as it came: one that says how the picture was made and names no place. */
const usableXmp = (xmp: string) => /DigitalSourceType/.test(xmp) && !/GPS/i.test(xmp);

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0);
  return Buffer.concat([head, data, crc]);
}

function stripPng(bytes: Buffer, keepProvenance = false): Buffer | null {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(PNG_SIG)) return null;
  const out: Buffer[] = [PNG_SIG];
  let i = 8;
  let first = true;
  let ended = false;
  let sawData = false;
  let xmp = false;
  while (i + 12 <= bytes.length) {
    const len = bytes.readUInt32BE(i);
    const type = bytes.toString('latin1', i + 4, i + 8);
    if (len > bytes.length - i - 12 || !/^[A-Za-z]{4}$/.test(type)) return null;
    if (first && (type !== 'IHDR' || len !== 13)) return null;
    first = false;
    if (type === 'IDAT') sawData = true;
    if (PNG_KEEP.has(type) || (keepProvenance && type === 'caBX')) out.push(bytes.subarray(i, i + 12 + len));
    else if (keepProvenance && type === 'iTXt' && !xmp) {
      // An uncompressed XMP iTXt: keyword, NUL, compression flag 0, method, language, NUL, keyword, NUL, text.
      const data = bytes.subarray(i + 8, i + 8 + len);
      if (data.toString('latin1', 0, XMP_KEYWORD.length + 1) === `${XMP_KEYWORD}\0` && data[XMP_KEYWORD.length + 1] === 0 && usableXmp(data.toString('utf8'))) {
        out.push(bytes.subarray(i, i + 12 + len));
        xmp = true;
      }
    }
    if (type === 'IEND' && keepProvenance && !xmp) {
      // Before IEND: the XMP packet saying the picture was made with AI.
      out.splice(out.length - 1, 0, pngChunk('iTXt', Buffer.concat([Buffer.from(`${XMP_KEYWORD}\0\0\0\0\0`, 'latin1'), Buffer.from(AI_XMP, 'utf8')])));
    }
    i += 12 + len;
    if (type === 'IEND') {
      ended = true;
      break;
    }
  }
  return ended && sawData ? Buffer.concat(out) : null;
}

function stripJpeg(bytes: Buffer, keepProvenance = false): Buffer | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const out: Buffer[] = [bytes.subarray(0, 2)];
  let i = 2;
  let xmp = false;
  // Where an added XMP segment goes: after the start marker and the JFIF (APP0) segment.
  let xmpAt = 1;
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
      if (keepProvenance && !xmp) {
        const packet = Buffer.concat([Buffer.from(XMP_JPEG_NS, 'latin1'), Buffer.from(AI_XMP, 'utf8')]);
        const head = Buffer.from([0xff, 0xe1, 0, 0]);
        head.writeUInt16BE(2 + packet.length, 2);
        out.splice(xmpAt, 0, head, packet);
      }
      out.push(rest);
      return Buffer.concat(out);
    }
    // APP1–APP13 and APP15 (EXIF, XMP, C2PA…) and comments go; JFIF (APP0) and Adobe (APP14, colour) stay.
    // With keepProvenance (styled photos): C2PA (APP11) and the XMP packet saying how it was made stay.
    const seg = bytes.subarray(i, i + 2 + len);
    let keep = !((marker >= 0xe1 && marker <= 0xef && marker !== 0xee) || marker === 0xfe);
    if (keepProvenance && marker === 0xeb) keep = true;
    if (keepProvenance && marker === 0xe1) {
      if (!xmp && seg.toString('latin1', 4, 4 + XMP_JPEG_NS.length) === XMP_JPEG_NS && usableXmp(seg.toString('utf8', 4))) keep = xmp = true;
      else if (xmp && seg.toString('latin1', 4, 4 + XMP_JPEG_EXT_NS.length) === XMP_JPEG_EXT_NS) keep = true; // the rest of a long packet
    }
    if (keep) out.push(seg);
    if (marker === 0xe0 && out.length === xmpAt + 1) xmpAt = out.length;
    i += 2 + len;
  }
  return null;
}

/** WebP chunks kept: the picture, its animation and its colour profile (anything else goes). */
const WEBP_KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF', 'ICCP']);

function stripWebp(bytes: Buffer, keepProvenance = false): Buffer | null {
  if (bytes.length < 30 || bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WEBP') return null;
  const end = Math.min(bytes.length, 8 + bytes.readUInt32LE(4));
  const chunks: Buffer[] = [];
  let i = 12;
  let picture = false;
  let vp8x: Buffer | null = null;
  let xmp = false;
  while (i + 8 <= end) {
    const type = bytes.toString('latin1', i, i + 4);
    const len = bytes.readUInt32LE(i + 4);
    const size = 8 + len + (len % 2);
    if (8 + len > end - i) return null;
    if (type === 'VP8 ' || type === 'VP8L' || type === 'ANMF') picture = true;
    if (type === 'VP8X') {
      if (vp8x || len < 10) return null;
      vp8x = Buffer.from(bytes.subarray(i, i + 8 + len));
      vp8x[8] &= ~0x0c; // no EXIF, no XMP (XMP set again below when it is kept)
      chunks.push(vp8x, Buffer.alloc(size - 8 - len));
    } else if (WEBP_KEEP.has(type) || (keepProvenance && type === 'C2PA')) {
      chunks.push(bytes.subarray(i, Math.min(end, i + size)));
    } else if (keepProvenance && type === 'XMP ' && !xmp && usableXmp(bytes.toString('utf8', i + 8, i + 8 + len))) {
      chunks.push(bytes.subarray(i, Math.min(end, i + size)));
      xmp = true;
    }
    i += size;
  }
  if (!picture) return null;
  if (keepProvenance) {
    if (!xmp) {
      // The XMP packet saying the picture was made with AI, last (where the WebP layout puts it).
      const data = Buffer.from(AI_XMP, 'utf8');
      const head = Buffer.alloc(8);
      head.write('XMP ', 0, 'latin1');
      head.writeUInt32LE(data.length, 4);
      chunks.push(head, data, Buffer.alloc(data.length % 2));
    }
    if (!vp8x) {
      // A simple WebP (VP8 or VP8L alone) needs the extended header (VP8X) to carry XMP.
      const d = imageDimensions(bytes);
      if (!d) return null;
      const alpha = bytes.toString('latin1', 12, 16) === 'VP8L' && (bytes.readUInt32LE(21) >>> 28) & 1;
      vp8x = Buffer.alloc(18);
      vp8x.write('VP8X', 0, 'latin1');
      vp8x.writeUInt32LE(10, 4);
      vp8x[8] = alpha ? 0x10 : 0;
      vp8x.writeUIntLE(d.width - 1, 12, 3);
      vp8x.writeUIntLE(d.height - 1, 15, 3);
      chunks.unshift(vp8x);
    }
    vp8x[8] |= 0x04;
  }
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
 * keepProvenance (styled photos made by Gemini only): the C2PA manifest and the XMP packet saying
 * the picture was made with AI stay, and that packet is added when the picture came without one;
 * EXIF, GPS, text and comments still go.
 */
export function cleanImage(bytes: Buffer, maxBytes: number, { keepProvenance = false } = {}): { mime: string; bytes: Buffer; width: number; height: number } | null {
  if (!bytes.length || bytes.length > maxBytes) return null;
  const mime = bytes.subarray(0, 8).equals(PNG_SIG)
    ? 'image/png'
    : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    ? 'image/jpeg'
    : bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP'
    ? 'image/webp'
    : '';
  if (!mime) return null;
  const clean = mime === 'image/png' ? stripPng(bytes, keepProvenance) : mime === 'image/jpeg' ? stripJpeg(bytes, keepProvenance) : stripWebp(bytes, keepProvenance);
  if (!clean) return null;
  const d = imageDimensions(clean);
  if (!d || d.width < 64 || d.height < 64 || d.width > 4096 || d.height > 4096) return null;
  return { mime, bytes: clean, width: d.width, height: d.height };
}

/**
 * Store image bytes already checked (cleanImage) under their SHA-256, as uploads are. created is
 * false when the same picture was stored already (it may be a real photo a product uses).
 */
export function saveImageBytes(bytes: Buffer, mime: string): { url: string; created: boolean } {
  const ext = EXT[mime];
  if (!ext) throw new HttpError(400, 'Upload a PNG, JPEG or WebP image.');
  const name = `${crypto.createHash('sha256').update(bytes).digest('hex')}.${ext}`;
  let created = true;
  try {
    fs.writeFileSync(path.join(imagesDir(), name), bytes, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    created = false;
  }
  if (created) markChanged('photos');
  return { url: `/api/images/${name}`, created };
}

/** Remove a stored image (the caller checks nothing uses it). */
export function deleteImage(name: string): boolean {
  if (!IMAGE_NAME.test(name)) return false;
  try {
    fs.unlinkSync(path.join(imagesDir(), name));
    markChanged('photos');
    return true;
  } catch {
    return false;
  }
}
