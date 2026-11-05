'use client';

import React, { useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import type { Product } from '@/types';
import { Sheet } from '@/components/common/Sheet';
import { matchesSearch, productPhoto, type Category } from '@/lib/catalogFilter';
import { photoSources } from '@/lib/client/photos';
import { useLocale, useT, type Words } from '@/lib/i18n';
import { productTitle } from '@/lib/i18n/product';

const WORDS = {
  title: { en: 'Search the shop', ar: 'البحث في المتجر' },
  byName: { en: 'Search by name', ar: 'البحث بالاسم' },
  placeholder: { en: 'Search by name, colour or fabric', ar: 'ابحث بالاسم أو اللون أو القماش' },
  close: { en: 'Close search', ar: 'إغلاق البحث' },
  match1: { en: '{n} match', ar: 'نتيجة واحدة' },
  matchN: { en: '{n} matches', ar: '{n} نتيجة' },
  nothing: { en: 'Nothing called “{q}” yet. Try another word, or ask us in the chat.', ar: 'لا يوجد شيء باسم «{q}» حالياً. جرّب كلمة أخرى، أو اسألنا في المحادثة.' },
  seeAll: { en: 'See all {n} in the shop', ar: 'عرض كل النتائج ({n}) في المتجر' },
} as const satisfies Words;

interface SearchSheetProps {
  products: Product[];
  categories: Category[];
  initial: string;
  /** Show every match in the shop (the search stays in the address bar). */
  onSubmit: (q: string) => void;
  onOpenProduct: (p: Product) => void;
  onClose: () => void;
}

/** Search by name (or colour, category, fabric): matches appear as you type; tap one to open it. */
export function SearchSheet({ products, categories, initial, onSubmit, onOpenProduct, onClose }: SearchSheetProps) {
  const [q, setQ] = useState(initial);
  const t = useT(WORDS);
  const { locale } = useLocale();
  const input = useRef<HTMLInputElement>(null);
  const results = useMemo(() => (q.trim() ? products.filter((p) => matchesSearch(p, q, categories)) : []), [products, q, categories]);

  return (
    <Sheet labelledBy="search-sheet-title" onClose={onClose} variant="top" initialFocus={input}>
      <h2 id="search-sheet-title" className="sr-only">
        {t('title')}
      </h2>
      <form
        role="search"
        className="flex items-center gap-2 px-3 py-3 border-b border-line"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(q.trim());
        }}
      >
        <label className="flex-1 flex items-center gap-2 rounded-full bg-sand px-3.5">
          <Search className="w-4 h-4 text-ink-soft shrink-0" aria-hidden="true" />
          <span className="sr-only">{t('byName')}</span>
          <input
            ref={input}
            type="search"
            enterKeyHint="search"
            autoComplete="off"
            value={q}
            maxLength={80}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('placeholder')}
            className="w-full bg-transparent py-2.5 text-base sm:text-sm outline-none"
          />
        </label>
        <button type="button" onClick={onClose} aria-label={t('close')} className="w-10 h-10 rounded-full flex items-center justify-center text-ink hover:bg-sand shrink-0">
          <X className="w-5 h-5" aria-hidden="true" />
        </button>
      </form>

      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
        <p className="sr-only" aria-live="polite">
          {q.trim() ? t(results.length === 1 ? 'match1' : 'matchN', { n: results.length }) : ''}
        </p>
        {q.trim() && results.length === 0 && <p className="px-5 py-8 text-sm text-ink-soft text-center">{t('nothing', { q: q.trim() })}</p>}
        {results.length > 0 && (
          <ul className="divide-y divide-line">
            {results.slice(0, 8).map((p) => {
              const s = photoSources(productPhoto(p), [96, 160]);
              return (
                <li key={p.id}>
                  <button type="button" onClick={() => onOpenProduct(p)} className="w-full flex items-center gap-3 px-4 py-2.5 text-start hover:bg-ivory">
                    <span className="w-12 h-14 rounded-lg overflow-hidden bg-sand-deep shrink-0">
                      {s.src && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={s.src} srcSet={s.srcSet} sizes="48px" alt="" width={48} height={56} loading="lazy" className="photo w-full h-full object-cover" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm text-ink line-clamp-2" dir="auto">{productTitle(p, locale)}</span>
                      <span className="block text-xs font-semibold text-ink">{`AED ${p.price}`}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {results.length > 0 && (
          <div className="p-3">
            <button type="button" onClick={() => onSubmit(q.trim())} className="w-full rounded-full bg-ink text-paper text-sm font-semibold py-3">
              {t('seeAll', { n: results.length })}
            </button>
          </div>
        )}
      </div>
    </Sheet>
  );
}
