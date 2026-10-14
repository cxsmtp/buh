import crypto from 'node:crypto';
import type { BedProfileMeasurement, Product } from '@/types';
import { INITIAL_PRODUCTS } from '@/data/initialData';
import { getDb, inTransaction } from './db';
import { HttpError } from './http';
import { acceptImageRef } from './images';

/**
 * The catalogue. Stock lives in its own column so orders can reserve it
 * atomically (UPDATE … WHERE stock >= qty); everything else is the Product
 * JSON. Seeded with the starter catalogue on first start.
 */

export interface StoredProduct extends Product {
  active: boolean;
}

interface Row {
  id: string;
  data: string;
  stock: number;
  active: number;
}

let cache: StoredProduct[] | null = null;

function seedIfEmpty() {
  const db = getDb();
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM products').get() as { n: number };
  if (n > 0) return;
  const insert = db.prepare('INSERT INTO products (id, data, stock, active, position, updated_at) VALUES (?, ?, ?, 1, ?, ?)');
  inTransaction(() => {
    INITIAL_PRODUCTS.forEach((p, i) => {
      const { stockCount, ...rest } = p;
      insert.run(p.id, JSON.stringify(rest), stockCount, i, new Date().toISOString());
    });
  });
}

function fromRow(r: Row): StoredProduct {
  return { ...(JSON.parse(r.data) as Product), stockCount: r.stock, active: r.active === 1 };
}

export function listProducts({ includeHidden = false } = {}): StoredProduct[] {
  if (!cache) {
    seedIfEmpty();
    cache = (getDb().prepare('SELECT id, data, stock, active FROM products ORDER BY position, rowid').all() as Row[]).map(fromRow);
  }
  return includeHidden ? cache : cache.filter((p) => p.active);
}

export function getProduct(id: string): StoredProduct | undefined {
  return listProducts({ includeHidden: true }).find((p) => p.id === id);
}

export function invalidateProducts() {
  cache = null;
}

export function createProduct(input: unknown): StoredProduct {
  const product = validateProduct(input);
  product.id = `prod-${crypto.randomBytes(6).toString('hex')}`;
  product.createdAt = new Date().toISOString();
  const { stockCount, active, ...rest } = product;
  seedIfEmpty();
  // New products go first in the catalogue.
  getDb()
    .prepare('INSERT INTO products (id, data, stock, active, position, updated_at) VALUES (?, ?, ?, ?, (SELECT COALESCE(MIN(position), 0) - 1 FROM products), ?)')
    .run(product.id, JSON.stringify(rest), stockCount, active ? 1 : 0, new Date().toISOString());
  invalidateProducts();
  return getProduct(product.id)!;
}

export function updateProduct(id: string, input: unknown): StoredProduct {
  const existing = getProduct(id);
  if (!existing) throw new HttpError(404, 'Product not found.');
  const product = validateProduct({ ...existing, ...(input as object) });
  const { stockCount, active, ...rest } = { ...product, id: existing.id, createdAt: existing.createdAt };
  getDb()
    .prepare('UPDATE products SET data = ?, stock = ?, active = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(rest), stockCount, active ? 1 : 0, new Date().toISOString(), id);
  invalidateProducts();
  return getProduct(id)!;
}

// ── validation ──────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;
const CATEGORIES = ['bedsheets', 'duvet-covers', 'fitted-sheets', 'hotel-luxury', 'silk-collection'];
const WEAVES = ['Sateen', 'Percale', 'Linen', 'Jacquard'];
const PROFILE_IDS = ['single', 'double', 'queen', 'king', 'super-king', 'custom'];

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
  const id = text(p.id, `Size ${i + 1}`, 20, { required: true });
  if (!PROFILE_IDS.includes(id)) throw new HttpError(400, `Size ${i + 1} is not a known bed size.`);
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
  const category = text(p.category, 'Category', 30, { required: true });
  if (!CATEGORIES.includes(category)) throw new HttpError(400, 'Unknown category.');
  const weave = text(p.weave, 'Weave', 20) || 'Sateen';
  if (!WEAVES.includes(weave)) throw new HttpError(400, 'Unknown weave.');
  const price = num(p.price, 'Price', 1, 100_000);
  const compareAt = p.compareAtPrice === undefined || p.compareAtPrice === null || p.compareAtPrice === '' ? undefined : num(p.compareAtPrice, 'Compare-at price', 0, 100_000);

  if (!Array.isArray(p.profiles) || p.profiles.length === 0 || p.profiles.length > 8) throw new HttpError(400, 'Add 1 to 8 bed sizes.');
  const profiles = p.profiles.map(validateProfile);
  if (new Set(profiles.map((x) => x.id)).size !== profiles.length) throw new HttpError(400, 'Each bed size may appear once.');
  for (const pr of profiles) if (price + pr.priceDelta <= 0) throw new HttpError(400, `${pr.name} would cost nothing or less.`);
  const defaultProfileId = text(p.defaultProfileId, 'Default size', 20) || profiles[0].id;
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
    slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80),
    description: text(p.description, 'Description', 4000),
    shortDescription: text(p.shortDescription, 'Short description', 300),
    category: category as Product['category'],
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
    stockCount: num(p.stockCount ?? 0, 'Stock', 0, 100_000, { integer: true }),
    isFeatured: p.isFeatured === true,
    isNewArrival: p.isNewArrival === true,
    rating: num(p.rating ?? 5, 'Rating', 0, 5),
    reviewsCount: num(p.reviewsCount ?? 0, 'Reviews', 0, 1_000_000, { integer: true }),
    profiles,
    defaultProfileId: defaultProfileId as Product['defaultProfileId'],
    createdAt: typeof p.createdAt === 'string' ? p.createdAt.slice(0, 40) : new Date().toISOString(),
    active: p.active === undefined ? true : p.active === true,
  };
}
