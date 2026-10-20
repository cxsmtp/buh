'use client';

import React, { useEffect, useState } from 'react';
import type { CatalogSettings } from '@/types';
import { postJson } from '@/lib/apiClient';
import { CATEGORY_CODE_RE, DEFAULT_SKU_PREFIX, SKU_PREFIX_RE, categoryCode, composeSku, titleCode } from '@/lib/sku';

const field = 'px-2.5 py-1.5 rounded-lg border border-line-strong bg-surface text-ink text-xs font-mono uppercase focus:outline-none focus:ring-2 focus:ring-gold';

/**
 * Settings → Catalogue → SKUs: the prefix every SKU the shop makes starts with, and each
 * category's code (empty: made from its name), with the next SKU as it would be made now.
 */
export function SkuSettings({ draft, onChange }: { draft: CatalogSettings; onChange: (patch: Partial<CatalogSettings>) => void }) {
  const [next, setNext] = useState<number | null>(null);
  const first = draft.categories[0];
  useEffect(() => {
    if (!first) return;
    let alive = true;
    void postJson<{ next?: number }>('/api/admin/products/sku-suggest', { title: 'Example', category: first.id }).then((r) => {
      if (alive && r.ok && typeof r.data.next === 'number') setNext(r.data.next);
    });
    return () => {
      alive = false;
    };
  }, [first]);
  const prefix = (draft.skuPrefix || DEFAULT_SKU_PREFIX).toUpperCase();
  const prefixOk = !draft.skuPrefix || SKU_PREFIX_RE.test(draft.skuPrefix);
  const example = first ? composeSku(prefix, first.code || categoryCode(first.label, first.id), titleCode('Indigo Chevron'), next ?? 1) : '';
  return (
    <section className="space-y-2" aria-labelledby="sku-settings-title" data-testid="sku-settings">
      <h3 id="sku-settings-title" className="font-bold text-sm text-ink">SKUs</h3>
      <p className="text-ink-muted">Every product gets an SKU made by the shop: prefix, category code, a code from the name and a running number that is never reused. You can still type your own on any product.</p>
      <label className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-ink">Prefix</span>
        <input
          className={`${field} w-24`}
          value={draft.skuPrefix ?? ''}
          placeholder={DEFAULT_SKU_PREFIX}
          maxLength={6}
          aria-invalid={!prefixOk}
          onChange={(e) => onChange({ skuPrefix: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })}
        />
        <span className="text-ink-muted">2 to 6 capital letters or digits</span>
      </label>
      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
        {draft.categories.map((c, i) => {
          const auto = categoryCode(c.label, c.id);
          const ok = !c.code || CATEGORY_CODE_RE.test(c.code);
          return (
            <li key={c.id || i} className="flex items-center gap-2 min-w-0">
              <span className="flex-1 min-w-0 truncate text-ink">{c.label || c.id}</span>
              <input
                className={`${field} w-16`}
                value={c.code ?? ''}
                placeholder={auto}
                maxLength={3}
                aria-label={`SKU code for ${c.label || c.id}`}
                aria-invalid={!ok}
                onChange={(e) => {
                  const code = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
                  onChange({ categories: draft.categories.map((x, j) => (j === i ? (code ? { ...x, code } : (({ code: _drop, ...rest }) => (void _drop, rest))(x)) : x)) });
                }}
              />
            </li>
          );
        })}
      </ul>
      {example && (
        <p className="text-ink-soft" data-testid="sku-next">
          Next SKU (e.g. for &ldquo;Indigo Chevron&rdquo; in {first.label}): <span className="font-mono text-ink">{example}</span>
        </p>
      )}
    </section>
  );
}
