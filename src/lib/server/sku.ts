import { categoryCode, composeSku, DEFAULT_SKU_PREFIX, normalizeSku, SKU_MAX, SKU_RE, skuNumber, titleCode } from '@/lib/sku';
import { getDb } from './db';
import { HttpError } from './http';
import { getSettings } from './settings';

/**
 * The shop's SKUs (src/lib/sku.ts says how they look). Here: the running number and uniqueness.
 *
 * The running number lives in the database (kv `sku:counter`), so backups carry it and a restored
 * shop goes on from where the backup was. It only ever goes up: a product removed keeps its
 * number used, and an SKU the owner types that ends in a higher number moves it on. The next
 * number is also never below the highest one any product carries (so even a database from before
 * the counter, or an edited one, never repeats a number).
 *
 * Unique across every product, removed ones included, ignoring case. Reads the products table
 * directly (not products.ts, which calls here).
 */

const COUNTER = 'sku:counter';

export function skuPrefix(): string {
  return getSettings('catalog').skuPrefix || DEFAULT_SKU_PREFIX;
}

/** A category's SKU code: the owner's (Settings → Catalogue), else made from its name. */
export function categorySkuCode(categoryId: string): string {
  const c = getSettings('catalog').categories.find((x) => x.id === categoryId);
  return c?.code || categoryCode(c?.label ?? categoryId, categoryId);
}

function allSkus(): Array<{ id: string; sku: string }> {
  return (getDb().prepare("SELECT id, json_extract(data, '$.sku') AS sku FROM products WHERE json_extract(data, '$.sku') IS NOT NULL AND json_extract(data, '$.sku') <> ''").all() as Array<{ id: string; sku: string }>);
}

function counterValue(): number {
  const row = getDb().prepare('SELECT data FROM kv WHERE key = ?').get(COUNTER) as { data: string } | undefined;
  const n = Number(row?.data);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** The number the next SKU gets (nothing is taken). */
export function peekSkuNumber(): number {
  const prefix = skuPrefix();
  let high = counterValue();
  for (const { sku } of allSkus()) {
    const n = skuNumber(sku, prefix);
    if (n !== null && n > high) high = n;
  }
  return high + 1;
}

function setCounter(n: number) {
  getDb()
    .prepare('INSERT INTO kv (key, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
    .run(COUNTER, JSON.stringify(n), new Date().toISOString());
}

/** Remember that this SKU's number is used (only ever moves the counter up). Call inside the save's transaction. */
export function noteSkuUsed(sku: string): void {
  const n = skuNumber(sku, skuPrefix());
  if (n !== null && n > counterValue()) setCounter(n);
}

/** The product (other than `exceptId`) that already has this SKU, ignoring case. */
export function skuOwner(sku: string, exceptId = ''): string | null {
  const want = sku.toUpperCase();
  return allSkus().find((r) => r.id !== exceptId && String(r.sku).toUpperCase() === want)?.id ?? null;
}

/** The SKU a new (or SKU-less) product would get now: free, with the next number. Nothing is taken. */
export function suggestSku(title: string, category: string, exceptId = ''): string {
  const prefix = skuPrefix();
  const cat = categorySkuCode(category);
  const code = titleCode(title);
  let n = peekSkuNumber();
  let sku = composeSku(prefix, cat, code, n);
  while (skuOwner(sku, exceptId)) sku = composeSku(prefix, cat, code, ++n);
  return sku;
}

/** Make and take an SKU (the counter moves on). Call inside the save's transaction. */
export function allocateSku(title: string, category: string, exceptId = ''): string {
  const sku = suggestSku(title, category, exceptId);
  const n = skuNumber(sku, skuPrefix());
  if (n !== null) setCounter(Math.max(n, counterValue()));
  return sku;
}

/**
 * An SKU the owner typed, checked: capitals, digits and dashes (typed spaces and lower case are
 * made so), at most 40, and not another product's. The SKU a product already has is kept as it
 * is, even in an older form (never rewritten behind the owner's back).
 */
export function checkTypedSku(typed: string, opts: { productId?: string; current?: string; title: string; category: string }): string {
  if (opts.current && typed === opts.current) return typed;
  const sku = normalizeSku(typed);
  if (opts.current && sku === opts.current) return sku;
  if (!sku) return '';
  if (sku.length > SKU_MAX || !SKU_RE.test(sku)) throw new HttpError(400, 'An SKU may use capital letters, digits and dashes (at most 40 characters).');
  if (skuOwner(sku, opts.productId)) {
    const suggestion = suggestSku(opts.title, opts.category, opts.productId);
    throw new HttpError(409, `Another product already has the SKU ${sku}. Use ${suggestion}, or another code of your own.`, {}, { code: 'sku_taken', suggestion });
  }
  return sku;
}
