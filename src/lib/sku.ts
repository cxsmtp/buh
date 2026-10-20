/**
 * SKUs the shop makes by itself: <PREFIX>-<CAT>-<CODE>-<NNN>, e.g. BUH-HBS-INDCHV-007.
 *
 * - PREFIX: Settings → Catalogue (default BUH), 2–6 capitals or digits.
 * - CAT: the category's own code (Settings → Catalogue), else made from its name: the first
 *   letters of its words ("Hand Block Sets" → HBS), or a one-word name's first letter and
 *   consonants ("Towels" → TWL).
 * - CODE: up to 6 letters from the title's main words, the design first ("Indigo Chevron King
 *   Bed Set" → INDCHV); generic words (set, sheet, king, cotton…) are left out.
 * - NNN: the shop's running number (src/lib/server/sku.ts): never reused.
 *
 * Browser-safe: the product editor shows the same suggestion the server would make; the server
 * has the last word (it numbers, and refuses a duplicate).
 */

export const SKU_MAX = 40;
export const DEFAULT_SKU_PREFIX = 'BUH';
export const SKU_PREFIX_RE = /^[A-Z0-9]{2,6}$/;
export const CATEGORY_CODE_RE = /^[A-Z0-9]{2,3}$/;
/** Capitals, digits and single dashes between them. */
export const SKU_RE = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/;

const ascii = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '');

/** What an owner typed, as an SKU: capitals, spaces and other marks as dashes. ("buh jai 01" → BUH-JAI-01) */
export function normalizeSku(v: string): string {
  return ascii(v)
    .toUpperCase()
    .replace(/[\s_./\\]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

const STOP = new Set(['AND', 'THE', 'OF', 'FOR', 'WITH', 'IN', 'A', 'AN', 'BY', 'TO']);
/** Words that say what kind of product, not which design: left out of the title code. */
const GENERIC = new Set([
  ...STOP,
  'SET', 'SETS', 'BED', 'BEDS', 'SHEET', 'SHEETS', 'BEDSHEET', 'BEDSHEETS', 'DUVET', 'COVER', 'COVERS', 'PILLOW', 'PILLOWS',
  'PILLOWCASE', 'PILLOWCASES', 'CASE', 'CASES', 'FITTED', 'FLAT', 'SINGLE', 'DOUBLE', 'QUEEN', 'KING', 'SUPER', 'SIZE',
  'COTTON', 'PERCALE', 'SATEEN', 'LINEN', 'PRINT', 'PRINTED', 'PRINTS', 'HAND', 'BLOCK', 'HANDBLOCK', 'PIECE', 'PIECES',
  'PC', 'PCS', 'TC', 'NEW', 'LUXURY', 'PREMIUM', 'COLLECTION',
]);

const words = (s: string) => ascii(s).toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
const consonants = (w: string) => w.slice(1).replace(/[AEIOU]/g, '');

/** First letter, then consonants, then the rest of the letters: at most `n` characters. */
function squeeze(w: string, n: number): string {
  if (w.length <= n) return w;
  let out = w[0] + consonants(w);
  if (out.length < n) out += w.slice(1).replace(/[^AEIOU]/g, '');
  return out.slice(0, n);
}

/** A category's code from its name (2–3 characters). */
export function categoryCode(label: string, id = ''): string {
  const ws = words(label).filter((w) => !STOP.has(w));
  const from = ws.length ? ws : words(id.replace(/-/g, ' '));
  if (!from.length) return 'XX';
  if (from.length === 1) {
    const w = from[0];
    return (w.length <= 3 ? w.padEnd(2, 'X') : squeeze(w, 3)).slice(0, 3);
  }
  return from.slice(0, 3).map((w) => w[0]).join('');
}

/** Up to 6 letters from the title's main words (the design first). */
export function titleCode(title: string): string {
  const all = words(title).filter((w) => !/^\d+$/.test(w));
  const main = all.filter((w) => !GENERIC.has(w));
  const ws = (main.length ? main : all.filter((w) => !STOP.has(w))).slice(0, 3);
  if (!ws.length) return 'ITEM';
  const per = ws.length === 1 ? 6 : ws.length === 2 ? 3 : 2;
  return ws.map((w) => squeeze(w, per)).join('').slice(0, 6);
}

export function composeSku(prefix: string, cat: string, code: string, n: number): string {
  const num = String(Math.max(1, Math.floor(n))).padStart(3, '0');
  const sku = `${prefix}-${cat}-${code}-${num}`;
  return sku.length <= SKU_MAX ? sku : `${prefix}-${cat}-${num}`.slice(0, SKU_MAX);
}

/** The running number at the end of an SKU the shop made with this prefix (BUH-…-007 → 7), else null. */
export function skuNumber(sku: string, prefix: string): number | null {
  const m = new RegExp(`^${prefix}-(?:[A-Z0-9]+-){1,3}(\\d{3,7})$`).exec(sku.toUpperCase());
  return m ? Number(m[1]) : null;
}

/** A size's or variant's code, as the marketplace export has always written it (king → KING, super-king → SUPER-KING). */
export function sizeCode(sizeId: string): string {
  return sizeId.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
