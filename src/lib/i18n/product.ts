import type { Product } from '@/types';
import type { Locale } from './index';

/** A product's name in the shop's language: the owner's Arabic one in Arabic when there is one, else the English. */
export const productTitle = (p: Pick<Product, 'title' | 'titleAr'>, locale: Locale) => (locale === 'ar' && p.titleAr?.trim() ? p.titleAr : p.title);
export const productShort = (p: Pick<Product, 'shortDescription' | 'shortDescriptionAr'>, locale: Locale) => (locale === 'ar' && p.shortDescriptionAr?.trim() ? p.shortDescriptionAr : p.shortDescription);
export const productDescription = (p: Pick<Product, 'description' | 'descriptionAr'>, locale: Locale) => (locale === 'ar' && p.descriptionAr?.trim() ? p.descriptionAr : p.description);
