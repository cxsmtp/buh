'use client';

import React, { useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import type { Product } from '@/types';
import { priceLabel } from '@/lib/money';
import { Sheet } from '@/components/common/Sheet';
import { matchesSearch, productPhoto, type Category } from '@/lib/catalogFilter';
import { photoSources } from '@/lib/client/photos';

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
  const input = useRef<HTMLInputElement>(null);
  const results = useMemo(() => (q.trim() ? products.filter((p) => matchesSearch(p, q, categories)) : []), [products, q, categories]);

  return (
    <Sheet labelledBy="search-sheet-title" onClose={onClose} variant="top" initialFocus={input}>
      <h2 id="search-sheet-title" className="sr-only">
        Search the shop
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
          <span className="sr-only">Search by name</span>
          <input
            ref={input}
            type="search"
            enterKeyHint="search"
            autoComplete="off"
            value={q}
            maxLength={80}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name, colour or fabric"
            className="w-full bg-transparent py-2.5 text-base sm:text-sm outline-none"
          />
        </label>
        <button type="button" onClick={onClose} aria-label="Close search" className="w-10 h-10 rounded-full flex items-center justify-center text-ink hover:bg-sand shrink-0">
          <X className="w-5 h-5" aria-hidden="true" />
        </button>
      </form>

      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
        <p className="sr-only" aria-live="polite">
          {q.trim() ? `${results.length} ${results.length === 1 ? 'match' : 'matches'}` : ''}
        </p>
        {q.trim() && results.length === 0 && <p className="px-5 py-8 text-sm text-ink-soft text-center">Nothing called “{q.trim()}” yet. Try another word, or ask us in the chat.</p>}
        {results.length > 0 && (
          <ul className="divide-y divide-line">
            {results.slice(0, 8).map((p) => {
              const s = photoSources(productPhoto(p), [96, 160]);
              return (
                <li key={p.id}>
                  <button type="button" onClick={() => onOpenProduct(p)} className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-ivory">
                    <span className="w-12 h-14 rounded-lg overflow-hidden bg-sand-deep shrink-0">
                      {s.src && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={s.src} srcSet={s.srcSet} sizes="48px" alt="" width={48} height={56} loading="lazy" className="photo w-full h-full object-cover" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm text-ink line-clamp-2">{p.title}</span>
                      <span className="block text-xs font-semibold text-ink">{priceLabel(p)}</span>
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
              See all {results.length} in the shop
            </button>
          </div>
        )}
      </div>
    </Sheet>
  );
}
