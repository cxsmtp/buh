'use client';

import React, { useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, Loader2, Minus, Plus, Sparkles, Star, Trash2, Upload, X } from 'lucide-react';
import type { BedProfileMeasurement, CatalogSettings, Product } from '@/types';
import { postJson, sendJson } from '@/lib/apiClient';
import { shrinkPhoto } from '@/lib/shrinkPhoto';
import { AI_STAGING_PRESETS, transformProductImage } from '@/lib/aiImageTransform';

/**
 * One product, every field: photos, text, prices, colours, sizes and the
 * pieces in stock per size. Used for "Add product" (product = null) and for
 * editing an existing one. Stock edits are sent with the figures the owner
 * saw, so a sale made meanwhile is never overwritten (the server answers 409).
 */

const WEAVES: Product['weave'][] = ['Sateen', 'Percale', 'Linen', 'Jacquard'];
const MAX_PHOTOS = 8;

interface Draft {
  title: string;
  shortDescription: string;
  description: string;
  category: string;
  material: string;
  threadCount: string;
  weave: Product['weave'];
  price: string;
  compareAtPrice: string;
  colors: Array<{ name: string; hex: string }>;
  photos: string[]; // first = main photo
  sizes: BedProfileMeasurement[];
  stock: Record<string, number>;
  defaultProfileId: string;
  active: boolean;
  isFeatured: boolean;
  isNewArrival: boolean;
}

function draftFrom(product: Product | null, catalog: CatalogSettings): Draft {
  if (!product) {
    const king = catalog.sizes.find((s) => s.id === 'king') ?? catalog.sizes[0];
    return {
      title: '',
      shortDescription: '',
      description: '',
      category: catalog.categories[0]?.id ?? '',
      material: '100% Cotton',
      threadCount: '300',
      weave: 'Percale',
      price: '',
      compareAtPrice: '',
      colors: [{ name: 'As pictured', hex: '#ffffff' }],
      photos: [],
      sizes: king ? [king] : [],
      stock: king ? { [king.id]: 1 } : {},
      defaultProfileId: king?.id ?? '',
      active: true,
      isFeatured: false,
      isNewArrival: true,
    };
  }
  const photos = [product.featuredImage, ...product.galleryImages, product.aiTransformedImage]
    .filter((x): x is string => Boolean(x))
    .filter((x, i, all) => all.indexOf(x) === i)
    .slice(0, MAX_PHOTOS);
  return {
    title: product.title,
    shortDescription: product.shortDescription,
    description: product.description,
    category: product.category,
    material: product.material,
    threadCount: String(product.threadCount || ''),
    weave: product.weave,
    price: String(product.price),
    compareAtPrice: product.compareAtPrice ? String(product.compareAtPrice) : '',
    colors: product.colors.length ? product.colors : [{ name: 'As pictured', hex: '#ffffff' }],
    photos,
    sizes: product.profiles,
    stock: { ...product.stockBySize },
    defaultProfileId: product.defaultProfileId,
    active: product.active !== false,
    isFeatured: product.isFeatured,
    isNewArrival: Boolean(product.isNewArrival),
  };
}

const field = 'w-full px-3 py-2 rounded-xl border border-stone-300 bg-white text-stone-900 text-sm focus:outline-none focus:ring-2 focus:ring-[#c5a059]';
const label = 'block text-xs font-semibold text-stone-700 mb-1';

export function ProductEditor({
  product,
  catalog,
  onClose,
  onSaved,
}: {
  product: Product | null;
  catalog: CatalogSettings;
  onClose: () => void;
  /** Called with the saved product; the list reloads. */
  onSaved: (product: Product) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(product, catalog));
  const [seenStock] = useState<Record<string, number>>(() => ({ ...(product?.stockBySize ?? {}) }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [photoBusy, setPhotoBusy] = useState(false);
  const [openSize, setOpenSize] = useState<string | null>(null);
  const [aiPreset, setAiPreset] = useState(AI_STAGING_PRESETS[0]?.id ?? '');

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const unusedPresets = useMemo(() => catalog.sizes.filter((s) => !draft.sizes.some((x) => x.id === s.id)), [catalog.sizes, draft.sizes]);
  const totalStock = draft.sizes.reduce((n, s) => n + (draft.stock[s.id] ?? 0), 0);

  const addPhotos = async (files: FileList | null) => {
    if (!files?.length) return;
    setPhotoBusy(true);
    setError('');
    try {
      const added: string[] = [];
      for (const file of Array.from(files).slice(0, MAX_PHOTOS - draft.photos.length)) added.push(await shrinkPhoto(file));
      setDraft((d) => ({ ...d, photos: [...d.photos, ...added].slice(0, MAX_PHOTOS) }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the photo.');
    } finally {
      setPhotoBusy(false);
    }
  };

  const styleWithAi = async () => {
    if (!draft.photos[0]) return;
    setPhotoBusy(true);
    setError('');
    try {
      // A filter applied in the browser to a newly added photo. Its fallback is a stock
      // room photo, which must never be shown as this product, so only a real result is kept.
      const result = await transformProductImage(draft.photos[0], aiPreset);
      if (result.transformedUrl.startsWith('data:image/')) {
        setDraft((d) => ({ ...d, photos: [result.transformedUrl, ...d.photos].slice(0, MAX_PHOTOS) }));
      } else {
        setError('The room-style filter works on a newly added photo. Add the photo again, then apply it.');
      }
    } catch {
      setError('The room-style filter is not available right now. Your photo is kept as it is.');
    } finally {
      setPhotoBusy(false);
    }
  };

  const movePhoto = (i: number, to: number) =>
    setDraft((d) => {
      if (to < 0 || to >= d.photos.length) return d;
      const photos = [...d.photos];
      const [p] = photos.splice(i, 1);
      photos.splice(to, 0, p);
      return { ...d, photos };
    });

  const addSize = (id: string) => {
    const preset = catalog.sizes.find((s) => s.id === id);
    if (!preset) return;
    setDraft((d) => ({
      ...d,
      sizes: [...d.sizes, preset],
      stock: { ...d.stock, [id]: d.stock[id] ?? 1 },
      defaultProfileId: d.defaultProfileId || id,
    }));
  };

  const removeSize = (id: string) =>
    setDraft((d) => {
      const sizes = d.sizes.filter((s) => s.id !== id);
      const stock = { ...d.stock };
      delete stock[id];
      return { ...d, sizes, stock, defaultProfileId: d.defaultProfileId === id ? sizes[0]?.id ?? '' : d.defaultProfileId };
    });

  const updateSize = (id: string, patch: Partial<BedProfileMeasurement>) =>
    setDraft((d) => ({ ...d, sizes: d.sizes.map((s) => (s.id === id ? { ...s, ...patch } : s)) }));

  const setQty = (id: string, qty: number) => setDraft((d) => ({ ...d, stock: { ...d.stock, [id]: Math.max(0, Math.min(100_000, Math.round(qty) || 0)) } }));

  const save = async () => {
    setError('');
    if (!draft.title.trim()) return setError('Give the product a name.');
    if (!draft.photos.length) return setError('Add at least one photo.');
    if (!(Number(draft.price) > 0)) return setError('Enter the price in AED.');
    if (!draft.sizes.length) return setError('Add at least one size.');

    const [main, ...gallery] = draft.photos;
    const body: Record<string, unknown> = {
      title: draft.title.trim(),
      shortDescription: draft.shortDescription.trim(),
      description: draft.description.trim(),
      category: draft.category,
      material: draft.material.trim(),
      threadCount: Number(draft.threadCount) || 0,
      weave: draft.weave,
      price: Number(draft.price),
      compareAtPrice: draft.compareAtPrice ? Number(draft.compareAtPrice) : null,
      colors: draft.colors.filter((c) => c.name.trim()),
      featuredImage: main,
      galleryImages: gallery,
      aiTransformedImage: null,
      profiles: draft.sizes,
      defaultProfileId: draft.defaultProfileId || draft.sizes[0].id,
      active: draft.active,
      isFeatured: draft.isFeatured,
      isNewArrival: draft.isNewArrival,
    };
    if (product) {
      // Only the sizes whose stock was changed here, with what the owner saw.
      const changed = draft.sizes.filter((s) => (draft.stock[s.id] ?? 0) !== (seenStock[s.id] ?? 0) || !(s.id in seenStock));
      if (changed.length) {
        body.stockBySize = Object.fromEntries(changed.map((s) => [s.id, draft.stock[s.id] ?? 0]));
        body.expectedStockBySize = Object.fromEntries(changed.filter((s) => s.id in seenStock).map((s) => [s.id, seenStock[s.id]]));
      }
    } else {
      body.stockBySize = Object.fromEntries(draft.sizes.map((s) => [s.id, draft.stock[s.id] ?? 0]));
    }

    setSaving(true);
    const res = product
      ? await sendJson<{ product?: Product; message?: string }>('PATCH', `/api/admin/products/${encodeURIComponent(product.id)}`, { product: body })
      : await postJson<{ product?: Product; message?: string }>('/api/admin/products', { product: body });
    setSaving(false);
    if (!res.ok || !res.data.product) return setError(res.data.message || 'Could not save the product.');
    onSaved(res.data.product);
  };

  return (
    <div className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm flex items-stretch sm:items-center justify-center sm:p-4" role="dialog" aria-modal="true" aria-label={product ? `Edit ${product.title}` : 'Add a product'}>
      <div className="bg-stone-50 w-full sm:max-w-3xl sm:rounded-3xl shadow-2xl flex flex-col max-h-full sm:max-h-[92vh]">
        <div className="flex items-center justify-between px-4 py-3 border-b border-stone-200 bg-white sm:rounded-t-3xl">
          <h2 className="font-serif font-bold text-base text-[#0f1c2e] truncate">{product ? `Edit: ${product.title}` : 'Add a product'}</h2>
          <button type="button" onClick={onClose} className="p-1.5 rounded-full text-stone-500 hover:bg-stone-100" aria-label="Close without saving">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="overflow-y-auto px-4 py-4 space-y-5 text-sm">
          {/* Photos */}
          <section className="space-y-2">
            <h3 className="font-bold text-[#0f1c2e]">Photos <span className="font-normal text-stone-500 text-xs">(the first is the main photo; up to {MAX_PHOTOS})</span></h3>
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
              {draft.photos.map((src, i) => (
                <div key={`${i}-${src.slice(-24)}`} className={`relative rounded-xl overflow-hidden border-2 ${i === 0 ? 'border-[#c5a059]' : 'border-stone-200'} bg-white aspect-square`}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={src} alt={`Photo ${i + 1}`} className="w-full h-full object-cover" />
                  {i === 0 && <span className="absolute top-1 left-1 text-[10px] font-bold bg-[#c5a059] text-white px-1.5 rounded">Main</span>}
                  <div className="absolute bottom-0 inset-x-0 flex justify-between bg-black/50 p-0.5">
                    <button type="button" onClick={() => movePhoto(i, i - 1)} disabled={i === 0} className="p-1 text-white disabled:opacity-30" aria-label="Move left"><ArrowLeft className="w-3.5 h-3.5" /></button>
                    {i !== 0 && <button type="button" onClick={() => movePhoto(i, 0)} className="p-1 text-white" aria-label="Make main photo"><Star className="w-3.5 h-3.5" /></button>}
                    <button type="button" onClick={() => movePhoto(i, i + 1)} disabled={i === draft.photos.length - 1} className="p-1 text-white disabled:opacity-30" aria-label="Move right"><ArrowRight className="w-3.5 h-3.5" /></button>
                    <button type="button" onClick={() => set('photos', draft.photos.filter((_, j) => j !== i))} className="p-1 text-red-200" aria-label="Remove photo"><Trash2 className="w-3.5 h-3.5" /></button>
                  </div>
                </div>
              ))}
              {draft.photos.length < MAX_PHOTOS && (
                <label className="aspect-square rounded-xl border-2 border-dashed border-stone-300 bg-white flex flex-col items-center justify-center gap-1 text-stone-500 cursor-pointer hover:border-[#c5a059] focus-within:ring-2 focus-within:ring-[#c5a059]">
                  {photoBusy ? <Loader2 className="w-5 h-5 animate-spin" /> : <Upload className="w-5 h-5" />}
                  <span className="text-[11px] font-semibold">Add photos</span>
                  <input type="file" accept="image/*" multiple className="sr-only" onChange={(e) => void addPhotos(e.target.files)} />
                </label>
              )}
            </div>
            {draft.photos.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Sparkles className="w-4 h-4 text-[#c5a059]" />
                <select value={aiPreset} onChange={(e) => setAiPreset(e.target.value)} className="px-2 py-1 rounded-lg border border-stone-300 bg-white" aria-label="Room style">
                  {AI_STAGING_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <button type="button" onClick={() => void styleWithAi()} disabled={photoBusy} className="px-2.5 py-1 rounded-lg bg-[#0f1c2e] text-white font-semibold disabled:opacity-50">Apply room-style filter to the main photo</button>
              </div>
            )}
          </section>

          {/* Basics */}
          <section className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="sm:col-span-2">
              <label className={label} htmlFor="pe-title">Name</label>
              <input id="pe-title" className={field} value={draft.title} maxLength={160} onChange={(e) => set('title', e.target.value)} placeholder="e.g. Jaipur Indigo Hand Block Set" />
            </div>
            <div>
              <label className={label} htmlFor="pe-price">Price (AED)</label>
              <input id="pe-price" className={field} type="number" min={1} step="0.01" inputMode="decimal" value={draft.price} onChange={(e) => set('price', e.target.value)} />
            </div>
            <div>
              <label className={label} htmlFor="pe-compare">Was (AED, optional)</label>
              <input id="pe-compare" className={field} type="number" min={0} step="0.01" inputMode="decimal" value={draft.compareAtPrice} onChange={(e) => set('compareAtPrice', e.target.value)} />
            </div>
            <div>
              <label className={label} htmlFor="pe-cat">Category</label>
              <select id="pe-cat" className={field} value={draft.category} onChange={(e) => set('category', e.target.value)}>
                {catalog.categories.map((c) => <option key={c.id} value={c.id}>{c.icon} {c.label}</option>)}
                {!catalog.categories.some((c) => c.id === draft.category) && draft.category && <option value={draft.category}>{draft.category} (removed)</option>}
              </select>
            </div>
            <div>
              <label className={label} htmlFor="pe-material">Material</label>
              <input id="pe-material" className={field} value={draft.material} maxLength={120} onChange={(e) => set('material', e.target.value)} />
            </div>
            <div>
              <label className={label} htmlFor="pe-tc">Thread count</label>
              <input id="pe-tc" className={field} type="number" min={0} max={3000} value={draft.threadCount} onChange={(e) => set('threadCount', e.target.value)} />
            </div>
            <div>
              <label className={label} htmlFor="pe-weave">Weave</label>
              <select id="pe-weave" className={field} value={draft.weave} onChange={(e) => set('weave', e.target.value as Product['weave'])}>
                {WEAVES.map((w) => <option key={w}>{w}</option>)}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className={label} htmlFor="pe-short">Short description (on the card)</label>
              <input id="pe-short" className={field} value={draft.shortDescription} maxLength={300} onChange={(e) => set('shortDescription', e.target.value)} />
            </div>
            <div className="sm:col-span-2">
              <label className={label} htmlFor="pe-desc">Full description</label>
              <textarea id="pe-desc" className={`${field} min-h-[90px]`} value={draft.description} maxLength={4000} onChange={(e) => set('description', e.target.value)} />
            </div>
          </section>

          {/* Colours */}
          <section className="space-y-2">
            <h3 className="font-bold text-[#0f1c2e]">Colours</h3>
            {draft.colors.map((c, i) => (
              <div key={i} className="flex items-center gap-2">
                <input type="color" value={c.hex} onChange={(e) => set('colors', draft.colors.map((x, j) => (j === i ? { ...x, hex: e.target.value } : x)))} className="w-9 h-9 rounded-lg border border-stone-300 shrink-0" aria-label={`Colour ${i + 1} swatch`} />
                <input className={field} value={c.name} maxLength={40} onChange={(e) => set('colors', draft.colors.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} aria-label={`Colour ${i + 1} name`} />
                <button type="button" onClick={() => set('colors', draft.colors.filter((_, j) => j !== i))} disabled={draft.colors.length === 1} className="p-2 text-stone-500 disabled:opacity-30" aria-label={`Remove colour ${i + 1}`}><Trash2 className="w-4 h-4" /></button>
              </div>
            ))}
            {draft.colors.length < 12 && (
              <button type="button" onClick={() => set('colors', [...draft.colors, { name: '', hex: '#ffffff' }])} className="text-xs font-semibold text-[#0f1c2e] flex items-center gap-1"><Plus className="w-3.5 h-3.5" /> Add a colour</button>
            )}
          </section>

          {/* Sizes & stock */}
          <section className="space-y-2">
            <h3 className="font-bold text-[#0f1c2e]">Sizes and pieces in stock <span className="font-normal text-stone-500 text-xs">({totalStock} in total)</span></h3>
            <div className="space-y-2">
              {draft.sizes.map((s) => {
                const qty = draft.stock[s.id] ?? 0;
                const open = openSize === s.id;
                return (
                  <div key={s.id} className="rounded-xl border border-stone-200 bg-white">
                    <div className="flex flex-wrap items-center gap-2 p-2.5">
                      <label className="flex items-center gap-1.5 text-xs" title="The size shown first">
                        <input type="radio" name="pe-default" checked={draft.defaultProfileId === s.id} onChange={() => set('defaultProfileId', s.id)} />
                        <span className="font-semibold text-stone-800">{s.name}</span>
                      </label>
                      <span className="text-[11px] text-stone-500">{s.mattressSize}</span>
                      <div className="ml-auto flex items-center gap-1">
                        <button type="button" onClick={() => setQty(s.id, qty - 1)} disabled={qty === 0} className="p-1.5 rounded-lg border border-stone-300 disabled:opacity-30" aria-label={`One fewer ${s.name}`}><Minus className="w-3.5 h-3.5" /></button>
                        <input type="number" min={0} value={qty} onChange={(e) => setQty(s.id, Number(e.target.value))} className={`w-14 text-center px-1 py-1 rounded-lg border text-sm font-bold ${qty === 0 ? 'border-red-300 text-red-700' : 'border-stone-300'}`} aria-label={`Pieces of ${s.name} in stock`} />
                        <button type="button" onClick={() => setQty(s.id, qty + 1)} className="p-1.5 rounded-lg border border-stone-300" aria-label={`One more ${s.name}`}><Plus className="w-3.5 h-3.5" /></button>
                      </div>
                      <button type="button" onClick={() => setOpenSize(open ? null : s.id)} className="text-[11px] font-semibold text-[#0f1c2e] underline">{open ? 'Done' : 'Details'}</button>
                      <button type="button" onClick={() => removeSize(s.id)} disabled={draft.sizes.length === 1} className="p-1.5 text-stone-500 disabled:opacity-30" aria-label={`Remove ${s.name}`}><Trash2 className="w-4 h-4" /></button>
                    </div>
                    {open && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 p-2.5 border-t border-stone-100 text-xs">
                        {(
                          [
                            ['name', 'Name shown'],
                            ['badge', 'Short label'],
                            ['mattressSize', 'Mattress'],
                            ['fittedSheet', 'Fitted sheet'],
                            ['flatSheet', 'Flat sheet'],
                            ['pillowcases', 'Pillowcases'],
                            ['duvetCover', 'Duvet cover'],
                            ['cushionCovers', 'Cushion covers'],
                          ] as Array<[keyof BedProfileMeasurement, string]>
                        ).map(([k, l]) => (
                          <label key={k} className="block">
                            <span className="text-stone-600">{l}</span>
                            <input className={field} value={String(s[k] ?? '')} maxLength={80} onChange={(e) => updateSize(s.id, { [k]: e.target.value })} />
                          </label>
                        ))}
                        <label className="block">
                          <span className="text-stone-600">Price difference (AED, + or −)</span>
                          <input className={field} type="number" step="0.01" value={s.priceDelta} onChange={(e) => updateSize(s.id, { priceDelta: Number(e.target.value) || 0 })} />
                        </label>
                        <label className="block">
                          <span className="text-stone-600">Pieces in the set</span>
                          <input className={field} type="number" min={1} max={20} value={s.piecesIncluded} onChange={(e) => updateSize(s.id, { piecesIncluded: Math.max(1, Number(e.target.value) || 1) })} />
                        </label>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {unusedPresets.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {unusedPresets.map((s) => (
                  <button key={s.id} type="button" onClick={() => addSize(s.id)} className="text-[11px] font-semibold px-2.5 py-1 rounded-full border border-stone-300 bg-white hover:border-[#c5a059] flex items-center gap-1">
                    <Plus className="w-3 h-3" /> {s.name}
                  </button>
                ))}
              </div>
            )}
            <p className="text-[11px] text-stone-500">Size presets (names, measurements, price differences) are set in Settings → Catalogue.</p>
          </section>

          {/* Visibility */}
          <section className="flex flex-wrap gap-4 text-xs">
            <label className="flex items-center gap-2"><input type="checkbox" checked={draft.active} onChange={(e) => set('active', e.target.checked)} /> Shown in the shop</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={draft.isFeatured} onChange={(e) => set('isFeatured', e.target.checked)} /> Featured</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={draft.isNewArrival} onChange={(e) => set('isNewArrival', e.target.checked)} /> New arrival</label>
          </section>
        </div>

        <div className="border-t border-stone-200 bg-white px-4 py-3 sm:rounded-b-3xl space-y-2">
          {error && <p role="alert" className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 font-medium">{error}</p>}
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={onClose} className="px-4 py-2 rounded-xl border border-stone-300 bg-white text-sm font-semibold">Cancel</button>
            <button type="button" onClick={() => void save()} disabled={saving || photoBusy} className="px-5 py-2 rounded-xl bg-[#0f1c2e] text-white text-sm font-bold disabled:opacity-50 flex items-center gap-2">
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              {product ? 'Save changes' : 'Add to the shop'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
