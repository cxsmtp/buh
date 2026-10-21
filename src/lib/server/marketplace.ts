import crypto from 'node:crypto';
import type { CatalogSettings, Product } from '@/types';
import { toCsv } from './csv';

/**
 * "Export for Amazon / Noon" (Settings → Catalogue): groundwork for listing the shop's products
 * on Amazon.ae or Noon. One row per size or variant (grouped by parent_sku), with what both
 * marketplaces ask for: SKU, title, description, brand, price in AED, stock, photos, category and
 * the size. It is not either marketplace's own template: their column names differ by category,
 * so the owner copies these columns into the template their seller account gives them. No API
 * (that needs the seller account's credentials).
 *
 * SKUs: the shop's own SKU when the product has one (plus the size: BUH-JAI-01-KING), else a stable
 * one made from the product's id (BUH-A1B2C3D4E5F6-KING), the same in every export. At most 40
 * characters (Amazon's limit), letters, digits and dashes.
 */

export const MARKETPLACE_HEADERS = [
  'sku',
  'parent_sku',
  'title',
  'description',
  'brand',
  'price_aed',
  'compare_at_price_aed',
  'quantity',
  'main_image_url',
  'other_image_urls',
  'category',
  'product_type',
  'variation_theme',
  'size',
  'size_detail',
  'colour',
  'material',
  'weight_grams',
] as const;

const SKU_MAX = 40;
const clean = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const short = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 10).toUpperCase();

/** The parent SKU: the owner's SKU, or one made from the product's id (stable across exports). */
export function parentSku(p: Pick<Product, 'id' | 'sku'> & { marketplaceSku?: string }): string {
  // The code listings were made under before the product had an SKU: kept, so they still match.
  const kept = clean(p.marketplaceSku ?? '');
  if (kept) return kept.slice(0, SKU_MAX);
  const own = clean(p.sku ?? '');
  if (own) return own.slice(0, SKU_MAX);
  const fromId = clean(p.id.replace(/^prod-/, ''));
  const sku = `BUH-${fromId}`;
  return sku.length <= SKU_MAX ? sku : `BUH-${short(p.id)}`;
}

/** One size's SKU: the parent's plus the size (or a short fingerprint when that would be too long). */
export function variantSku(p: Pick<Product, 'id' | 'sku'> & { marketplaceSku?: string }, sizeId: string): string {
  const parent = parentSku(p);
  const sku = `${parent}-${clean(sizeId) || short(sizeId)}`;
  return sku.length <= SKU_MAX ? sku : `${parent.slice(0, SKU_MAX - 11)}-${short(`${p.id}|${sizeId}`)}`;
}

/** The size's SKU as the shop shows it (its own SKU plus the size), whatever code marketplaces know it by. */
export function shopVariantSku(p: Pick<Product, 'id' | 'sku'>, sizeId: string): string {
  return variantSku({ id: p.id, sku: p.sku }, sizeId);
}

/** The product's SKU as the shop shows it (its own; else the fixed one from its id). */
export function shopSku(p: Pick<Product, 'id' | 'sku'>): string {
  return parentSku({ id: p.id, sku: p.sku });
}

const money = (aed: number) => (Math.round(aed * 100) / 100).toFixed(2);

export function marketplaceRows(products: Product[], opts: { base: string; brand: string; categories: CatalogSettings['categories']; labelStyledPhotos?: boolean }): unknown[][] {
  const abs = (u: string) => (!u ? '' : u.startsWith('http') ? u : `${opts.base}${u}`);
  return products.flatMap((p) => {
    const simple = p.productType === 'simple';
    const category = opts.categories.find((c) => c.id === p.category)?.label ?? p.category;
    const main = abs(p.aiTransformedImage || p.featuredImage);
    // Styled (AI) photos go out only while the shop labels them, as in the Meta feed.
    const shown = p.galleryImages.filter((u) => opts.labelStyledPhotos !== false || !p.stagedPhotos?.[u]);
    const others = [p.featuredImage, ...shown].map(abs).filter((u) => u && u !== main).filter((u, i, all) => all.indexOf(u) === i).slice(0, 8).join('|');
    return p.profiles.map((s) => [
      variantSku(p, s.id),
      parentSku(p),
      `${p.title} (${s.name})`.slice(0, 200),
      (p.description || p.shortDescription || p.title).slice(0, 2000),
      opts.brand,
      money(p.price + (s.priceDelta || 0)),
      p.compareAtPrice && p.compareAtPrice > p.price ? money(p.compareAtPrice + (s.priceDelta || 0)) : '',
      Math.max(0, p.stockBySize[s.id] ?? 0),
      main,
      others,
      category,
      simple ? 'simple' : 'bedding',
      'Size',
      s.name,
      simple ? s.dimensions ?? '' : s.mattressSize,
      p.colors.map((c) => c.name).join(' / '),
      p.material,
      Number(s.weightGrams) > 0 ? Math.round(Number(s.weightGrams)) : '',
    ]);
  });
}

export function marketplaceCsv(products: Product[], opts: { base: string; brand: string; categories: CatalogSettings['categories']; labelStyledPhotos?: boolean }): string {
  return toCsv([...MARKETPLACE_HEADERS], marketplaceRows(products, opts));
}
