import crypto from 'node:crypto';
import { dubaiToday } from '@/lib/reportPeriods';
import { audit } from './audit';
import { getDb, inTransaction } from './db';
import { HttpError } from './http';
import { getProduct, listProducts } from './products';

/**
 * Shareable selections ("collections"): the owner picks a few products in Inventory, gives them a
 * short title ("Eid picks") and gets one link, /c/eid-picks-7k2mq, to send on WhatsApp or post on
 * Instagram. The page shows just those products (only the ones on sale: hidden and removed products
 * never appear), with add to bag. A collection may have a last day (a UAE date): after it the link
 * shows "This selection has ended" and a way into the shop.
 *
 * The slug is the title's words plus five random characters (31-letter alphabet, ~28 million
 * choices), so links are short but can't be guessed from a title; it never changes once made,
 * even when the collection is renamed. Views and adds to bag are two counters, nothing about who.
 */

export interface Collection {
  id: string;
  slug: string;
  title: string;
  productIds: string[];
  /** The last day the link opens (YYYY-MM-DD, UAE), or null for no end. */
  expiresOn: string | null;
  views: number;
  bagAdds: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

/** What a shopper's page gets: the products on sale, in order, and whether it has ended. */
export interface PublicCollection {
  slug: string;
  title: string;
  productIds: string[];
  expiresOn: string | null;
  ended: boolean;
}

interface Row {
  id: string;
  slug: string;
  title: string;
  product_ids: string;
  expires_on: string | null;
  views: number;
  bag_adds: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

export const COLLECTION_LIMITS = { titleMax: 60, products: 60, collections: 200 };
/** A collection's address: lowercase words and digits joined by dashes, ending in the random part. */
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?-[a-z2-9]{5}$/;
const SLUG_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const ID_PATTERN = /^col-[a-f0-9]{12}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function fromRow(r: Row): Collection {
  let ids: string[] = [];
  try {
    const parsed = JSON.parse(r.product_ids) as unknown;
    if (Array.isArray(parsed)) ids = parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    // unreadable: shown as empty
  }
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    productIds: ids,
    expiresOn: r.expires_on,
    views: r.views,
    bagAdds: r.bag_adds,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

/** Has it ended? The last day is a UAE date: it opens until midnight in the UAE. */
export function hasEnded(expiresOn: string | null, now = Date.now()): boolean {
  return Boolean(expiresOn) && dubaiToday(now) > (expiresOn as string);
}

function slugWords(title: string): string {
  const base = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/g, '');
  return base || 'picks';
}

function randomPart(): string {
  const bytes = crypto.randomBytes(5);
  return Array.from(bytes, (b) => SLUG_ALPHABET[b % SLUG_ALPHABET.length]).join('');
}

/** A new slug for this title (checked unused). */
export function makeSlug(title: string): string {
  const db = getDb();
  for (let i = 0; i < 20; i++) {
    const slug = `${slugWords(title)}-${randomPart()}`;
    if (!db.prepare('SELECT 1 FROM collections WHERE slug = ?').get(slug)) return slug;
  }
  throw new HttpError(503, 'Could not make a new link. Please try again.');
}

// ── validation (an allow-list of fields, each checked) ────────────────────────

type Obj = Record<string, unknown>;

function cleanTitle(v: unknown): string {
  if (typeof v !== 'string') throw new HttpError(400, 'Give the selection a title.');
  const t = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) throw new HttpError(400, 'Give the selection a title.');
  if (t.length > COLLECTION_LIMITS.titleMax) throw new HttpError(400, `The title is too long (at most ${COLLECTION_LIMITS.titleMax} characters).`);
  return t;
}

/** Products that exist (hidden ones too: the page shows only those on sale), once each, in order. */
function cleanProductIds(v: unknown): string[] {
  if (!Array.isArray(v) || v.length === 0) throw new HttpError(400, 'Choose at least one product.');
  if (v.length > COLLECTION_LIMITS.products) throw new HttpError(400, `At most ${COLLECTION_LIMITS.products} products in one selection.`);
  const out: string[] = [];
  for (const id of v) {
    if (typeof id !== 'string' || id.length > 80 || !getProduct(id)) throw new HttpError(400, 'One of the products no longer exists. Refresh and try again.');
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** A real calendar date (YYYY-MM-DD), not before today in the UAE; empty or null: no end. */
function cleanExpiry(v: unknown, now = Date.now()): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !DATE.test(v)) throw new HttpError(400, 'The last day must be a date (YYYY-MM-DD).');
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw new HttpError(400, 'The last day must be a real date.');
  if (v < dubaiToday(now)) throw new HttpError(400, 'The last day can’t be in the past.');
  if (v > dubaiToday(now + 3 * 366 * 86_400_000)) throw new HttpError(400, 'Choose a last day within three years.');
  return v;
}

function checkId(id: string): void {
  if (!ID_PATTERN.test(id)) throw new HttpError(404, 'Selection not found.');
}

// ── reads ─────────────────────────────────────────────────────────────────────

export function listCollections(): Collection[] {
  return (getDb().prepare('SELECT * FROM collections ORDER BY created_at DESC, rowid DESC').all() as Row[]).map(fromRow);
}

export function getCollection(id: string): Collection | undefined {
  if (!ID_PATTERN.test(id)) return undefined;
  const r = getDb().prepare('SELECT * FROM collections WHERE id = ?').get(id) as Row | undefined;
  return r ? fromRow(r) : undefined;
}

export function getCollectionBySlug(slug: string): Collection | undefined {
  if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug)) return undefined;
  const r = getDb().prepare('SELECT * FROM collections WHERE slug = ?').get(slug) as Row | undefined;
  return r ? fromRow(r) : undefined;
}

/**
 * The shopper's view of /c/<slug>: only products on sale (shown, not removed), in the owner's
 * order. Undefined for an address that names no collection.
 */
export function publicCollection(slug: string, now = Date.now()): PublicCollection | undefined {
  const c = getCollectionBySlug(slug);
  if (!c) return undefined;
  const onSale = new Set(listProducts().map((p) => p.id));
  return { slug: c.slug, title: c.title, productIds: c.productIds.filter((id) => onSale.has(id)), expiresOn: c.expiresOn, ended: hasEnded(c.expiresOn, now) };
}

// ── changes (admin only: the routes check the session) ────────────────────────

export function createCollection(body: Obj, actor: string): { collection: Collection; replayed: boolean } {
  const key = body.key;
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(key)) throw new HttpError(400, 'Give an idempotency key.');
  const db = getDb();
  const earlier = () => {
    const r = db.prepare('SELECT * FROM collections WHERE idempotency_key = ?').get(key) as Row | undefined;
    return r ? { collection: fromRow(r), replayed: true } : null;
  };
  const first = earlier();
  if (first) return first;
  const title = cleanTitle(body.title);
  const productIds = cleanProductIds(body.productIds);
  const expiresOn = cleanExpiry(body.expiresOn);
  let out: { collection: Collection; replayed: boolean } | null = null;
  inTransaction(() => {
    out = earlier();
    if (out) return;
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM collections').get() as { n: number };
    if (n >= COLLECTION_LIMITS.collections) throw new HttpError(409, `You have ${COLLECTION_LIMITS.collections} shared selections: delete some you no longer use first.`);
    const id = `col-${crypto.randomBytes(6).toString('hex')}`;
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO collections (id, slug, title, product_ids, expires_on, idempotency_key, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, makeSlug(title), title, JSON.stringify(productIds), expiresOn, key, now, actor, now, actor);
    out = { collection: getCollection(id)!, replayed: false };
  });
  const result = out as unknown as { collection: Collection; replayed: boolean };
  if (!result.replayed) audit('collection.created', { by: actor, id: result.collection.id, slug: result.collection.slug, title, products: productIds.length, expiresOn });
  return result;
}

/** Rename, change the products or the last day (the address stays the same). */
export function updateCollection(id: string, body: Obj, actor: string): Collection {
  checkId(id);
  const before = getCollection(id);
  if (!before) throw new HttpError(404, 'Selection not found.');
  const title = body.title === undefined ? before.title : cleanTitle(body.title);
  const productIds = body.productIds === undefined ? before.productIds : cleanProductIds(body.productIds);
  // An unchanged last day may already be past (to show it ended); a new one must not be.
  const expiresOn = body.expiresOn === undefined || body.expiresOn === before.expiresOn ? before.expiresOn : cleanExpiry(body.expiresOn);
  getDb()
    .prepare('UPDATE collections SET title = ?, product_ids = ?, expires_on = ?, updated_at = ?, updated_by = ? WHERE id = ?')
    .run(title, JSON.stringify(productIds), expiresOn, new Date().toISOString(), actor, id);
  audit('collection.updated', { by: actor, id, slug: before.slug, title, products: productIds.length, expiresOn });
  return getCollection(id)!;
}

export function deleteCollection(id: string, actor: string): void {
  checkId(id);
  const before = getCollection(id);
  if (!before) throw new HttpError(404, 'Selection not found.');
  getDb().prepare('DELETE FROM collections WHERE id = ?').run(id);
  audit('collection.deleted', { by: actor, id, slug: before.slug, title: before.title, views: before.views, bagAdds: before.bagAdds });
}

/** One view or one add to bag on an open collection's page (a counter; nothing about who). */
export function countCollectionEvent(slug: string, kind: 'view' | 'bag', now = Date.now()): boolean {
  const c = getCollectionBySlug(slug);
  if (!c || hasEnded(c.expiresOn, now)) return false;
  const column = kind === 'view' ? 'views' : 'bag_adds';
  getDb().prepare(`UPDATE collections SET ${column} = ${column} + 1 WHERE id = ? AND ${column} < 1000000000`).run(c.id);
  return true;
}
