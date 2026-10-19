import type { BedProfileMeasurement, CatalogSettings, Product, ProductType } from '@/types';

/**
 * Bedding or simple products (BUH-02.17). Everything before is bedding: its sizes are bed sizes
 * with sheet and pillowcase measurements. A simple product (towels, cushions, throws, curtains,
 * decor) has plain variants in the same list (`profiles`), so stock per variant, orders, weights,
 * labels and the feeds work the same way; a variant has a name, a price difference, stock, a
 * weight and optional dimensions, and no bed measurements. Stored products without the field are
 * bedding (nothing is rewritten).
 */

export const PRODUCT_TYPES: readonly ProductType[] = ['bedding', 'simple'];

export function productTypeOf(p: Pick<Product, 'productType'> | null | undefined): ProductType {
  return p?.productType === 'simple' ? 'simple' : 'bedding';
}

export const isSimple = (p: Pick<Product, 'productType'> | null | undefined) => productTypeOf(p) === 'simple';

/** What a new product in this category starts as (Settings → Catalogue; absent: bedding). */
export function defaultTypeFor(catalog: Pick<CatalogSettings, 'categories'>, categoryId: string): ProductType {
  return catalog.categories.find((c) => c.id === categoryId)?.defaultType === 'simple' ? 'simple' : 'bedding';
}

/** The size line under a size or variant's name: the bed's mattress, or the variant's dimensions. */
export function sizeDetail(p: Pick<Product, 'productType'>, s: Pick<BedProfileMeasurement, 'mattressSize' | 'dimensions'>): string {
  return (isSimple(p) ? s.dimensions ?? '' : s.mattressSize ?? '').trim();
}

/** A fresh variant id (lowercase letters, digits, dashes; unique on the product). */
export function newVariantId(taken: string[]): string {
  for (;;) {
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    const id = `v-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
    if (!taken.includes(id)) return id;
  }
}

/** A blank variant of a simple product. */
export function blankVariant(taken: string[], name = 'One size'): BedProfileMeasurement {
  return { id: newVariantId(taken), name, badge: '', mattressSize: '', fittedSheet: '', flatSheet: '', pillowcases: '', piecesIncluded: 1, priceDelta: 0, dimensions: '' };
}
