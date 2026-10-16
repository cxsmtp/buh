import { HttpError } from './http';

const DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

/**
 * Accept only png / jpeg / webp data URLs whose bytes really start with that
 * format's signature, under a size cap. Rejects SVG (script-capable) and
 * anything mislabelled.
 */
/**
 * Width and height from a PNG, JPEG or WebP file's header (no decoding), or null if they can't be
 * read. Used to refuse huge logos before anything draws them.
 */
export function imageDimensions(bytes: Buffer): { width: number; height: number } | null {
  try {
    // PNG: the IHDR chunk right after the signature.
    if (bytes.length >= 24 && bytes[0] === 0x89 && bytes.toString('latin1', 12, 16) === 'IHDR') {
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
    // JPEG: walk the segments to the first start-of-frame (SOF0–SOF15, except DHT/JPG/DAC).
    if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
      let i = 2;
      while (i + 9 < bytes.length) {
        if (bytes[i] !== 0xff) return null;
        const marker = bytes[i + 1];
        if (marker === 0xff) {
          i++;
          continue;
        }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          i += 2;
          continue;
        }
        const len = bytes.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
        }
        if (len < 2) return null;
        i += 2 + len;
      }
      return null;
    }
    // WebP: lossy (VP8), lossless (VP8L) or extended (VP8X).
    if (bytes.length >= 30 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
      const kind = bytes.toString('latin1', 12, 16);
      if (kind === 'VP8 ') return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
      if (kind === 'VP8L') {
        const b = bytes.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
      if (kind === 'VP8X') return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
    }
  } catch {
    // truncated header
  }
  return null;
}

export function parseImageDataUrl(value: unknown, maxBytes = 6 * 1024 * 1024): { mime: string; bytes: Buffer } {
  const match = typeof value === 'string' ? DATA_URL.exec(value) : null;
  if (!match) throw new HttpError(400, 'Upload a PNG, JPEG or WebP image.');
  const [, mime, b64] = match;
  if (b64.length * 0.75 > maxBytes) throw new HttpError(413, 'The image is too large.');
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length > maxBytes) throw new HttpError(413, 'The image is too large.');

  const signatures: Record<string, number[]> = {
    'image/png': [0x89, 0x50, 0x4e, 0x47],
    'image/jpeg': [0xff, 0xd8, 0xff],
    'image/webp': [0x52, 0x49, 0x46, 0x46],
  };
  const magic = signatures[mime];
  const ok =
    bytes.length >= 12 &&
    magic.every((b, i) => bytes[i] === b) &&
    (mime !== 'image/webp' || bytes.toString('latin1', 8, 12) === 'WEBP');
  if (!ok) throw new HttpError(400, 'The file is not a valid PNG, JPEG or WebP image.');
  return { mime, bytes };
}

/**
 * A bank-transfer receipt: an image (as above) or a PDF, checked by its first
 * bytes. Returned with the file extension to store it under.
 */
export function parseReceiptDataUrl(value: unknown, maxBytes = 5 * 1024 * 1024): { ext: 'png' | 'jpg' | 'webp' | 'pdf'; bytes: Buffer } {
  const pdf = typeof value === 'string' ? /^data:application\/pdf;base64,([A-Za-z0-9+/]+={0,2})$/.exec(value) : null;
  if (pdf) {
    if (pdf[1].length * 0.75 > maxBytes) throw new HttpError(413, 'The receipt is too large (max 5 MB).');
    const bytes = Buffer.from(pdf[1], 'base64');
    if (bytes.length > maxBytes) throw new HttpError(413, 'The receipt is too large (max 5 MB).');
    if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new HttpError(400, 'The receipt is not a valid PDF.');
    return { ext: 'pdf', bytes };
  }
  const { mime, bytes } = parseImageDataUrl(value, maxBytes);
  return { ext: mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg', bytes };
}
