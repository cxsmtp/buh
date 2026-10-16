'use client';

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Camera, Check, ChevronDown, GripVertical, ImagePlus, Loader2, Minus, Plus, Sparkles, Star, Trash2, X } from 'lucide-react';
import type { BedProfileMeasurement, CatalogSettings, Product } from '@/types';
import { getJson, postJson, sendJson } from '@/lib/apiClient';
import { shrinkPhoto } from '@/lib/shrinkPhoto';
import { shortSizeName } from '@/lib/client/stock';
import { AI_STAGING_PRESETS, transformProductImage } from '@/lib/aiImageTransform';
import { Sheet } from '@/components/common/Sheet';

/**
 * Add or edit a product in four steps, made for a phone:
 *   1. Photos: take them with the camera or pick several from the gallery; each is
 *      shrunk on the phone (at most 1600 px, JPEG) and uploaded through the shop's
 *      image checks straight away. Drag or use the arrows to order them; the first
 *      is the cover.
 *   2. Name, category and price (more details folded away).
 *   3. Sizes from the presets in Settings → Catalogue, each with its pieces in stock.
 *   4. Publish (or keep hidden).
 * The draft saves itself on the server as the owner goes (like the settings), so
 * nothing is lost to a phone call; it can be finished on another device. Stock
 * edits are sent with the figures the owner saw, so a sale made meanwhile is never
 * overwritten (the server answers 409 and the current figures are shown).
 */

const WEAVES: Product['weave'][] = ['Sateen', 'Percale', 'Linen', 'Jacquard'];
const MAX_PHOTOS = 8;
const STEPS = ['Photos', 'Details', 'Sizes', 'Publish'] as const;

interface Draft {
  step: number;
  title: string;
  sku: string;
  shortDescription: string;
  description: string;
  category: string;
  material: string;
  threadCount: string;
  weave: Product['weave'];
  price: string;
  compareAtPrice: string;
  colors: Array<{ name: string; hex: string }>;
  photos: string[]; // uploaded URLs; first = cover
  sizes: BedProfileMeasurement[];
  stock: Record<string, number>;
  defaultProfileId: string;
  active: boolean;
  isFeatured: boolean;
  isNewArrival: boolean;
  /** Stock when editing began: sent as "expected" on save. */
  seenStock: Record<string, number>;
}

function draftFrom(product: Product | null, catalog: CatalogSettings): Draft {
  if (!product) {
    const king = catalog.sizes.find((s) => s.id === 'king') ?? catalog.sizes[0];
    return {
      step: 0,
      title: '',
      sku: '',
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
      seenStock: {},
    };
  }
  // The shop shows the styled photo first when there is one, so it stays the cover here.
  const photos = [product.aiTransformedImage, product.featuredImage, ...product.galleryImages]
    .filter((x): x is string => Boolean(x))
    .filter((x, i, all) => all.indexOf(x) === i)
    .slice(0, MAX_PHOTOS);
  return {
    step: 0,
    title: product.title,
    sku: product.sku ?? '',
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
    seenStock: { ...product.stockBySize },
  };
}

/** A saved draft over the starting values (anything missing keeps the starting value). */
function withSaved(base: Draft, saved: Record<string, unknown>): Draft {
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(saved)) if (k in base && v !== undefined && v !== null) out[k] = v;
  return out as unknown as Draft;
}

const field = 'w-full min-h-11 px-3 py-2 rounded-xl border border-stone-300 bg-white text-stone-900 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-[#c5a059]';
const label = 'block text-sm font-semibold text-stone-800 mb-1';
const stepBtn = 'w-12 h-12 rounded-xl border border-stone-300 bg-white flex items-center justify-center disabled:opacity-30';

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
  const draftId = product?.id ?? 'new';
  const titleId = useId();
  const [draft, setDraft] = useState<Draft>(() => draftFrom(product, catalog));
  const [loaded, setLoaded] = useState(false);
  const [resumedAt, setResumedAt] = useState<string | null>(null);
  const [draftStatus, setDraftStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(0);
  const [openSize, setOpenSize] = useState<string | null>(null);
  const [aiPreset, setAiPreset] = useState(AI_STAGING_PRESETS[0]?.id ?? '');
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  // Photos added in this session, as taken (the room-style filter works on these).
  const [originals, setOriginals] = useState<Record<string, string>>({});
  const lastSaved = useRef('');

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const unusedPresets = useMemo(() => catalog.sizes.filter((s) => !draft.sizes.some((x) => x.id === s.id)), [catalog.sizes, draft.sizes]);
  const totalStock = draft.sizes.reduce((n, s) => n + (draft.stock[s.id] ?? 0), 0);

  // 1. Pick up a saved draft, if there is one.
  useEffect(() => {
    let live = true;
    void getJson<{ draft: { data: Record<string, unknown>; updatedAt: string } | null }>(`/api/admin/products/drafts/${encodeURIComponent(draftId)}`).then(({ ok, data }) => {
      if (!live) return;
      if (ok && data.draft) {
        const restored = withSaved(draftFrom(product, catalog), data.draft.data);
        lastSaved.current = JSON.stringify(restored);
        setDraft(restored);
        setResumedAt(data.draft.updatedAt);
      } else {
        lastSaved.current = JSON.stringify(draftFrom(product, catalog));
      }
      setLoaded(true);
    });
    return () => {
      live = false;
    };
    // Once, when the editor opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 2. Save the draft about a second after each change.
  const json = JSON.stringify(draft);
  useEffect(() => {
    if (!loaded || json === lastSaved.current) return;
    const t = setTimeout(async () => {
      setDraftStatus('saving');
      const { ok } = await sendJson('PUT', `/api/admin/products/drafts/${encodeURIComponent(draftId)}`, { draft: JSON.parse(json) });
      if (ok) lastSaved.current = json;
      setDraftStatus(ok ? 'saved' : 'error');
    }, 1200);
    return () => clearTimeout(t);
  }, [json, loaded, draftId]);

  const startOver = async () => {
    if (!window.confirm('Throw this draft away and start again?')) return;
    await sendJson('DELETE', `/api/admin/products/drafts/${encodeURIComponent(draftId)}`);
    const fresh = draftFrom(product, catalog);
    lastSaved.current = JSON.stringify(fresh);
    setDraft(fresh);
    setResumedAt(null);
    setDraftStatus('idle');
  };

  // ── photos ────────────────────────────────────────────────────────────────
  const upload = async (dataUrl: string): Promise<string> => {
    const res = await postJson<{ url?: string; message?: string }>('/api/admin/images', { image: dataUrl });
    if (!res.ok || !res.data.url) throw new Error(res.data.message || 'The photo could not be uploaded.');
    const url = res.data.url;
    setOriginals((o) => ({ ...o, [url]: dataUrl }));
    return res.data.url;
  };

  const addPhotos = async (files: FileList | null) => {
    if (!files?.length) return;
    setError('');
    const room = MAX_PHOTOS - draft.photos.length - uploading;
    const list = Array.from(files).slice(0, Math.max(0, room));
    if (files.length > list.length) setError(`At most ${MAX_PHOTOS} photos: the first ${list.length} were added.`);
    setUploading((n) => n + list.length);
    for (const file of list) {
      try {
        const url = await upload(await shrinkPhoto(file));
        setDraft((d) => (d.photos.includes(url) ? d : { ...d, photos: [...d.photos, url].slice(0, MAX_PHOTOS) }));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not read the photo.');
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const styleWithAi = async () => {
    const original = draft.photos[0] ? originals[draft.photos[0]] : undefined;
    if (!original) return setError('The room-style filter works on a photo added just now. Add the photo again, make it the cover, then apply it.');
    setUploading((n) => n + 1);
    setError('');
    try {
      // Its fallback is a stock room photo, which must never be shown as this product: only a real result is kept.
      const result = await transformProductImage(original, aiPreset);
      if (!result.transformedUrl.startsWith('data:image/')) throw new Error('no result');
      const url = await upload(result.transformedUrl);
      setDraft((d) => ({ ...d, photos: [url, ...d.photos.filter((p) => p !== url)].slice(0, MAX_PHOTOS) }));
    } catch {
      setError('The room-style filter is not available right now. Your photo is kept as it is.');
    } finally {
      setUploading((n) => n - 1);
    }
  };

  const movePhoto = (i: number, to: number) =>
    setDraft((d) => {
      if (to < 0 || to >= d.photos.length || i === to) return d;
      const photos = [...d.photos];
      const [p] = photos.splice(i, 1);
      photos.splice(to, 0, p);
      return { ...d, photos };
    });

  // ── sizes ─────────────────────────────────────────────────────────────────
  const addSize = (id: string) => {
    const preset = catalog.sizes.find((s) => s.id === id);
    if (!preset) return;
    setDraft((d) => ({ ...d, sizes: [...d.sizes, preset], stock: { ...d.stock, [id]: d.stock[id] ?? 1 }, defaultProfileId: d.defaultProfileId || id }));
  };
  const removeSize = (id: string) =>
    setDraft((d) => {
      const sizes = d.sizes.filter((s) => s.id !== id);
      const stock = { ...d.stock };
      delete stock[id];
      return { ...d, sizes, stock, defaultProfileId: d.defaultProfileId === id ? sizes[0]?.id ?? '' : d.defaultProfileId };
    });
  const updateSize = (id: string, patch: Partial<BedProfileMeasurement>) => setDraft((d) => ({ ...d, sizes: d.sizes.map((s) => (s.id === id ? { ...s, ...patch } : s)) }));
  const setQty = (id: string, qty: number) => setDraft((d) => ({ ...d, stock: { ...d.stock, [id]: Math.max(0, Math.min(100_000, Math.round(qty) || 0)) } }));

  // ── steps ─────────────────────────────────────────────────────────────────
  const problem = useCallback(
    (step: number): string => {
      if (step === 0 && !draft.photos.length) return 'Add at least one photo.';
      if (step === 1 && !draft.title.trim()) return 'Give the product a name.';
      if (step === 1 && !(Number(draft.price) > 0)) return 'Enter the price in AED.';
      if (step === 2 && !draft.sizes.length) return 'Add at least one size.';
      return '';
    },
    [draft]
  );
  const go = (to: number) => {
    // Forward only past complete steps; back always.
    for (let s = draft.step; s < to; s++) {
      const p = problem(s);
      if (p) {
        setError(p);
        set('step', s);
        return;
      }
    }
    setError('');
    set('step', Math.max(0, Math.min(STEPS.length - 1, to)));
  };

  const save = async () => {
    setError('');
    for (let s = 0; s < 3; s++) {
      const p = problem(s);
      if (p) {
        set('step', s);
        return setError(p);
      }
    }
    if (uploading) return setError('Wait for the photos to finish uploading.');
    const [main, ...gallery] = draft.photos;
    const body: Record<string, unknown> = {
      title: draft.title.trim(),
      sku: draft.sku.trim(),
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
    const seen = draft.seenStock;
    if (product) {
      // Only the sizes whose stock was changed here, with what the owner saw.
      const changed = draft.sizes.filter((s) => (draft.stock[s.id] ?? 0) !== (seen[s.id] ?? 0) || !(s.id in seen));
      if (changed.length) {
        body.stockBySize = Object.fromEntries(changed.map((s) => [s.id, draft.stock[s.id] ?? 0]));
        body.expectedStockBySize = Object.fromEntries(changed.filter((s) => s.id in seen).map((s) => [s.id, seen[s.id]]));
      }
    } else {
      body.stockBySize = Object.fromEntries(draft.sizes.map((s) => [s.id, draft.stock[s.id] ?? 0]));
    }

    setSaving(true);
    const res = product
      ? await sendJson<{ product?: Product; message?: string }>('PATCH', `/api/admin/products/${encodeURIComponent(product.id)}`, { product: body })
      : await postJson<{ product?: Product; message?: string }>('/api/admin/products', { product: body });
    setSaving(false);
    if (res.status === 409 && product) {
      // A sale (or another phone) changed the stock meanwhile: show today's figures and let them save again.
      const fresh = await getJson<{ products: Product[] }>('/api/admin/products');
      const now = fresh.ok ? fresh.data.products.find((x) => x.id === product.id) : undefined;
      if (now) {
        setDraft((d) => ({
          ...d,
          step: 2,
          seenStock: { ...now.stockBySize },
          stock: { ...d.stock, ...Object.fromEntries(Object.entries(now.stockBySize).filter(([size]) => (d.stock[size] ?? 0) === (seen[size] ?? 0))) },
        }));
      }
      return setError(`${res.data.message || 'Stock changed meanwhile.'} The current figures are shown; check them and save again.`);
    }
    if (!res.ok || !res.data.product) return setError(res.data.message || 'Could not save the product.');
    lastSaved.current = json; // nothing left to autosave
    await sendJson('DELETE', `/api/admin/products/drafts/${encodeURIComponent(draftId)}`);
    onSaved(res.data.product);
  };

  const step = draft.step;
  const cover = draft.photos[0];

  return (
    <Sheet labelledBy={titleId} onClose={onClose} variant="full" wide className="bg-stone-50">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-stone-200 bg-white">
        <h2 id={titleId} className="font-serif font-bold text-base text-[#0f1c2e] truncate flex-1">
          {product ? `Edit ${product.title}` : 'Add a product'}
        </h2>
        <span className="text-[11px] text-stone-600 shrink-0" role="status">
          {draftStatus === 'saving' ? 'Saving draft…' : draftStatus === 'saved' ? 'Draft saved' : draftStatus === 'error' ? 'Draft not saved' : ''}
        </span>
        <button type="button" onClick={onClose} className="min-h-11 min-w-11 flex items-center justify-center rounded-full text-stone-600 hover:bg-stone-100" aria-label="Close (the draft is kept)">
          <X className="w-5 h-5" aria-hidden="true" />
        </button>
      </div>

      {/* Where you are: tap a step to go there. */}
      <nav aria-label="Steps" className="bg-white border-b border-stone-200 px-2">
        <ol className="flex">
          {STEPS.map((name, i) => (
            <li key={name} className="flex-1 min-w-0">
              <button
                type="button"
                onClick={() => go(i)}
                aria-current={i === step ? 'step' : undefined}
                className={`w-full min-h-11 px-1 text-[11px] sm:text-xs font-semibold border-b-2 flex items-center justify-center gap-1 ${i === step ? 'border-[#0f1c2e] text-[#0f1c2e]' : 'border-transparent text-stone-600'}`}
              >
                <span className={`w-5 h-5 shrink-0 rounded-full text-[10px] flex items-center justify-center ${i < step ? 'bg-emerald-700 text-white' : i === step ? 'bg-[#0f1c2e] text-white' : 'bg-stone-200 text-stone-800'}`}>
                  {i < step ? <Check className="w-3 h-3" aria-hidden="true" /> : i + 1}
                </span>
                <span className="truncate">{name}</span>
              </button>
            </li>
          ))}
        </ol>
      </nav>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 text-sm">
        {resumedAt && (
          <div className="rounded-xl border border-stone-300 bg-white px-3 py-2 text-xs text-stone-800 flex flex-wrap items-center gap-2">
            <span>Continuing your draft from {new Date(resumedAt).toLocaleString()}.</span>
            <button type="button" onClick={() => void startOver()} className="min-h-11 px-2 font-semibold underline">
              Start over
            </button>
          </div>
        )}

        {step === 0 && (
          <section className="space-y-3" aria-label="Photos">
            <p className="text-stone-700">
              Photos first. The <strong>cover</strong> (the first) is what shoppers see in the list. Drag to reorder, or use the arrows. Up to {MAX_PHOTOS}.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <label className="min-h-14 rounded-2xl bg-[#0f1c2e] text-white font-bold flex items-center justify-center gap-2 cursor-pointer focus-within:ring-2 focus-within:ring-[#c5a059]">
                <Camera className="w-5 h-5" aria-hidden="true" /> Take photo
                <input type="file" accept="image/*" capture="environment" className="sr-only" aria-label="Take a photo with the camera" onChange={(e) => { void addPhotos(e.target.files); e.target.value = ''; }} disabled={draft.photos.length + uploading >= MAX_PHOTOS} />
              </label>
              <label className="min-h-14 rounded-2xl border-2 border-[#0f1c2e] bg-white text-[#0f1c2e] font-bold flex items-center justify-center gap-2 cursor-pointer focus-within:ring-2 focus-within:ring-[#c5a059]">
                <ImagePlus className="w-5 h-5" aria-hidden="true" /> From gallery
                <input type="file" accept="image/*" multiple className="sr-only" aria-label="Choose photos from the gallery" onChange={(e) => { void addPhotos(e.target.files); e.target.value = ''; }} disabled={draft.photos.length + uploading >= MAX_PHOTOS} />
              </label>
            </div>
            {draft.photos.length === 0 && uploading === 0 && (
              <div className="rounded-2xl border-2 border-dashed border-stone-300 bg-white px-4 py-10 text-center text-stone-600">
                <Camera className="w-8 h-8 mx-auto mb-2 text-stone-400" aria-hidden="true" />
                No photos yet. Take one, or choose several from the gallery.
              </div>
            )}
            <ol className="grid grid-cols-2 sm:grid-cols-4 gap-2" aria-label="Photos in order">
              {draft.photos.map((src, i) => (
                <li
                  key={src}
                  draggable
                  onDragStart={() => setDragFrom(i)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragFrom !== null) movePhoto(dragFrom, i);
                    setDragFrom(null);
                  }}
                  onDragEnd={() => setDragFrom(null)}
                  className={`relative rounded-xl overflow-hidden border-2 bg-white ${i === 0 ? 'border-[#c5a059]' : 'border-stone-200'} ${dragFrom === i ? 'opacity-50' : ''}`}
                  data-photo-index={i}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={src} alt={i === 0 ? 'Cover photo' : `Photo ${i + 1}`} className="w-full aspect-square object-cover" draggable={false} />
                  <span className="absolute top-1 left-1 flex items-center gap-1">
                    <GripVertical className="w-4 h-4 text-white drop-shadow" aria-hidden="true" />
                    {i === 0 && <span className="text-[11px] font-bold bg-[#0f1c2e] text-white px-1.5 py-0.5 rounded">Cover</span>}
                  </span>
                  <div className="grid grid-cols-4 bg-white border-t border-stone-200">
                    <button type="button" onClick={() => movePhoto(i, i - 1)} disabled={i === 0} className="min-h-11 flex items-center justify-center disabled:opacity-30" aria-label={`Move photo ${i + 1} earlier`}>
                      <ArrowLeft className="w-4 h-4" aria-hidden="true" />
                    </button>
                    <button type="button" onClick={() => movePhoto(i, 0)} disabled={i === 0} className="min-h-11 flex items-center justify-center disabled:opacity-30" aria-label={`Make photo ${i + 1} the cover`}>
                      <Star className="w-4 h-4" aria-hidden="true" />
                    </button>
                    <button type="button" onClick={() => movePhoto(i, i + 1)} disabled={i === draft.photos.length - 1} className="min-h-11 flex items-center justify-center disabled:opacity-30" aria-label={`Move photo ${i + 1} later`}>
                      <ArrowRight className="w-4 h-4" aria-hidden="true" />
                    </button>
                    <button type="button" onClick={() => set('photos', draft.photos.filter((_, j) => j !== i))} className="min-h-11 flex items-center justify-center text-red-800" aria-label={`Remove photo ${i + 1}`}>
                      <Trash2 className="w-4 h-4" aria-hidden="true" />
                    </button>
                  </div>
                </li>
              ))}
              {Array.from({ length: uploading }, (_, i) => (
                <li key={`up-${i}`} className="rounded-xl border-2 border-dashed border-stone-300 bg-white aspect-square flex flex-col items-center justify-center gap-1 text-stone-600" aria-label="Uploading a photo">
                  <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />
                  <span className="text-[11px]">Uploading…</span>
                </li>
              ))}
            </ol>
            {cover && originals[cover] && (
              <details className="rounded-xl border border-stone-200 bg-white px-3 py-2">
                <summary className="min-h-11 flex items-center gap-2 font-semibold cursor-pointer">
                  <Sparkles className="w-4 h-4 text-[#8a6a2c]" aria-hidden="true" /> Room-style filter for the cover (optional)
                </summary>
                <div className="flex flex-wrap items-center gap-2 pb-2">
                  <select value={aiPreset} onChange={(e) => setAiPreset(e.target.value)} className={`${field} sm:w-auto`} aria-label="Room style">
                    {AI_STAGING_PRESETS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <button type="button" onClick={() => void styleWithAi()} disabled={uploading > 0} className="min-h-11 px-3 rounded-xl bg-[#0f1c2e] text-white font-semibold disabled:opacity-50">
                    Apply
                  </button>
                </div>
              </details>
            )}
          </section>
        )}

        {step === 1 && (
          <section className="space-y-3" aria-label="Details">
            <div>
              <label className={label} htmlFor="pe-title">
                Name
              </label>
              <input id="pe-title" className={field} value={draft.title} maxLength={160} onChange={(e) => set('title', e.target.value)} placeholder="e.g. Jaipur Indigo Hand Block Set" />
            </div>
            <div>
              <label className={label} htmlFor="pe-cat">
                Category
              </label>
              <select id="pe-cat" className={field} value={draft.category} onChange={(e) => set('category', e.target.value)}>
                {catalog.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.icon} {c.label}
                  </option>
                ))}
                {!catalog.categories.some((c) => c.id === draft.category) && draft.category && <option value={draft.category}>{draft.category} (removed)</option>}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={label} htmlFor="pe-price">
                  Price (AED)
                </label>
                <input id="pe-price" className={field} type="number" min={1} step="0.01" inputMode="decimal" value={draft.price} onChange={(e) => set('price', e.target.value)} />
              </div>
              <div>
                <label className={label} htmlFor="pe-compare">
                  Was (optional)
                </label>
                <input id="pe-compare" className={field} type="number" min={0} step="0.01" inputMode="decimal" value={draft.compareAtPrice} onChange={(e) => set('compareAtPrice', e.target.value)} />
              </div>
            </div>
            <details className="rounded-xl border border-stone-200 bg-white px-3 py-1">
              <summary className="min-h-11 flex items-center gap-2 font-semibold cursor-pointer">
                <ChevronDown className="w-4 h-4" aria-hidden="true" /> More details (SKU, description, fabric, colours)
              </summary>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pb-3">
                <div>
                  <label className={label} htmlFor="pe-sku">
                    SKU (your stock code)
                  </label>
                  <input id="pe-sku" className={field} value={draft.sku} maxLength={40} onChange={(e) => set('sku', e.target.value)} placeholder="e.g. BUH-JAI-01" />
                </div>
                <div>
                  <label className={label} htmlFor="pe-material">
                    Material
                  </label>
                  <input id="pe-material" className={field} value={draft.material} maxLength={120} onChange={(e) => set('material', e.target.value)} />
                </div>
                <div>
                  <label className={label} htmlFor="pe-tc">
                    Thread count
                  </label>
                  <input id="pe-tc" className={field} type="number" inputMode="numeric" min={0} max={3000} value={draft.threadCount} onChange={(e) => set('threadCount', e.target.value)} />
                </div>
                <div>
                  <label className={label} htmlFor="pe-weave">
                    Weave
                  </label>
                  <select id="pe-weave" className={field} value={draft.weave} onChange={(e) => set('weave', e.target.value as Product['weave'])}>
                    {WEAVES.map((w) => (
                      <option key={w}>{w}</option>
                    ))}
                  </select>
                </div>
                <div className="sm:col-span-2">
                  <label className={label} htmlFor="pe-short">
                    Short description (on the card)
                  </label>
                  <input id="pe-short" className={field} value={draft.shortDescription} maxLength={300} onChange={(e) => set('shortDescription', e.target.value)} />
                </div>
                <div className="sm:col-span-2">
                  <label className={label} htmlFor="pe-desc">
                    Full description
                  </label>
                  <textarea id="pe-desc" className={`${field} min-h-[90px]`} value={draft.description} maxLength={4000} onChange={(e) => set('description', e.target.value)} />
                </div>
                <fieldset className="sm:col-span-2 space-y-2">
                  <legend className={label}>Colours</legend>
                  {draft.colors.map((c, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <input type="color" value={c.hex} onChange={(e) => set('colors', draft.colors.map((x, j) => (j === i ? { ...x, hex: e.target.value } : x)))} className="w-11 h-11 rounded-lg border border-stone-300 shrink-0" aria-label={`Colour ${i + 1} swatch`} />
                      <input className={field} value={c.name} maxLength={40} onChange={(e) => set('colors', draft.colors.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} aria-label={`Colour ${i + 1} name`} />
                      <button type="button" onClick={() => set('colors', draft.colors.filter((_, j) => j !== i))} disabled={draft.colors.length === 1} className="min-h-11 min-w-11 flex items-center justify-center text-stone-600 disabled:opacity-30" aria-label={`Remove colour ${i + 1}`}>
                        <Trash2 className="w-4 h-4" aria-hidden="true" />
                      </button>
                    </div>
                  ))}
                  {draft.colors.length < 12 && (
                    <button type="button" onClick={() => set('colors', [...draft.colors, { name: '', hex: '#ffffff' }])} className="min-h-11 text-sm font-semibold text-[#0f1c2e] flex items-center gap-1">
                      <Plus className="w-4 h-4" aria-hidden="true" /> Add a colour
                    </button>
                  )}
                </fieldset>
              </div>
            </details>
          </section>
        )}

        {step === 2 && (
          <section className="space-y-3" aria-label="Sizes and stock">
            <p className="text-stone-700">
              Sizes and pieces in stock <span className="text-stone-600">({totalStock} in total)</span>. Tap a size below to add it.
            </p>
            <ul className="space-y-2">
              {draft.sizes.map((s) => {
                const qty = draft.stock[s.id] ?? 0;
                const open = openSize === s.id;
                return (
                  <li key={s.id} className="rounded-xl border border-stone-200 bg-white">
                    <div className="flex items-center gap-2 p-2">
                      <span className="min-w-0 flex-1">
                        <span className="block font-semibold text-stone-900 truncate">{shortSizeName(s)}</span>
                        <span className="block text-[11px] text-stone-600 truncate">{s.mattressSize}</span>
                      </span>
                      <button type="button" onClick={() => setQty(s.id, qty - 1)} disabled={qty === 0} className={stepBtn} aria-label={`One fewer ${s.name}`}>
                        <Minus className="w-5 h-5" aria-hidden="true" />
                      </button>
                      <input type="number" inputMode="numeric" min={0} value={qty} onFocus={(e) => e.target.select()} onChange={(e) => setQty(s.id, Number(e.target.value))} className={`w-16 h-12 text-center rounded-xl border-2 text-lg font-bold ${qty === 0 ? 'border-red-300 text-red-800' : 'border-stone-300'}`} aria-label={`Pieces of ${s.name} in stock`} />
                      <button type="button" onClick={() => setQty(s.id, qty + 1)} className={stepBtn} aria-label={`One more ${s.name}`}>
                        <Plus className="w-5 h-5" aria-hidden="true" />
                      </button>
                    </div>
                    <div className="flex flex-wrap items-center gap-1 px-2 pb-1 text-xs">
                      <label className="min-h-11 flex items-center gap-2 pr-2" title="The size shown first">
                        <input type="radio" name="pe-default" className="w-5 h-5" checked={draft.defaultProfileId === s.id} onChange={() => set('defaultProfileId', s.id)} /> Shown first
                      </label>
                      <button type="button" onClick={() => setOpenSize(open ? null : s.id)} aria-expanded={open} className="min-h-11 px-2 font-semibold text-[#0f1c2e] underline">
                        {open ? 'Done' : 'Measurements & price'}
                      </button>
                      <button type="button" onClick={() => removeSize(s.id)} disabled={draft.sizes.length === 1} className="ml-auto min-h-11 min-w-11 flex items-center justify-center text-stone-600 disabled:opacity-30" aria-label={`Remove ${s.name}`}>
                        <Trash2 className="w-4 h-4" aria-hidden="true" />
                      </button>
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
                            <span className="text-stone-700">{l}</span>
                            <input className={field} value={String(s[k] ?? '')} maxLength={80} onChange={(e) => updateSize(s.id, { [k]: e.target.value })} />
                          </label>
                        ))}
                        <label className="block">
                          <span className="text-stone-700">Price difference (AED, + or −)</span>
                          <input className={field} type="number" step="0.01" value={s.priceDelta} onChange={(e) => updateSize(s.id, { priceDelta: Number(e.target.value) || 0 })} />
                        </label>
                        <label className="block">
                          <span className="text-stone-700">Pieces in the set</span>
                          <input className={field} type="number" min={1} max={20} value={s.piecesIncluded} onChange={(e) => updateSize(s.id, { piecesIncluded: Math.max(1, Number(e.target.value) || 1) })} />
                        </label>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            {unusedPresets.length > 0 && (
              <div className="flex flex-wrap gap-2" role="group" aria-label="Add a size">
                {unusedPresets.map((s) => (
                  <button key={s.id} type="button" onClick={() => addSize(s.id)} className="min-h-11 text-xs font-semibold px-3 rounded-full border border-stone-300 bg-white hover:border-[#c5a059] flex items-center gap-1" aria-label={`Add size ${s.name}`}>
                    <Plus className="w-3.5 h-3.5" aria-hidden="true" /> {shortSizeName(s)}
                  </button>
                ))}
              </div>
            )}
            <p className="text-xs text-stone-600">Size presets (names, measurements, price differences) are set in Settings → Catalogue.</p>
          </section>
        )}

        {step === 3 && (
          <section className="space-y-3" aria-label="Publish">
            <div className="flex gap-3 rounded-2xl border border-stone-200 bg-white p-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {cover && <img src={cover} alt="" className="w-20 h-20 rounded-xl object-cover shrink-0" />}
              <div className="min-w-0">
                <div className="font-bold text-[#0f1c2e] break-words">{draft.title || 'No name yet'}</div>
                <div className="text-xs text-stone-700">
                  AED {draft.price || '—'} · {catalog.categories.find((c) => c.id === draft.category)?.label ?? draft.category} · {draft.photos.length} {draft.photos.length === 1 ? 'photo' : 'photos'}
                </div>
                <div className="mt-1 text-xs text-stone-800">{draft.sizes.map((s) => `${shortSizeName(s)} ${draft.stock[s.id] ?? 0}`).join(' · ')}</div>
              </div>
            </div>
            <div className="rounded-2xl border border-stone-200 bg-white divide-y divide-stone-100">
              {(
                [
                  ['active', 'Shown in the shop', 'Off: saved but hidden until you show it.'],
                  ['isNewArrival', 'New arrival', 'Marked as new in the shop.'],
                  ['isFeatured', 'Featured', 'Shown among the first products.'],
                ] as Array<['active' | 'isNewArrival' | 'isFeatured', string, string]>
              ).map(([k, l, hint]) => (
                <label key={k} className="flex items-center gap-3 px-3 min-h-14">
                  <input type="checkbox" className="w-5 h-5" checked={draft[k]} onChange={(e) => set(k, e.target.checked)} />
                  <span>
                    <span className="block font-semibold text-stone-900">{l}</span>
                    <span className="block text-xs text-stone-600">{hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </section>
        )}
      </div>

      <div className="border-t border-stone-200 bg-white px-4 py-3 space-y-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {error && (
          <p role="alert" className="text-xs text-red-800 bg-red-50 border border-red-200 rounded-lg px-3 py-2 font-medium">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          {step > 0 ? (
            <button type="button" onClick={() => go(step - 1)} className="min-h-12 px-4 rounded-xl border border-stone-300 bg-white text-sm font-semibold flex items-center gap-1">
              <ArrowLeft className="w-4 h-4" aria-hidden="true" /> Back
            </button>
          ) : (
            <button type="button" onClick={onClose} className="min-h-12 px-4 rounded-xl border border-stone-300 bg-white text-sm font-semibold">
              Cancel
            </button>
          )}
          {step < STEPS.length - 1 ? (
            <button type="button" onClick={() => go(step + 1)} disabled={step === 0 && uploading > 0} className="flex-1 min-h-12 rounded-xl bg-[#0f1c2e] text-white text-sm font-bold flex items-center justify-center gap-1 disabled:opacity-50">
              Next: {STEPS[step + 1]} <ArrowRight className="w-4 h-4" aria-hidden="true" />
            </button>
          ) : (
            <button type="button" onClick={() => void save()} disabled={saving || uploading > 0} className="flex-1 min-h-12 rounded-xl bg-[#0f1c2e] text-white text-sm font-bold disabled:opacity-50 flex items-center justify-center gap-2">
              {saving && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
              {product ? 'Save changes' : draft.active ? 'Publish' : 'Save hidden'}
            </button>
          )}
        </div>
      </div>
    </Sheet>
  );
}
