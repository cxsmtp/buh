'use client';

import React, { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import type { Product } from '@/types';
import { Sheet } from '@/components/common/Sheet';
import { SORTS, clearFilters, computeFacets, type Category, type Filters, type Option } from '@/lib/catalogFilter';
import { useLocale, useT, type Locale, type Words } from '@/lib/i18n';

/** The browsing words made in src/lib/catalogFilter.ts (sorts, colour families, quick filters), in Arabic. */
const CATALOG_AR: Record<string, string> = {
  Featured: 'المميّزة',
  Newest: 'الأحدث',
  'Price: low to high': 'السعر: من الأقل إلى الأعلى',
  'Price: high to low': 'السعر: من الأعلى إلى الأقل',
  'White & cream': 'أبيض وكريمي',
  Grey: 'رمادي',
  Black: 'أسود',
  'Red & pink': 'أحمر ووردي',
  'Orange & terracotta': 'برتقالي وطوبي',
  'Yellow & gold': 'أصفر وذهبي',
  Green: 'أخضر',
  'Blue & indigo': 'أزرق ونيلي',
  Purple: 'بنفسجي',
  All: 'الكل',
  'New in': 'وصل حديثاً',
  'On sale': 'تخفيضات',
  'In stock': 'متوفر',
  'Any price': 'أي سعر',
};

/**
 * A label made by the catalogue's browsing code, in the shop's language. Words the owner typed
 * (category and size names) stay as typed; fixed words and price ranges are translated.
 */
export function catalogLabel(label: string, locale: Locale): string {
  if (locale !== 'ar') return label;
  if (CATALOG_AR[label]) return CATALOG_AR[label];
  let m = /^Under AED (.+)$/.exec(label);
  if (m) return `أقل من AED ${m[1]}`;
  m = /^AED (.+) and over$/.exec(label);
  if (m) return `AED ${m[1]} فأكثر`;
  m = /^Size: (.+)$/.exec(label);
  if (m) return `المقاس: ${m[1]}`;
  return label;
}

const WORDS = {
  title: { en: 'Filter & sort', ar: 'التصفية والترتيب' },
  close: { en: 'Close filters', ar: 'إغلاق التصفية' },
  sortBy: { en: 'Sort by', ar: 'ترتيب حسب' },
  category: { en: 'Category', ar: 'الفئة' },
  size: { en: 'Size', ar: 'المقاس' },
  colour: { en: 'Colour', ar: 'اللون' },
  price: { en: 'Price', ar: 'السعر' },
  inStockOnly: { en: 'In stock only', ar: 'المتوفر فقط' },
  onSale: { en: 'On sale', ar: 'تخفيضات' },
  newIn: { en: 'New in', ar: 'وصل حديثاً' },
  clearAll: { en: 'Clear all', ar: 'مسح الكل' },
  noMatch: { en: 'No pieces match', ar: 'لا توجد قطع مطابقة' },
  show1: { en: 'Show {n} piece', ar: 'عرض قطعة واحدة' },
  showN: { en: 'Show {n} pieces', ar: 'عرض {n} قطعة' },
} as const satisfies Words;

interface FilterSheetProps {
  products: Product[];
  categories: Category[];
  filters: Filters;
  onApply: (next: Filters) => void;
  onClose: () => void;
}

const pill = (on: boolean) =>
  `inline-flex max-w-full min-w-0 items-center gap-1.5 px-3.5 py-2 rounded-full text-sm text-start break-anywhere border transition-colors disabled:opacity-40 ${
    on ? 'bg-ink border-ink text-paper' : 'bg-surface border-line-strong text-ink hover:border-ink-muted'
  }`;

function toggle(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

/**
 * Filters, only when wanted: a bottom sheet with the choices that make sense for the products in
 * the shop (category, size, colour, price, in stock, on sale, new in) and the sort. Each choice
 * shows how many pieces it leaves; "Show N" applies them (one step back in the browser's history).
 */
export function FilterSheet({ products, categories, filters, onApply, onClose }: FilterSheetProps) {
  const [draft, setDraft] = useState<Filters>(filters);
  const facets = useMemo(() => computeFacets(products, draft, categories), [products, draft, categories]);
  const set = (patch: Partial<Filters>) => setDraft((d) => ({ ...d, ...patch }));
  const t = useT(WORDS);
  const { locale } = useLocale();

  const options = (label: string, opts: Option[], key: 'cats' | 'sizes' | 'colors') =>
    opts.length > 0 && (
      <fieldset className="space-y-2.5">
        <legend className="label-caps text-ink mb-3">{label}</legend>
        <div className="flex flex-wrap gap-2">
          {opts.map((o) => (
            <button
              key={o.id}
              type="button"
              aria-pressed={o.selected}
              disabled={!o.selected && o.count === 0}
              onClick={() => set({ [key]: toggle(draft[key], o.id) } as Partial<Filters>)}
              className={pill(o.selected)}
            >
              {o.hex && <span className="w-4 h-4 rounded-full border border-line-strong" style={{ backgroundColor: o.hex }} aria-hidden="true" />}
              <span>{catalogLabel(o.label, locale)}</span>
              <span className={`text-xs ${o.selected ? 'text-sand' : 'text-ink-soft'}`}>
                <span className="sr-only">, </span>
                {o.count}
              </span>
            </button>
          ))}
        </div>
      </fieldset>
    );

  const switchRow = (label: string, count: number | null, on: boolean, patch: Partial<Filters>) =>
    count !== null && (
      <button type="button" role="switch" aria-checked={on} onClick={() => set(patch)} className="w-full flex items-center justify-between gap-3 py-2.5 text-start">
        <span className="text-sm text-ink">
          {label} <span className="text-xs text-ink-soft">({count})</span>
        </span>
        <span className={`relative inline-block w-11 h-6 rounded-full transition-colors shrink-0 ${on ? 'bg-ink' : 'bg-line-strong'}`} aria-hidden="true">
          <span className={`absolute top-0.5 start-0.5 w-5 h-5 rounded-full bg-surface  transition-transform ${on ? 'translate-x-5 rtl:-translate-x-5' : ''}`} />
        </span>
      </button>
    );

  const hasToggles = facets.inStock !== null || facets.sale !== null || facets.newIn !== null;

  return (
    <Sheet labelledBy="filter-sheet-title" onClose={onClose} variant="bottom">
      <div className="flex justify-center pt-2 sm:hidden" aria-hidden="true">
        <span className="w-10 h-1 rounded-full bg-line-strong" />
      </div>
      <div className="flex items-center justify-between px-5 pt-2 pb-3 border-b border-line">
        <h2 id="filter-sheet-title" className="font-serif text-2xl text-ink">
          {t('title')}
        </h2>
        <button type="button" onClick={onClose} aria-label={t('close')} className="w-10 h-10 -me-2 rounded-full flex items-center justify-center text-ink hover:bg-sand">
          <X className="w-5 h-5" aria-hidden="true" />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-5 py-4 space-y-6">
        <fieldset className="space-y-2.5">
          <legend className="label-caps text-ink mb-3">{t('sortBy')}</legend>
          <div className="flex flex-wrap gap-2">
            {SORTS.map((s) => (
              <button key={s.id} type="button" aria-pressed={draft.sort === s.id} onClick={() => set({ sort: s.id })} className={pill(draft.sort === s.id)}>
                {catalogLabel(s.label, locale)}
              </button>
            ))}
          </div>
        </fieldset>

        {options(t('category'), facets.categories, 'cats')}
        {options(t('size'), facets.sizes, 'sizes')}
        {options(t('colour'), facets.colors, 'colors')}

        {facets.prices.length > 0 && (
          <fieldset className="space-y-2.5">
            <legend className="label-caps text-ink mb-3">{t('price')}</legend>
            <div className="flex flex-wrap gap-2">
              {facets.prices.map((b) => (
                <button
                  key={`${b.min}-${b.max}`}
                  type="button"
                  aria-pressed={b.selected}
                  disabled={!b.selected && b.count === 0}
                  onClick={() => set(b.selected ? { min: null, max: null } : { min: b.min, max: b.max })}
                  className={pill(b.selected)}
                >
                  <span>{catalogLabel(b.label, locale)}</span>
                  <span className={`text-xs ${b.selected ? 'text-sand' : 'text-ink-soft'}`}>
                    <span className="sr-only">, </span>
                    {b.count}
                  </span>
                </button>
              ))}
            </div>
          </fieldset>
        )}

        {hasToggles && (
          <div className="divide-y divide-line border-y border-line">
            {switchRow(t('inStockOnly'), facets.inStock, draft.inStock, { inStock: !draft.inStock })}
            {switchRow(t('onSale'), facets.sale, draft.sale, { sale: !draft.sale })}
            {switchRow(t('newIn'), facets.newIn, draft.newIn, { newIn: !draft.newIn })}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-line px-5 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))] flex flex-wrap items-center gap-x-3 gap-y-2 bg-surface">
        <button type="button" onClick={() => setDraft(clearFilters(draft))} className="shrink-0 px-3 py-3 rounded-full text-sm text-ink underline underline-offset-4">
          {t('clearAll')}
        </button>
        <button
          type="button"
          onClick={() => {
            onApply(draft);
            onClose();
          }}
          className="flex-1 basis-40 min-w-0 bg-ink hover:bg-ink-2 text-ivory font-medium tracking-[0.04em] text-sm py-3 px-4 rounded-full"
        >
          {facets.total === 0 ? t('noMatch') : t(facets.total === 1 ? 'show1' : 'showN', { n: facets.total })}
        </button>
      </div>
    </Sheet>
  );
}
