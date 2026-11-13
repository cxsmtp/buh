/**
 * QR stickers for the inventory (asked by the owner: "every item … that number will be converted
 * into QR code and printed on a sheet", "40 QR codes on one, four in four columns and 10 rows on A4
 * size"): the QR code reads back as the item's shop link with its size (decoded here with the same
 * reader the hub's scanner uses on iPhones); one sticker per piece in stock, or one per size; 40 to
 * an A4 sheet, filled from the chosen start; the stock code printed; a scan or typed code is parsed
 * safely.
 */
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { test } from 'node:test';
import jsQR from 'jsqr';
import { tempDataDir } from './helpers.mjs';

tempDataDir();
const qr = await import('@/lib/server/qrStickers');
const { listProducts } = await import('@/lib/server/products');
const { shopVariantSku } = await import('@/lib/server/marketplace');

/** The QR code drawn as an image (4 px a module, a quiet zone of 4 modules), read back by jsQR. */
function decode(text: string): string | null {
  const { size, rows } = qr.qrRuns(text);
  const px = 4;
  const w = (size + 8) * px;
  const data = new Uint8ClampedArray(w * w * 4).fill(255);
  rows.forEach((runs, y) => {
    for (const [x, len] of runs) {
      for (let mx = x; mx < x + len; mx++) {
        for (let dy = 0; dy < px; dy++) {
          for (let dx = 0; dx < px; dx++) {
            const i = (((y + 4) * px + dy) * w + (mx + 4) * px + dx) * 4;
            data[i] = data[i + 1] = data[i + 2] = 0;
          }
        }
      }
    }
  });
  return jsQR(data, w, w)?.data ?? null;
}
function pages(pdf: Buffer): number {
  return (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;
}
function text(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  const streams: string[] = [];
  for (const m of raw.matchAll(/stream\n([\s\S]*?)\nendstream/g)) {
    try {
      streams.push(zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'));
    } catch {
      // not deflated
    }
  }
  const map = new Map<string, string>();
  for (const s of streams) for (const m of s.matchAll(/<([0-9a-f]{4})> <([0-9a-f]{4,8})>/g)) map.set(m[1], String.fromCodePoint(...(m[2].match(/.{4}/g) ?? []).map((h) => parseInt(h, 16))));
  return streams
    .filter((s) => s.includes(' Tj ET'))
    .flatMap((s) => [...s.matchAll(/<([0-9a-f]*)> Tj/g)].map((m) => (m[1].match(/.{4}/g) ?? []).map((g) => map.get(g) ?? '?').join('')))
    .join('\n');
}

test('asked: the QR code reads back as the item’s shop link with its size (never the hub)', () => {
  const url = qr.stickerUrl('https://beautifuluaehome.com/', 'prod-123_ab', 'super-king');
  assert.equal(url, 'https://beautifuluaehome.com/p/prod-123_ab?s=super-king');
  assert.equal(decode(url), url);
  assert.equal(decode('BUH-HBS-INDCHV-007-KING'), 'BUH-HBS-INDCHV-007-KING');
});

test('one sticker per piece in stock (or one per size); 40 to an A4 sheet; start skips used stickers; the stock code printed', () => {
  const products = listProducts({ includeHidden: true }).slice(0, 3).map((p, n) => ({ ...p, stockBySize: Object.fromEntries(p.profiles.map((s, i) => [s.id, i === 0 ? 7 + n * 10 : 0])) }));
  const code = (p: (typeof products)[number], s: string) => shopVariantSku(p, s);
  const each = qr.stickersFor(products, 'https://shop.test', code, 'stock');
  assert.equal(each.length, 7 + 17 + 27, 'one per piece in stock, sizes with none left out');
  const once = qr.stickersFor(products, 'https://shop.test', code, 'one');
  assert.equal(once.length, products.reduce((n, p) => n + p.profiles.length, 0), 'one per design and size');
  const s0 = each[0];
  assert.equal(s0.code, shopVariantSku(products[0], products[0].profiles[0].id));
  assert.equal(s0.url, `https://shop.test/p/${encodeURIComponent(products[0].id)}?s=${encodeURIComponent(products[0].profiles[0].id)}`);
  const pdf = qr.stickersPdf(each); // 51 stickers
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.equal(pages(pdf), 2, '40 on the first sheet, 11 on the second');
  assert.match(pdf.toString('latin1'), /\/MediaBox \[0 0 595\.28 841\.89\]/, 'A4 portrait');
  assert.ok(text(pdf).replace(/-\n/g, '-').includes(s0.code), 'the stock code printed (a long one over two lines, broken at a dash)');
  const shortSize = products[0].profiles[0].name.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  assert.ok(text(pdf).replace(/\n/g, ' ').includes(shortSize), `the size printed (${shortSize})`);
  assert.equal(pages(qr.stickersPdf(each.slice(0, 40), 0)), 1);
  assert.equal(pages(qr.stickersPdf(each.slice(0, 40), 1)), 2, 'starting at sticker 2, the 40th goes on a second sheet');
  assert.equal(pages(qr.stickersPdf(each.slice(0, 1), 39)), 1, 'the last free sticker');
  assert.equal(qr.PER_SHEET, 40);
});

test('a scan or a typed code: a sticker’s link gives the product and size; a stock code is upper-cased; anything else refused', () => {
  assert.deepEqual(qr.parseScan('https://beautifuluaehome.com/p/prod-1?s=king'), { productId: 'prod-1', sizeId: 'king' });
  assert.deepEqual(qr.parseScan('https://beautifuluaehome.com/p/prod-1'), { productId: 'prod-1' });
  assert.deepEqual(qr.parseScan('  buh hbs indchv 007 king '), { code: 'BUH-HBS-INDCHV-007-KING' });
  for (const bad of ['', '   ', 'https://evil.test/p/../../etc?s=x', '/p/a%2Fb', 'javascript:alert(1)', 'x'.repeat(80), '/p/ok?s=<script>']) assert.equal(qr.parseScan(bad), null, bad);
});
