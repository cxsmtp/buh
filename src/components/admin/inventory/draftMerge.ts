import type { BedProfileMeasurement, Product, ProductType, SetPhotos } from '@/types';

/**
 * The product editor's draft, and how the owner's changes are told apart from the product they
 * started from: so that a product saved meanwhile somewhere else (another device, the Picture
 * studio) is never overwritten by a whole, older draft. Only what the owner changed goes on top.
 */

export const MAX_PHOTOS = 8;

export interface Draft {
  step: number;
  /** Bed linen (bed sizes) or other (plain variants). */
  productType: ProductType;
  title: string;
  sku: string;
  /** The SKU is the shop's suggestion (it follows the name and category until the owner types one). */
  skuAuto: boolean;
  /** Optional words for Google (empty: made by the shop). */
  seoTitle: string;
  seoDescription: string;
  shortDescription: string;
  description: string;
  /** The Arabic shop's words (empty: the English shows). */
  titleAr: string;
  shortDescriptionAr: string;
  descriptionAr: string;
  category: string;
  material: string;
  threadCount: string;
  weave: Product['weave'];
  price: string;
  compareAtPrice: string;
  /** Optional: none means the shop shows no colour choice. */
  colors: Array<{ name: string; hex: string }>;
  photos: string[]; // uploaded URLs; first = cover
  /** The set's sheet has elastic corners (else it is a flat sheet). */
  fitted: boolean;
  sizes: BedProfileMeasurement[];
  stock: Record<string, number>;
  defaultProfileId: string;
  active: boolean;
  isFeatured: boolean;
  isNewArrival: boolean;
  /** Stock when editing began: sent as "expected" on save. */
  seenStock: Record<string, number>;
  /** What the BUH-02.10 update took off the shop (a standard duvet cover), per size: offered back in one tap. */
  legacy: NonNullable<Product['legacyMeasurements']>;
  /** Gift lines by festival id (and "everyday"): the shop shows the themed festival's. */
  giftLines: Record<string, string>;
  /** The owner's note for "Style in a bedroom" (kept with the draft). */
  stagingNotes: string;
  /** The set's other pieces (the pillow cover, the comforter): the AI pictures copy each from its own photo. */
  setPhotos: SetPhotos;
  /** Off by default: a set without a comforter has none in its AI pictures. */
  hasComforter: boolean;
  /** The AI's motif and design words: the styling prompt's context. */
  aiMotif: string;
  aiDesign: string;
}

/** Never part of "what the owner changed": where they are in the steps, and the stock they saw. */
const NOT_CHANGES = new Set(['step', 'seenStock']);

/** The fields that differ from the starting values: the owner's changes. */
export function touchedKeys(base: Draft, draft: Draft): string[] {
  return (Object.keys(draft) as Array<keyof Draft>).filter((k) => !NOT_CHANGES.has(k) && JSON.stringify(draft[k]) !== JSON.stringify(base[k]));
}

/**
 * The owner's changes (`touched` fields of `mine`) on top of the product as it is now (`current`).
 * Photos: the owner's list, then any photo added to the product meanwhile (one made in the Picture
 * studio is not dropped). Stock: only the sizes whose figure the owner changed keep theirs, with
 * the figure they saw (the save checks it); every other size shows today's.
 */
export function rebaseDraft(current: Draft, mine: Draft, touched: string[], basePhotos: string[] | undefined): Draft {
  const out = { ...current, step: mine.step } as Record<string, unknown>;
  for (const k of touched) if (k in current && !NOT_CHANGES.has(k) && k !== 'photos' && k !== 'stock') out[k] = (mine as unknown as Record<string, unknown>)[k];
  if (touched.includes('photos')) {
    const known = new Set([...(basePhotos ?? []), ...mine.photos]);
    out.photos = [...mine.photos, ...current.photos.filter((u) => !known.has(u))].slice(0, MAX_PHOTOS);
  }
  const sizes = out.sizes as Draft['sizes'];
  const stock: Record<string, number> = {};
  const seen: Record<string, number> = {};
  for (const s of sizes) {
    const changed = s.id in mine.stock && mine.stock[s.id] !== (mine.seenStock[s.id] ?? -1);
    stock[s.id] = changed ? mine.stock[s.id] : current.stock[s.id] ?? mine.stock[s.id] ?? 0;
    const saw = changed && s.id in mine.seenStock ? mine.seenStock[s.id] : current.seenStock[s.id];
    if (saw !== undefined) seen[s.id] = saw;
  }
  const result = { ...(out as unknown as Draft), stock, seenStock: seen };
  if (!sizes.some((s) => s.id === result.defaultProfileId)) result.defaultProfileId = sizes[0]?.id ?? '';
  return result;
}
