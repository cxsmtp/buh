'use client';

import React, { useState } from 'react';
import { ArrowDown, ArrowUp, Loader2, Plus, Trash2 } from 'lucide-react';
import { useAutoSave, type AutoSaveHooks } from './useAutoSave';
import type { BedProfileMeasurement, CatalogSettings } from '@/types';
import { DEFAULT_WEAVES } from '@/data/catalogDefaults';
import { WeavesEditor } from './WeavesEditor';

/**
 * Settings → Catalogue: the size presets offered when adding a product (name,
 * measurements, price difference), the shop's categories, and when to warn
 * "Only N left", and the weaves (Sateen, Percale, …). Changing a preset does not change existing products: each
 * product keeps its own copy of its sizes (edit them in the product).
 */

const field = 'w-full px-2.5 py-1.5 rounded-lg border border-line-strong bg-surface text-ink text-xs focus:outline-none focus:ring-2 focus:ring-gold';

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);

export function CatalogSettingsCard({ value, onSave, auto }: { value: CatalogSettings; onSave: (v: CatalogSettings) => Promise<string | null>; auto?: AutoSaveHooks }) {
  const [draft, setDraft] = useState<CatalogSettings>(value);
  const autosave = useAutoSave({ settingsKey: 'catalog', value: draft, enabled: Boolean(auto), ...auto });
  const [open, setOpen] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  const setSize = (i: number, patch: Partial<BedProfileMeasurement>) =>
    setDraft((d) => ({ ...d, sizes: d.sizes.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
  const moveSize = (i: number, to: number) =>
    setDraft((d) => {
      if (to < 0 || to >= d.sizes.length) return d;
      const sizes = [...d.sizes];
      const [s] = sizes.splice(i, 1);
      sizes.splice(to, 0, s);
      return { ...d, sizes };
    });
  const addSize = () => {
    setDraft((d) => ({
      ...d,
      sizes: [
        ...d.sizes,
        { id: `size-${d.sizes.length + 1}`, name: 'New size', badge: '', mattressSize: '', fittedSheet: '', flatSheet: '', pillowcases: '', piecesIncluded: 3, priceDelta: 0 },
      ],
    }));
    setOpen(draft.sizes.length);
  };

  const save = async () => {
    autosave.cancel();
    setSaving(true);
    setStatus(null);
    const problem = await onSave(draft);
    setSaving(false);
    setStatus(problem ? { ok: false, text: problem } : { ok: true, text: 'Saved. New products use these presets.' });
  };

  return (
    <div className="space-y-5 text-xs">
      <section className="space-y-2">
        <h3 className="font-bold text-sm text-ink">Size presets</h3>
        <p className="text-ink-muted">Offered when adding a product. Each product keeps its own copy, so changes here don&apos;t alter products you already have.</p>
        {draft.sizes.map((s, i) => (
          <div key={i} className="rounded-xl border border-line bg-surface">
            <div className="flex items-center gap-2 p-2">
              <span className="font-semibold text-ink flex-1 min-w-0 truncate">{s.name}</span>
              <span className="text-ink-muted hidden sm:inline">{s.mattressSize}</span>
              <span className="text-ink-muted">{s.priceDelta >= 0 ? `+${s.priceDelta}` : s.priceDelta} AED</span>
              <button type="button" onClick={() => moveSize(i, i - 1)} disabled={i === 0} className="p-1 disabled:opacity-30" aria-label={`Move ${s.name} up`}><ArrowUp className="w-3.5 h-3.5" /></button>
              <button type="button" onClick={() => moveSize(i, i + 1)} disabled={i === draft.sizes.length - 1} className="p-1 disabled:opacity-30" aria-label={`Move ${s.name} down`}><ArrowDown className="w-3.5 h-3.5" /></button>
              <button type="button" onClick={() => setOpen(open === i ? null : i)} className="font-semibold underline">{open === i ? 'Done' : 'Edit'}</button>
              <button type="button" onClick={() => setDraft((d) => ({ ...d, sizes: d.sizes.filter((_, j) => j !== i) }))} disabled={draft.sizes.length === 1} className="p-1 text-ink-muted disabled:opacity-30" aria-label={`Delete ${s.name}`}><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
            {open === i && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 p-2 border-t border-line">
                <label>
                  <span className="text-ink-soft">Name</span>
                  <input className={field} value={s.name} maxLength={60} onChange={(e) => setSize(i, { name: e.target.value })} />
                </label>
                <label>
                  <span className="text-ink-soft">Id (letters, digits, dashes; used in orders)</span>
                  <input className={field} value={s.id} maxLength={30} onChange={(e) => setSize(i, { id: slug(e.target.value) })} />
                </label>
                {(
                  [
                    ['badge', 'Short label'],
                    ['mattressSize', 'Mattress'],
                    ['fittedSheet', 'Fitted sheet'],
                    ['flatSheet', 'Flat sheet'],
                    ['pillowcases', 'Pillowcases'],
                    ['duvetCover', 'Duvet cover'],
                    ['cushionCovers', 'Cushion covers'],
                  ] as Array<[keyof BedProfileMeasurement, string]>
                ).map(([k, l]) => (
                  <label key={k}>
                    <span className="text-ink-soft">{l}</span>
                    <input className={field} value={String(s[k] ?? '')} maxLength={80} onChange={(e) => setSize(i, { [k]: e.target.value })} />
                  </label>
                ))}
                <label>
                  <span className="text-ink-soft">Price difference (AED)</span>
                  <input className={field} type="number" step="0.01" value={s.priceDelta} onChange={(e) => setSize(i, { priceDelta: Number(e.target.value) || 0 })} />
                </label>
                <label>
                  <span className="text-ink-soft">Pieces in the set</span>
                  <input className={field} type="number" min={1} max={20} value={s.piecesIncluded} onChange={(e) => setSize(i, { piecesIncluded: Math.max(1, Number(e.target.value) || 1) })} />
                </label>
                <label>
                  <span className="text-ink-soft">Weight (g), packed set</span>
                  <input
                    className={field}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={50000}
                    step={1}
                    value={s.weightGrams ?? ''}
                    placeholder="e.g. 1200"
                    onChange={(e) => {
                      const g = Math.round(Number(e.target.value));
                      setSize(i, { weightGrams: e.target.value === '' || !(g > 0) ? undefined : Math.min(50000, g) });
                    }}
                  />
                </label>
              </div>
            )}
          </div>
        ))}
        {draft.sizes.length < 20 && (
          <button type="button" onClick={addSize} className="font-semibold text-ink flex items-center gap-1"><Plus className="w-3.5 h-3.5" /> Add a size preset</button>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="font-bold text-sm text-ink">Categories</h3>
        {draft.categories.map((c, i) => (
          <div key={i} className="flex items-center gap-2">
            <input className={`${field} w-12 text-center`} value={c.icon} maxLength={8} aria-label={`Category ${i + 1} icon`} onChange={(e) => setDraft((d) => ({ ...d, categories: d.categories.map((x, j) => (j === i ? { ...x, icon: e.target.value } : x)) }))} />
            <input
              className={field}
              value={c.label}
              maxLength={40}
              aria-label={`Category ${i + 1} name`}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  // A new category takes its id from its name; existing ids stay (products point at them).
                  categories: d.categories.map((x, j) => (j === i ? { ...x, label: e.target.value, id: value.categories.some((v) => v.id === x.id) ? x.id : slug(e.target.value) || x.id } : x)),
                }))
              }
            />
            <button type="button" onClick={() => setDraft((d) => ({ ...d, categories: d.categories.filter((_, j) => j !== i) }))} disabled={draft.categories.length === 1} className="p-1.5 text-ink-muted disabled:opacity-30" aria-label={`Delete category ${c.label}`}><Trash2 className="w-3.5 h-3.5" /></button>
          </div>
        ))}
        {draft.categories.length < 30 && (
          <button type="button" onClick={() => setDraft((d) => ({ ...d, categories: [...d.categories, { id: `category-${d.categories.length + 1}`, label: '', icon: '🧵' }] }))} className="font-semibold text-ink flex items-center gap-1"><Plus className="w-3.5 h-3.5" /> Add a category</button>
        )}
        <p className="text-ink-muted">A category with no products is not shown to customers. Deleting one keeps it on the products that use it until you change them.</p>
      </section>

      <WeavesEditor
        weaves={draft.weaves ?? [...DEFAULT_WEAVES]}
        onChange={(weaves) => setDraft((d) => ({ ...d, weaves }))}
        // Renamed on the server (products and list): the form follows, so the next save keeps it.
        onRenamed={(from, to, saved) => setDraft((d) => ({ ...d, weaves: (d.weaves ?? saved).some((w) => w === to) ? (d.weaves ?? saved).filter((w) => w !== from) : (d.weaves ?? saved).map((w) => (w === from ? to : w)) }))}
      />

      <section className="space-y-1">
        <label className="flex items-center gap-2">
          <span className="font-bold text-sm text-ink">Show &ldquo;Only N left&rdquo; at</span>
          <input className={`${field} w-16`} type="number" min={0} max={50} value={draft.lowStockThreshold} onChange={(e) => setDraft((d) => ({ ...d, lowStockThreshold: Math.max(0, Math.min(50, Number(e.target.value) || 0)) }))} />
          <span className="text-ink-soft">pieces or fewer</span>
        </label>
      </section>

      <div className="flex items-center gap-3">
        <button type="button" onClick={() => void save()} disabled={saving} className="px-4 py-2 rounded-xl bg-ink text-paper font-bold text-xs disabled:opacity-50 flex items-center gap-1.5">
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Save catalogue settings
        </button>
        {auto && autosave.bar}
        {status && <span role="status" className={status.ok ? 'text-success font-semibold' : 'text-danger font-semibold'}>{status.text}</span>}
      </div>
    </div>
  );
}
