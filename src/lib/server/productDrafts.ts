import { getDb } from './db';
import { HttpError } from './http';
import { IMAGE_NAME } from './images';
import { getProduct } from './products';

/**
 * Drafts of the step-by-step product editor. They save themselves while the
 * owner works (like the settings do), so a phone call, a closed tab or a flat
 * battery loses nothing, and a draft started on the phone can be finished on a
 * laptop. One draft for a new product ('new') and one per product being edited.
 * Nothing in a draft is shown in the shop: publishing goes through the normal,
 * fully validated product save. Photos in a draft are already uploaded (their
 * URLs), so a draft is small.
 */

export interface ProductDraft {
  data: Record<string, unknown>;
  updatedAt: string;
  updatedBy: string;
}

const MAX_BYTES = 64 * 1024;

function checkId(id: string): string {
  if (id === 'new') return id;
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(id) || !getProduct(id)) throw new HttpError(404, 'Product not found.');
  return id;
}

const s = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, '').slice(0, max) : undefined);
const b = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
const n = (v: unknown, min: number, max: number) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined);

function photo(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  if (v.startsWith('/api/images/') && IMAGE_NAME.test(v.slice('/api/images/'.length))) return v;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && v.length <= 2000 ? u.href : null;
  } catch {
    return null;
  }
}

/** Keep only the editor's own fields, each of the right kind (anything else is dropped). */
export function cleanDraft(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'A draft must be an object.');
  const d = input as Record<string, unknown>;
  const photos = Array.isArray(d.photos) ? d.photos.slice(0, 8).map(photo) : [];
  if (photos.some((p) => p === null)) throw new HttpError(400, 'Upload photos before saving them in a draft.');
  const sizes = Array.isArray(d.sizes)
    ? d.sizes.slice(0, 12).map((x) => {
        const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
        return {
          id: s(o.id, 30) ?? '',
          name: s(o.name, 60) ?? '',
          badge: s(o.badge, 40) ?? '',
          mattressSize: s(o.mattressSize, 80) ?? '',
          fittedSheet: s(o.fittedSheet, 80) ?? '',
          flatSheet: s(o.flatSheet, 80) ?? '',
          pillowcases: s(o.pillowcases, 80) ?? '',
          duvetCover: s(o.duvetCover, 80),
          cushionCovers: s(o.cushionCovers, 80),
          otherPieces: s(o.otherPieces, 80),
          piecesIncluded: n(o.piecesIncluded, 1, 20) ?? 1,
          priceDelta: n(o.priceDelta, -10_000, 10_000) ?? 0,
          weightGrams: n(o.weightGrams, 1, 50_000) === undefined ? undefined : Math.round(o.weightGrams as number),
        };
      })
    : [];
  const stock: Record<string, number> = {};
  if (d.stock && typeof d.stock === 'object' && !Array.isArray(d.stock)) {
    for (const [k, v] of Object.entries(d.stock as Record<string, unknown>).slice(0, 12)) {
      const q = n(v, 0, 100_000);
      if (/^[a-z0-9][a-z0-9-]{0,29}$/.test(k) && q !== undefined) stock[k] = Math.round(q);
    }
  }
  const colors = Array.isArray(d.colors)
    ? d.colors.slice(0, 12).map((c) => {
        const o = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
        const hex = s(o.hex, 7) ?? '#ffffff';
        return { name: s(o.name, 40) ?? '', hex: /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : '#ffffff' };
      })
    : undefined;
  const out: Record<string, unknown> = {
    step: n(d.step, 0, 3),
    title: s(d.title, 160),
    sku: s(d.sku, 40),
    category: s(d.category, 40),
    price: s(d.price, 12),
    compareAtPrice: s(d.compareAtPrice, 12),
    shortDescription: s(d.shortDescription, 300),
    description: s(d.description, 4000),
    material: s(d.material, 120),
    threadCount: s(d.threadCount, 6),
    weave: s(d.weave, 30),
    colors,
    photos,
    sizes,
    stock,
    defaultProfileId: s(d.defaultProfileId, 30),
    active: b(d.active),
    fitted: b(d.fitted),
    isFeatured: b(d.isFeatured),
    isNewArrival: b(d.isNewArrival),
    // What the stock was when editing started (for the conflict check on publish).
    seenStock: d.seenStock && typeof d.seenStock === 'object' && !Array.isArray(d.seenStock)
      ? Object.fromEntries(Object.entries(d.seenStock as Record<string, unknown>).slice(0, 12).filter(([, v]) => n(v, 0, 100_000) !== undefined))
      : undefined,
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  if (JSON.stringify(out).length > MAX_BYTES) throw new HttpError(413, 'The draft is too large.');
  return out;
}

export function getDraft(id: string): ProductDraft | null {
  const row = getDb().prepare('SELECT data, updated_at, updated_by FROM product_drafts WHERE id = ?').get(checkId(id)) as { data: string; updated_at: string; updated_by: string } | undefined;
  return row ? { data: JSON.parse(row.data) as Record<string, unknown>, updatedAt: row.updated_at, updatedBy: row.updated_by } : null;
}

export function saveDraft(id: string, input: unknown, actor: string): ProductDraft {
  const data = cleanDraft(input);
  const updatedAt = new Date().toISOString();
  getDb()
    .prepare('INSERT INTO product_drafts (id, data, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, updated_by = excluded.updated_by')
    .run(checkId(id), JSON.stringify(data), updatedAt, actor.slice(0, 200));
  return { data, updatedAt, updatedBy: actor };
}

export function deleteDraft(id: string): void {
  getDb().prepare('DELETE FROM product_drafts WHERE id = ?').run(id === 'new' ? id : id.slice(0, 60));
}
