import { HttpError } from './http';

const DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

/**
 * Accept only png / jpeg / webp data URLs whose bytes really start with that
 * format's signature, under a size cap. Rejects SVG (script-capable) and
 * anything mislabelled.
 */
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
