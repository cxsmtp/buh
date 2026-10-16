'use client';

import React, { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import type { Product } from '@/types';
import { Sheet } from '@/components/common/Sheet';
import { SORTS, clearFilters, computeFacets, type Category, type Filters, type Option } from '@/lib/catalogFilter';

interface FilterSheetProps {
  products: Product[];
  categories: Category[];
  filters: Filters;
  onApply: (next: Filters) => void;
  onClose: () => void;
}

const pill = (on: boolean) =>
  `inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full text-sm border transition-colors disabled:opacity-40 ${
    on ? 'bg-[#0f1c2e] border-[#0f1c2e] text-white' : 'bg-white border-stone-300 text-stone-900 hover:border-stone-500'
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

  const options = (label: string, opts: Option[], key: 'cats' | 'sizes' | 'colors') =>
    opts.length > 0 && (
      <fieldset className="space-y-2.5">
        <legend className="text-sm font-semibold text-stone-900 mb-2.5">{label}</legend>
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
              {o.hex && <span className="w-4 h-4 rounded-full border border-stone-300" style={{ backgroundColor: o.hex }} aria-hidden="true" />}
              <span>{o.label}</span>
              <span className={`text-xs ${o.selected ? 'text-stone-200' : 'text-stone-600'}`}>
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
      <button type="button" role="switch" aria-checked={on} onClick={() => set(patch)} className="w-full flex items-center justify-between gap-3 py-2.5 text-left">
        <span className="text-sm text-stone-900">
          {label} <span className="text-xs text-stone-600">({count})</span>
        </span>
        <span className={`relative inline-block w-11 h-6 rounded-full transition-colors shrink-0 ${on ? 'bg-[#0f1c2e]' : 'bg-stone-300'}`} aria-hidden="true">
          <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-5' : ''}`} />
        </span>
      </button>
    );

  const hasToggles = facets.inStock !== null || facets.sale !== null || facets.newIn !== null;

  return (
    <Sheet labelledBy="filter-sheet-title" onClose={onClose} variant="bottom">
      <div className="flex justify-center pt-2 sm:hidden" aria-hidden="true">
        <span className="w-10 h-1 rounded-full bg-stone-300" />
      </div>
      <div className="flex items-center justify-between px-5 pt-2 pb-3 border-b border-stone-200">
        <h2 id="filter-sheet-title" className="font-serif text-lg text-stone-900">
          Filter &amp; sort
        </h2>
        <button type="button" onClick={onClose} aria-label="Close filters" className="w-10 h-10 -mr-2 rounded-full flex items-center justify-center text-stone-800 hover:bg-stone-100">
          <X className="w-5 h-5" aria-hidden="true" />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-5 py-4 space-y-6">
        <fieldset className="space-y-2.5">
          <legend className="text-sm font-semibold text-stone-900 mb-2.5">Sort by</legend>
          <div className="flex flex-wrap gap-2">
            {SORTS.map((s) => (
              <button key={s.id} type="button" aria-pressed={draft.sort === s.id} onClick={() => set({ sort: s.id })} className={pill(draft.sort === s.id)}>
                {s.label}
              </button>
            ))}
          </div>
        </fieldset>

        {options('Category', facets.categories, 'cats')}
        {options('Size', facets.sizes, 'sizes')}
        {options('Colour', facets.colors, 'colors')}

        {facets.prices.length > 0 && (
          <fieldset className="space-y-2.5">
            <legend className="text-sm font-semibold text-stone-900 mb-2.5">Price</legend>
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
                  <span>{b.label}</span>
                  <span className={`text-xs ${b.selected ? 'text-stone-200' : 'text-stone-600'}`}>
                    <span className="sr-only">, </span>
                    {b.count}
                  </span>
                </button>
              ))}
            </div>
          </fieldset>
        )}

        {hasToggles && (
          <div className="divide-y divide-stone-200 border-y border-stone-200">
            {switchRow('In stock only', facets.inStock, draft.inStock, { inStock: !draft.inStock })}
            {switchRow('On sale', facets.sale, draft.sale, { sale: !draft.sale })}
            {switchRow('New in', facets.newIn, draft.newIn, { newIn: !draft.newIn })}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-stone-200 px-5 py-3 pb-safe flex items-center gap-3 bg-white">
        <button type="button" onClick={() => setDraft(clearFilters(draft))} className="px-4 py-3 rounded-full text-sm font-semibold text-stone-900 underline underline-offset-4">
          Clear all
        </button>
        <button
          type="button"
          onClick={() => {
            onApply(draft);
            onClose();
          }}
          className="flex-1 bg-[#0f1c2e] hover:bg-[#1c2c44] text-white font-semibold text-sm py-3 px-4 rounded-full"
        >
          {facets.total === 0 ? 'No pieces match' : `Show ${facets.total} ${facets.total === 1 ? 'piece' : 'pieces'}`}
        </button>
      </div>
    </Sheet>
  );
}
