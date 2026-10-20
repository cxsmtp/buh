'use client';

import React, { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { postJson } from '@/lib/apiClient';

/**
 * The product's SKU, next to its name: filled in by the shop as soon as there is a name and a
 * category (BUH-HBS-INDCHV-007, src/lib/sku.ts), following the name while it is the shop's own;
 * Regenerate makes a fresh one; typing makes it the owner's. The server has the last word (it
 * numbers it, and refuses one another product has).
 */
export function SkuField({
  value,
  auto,
  title,
  category,
  productId,
  onChange,
  fieldClass,
  labelClass,
}: {
  value: string;
  /** True while the SKU is the shop's suggestion (it follows the name and category). */
  auto: boolean;
  title: string;
  category: string;
  productId?: string;
  onChange: (sku: string, auto: boolean) => void;
  fieldClass: string;
  labelClass: string;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const latest = useRef(0);

  const suggest = async () => {
    const ask = ++latest.current;
    setBusy(true);
    const res = await postJson<{ sku?: string; message?: string }>('/api/admin/products/sku-suggest', { title: title.trim(), category, ...(productId ? { productId } : {}) });
    if (ask !== latest.current) return;
    setBusy(false);
    if (res.ok && res.data.sku) {
      setProblem('');
      onChange(res.data.sku, true);
    } else setProblem(res.data.message || 'Could not make an SKU just now.');
  };

  // While it is the shop's own: follow the name and category (a moment after typing stops).
  useEffect(() => {
    if (!auto || !title.trim() || !category) return;
    const t = setTimeout(() => void suggest(), 450);
    return () => clearTimeout(t);
    // suggest reads the latest props itself
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, title, category]);

  return (
    <div>
      <label className={labelClass} htmlFor="pe-sku">
        SKU
      </label>
      <div className="flex gap-2">
        <input
          id="pe-sku"
          className={`${fieldClass} font-mono uppercase`}
          value={value}
          maxLength={40}
          autoCapitalize="characters"
          spellCheck={false}
          aria-describedby="pe-sku-hint"
          onChange={(e) => {
            // Typed by the owner: a suggestion still on its way is dropped.
            latest.current++;
            setBusy(false);
            onChange(e.target.value.toUpperCase(), false);
          }}
          placeholder={!auto ? 'Made by the shop when you save' : title.trim() ? 'Making one…' : 'Made from the name'}
        />
        <button
          type="button"
          onClick={() => void suggest()}
          disabled={busy || !category}
          className="shrink-0 min-h-11 px-3 rounded-xl border border-line-strong bg-surface text-sm font-semibold text-ink inline-flex items-center gap-1.5 disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${busy ? 'animate-spin' : ''}`} aria-hidden="true" /> Regenerate
        </button>
      </div>
      <p id="pe-sku-hint" className="mt-1 text-xs text-ink-soft">
        {problem || 'Made automatically — change it if you have your own codes.'}
      </p>
    </div>
  );
}
