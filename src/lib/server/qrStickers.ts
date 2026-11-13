import QRCode from 'qrcode';
import type { StoredProduct } from './products';
import { PdfDoc, type RGB } from './pdf/pdf';

/**
 * QR stickers for the inventory (asked by the owner: "every item we have already given a number,
 * that number will be converted into QR code and printed on a sheet… I can scan the QR code").
 *
 * One sticker per piece in stock (or one per design and size), 40 to an A4 sheet: 4 across, 10
 * down, 52.5 × 29.7 mm each, the common ready-made sticker sheet. Each holds:
 *  - a QR code of the item's own shop link with its size (/p/<product>?s=<size>): any phone camera
 *    opens the product, and the Admin Hub's scanner reads the product and size from it. Never the
 *    hub's private link: a sticker can end up with a customer.
 *  - the stock code (the product's SKU and the size, as the marketplace export writes it), large;
 *  - a short name and the size.
 * "Start at" skips stickers already peeled off a sheet.
 */

const A4: [number, number] = [595.28, 841.89];
const COLS = 4;
const ROWS = 10;
export const PER_SHEET = COLS * ROWS;
const CELL_W = A4[0] / COLS; // 148.82 pt = 52.5 mm
const CELL_H = A4[1] / ROWS; // 84.19 pt = 29.7 mm
const INK: RGB = [0.08, 0.08, 0.08];
const SOFT: RGB = [0.35, 0.35, 0.35];

export interface Sticker {
  productId: string;
  sizeId: string;
  /** The stock code printed (product SKU + size), e.g. BUH-HBS-INDCHV-007-KING. */
  code: string;
  title: string;
  sizeName: string;
  /** What the QR code holds: the shop's product link with the size. */
  url: string;
}

/** The link a sticker's QR code holds (the public product page, with the size). */
export function stickerUrl(base: string, productId: string, sizeId: string): string {
  return `${base.replace(/\/+$/, '')}/p/${encodeURIComponent(productId)}?s=${encodeURIComponent(sizeId)}`;
}

/** The QR code's dark modules as rows of runs [x, length], for drawing (merged per row). */
export function qrRuns(text: string): { size: number; rows: Array<Array<[number, number]>> } {
  const q = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n = q.modules.size;
  const rows: Array<Array<[number, number]>> = [];
  for (let y = 0; y < n; y++) {
    const runs: Array<[number, number]> = [];
    let x = 0;
    while (x < n) {
      if (q.modules.get(x, y)) {
        const s = x;
        while (x < n && q.modules.get(x, y)) x++;
        runs.push([s, x - s]);
      } else x++;
    }
    rows.push(runs);
  }
  return { size: n, rows };
}

/** The stickers for these products: each size with stock, one per piece (copies 'stock') or one per size. */
export function stickersFor(products: StoredProduct[], base: string, codeOf: (p: StoredProduct, sizeId: string) => string, copies: 'stock' | 'one'): Sticker[] {
  const out: Sticker[] = [];
  for (const p of products) {
    for (const prof of p.profiles) {
      const inStock = Math.max(0, Math.floor(p.stockBySize?.[prof.id] ?? 0));
      if (copies === 'stock' && inStock === 0) continue;
      const one: Sticker = { productId: p.id, sizeId: prof.id, code: codeOf(p, prof.id), title: p.title, sizeName: prof.name, url: stickerUrl(base, p.id, prof.id) };
      const n = copies === 'stock' ? inStock : 1;
      for (let i = 0; i < n; i++) out.push(one);
    }
  }
  return out;
}

/** The sheets: A4 portrait, 4 × 10 stickers, filled from `start` (0–39) on the first sheet. */
export function stickersPdf(stickers: Sticker[], start = 0): Buffer {
  const doc = new PdfDoc({ title: `QR stickers (${stickers.length})`, author: 'Beautiful UAE Home', subject: 'Inventory QR stickers' }, A4);
  const first = Math.max(0, Math.min(PER_SHEET - 1, Math.floor(start)));
  const cache = new Map<string, ReturnType<typeof qrRuns>>();
  let slot = first;
  doc.addPage();
  for (const s of stickers) {
    if (slot === PER_SHEET) {
      doc.addPage();
      slot = 0;
    }
    const col = slot % COLS;
    const row = Math.floor(slot / COLS);
    draw(doc, col * CELL_W, row * CELL_H, s, cache);
    slot++;
  }
  return doc.render();
}

function draw(doc: PdfDoc, x: number, y: number, s: Sticker, cache: Map<string, ReturnType<typeof qrRuns>>) {
  // Kept inside a 5 pt margin (ready-made sheets and printers both shift a little), with white
  // around the code so a phone reads it at once.
  const pad = 5;
  const qrSide = CELL_H - pad * 2 - 4; // about 25 mm: scans from a phone at arm's length
  let qr = cache.get(s.url);
  if (!qr) {
    qr = qrRuns(s.url);
    cache.set(s.url, qr);
  }
  const m = qrSide / qr.size;
  const qx = x + pad + 2;
  const qy = y + (CELL_H - qrSide) / 2;
  qr.rows.forEach((runs, r) => {
    for (const [cx, len] of runs) doc.box(qx + cx * m, qy + r * m, len * m, m, INK);
  });
  const tx = qx + qrSide + 7;
  const tw = x + CELL_W - pad - tx;
  // The stock code, large (it is what a person reads): on two lines rather than too small.
  let size = 8.5;
  while (size > 7 && doc.measure(s.code, size, 'bold') > tw) size -= 0.5;
  const codeLines = doc.measure(s.code, size, 'bold') > tw ? splitCode(doc, s.code, size, tw).slice(0, 2) : [s.code];
  let ty = y + pad + 2 + size;
  for (const l of codeLines) {
    doc.text(l, tx, ty, { size, style: 'bold', color: INK });
    ty += size + 1.5;
  }
  ty += 1.5;
  const titleLines = doc.wrap(s.title, 6.5, tw).slice(0, 2);
  for (const l of titleLines) {
    doc.text(l, tx, ty, { size: 6.5, color: SOFT });
    ty += 8;
  }
  // The size, short ("King Size Bed (Most Popular)" → "King Size Bed"), on up to two lines.
  const sizeName = s.sizeName.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  const sizeLines = doc.wrap(sizeName, 7, tw, 'bold');
  const room = Math.max(1, Math.floor((y + CELL_H - pad - ty) / 8.5));
  const shown = sizeLines.slice(0, Math.min(2, room));
  if (sizeLines.length > shown.length) {
    let last = shown[shown.length - 1];
    while (last.length > 1 && doc.measure(`${last}…`, 7, 'bold') > tw) last = last.slice(0, -1).trimEnd();
    shown[shown.length - 1] = `${last}…`;
  }
  ty += 1;
  for (const l of shown) {
    doc.text(l, tx, ty, { size: 7, style: 'bold', color: INK });
    ty += 8.5;
  }
}

/** A stock code over two lines, broken at a dash where it can be. */
function splitCode(doc: PdfDoc, code: string, size: number, width: number): string[] {
  const parts = code.split('-');
  for (let i = parts.length - 1; i > 0; i--) {
    const a = `${parts.slice(0, i).join('-')}-`;
    const b = parts.slice(i).join('-');
    if (doc.measure(a, size, 'bold') <= width && doc.measure(b, size, 'bold') <= width) return [a, b];
  }
  return doc.wrap(code, size, width, 'bold');
}

/** What a scan read: the product and size from a sticker's link, or a typed stock code. */
export function parseScan(raw: string): { productId: string; sizeId?: string } | { code: string } | null {
  const text = String(raw ?? '').trim().slice(0, 500);
  if (!text) return null;
  const m = /\/p\/([^/?#\s]+)(?:\?([^#\s]*))?/.exec(text);
  if (m) {
    let productId = '';
    try {
      productId = decodeURIComponent(m[1]);
    } catch {
      return null;
    }
    const s = new URLSearchParams(m[2] ?? '').get('s') ?? undefined;
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(productId) || (s !== undefined && !/^[A-Za-z0-9_-]{1,60}$/.test(s))) return null;
    return s ? { productId, sizeId: s } : { productId };
  }
  const code = text.toUpperCase().replace(/\s+/g, '-');
  return /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(code) && code.length <= 60 ? { code } : null;
}
