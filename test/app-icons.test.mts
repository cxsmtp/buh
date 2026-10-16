/**
 * The app's icons: many requests at once (a restart, a new logo) draw each icon once; a logo too
 * big to draw safely is refused when saved and never drawn (the letters are), whatever its file
 * size; image sizes are read from the PNG, JPEG or WebP header without decoding.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import zlib from 'node:zlib';
import { tempDataDir } from './helpers.mjs';

tempDataDir();
const settings = await import('@/lib/server/settings');
const { saveImageDataUrl, LOGO_MAX_SIDE } = await import('@/lib/server/images');
const { imageDimensions } = await import('@/lib/server/imageInput');
const icons = await import('@/lib/server/appIcons');

/** A real PNG (solid colour) of the given size; or just a header claiming that size. */
function png(width: number, height: number, headerOnly = false): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (headerOnly) return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IEND', Buffer.alloc(0))]);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x7f)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const dataUrl = (b: Buffer, mime = 'image/png') => `data:${mime};base64,${b.toString('base64')}`;

test('image sizes come from the header: PNG, JPEG, WebP', () => {
  assert.deepEqual(imageDimensions(png(640, 480, true)), { width: 640, height: 480 });
  // A JPEG: SOI, an APP0 segment, then SOF0 with height 300 and width 500.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x01, 0xf4, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(imageDimensions(jpeg), { width: 500, height: 300 });
  const vp8x = Buffer.alloc(30);
  vp8x.write('RIFF', 0, 'latin1');
  vp8x.write('WEBPVP8X', 8, 'latin1');
  vp8x.writeUIntLE(1199, 24, 3);
  vp8x.writeUIntLE(799, 27, 3);
  assert.deepEqual(imageDimensions(vp8x), { width: 1200, height: 800 });
  assert.equal(imageDimensions(Buffer.from('not an image')), null);
});

test('a logo bigger than the limit is refused when saved, even as a tiny file', async () => {
  const huge = png(LOGO_MAX_SIDE + 1, 10, true); // a few dozen bytes claiming 4097 px wide
  await assert.rejects(settings.updateSettings('brand', { logoType: 'image', logoImageUrl: dataUrl(huge) }), /at most 4096/);
  // Also when it was stored some other way and is referred to by address.
  const stored = saveImageDataUrl(dataUrl(huge));
  await assert.rejects(settings.updateSettings('brand', { logoType: 'image', logoImageUrl: stored }), /at most 4096/);
  // A normal logo is fine.
  await settings.updateSettings('brand', { logoType: 'image', logoImageUrl: dataUrl(png(64, 64)) });
  assert.match(settings.getSettings('brand').logoImageUrl || '', /^\/api\/images\/[a-f0-9]{64}\.png$/);
});

test('an oversized or unreadable stored logo is never drawn: the icon falls back to the letters', () => {
  const huge = saveImageDataUrl(dataUrl(png(20000, 20000, true)));
  assert.equal(icons.logoForIcon({ logoType: 'image', logoImageUrl: huge }), null);
  const ok = saveImageDataUrl(dataUrl(png(32, 32)));
  assert.match(icons.logoForIcon({ logoType: 'image', logoImageUrl: ok }) || '', /^data:image\/png;base64,/);
  assert.equal(icons.logoForIcon({ logoType: 'text', logoImageUrl: ok }), null);
});

test('many requests at once draw each icon once (after a restart or a new logo)', async () => {
  await settings.updateSettings('brand', { logoType: 'text', logoText: 'QX' });
  const before = icons.iconStats.draws;
  const all = await Promise.all(Array.from({ length: 12 }, () => icons.appIconPng('icon-192.png')!));
  assert.equal(icons.iconStats.draws - before, 1, 'drawn once for 12 requests');
  assert.ok(all.every((p) => p === all[0]));
  assert.equal(Buffer.from(all[0]).subarray(1, 4).toString(), 'PNG');
  assert.equal(Buffer.from(all[0]).readUInt32BE(16), 192);
  // A new logo is a new drawing (once), the old one is not reused.
  await settings.updateSettings('brand', { logoText: 'ZZ' });
  await Promise.all(Array.from({ length: 5 }, () => icons.appIconPng('icon-192.png')!));
  assert.equal(icons.iconStats.draws - before, 2);
  assert.equal(icons.appIconPng('evil.svg'), null);
});
