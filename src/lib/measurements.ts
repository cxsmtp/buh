import type { BedProfileMeasurement, Product } from '@/types';

/**
 * What a size of a product is said to include, as the shop shows it: only the pieces the owner
 * filled in on that product (never a standard size's defaults), and one sheet line: "Fitted
 * sheet" when the product is ticked as fitted (elastic corners), else "Flat sheet".
 */

export interface MeasurementRow {
  key: 'sheet' | 'pillowcases' | 'duvetCover' | 'otherPieces';
  label: string;
  value: string;
}

type Size = Pick<BedProfileMeasurement, 'fittedSheet' | 'flatSheet' | 'pillowcases' | 'duvetCover' | 'otherPieces'>;

const clean = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** The sheet line of a size: its label and value, or null when the owner gave none. */
export function sheetRow(product: Pick<Product, 'fitted'>, size: Size): MeasurementRow | null {
  const value = clean(product.fitted ? size.fittedSheet : size.flatSheet);
  return value ? { key: 'sheet', label: product.fitted ? 'Fitted sheet' : 'Flat sheet', value } : null;
}

/** The rows to show for a size, in order, with nothing empty. */
export function measurementRows(product: Pick<Product, 'fitted'>, size: Size): MeasurementRow[] {
  const rows: Array<MeasurementRow | null> = [
    sheetRow(product, size),
    clean(size.pillowcases) ? { key: 'pillowcases', label: 'Pillowcases', value: clean(size.pillowcases) } : null,
    clean(size.duvetCover) ? { key: 'duvetCover', label: 'Duvet cover', value: clean(size.duvetCover) } : null,
    clean(size.otherPieces) ? { key: 'otherPieces', label: 'Other pieces', value: clean(size.otherPieces) } : null,
  ];
  return rows.filter((r): r is MeasurementRow => r !== null);
}

/** A duvet product: its category is duvet covers, or its words mention a duvet. */
export function isDuvetProduct(product: Pick<Product, 'category' | 'title' | 'description' | 'shortDescription'>): boolean {
  if (product.category === 'duvet-covers') return true;
  return /duvet/i.test([product.title, product.shortDescription, product.description].join(' '));
}

/**
 * The standard size's measurements for a product's size ("Use standard sizes" in the editor):
 * both sheet sizes and the pillowcases; the duvet cover only for a duvet product. The owner
 * then removes what the set does not include.
 */
export function standardMeasurements(
  product: Pick<Product, 'category' | 'title' | 'description' | 'shortDescription'>,
  preset: Pick<BedProfileMeasurement, 'fittedSheet' | 'flatSheet' | 'pillowcases' | 'duvetCover'> | undefined
): Pick<BedProfileMeasurement, 'fittedSheet' | 'flatSheet' | 'pillowcases'> & { duvetCover?: string } {
  if (!preset) return { fittedSheet: '', flatSheet: '', pillowcases: '' };
  return {
    fittedSheet: clean(preset.fittedSheet),
    flatSheet: clean(preset.flatSheet),
    pillowcases: clean(preset.pillowcases),
    ...(isDuvetProduct(product) && clean(preset.duvetCover) ? { duvetCover: clean(preset.duvetCover) } : {}),
  };
}

/**
 * A size added to a product from a Settings → Catalogue preset: its name, mattress, price and
 * packed weight, but none of the pieces (those are this product's own).
 */
export function sizeFromPreset(preset: BedProfileMeasurement): BedProfileMeasurement {
  return {
    id: preset.id,
    name: preset.name,
    badge: preset.badge,
    mattressSize: preset.mattressSize,
    fittedSheet: '',
    flatSheet: '',
    pillowcases: '',
    piecesIncluded: preset.piecesIncluded,
    priceDelta: preset.priceDelta,
    ...(preset.weightGrams ? { weightGrams: preset.weightGrams } : {}),
  };
}
