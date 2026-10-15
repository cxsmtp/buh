'use client';

import React, { useMemo, useState } from 'react';
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, Edit3, Eye, EyeOff, Minus, Package, Plus, Search } from 'lucide-react';
import type { CatalogSettings, Product } from '@/types';
import { postJson, sendJson } from '@/lib/apiClient';
import { ProductEditor } from './inventory/ProductEditor';

/**
 * Inventory: every product with its pieces per size. + / − change one size's
 * stock straight away (each tap is one atomic change on the server, so a sale
 * at the same moment is never lost). Edit opens the full editor; Remove
 * archives (past orders keep showing it) and can be undone.
 */

type AdminProduct = Product & { archived?: boolean };
type Filter = 'all' | 'low' | 'sold-out' | 'hidden' | 'archived';

interface AdminInventoryTabProps {
  products: AdminProduct[];
  catalog: CatalogSettings;
  /** Reload products (after any change). */
  onChanged: () => Promise<void> | void;
  /** Open the editor for a new product straight away (the "+ Add" tab). */
  startAdding?: boolean;
}

export const AdminInventoryTab: React.FC<AdminInventoryTabProps> = ({ products, catalog, onChanged, startAdding = false }) => {
  const [editing, setEditing] = useState<AdminProduct | 'new' | null>(startAdding ? 'new' : null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ id: string; text: string } | null>(null);
  const low = catalog.lowStockThreshold;

  const live = products.filter((p) => !p.archived);
  const counts = {
    all: live.length,
    low: live.filter((p) => p.profiles.some((s) => (p.stockBySize[s.id] ?? 0) > 0 && (p.stockBySize[s.id] ?? 0) <= low)).length,
    'sold-out': live.filter((p) => p.stockCount === 0).length,
    hidden: live.filter((p) => p.active === false).length,
    archived: products.filter((p) => p.archived).length,
  };

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return products
      .filter((p) => (filter === 'archived' ? p.archived : !p.archived))
      .filter((p) =>
        filter === 'low'
          ? p.profiles.some((s) => (p.stockBySize[s.id] ?? 0) > 0 && (p.stockBySize[s.id] ?? 0) <= low)
          : filter === 'sold-out'
          ? p.stockCount === 0
          : filter === 'hidden'
          ? p.active === false
          : true
      )
      .filter((p) => !q || p.title.toLowerCase().includes(q) || p.material.toLowerCase().includes(q) || p.category.includes(q));
  }, [products, filter, query, low]);

  const run = async (id: string, call: () => Promise<{ ok: boolean; data: { message?: string } }>) => {
    setBusy(id);
    setMessage(null);
    const { ok, data } = await call();
    setBusy(null);
    if (!ok) setMessage({ id, text: data.message || 'Could not save that change.' });
    await onChanged();
  };

  const adjust = (p: AdminProduct, sizeId: string, delta: number) =>
    run(p.id, () => postJson(`/api/admin/products/${encodeURIComponent(p.id)}/stock`, { sizeId, delta }));
  const toggleVisible = (p: AdminProduct) =>
    run(p.id, () => sendJson('PATCH', `/api/admin/products/${encodeURIComponent(p.id)}`, { product: { active: p.active === false } }));
  const archive = (p: AdminProduct, archived: boolean) => {
    if (archived && !window.confirm(`Remove "${p.title}" from the shop? It stays in past orders, and you can restore it under "Removed".`)) return;
    return run(p.id, () => postJson(`/api/admin/products/${encodeURIComponent(p.id)}/archive`, { archived }));
  };
  const move = (p: AdminProduct, dir: -1 | 1) => {
    const ids = products.map((x) => x.id);
    const i = ids.indexOf(p.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    return run(p.id, () => sendJson('PUT', '/api/admin/products/order', { ids }));
  };

  const categoryLabel = (id: string) => catalog.categories.find((c) => c.id === id)?.label ?? id;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-serif font-bold text-lg text-[#0f1c2e] flex items-center gap-2"><Package className="w-5 h-5 text-[#c5a059]" /> Inventory</h2>
        <button type="button" onClick={() => setEditing('new')} className="ml-auto px-3.5 py-2 rounded-xl bg-[#0f1c2e] text-white text-xs font-bold flex items-center gap-1.5">
          <Plus className="w-4 h-4" /> Add product
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5 text-xs">
        {(
          [
            ['all', 'All'],
            ['low', `Low (≤ ${low})`],
            ['sold-out', 'Sold out'],
            ['hidden', 'Hidden'],
            ['archived', 'Removed'],
          ] as Array<[Filter, string]>
        ).map(([id, name]) => (
          <button
            key={id}
            type="button"
            onClick={() => setFilter(id)}
            aria-pressed={filter === id}
            className={`px-2.5 py-1 rounded-full border font-semibold ${filter === id ? 'bg-[#0f1c2e] text-white border-[#0f1c2e]' : 'bg-white border-stone-300 text-stone-700'}`}
          >
            {name} <span className="opacity-70">{counts[id]}</span>
          </button>
        ))}
        <label className="relative ml-auto min-w-0 flex-1 sm:flex-none sm:w-56">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-500" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search products" aria-label="Search products" className="w-full pl-8 pr-2 py-1.5 rounded-full border border-stone-300 bg-white" />
        </label>
      </div>

      {shown.length === 0 && <p className="text-center text-sm text-stone-500 py-10 bg-white rounded-2xl border border-stone-200">Nothing here.</p>}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {shown.map((p) => (
          <div key={p.id} className={`bg-white rounded-2xl border p-3 flex gap-3 ${p.active === false || p.archived ? 'border-stone-200 opacity-80' : 'border-stone-200'}`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={p.featuredImage} alt="" className="w-20 h-20 sm:w-24 sm:h-24 rounded-xl object-cover bg-stone-100 shrink-0" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="flex items-start gap-2">
                <div className="min-w-0">
                  <div className="font-bold text-sm text-[#0f1c2e] truncate">{p.title}</div>
                  <div className="text-[11px] text-stone-500">
                    AED {p.price} · {categoryLabel(p.category)}
                    {p.active === false && !p.archived && <span className="ml-1 font-semibold text-stone-700">· hidden</span>}
                    {p.stockCount === 0 && !p.archived && <span className="ml-1 font-semibold text-red-700">· sold out</span>}
                  </div>
                </div>
              </div>

              {!p.archived && (
                <div className="flex flex-wrap gap-1.5">
                  {p.profiles.map((s) => {
                    const qty = p.stockBySize[s.id] ?? 0;
                    return (
                      <div key={s.id} className={`flex items-center rounded-lg border text-[11px] ${qty === 0 ? 'border-red-200 bg-red-50' : qty <= low ? 'border-amber-200 bg-amber-50' : 'border-stone-200 bg-stone-50'}`}>
                        <button type="button" disabled={busy === p.id || qty === 0} onClick={() => void adjust(p, s.id, -1)} className="px-2.5 py-2 disabled:opacity-30" aria-label={`One fewer ${s.name} of ${p.title}`}><Minus className="w-3 h-3" /></button>
                        <span className="px-1 font-semibold whitespace-nowrap">{s.badge || s.name}: {qty}</span>
                        <button type="button" disabled={busy === p.id} onClick={() => void adjust(p, s.id, 1)} className="px-2.5 py-2 disabled:opacity-30" aria-label={`One more ${s.name} of ${p.title}`}><Plus className="w-3 h-3" /></button>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-1.5 text-[11px] pt-0.5">
                {p.archived ? (
                  <button type="button" onClick={() => void archive(p, false)} disabled={busy === p.id} className="px-2 py-1 rounded-lg border border-stone-300 font-semibold flex items-center gap-1"><ArchiveRestore className="w-3.5 h-3.5" /> Restore (hidden)</button>
                ) : (
                  <>
                    <button type="button" onClick={() => setEditing(p)} className="px-2 py-1 rounded-lg bg-[#0f1c2e] text-white font-semibold flex items-center gap-1"><Edit3 className="w-3.5 h-3.5" /> Edit</button>
                    <button type="button" onClick={() => void toggleVisible(p)} disabled={busy === p.id} className="px-2 py-1 rounded-lg border border-stone-300 font-semibold flex items-center gap-1" title={p.active === false ? 'Hidden from the shop: click to show' : 'Shown in the shop: click to hide'}>
                      {p.active === false ? <><EyeOff className="w-3.5 h-3.5" /> Hidden</> : <><Eye className="w-3.5 h-3.5" /> Visible</>}
                    </button>
                    <button type="button" onClick={() => void move(p, -1)} disabled={busy === p.id} className="p-1 rounded-lg border border-stone-300" aria-label={`Move ${p.title} up`}><ArrowUp className="w-3.5 h-3.5" /></button>
                    <button type="button" onClick={() => void move(p, 1)} disabled={busy === p.id} className="p-1 rounded-lg border border-stone-300" aria-label={`Move ${p.title} down`}><ArrowDown className="w-3.5 h-3.5" /></button>
                    <button type="button" onClick={() => void archive(p, true)} disabled={busy === p.id} className="ml-auto px-2 py-1 rounded-lg border border-red-200 text-red-700 font-semibold flex items-center gap-1"><Archive className="w-3.5 h-3.5" /> Remove</button>
                  </>
                )}
              </div>
              {message?.id === p.id && <p role="alert" className="text-[11px] text-red-700">{message.text}</p>}
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <ProductEditor
          product={editing === 'new' ? null : editing}
          catalog={catalog}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void onChanged();
          }}
        />
      )}
    </div>
  );
};
