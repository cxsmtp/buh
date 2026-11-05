'use client';

import React from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { useLocale, useT, type Words } from '@/lib/i18n';

const WORDS = {
  forYou: { en: 'A selection for you', ar: 'تشكيلة مختارة لك' },
  piece: { en: 'piece', ar: 'قطعة' },
  pieces: { en: 'pieces', ar: 'قطعة' },
  until: { en: 'Until {date}', ar: 'حتى {date}' },
  browse: { en: 'Browse the whole shop', ar: 'تصفّح المتجر كاملاً' },
} as const satisfies Words;

/** A shared selection as its page gets it from the server (only products on sale). */
export interface ShopCollection {
  slug: string;
  title: string;
  productIds: string[];
  /** The last day it opens (YYYY-MM-DD, UAE), when the owner set one. */
  expiresOn: string | null;
}

/** "Until 30 Mar" for a last day (a UAE calendar date). */
function lastDayText(date: string, locale: 'en' | 'ar' = 'en'): string {
  const d = new Date(`${date}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? date : d.toLocaleDateString(locale === 'ar' ? 'ar-AE-u-nu-latn' : 'en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** The top of a shared selection's page (/c/<slug>): its title, how many pieces, and a way into the whole shop. */
export function CollectionHeader({ collection, pieces }: { collection: ShopCollection; pieces: number | null }) {
  const t = useT(WORDS);
  const { locale } = useLocale();
  return (
    <section aria-labelledby="collection-title" className="space-y-2 pt-1" data-testid="collection-header">
      <p className="label-caps text-gold-deep">{t('forYou')}</p>
      <h1 id="collection-title" className="font-serif text-3xl sm:text-4xl leading-tight text-ink break-anywhere">
        {collection.title}
      </h1>
      <p className="text-[13px] text-ink-soft flex flex-wrap items-center gap-x-3 gap-y-1">
        {pieces !== null && (
          <span>
            <span className="text-ink font-medium">{pieces}</span> {t(pieces === 1 ? 'piece' : 'pieces')}
          </span>
        )}
        {collection.expiresOn && <span>{t('until', { date: lastDayText(collection.expiresOn, locale) })}</span>}
        <Link href="/" className="inline-flex items-center gap-1 min-h-11 text-ink underline underline-offset-4">
          <ArrowLeft className="w-3.5 h-3.5 rtl:-scale-x-100" aria-hidden="true" /> {t('browse')}
        </Link>
      </p>
    </section>
  );
}
