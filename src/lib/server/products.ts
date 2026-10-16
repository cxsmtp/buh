import crypto from 'node:crypto';
import { audit } from './audit';
import type { BedProfileMeasurement, Product } from '@/types';
import { INITIAL_PRODUCTS } from '@/data/initialData';
import { getDb, inTransaction } from './db';
import { HttpError } from './http';
import { acceptImageRef } from './images';
import { bump, changedElsewhere } from './live';
import { getSettings } from './settings';
import { auditBacklog, auditMove, insertMove, type SizeChange, type StockMove } from './stockLedger';

/**
 * The catalogue. Stock is kept per product and size in product_stock, so an
 * order reserves exactly the piece it buys (UPDATE … WHERE qty >= n) and two
 * customers can never both get the last King. Everything else is the Product
 * JSON. Seeded with the starter catalogue on first start.
 *
 * Removing a product archives it (past orders still show it); archived
 * products are hidden everywhere except "Show archived" in the admin hub.
 */

export interface StoredProduct extends Product {
  active: boolean;
  archived?: boolean;
}

interface Row {
  id: string;
  data: string;
  active: number;
  archived: number;
}

let cache: StoredProduct[] | null = null;

const SIZE_ID = /^[a-z0-9][a-z0-9-]{0,29}$/;

function writeStock(productId: string, stockBySize: Record<string, number>) {
  const db = getDb();
  const upsert = db.prepare(
    'INSERT INTO product_stock (product_id, size_id, qty) VALUES (?, ?, ?) ON CONFLICT(product_id, size_id) DO UPDATE SET qty = excluded.qty'
  );
  for (const [size, qty] of Object.entries(stockBySize)) upsert.run(productId, size, qty);
}

/**
 * SEED_STOCK (demos and tests only): the starter catalogue gets this many
 * pieces of every size, instead of its realistic one or two.
 */
function seedStock(p: Product): Record<string, number> {
  const n = Number(process.env.SEED_STOCK);
  return Number.isInteger(n) && n > 0 && n <= 1000 ? Object.fromEntries(p.profiles.map((s) => [s.id, n])) : p.stockBySize;
}

function seedIfEmpty() {
  const db = getDb();
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM products').get() as { n: number };
  if (n > 0) return;
  const insert = db.prepare('INSERT INTO products (id, data, stock, active, position, updated_at) VALUES (?, ?, 0, 1, ?, ?)');
  inTransaction(() => {
    INITIAL_PRODUCTS.forEach((p, i) => {
      const { stockCount, stockBySize, ...rest } = p;
      void stockCount;
      insert.run(p.id, JSON.stringify(rest), i, new Date().toISOString());
      void stockBySize;
      writeStock(p.id, seedStock(p));
    });
  });
}

function stockMap(): Map<string, Record<string, number>> {
  const map = new Map<string, Record<string, number>>();
  for (const r of getDb().prepare('SELECT product_id, size_id, qty FROM product_stock').all() as Array<{ product_id: string; size_id: string; qty: number }>) {
    const m = map.get(r.product_id) ?? {};
    m[r.size_id] = r.qty;
    map.set(r.product_id, m);
  }
  return map;
}

function fromRow(r: Row, stock: Record<string, number>): StoredProduct {
  const p = JSON.parse(r.data) as Product;
  // Only sizes the product still offers count.
  const stockBySize: Record<string, number> = {};
  for (const pr of p.profiles) stockBySize[pr.id] = stock[pr.id] ?? 0;
  const stockCount = Object.values(stockBySize).reduce((a, b) => a + b, 0);
  return { ...p, stockBySize, stockCount, active: r.active === 1, ...(r.archived ? { archived: true } : {}) };
}

export function listProducts({ includeHidden = false, includeArchived = false } = {}): StoredProduct[] {
  if (cache && changedElsewhere('catalog')) cache = null;
  if (!cache) {
    seedIfEmpty();
    const stock = stockMap();
    cache = (getDb().prepare('SELECT id, data, active, archived FROM products ORDER BY position, rowid').all() as Row[]).map((r) => fromRow(r, stock.get(r.id) ?? {}));
  }
  return cache.filter((p) => (includeArchived || !p.archived) && (includeHidden || p.active));
}

export function getProduct(id: string): StoredProduct | undefined {
  return listProducts({ includeHidden: true, includeArchived: true }).find((p) => p.id === id);
}

export function invalidateProducts() {
  cache = null;
  bump('catalog'); // open pages reload the catalogue
}

/**
 * The editor's stock change into the audit log. The save itself is already done (and the move is in
 * the ledger); if the log cannot be written now, the next audited stock move writes it.
 */
function recordMove(move: StockMove | null, title: string) {
  if (!move) return;
  const db = getDb();
  if (auditBacklog(db)) auditMove(db, move, { title });
}

/** Stock for the sizes given in the input: stockBySize, or (older callers) stockCount for the default size. */
function stockFromInput(input: Obj, product: StoredProduct): Record<string, number> | undefined {
  if (input.stockBySize !== undefined) {
    if (!input.stockBySize || typeof input.stockBySize !== 'object' || Array.isArray(input.stockBySize)) throw new HttpError(400, 'Stock per size must be an object.');
    const out: Record<string, number> = {};
    for (const [size, qty] of Object.entries(input.stockBySize as Obj)) {
      if (!product.profiles.some((pr) => pr.id === size)) throw new HttpError(400, `Stock given for a size this product does not offer (${size.slice(0, 30)}).`);
      out[size] = num(qty, `Stock for ${size}`, 0, 100_000, { integer: true });
    }
    return out;
  }
  if (input.stockCount !== undefined) return { [product.defaultProfileId]: num(input.stockCount, 'Stock', 0, 100_000, { integer: true }) };
  return undefined;
}

export function createProduct(input: unknown, actor = 'admin'): StoredProduct {
  const product = validateProduct(input);
  product.id = `prod-${crypto.randomBytes(6).toString('hex')}`;
  product.createdAt = new Date().toISOString();
  const stock = stockFromInput(input as Obj, product) ?? {};
  const { stockCount, stockBySize, active, ...rest } = product;
  void stockCount;
  void stockBySize;
  seedIfEmpty();
  let movedNow: StockMove | null = null;
  inTransaction(() => {
    // New products go first in the catalogue.
    getDb()
      .prepare('INSERT INTO products (id, data, stock, active, position, updated_at) VALUES (?, ?, 0, ?, (SELECT COALESCE(MIN(position), 0) - 1 FROM products), ?)')
      .run(product.id, JSON.stringify(rest), active ? 1 : 0, new Date().toISOString());
    writeStock(product.id, stock);
    const changes = Object.entries(stock).filter(([, qty]) => qty > 0).map(([sizeId, qty]) => ({ sizeId, from: 0, to: qty }));
    if (changes.length) movedNow = insertMove(getDb(), { key: `new-${crypto.randomUUID()}`, hash: '', productId: product.id, actor, reason: 'received', changes, note: 'new product' });
  });
  invalidateProducts();
  recordMove(movedNow, product.title);
  return getProduct(product.id)!;
}

/**
 * Change a product. Stock moves with every sale, so it is only written for the
 * sizes sent, and, with expectedStockBySize (what the admin saw), only if
 * nobody bought one meanwhile: otherwise 409 and nothing is saved.
 */
export function updateProduct(id: string, input: unknown, actor = 'admin'): StoredProduct {
  const existing = getProduct(id);
  if (!existing) throw new HttpError(404, 'Product not found.');
  const changes = { ...((input && typeof input === 'object' ? input : {}) as Obj) };
  const expectedBySize = expectedStockFromInput(changes, existing);
  delete changes.expectedStock;
  delete changes.expectedStockBySize;
  const product = validateProduct({ ...existing, ...changes, stockBySize: undefined });
  const stock = stockFromInput(changes, product);
  const { stockCount, stockBySize, active, ...rest } = { ...product, id: existing.id, createdAt: existing.createdAt };
  void stockCount;
  void stockBySize;
  const db = getDb();
  let movedNow: StockMove | null = null;
  inTransaction(() => {
    db.prepare('UPDATE products SET data = ?, active = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(rest), active ? 1 : 0, new Date().toISOString(), id);
    const moved: SizeChange[] = [];
    for (const [size, qty] of Object.entries(stock ?? {})) {
      const expected = expectedBySize?.[size];
      const current = (db.prepare('SELECT qty FROM product_stock WHERE product_id = ? AND size_id = ?').get(id, size) as { qty: number } | undefined)?.qty ?? 0;
      if (current !== qty) moved.push({ sizeId: size, from: current, to: qty });
      if (expected === undefined) {
        writeStock(id, { [size]: qty });
        continue;
      }
      if (current !== expected) {
        const name = product.profiles.find((pr) => pr.id === size)?.name ?? size;
        throw new HttpError(409, `Stock for ${name} changed while you were editing (now ${current}). Check it and save again.`);
      }
      writeStock(id, { [size]: qty });
    }
    // Sizes no longer offered keep no stock: what they had leaves the books in the same move.
    const offeredNow = new Set(product.profiles.map((pr) => pr.id));
    for (const r of db.prepare('SELECT size_id, qty FROM product_stock WHERE product_id = ? AND qty > 0 ORDER BY size_id').all(id) as Array<{ size_id: string; qty: number }>) {
      if (!offeredNow.has(r.size_id)) moved.push({ sizeId: r.size_id, from: r.qty, to: 0 });
    }
    // Every change of stock is in the ledger, with who made it (here: the product editor).
    if (moved.length) movedNow = insertMove(db, { key: `edit-${crypto.randomUUID()}`, hash: '', productId: id, actor, reason: 'correction', changes: moved, note: 'product editor' });
    // Sizes no longer offered keep no stock.
    const offered = product.profiles.map((pr) => pr.id);
    db.prepare(`DELETE FROM product_stock WHERE product_id = ? AND size_id NOT IN (${offered.map(() => '?').join(',')})`).run(id, ...offered);
  });
  invalidateProducts();
  recordMove(movedNow, product.title);
  return getProduct(id)!;
}

function expectedStockFromInput(input: Obj, product: StoredProduct): Record<string, number> | undefined {
  const check = (v: unknown) => {
    if (!(Number.isInteger(v) && (v as number) >= 0)) throw new HttpError(400, 'Expected stock must be a whole number.');
    return v as number;
  };
  if (input.expectedStockBySize !== undefined) {
    if (!input.expectedStockBySize || typeof input.expectedStockBySize !== 'object') throw new HttpError(400, 'Expected stock must be an object.');
    return Object.fromEntries(Object.entries(input.expectedStockBySize as Obj).map(([k, v]) => [k, check(v)]));
  }
  if (input.expectedStock !== undefined) return { [product.defaultProfileId]: check(input.expectedStock) };
  return undefined;
}

/** Add or remove pieces of one size (the + / − buttons); never below zero. */
export function adjustStock(id: string, sizeId: string, delta: number): StoredProduct {
  const product = getProduct(id);
  if (!product) throw new HttpError(404, 'Product not found.');
  if (!product.profiles.some((pr) => pr.id === sizeId)) throw new HttpError(400, 'This product does not offer that size.');
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 1000) throw new HttpError(400, 'Change must be a whole number from -1000 to 1000.');
  const db = getDb();
  inTransaction(() => {
    db.prepare('INSERT OR IGNORE INTO product_stock (product_id, size_id, qty) VALUES (?, ?, 0)').run(id, sizeId);
    const r = db.prepare('UPDATE product_stock SET qty = qty + ? WHERE product_id = ? AND size_id = ? AND qty + ? >= 0').run(delta, id, sizeId, delta);
    if (r.changes !== 1) throw new HttpError(409, 'There are not that many pieces to remove.');
  });
  invalidateProducts();
  return getProduct(id)!;
}

/**
 * A copy of a product (for a colour variant): same photos, text, price and sizes, no stock,
 * hidden until the owner shows it, placed right after the original. The same key again
 * returns the first copy instead of making another.
 */
export function duplicateProduct(id: string, key: string, actor = 'admin'): { product: StoredProduct; replayed: boolean } {
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(key)) throw new HttpError(400, 'Give an idempotency key.');
  // The key names one copy of one product: { sourceId, copyId }.
  const earlier = (): { product: StoredProduct; replayed: boolean } | null => {
    const row = getDb().prepare('SELECT data FROM kv WHERE key = ?').get(`dup:${key}`) as { data: string } | undefined;
    if (!row) return null;
    const done = JSON.parse(row.data) as { sourceId?: string; copyId?: string };
    if (done.sourceId !== id) throw new HttpError(409, 'This request was already used to copy another product. Refresh and try again.', {}, { code: 'key_reused' });
    const copy = getProduct(done.copyId ?? '');
    if (!copy) throw new HttpError(404, 'The copy made by this request no longer exists. Refresh and duplicate again.');
    return { product: copy, replayed: true };
  };
  const first = earlier();
  if (first) return first;
  const original = getProduct(id);
  if (!original) throw new HttpError(404, 'Product not found.');
  const copyId = `prod-${crypto.randomBytes(6).toString('hex')}`;
  const { stockCount, stockBySize, active, archived, ...rest } = original;
  void stockCount;
  void stockBySize;
  void active;
  void archived;
  const title = `${original.title} (copy)`.slice(0, 160);
  const data = { ...rest, id: copyId, title, sku: undefined, createdAt: new Date().toISOString(), reviewsCount: 0 };
  const db = getDb();
  let replay: { product: StoredProduct; replayed: boolean } | null = null;
  inTransaction(() => {
    replay = earlier();
    if (replay) return;
    const pos = (db.prepare('SELECT position FROM products WHERE id = ?').get(id) as { position: number }).position;
    db.prepare('UPDATE products SET position = position + 1 WHERE position > ?').run(pos);
    db.prepare('INSERT INTO products (id, data, stock, active, position, updated_at) VALUES (?, ?, 0, 0, ?, ?)').run(copyId, JSON.stringify(data), pos + 1, new Date().toISOString());
    writeStock(copyId, Object.fromEntries(original.profiles.map((s) => [s.id, 0])));
    db.prepare('INSERT INTO kv (key, data, updated_at) VALUES (?, ?, ?)').run(`dup:${key}`, JSON.stringify({ sourceId: id, copyId }), new Date().toISOString());
  });
  if (replay) return replay;
  invalidateProducts();
  audit('product.duplicated', { by: actor, productId: id, copyId, title });
  return { product: getProduct(copyId)!, replayed: false };
}

/** Remove from the shop for good (kept for past orders); restore brings it back hidden. */
export function setArchived(id: string, archived: boolean): StoredProduct {
  if (!getProduct(id)) throw new HttpError(404, 'Product not found.');
  getDb()
    .prepare('UPDATE products SET archived = ?, active = CASE WHEN ? = 1 THEN 0 ELSE active END, updated_at = ? WHERE id = ?')
    .run(archived ? 1 : 0, archived ? 1 : 0, new Date().toISOString(), id);
  invalidateProducts();
  return getProduct(id)!;
}

/** Order of products in the shop: the ids in the order given (unknown ids are refused). */
export function reorderProducts(ids: unknown): void {
  if (!Array.isArray(ids) || ids.length > 1000 || ids.some((x) => typeof x !== 'string')) throw new HttpError(400, 'Give the product ids in order.');
  const known = new Set(listProducts({ includeHidden: true, includeArchived: true }).map((p) => p.id));
  if ((ids as string[]).some((x) => !known.has(x))) throw new HttpError(400, 'Unknown product in the list.');
  const update = getDb().prepare('UPDATE products SET position = ? WHERE id = ?');
  inTransaction(() => (ids as string[]).forEach((pid, i) => update.run(i, pid)));
  invalidateProducts();
}

// ── validation ──────────────────────────────────────────────────────────────

/** The stored product without going through the cache (used during validation). */
function getProductRaw(id: string): Product | undefined {
  const r = getDb().prepare('SELECT data FROM products WHERE id = ?').get(id) as { data: string } | undefined;
  return r ? (JSON.parse(r.data) as Product) : undefined;
}

type Obj = Record<string, unknown>;
const WEAVES = ['Sateen', 'Percale', 'Linen', 'Jacquard'];

function text(v: unknown, field: string, max: number, { required = false } = {}): string {
  if (v === undefined || v === null || v === '') {
    if (required) throw new HttpError(400, `${field} is required.`);
    return '';
  }
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be text.`);
  const s = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, '').trim();
  if (s.length > max) throw new HttpError(400, `${field} is too long (max ${max} characters).`);
  return s;
}

function num(v: unknown, field: string, min: number, max: number, { integer = false } = {}): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    throw new HttpError(400, `${field} must be ${integer ? 'a whole number' : 'a number'} from ${min} to ${max}.`);
  }
  return integer ? n : Math.round(n * 100) / 100;
}

function validateProfile(v: unknown, i: number): BedProfileMeasurement {
  const p = (v && typeof v === 'object' ? v : {}) as Obj;
  const id = text(p.id, `Size ${i + 1}`, 30, { required: true });
  if (!SIZE_ID.test(id)) throw new HttpError(400, `Size ${i + 1}: the id may use only lowercase letters, digits and dashes.`);
  return {
    id: id as BedProfileMeasurement['id'],
    name: text(p.name, `Size ${i + 1} name`, 60, { required: true }),
    badge: text(p.badge, `Size ${i + 1} badge`, 40),
    mattressSize: text(p.mattressSize, `Size ${i + 1} mattress`, 80),
    fittedSheet: text(p.fittedSheet, `Size ${i + 1} fitted sheet`, 80),
    flatSheet: text(p.flatSheet, `Size ${i + 1} flat sheet`, 80),
    pillowcases: text(p.pillowcases, `Size ${i + 1} pillowcases`, 80),
    duvetCover: text(p.duvetCover, `Size ${i + 1} duvet cover`, 80) || undefined,
    cushionCovers: text(p.cushionCovers, `Size ${i + 1} cushion covers`, 80) || undefined,
    piecesIncluded: num(p.piecesIncluded ?? 1, `Size ${i + 1} pieces`, 1, 20, { integer: true }),
    priceDelta: num(p.priceDelta ?? 0, `Size ${i + 1} price difference`, -10_000, 10_000),
  };
}

export function validateProduct(input: unknown): StoredProduct {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Product must be an object.');
  const p = input as Obj;
  const title = text(p.title, 'Title', 160, { required: true });
  const category = text(p.category, 'Category', 40, { required: true });
  // A product may keep a category the owner later removed; new values must exist.
  const existing = typeof p.id === 'string' ? getProductRaw(p.id) : undefined;
  if (category !== existing?.category && !getSettings('catalog').categories.some((c) => c.id === category)) throw new HttpError(400, 'Unknown category: add it in Settings → Catalogue first.');
  const sku = text(p.sku, 'SKU', 40);
  if (sku && !/^[A-Za-z0-9][A-Za-z0-9 ._\/-]*$/.test(sku)) throw new HttpError(400, 'SKU may use letters, digits, spaces and . _ / -');
  const weave = text(p.weave, 'Weave', 20) || 'Sateen';
  if (!WEAVES.includes(weave)) throw new HttpError(400, 'Unknown weave.');
  const price = num(p.price, 'Price', 1, 100_000);
  const compareAt = p.compareAtPrice === undefined || p.compareAtPrice === null || p.compareAtPrice === '' ? undefined : num(p.compareAtPrice, 'Compare-at price', 0, 100_000);

  if (!Array.isArray(p.profiles) || p.profiles.length === 0 || p.profiles.length > 12) throw new HttpError(400, 'Add 1 to 12 sizes.');
  const profiles = p.profiles.map(validateProfile);
  if (new Set(profiles.map((x) => x.id)).size !== profiles.length) throw new HttpError(400, 'Each bed size may appear once.');
  for (const pr of profiles) if (price + pr.priceDelta <= 0) throw new HttpError(400, `${pr.name} would cost nothing or less.`);
  const defaultProfileId = text(p.defaultProfileId, 'Default size', 30) || profiles[0].id;
  if (!profiles.some((x) => x.id === defaultProfileId)) throw new HttpError(400, 'The default size must be one of the sizes.');

  const colorsIn = Array.isArray(p.colors) ? p.colors : [];
  if (colorsIn.length > 12) throw new HttpError(400, 'At most 12 colours.');
  const colors = colorsIn.map((c, i) => {
    const o = (c && typeof c === 'object' ? c : {}) as Obj;
    const hex = text(o.hex, `Colour ${i + 1}`, 7) || '#ffffff';
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) throw new HttpError(400, `Colour ${i + 1} must look like #ffffff.`);
    return { name: text(o.name, `Colour ${i + 1} name`, 40, { required: true }), hex };
  });

  const gallery = Array.isArray(p.galleryImages) ? p.galleryImages : [];
  if (gallery.length > 8) throw new HttpError(400, 'At most 8 gallery images.');

  return {
    id: typeof p.id === 'string' ? p.id : '',
    title,
    sku: sku || undefined,
    slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80),
    description: text(p.description, 'Description', 4000),
    shortDescription: text(p.shortDescription, 'Short description', 300),
    category,
    price,
    compareAtPrice: compareAt,
    material: text(p.material, 'Material', 120),
    threadCount: num(p.threadCount ?? 0, 'Thread count', 0, 3000, { integer: true }),
    weave: weave as Product['weave'],
    colors: colors.length ? colors : [{ name: 'Standard', hex: '#ffffff' }],
    featuredImage: acceptImageRef(p.featuredImage, 'Main photo', { required: true }),
    galleryImages: gallery.map((g, i) => acceptImageRef(g, `Gallery photo ${i + 1}`)).filter(Boolean),
    // The raw phone snap is not kept: only the photos shown in the shop.
    aiTransformedImage: acceptImageRef(p.aiTransformedImage, 'Styled photo') || undefined,
    aiStagingPrompt: text(p.aiStagingPrompt, 'Staging prompt', 1000) || undefined,
    isAiEnhanced: p.isAiEnhanced === true,
    stockCount: 0,
    stockBySize: {},
    isFeatured: p.isFeatured === true,
    isNewArrival: p.isNewArrival === true,
    rating: num(p.rating ?? 5, 'Rating', 0, 5),
    reviewsCount: num(p.reviewsCount ?? 0, 'Reviews', 0, 1_000_000, { integer: true }),
    profiles,
    defaultProfileId,
    createdAt: typeof p.createdAt === 'string' ? p.createdAt.slice(0, 40) : new Date().toISOString(),
    active: p.active === undefined ? true : p.active === true,
  };
}
