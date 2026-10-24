'use client';

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Camera, Check, ImagePlus, Loader2, Minus, Plus, Sparkles, X } from 'lucide-react';
import type { CatalogSettings, Product } from '@/types';
import { getJson, postJson, sendJson } from '@/lib/apiClient';
import { newKey, shortSizeName } from '@/lib/client/stock';
import { shrinkPhoto } from '@/lib/shrinkPhoto';
import { defaultTypeFor } from '@/lib/productType';
import { visibleJobs } from '@/lib/client/autoJobs';
import { Sheet } from '@/components/common/Sheet';
import { SetPiecesField, type SetPieceKind } from './SetPiecesField';

/**
 * Add a product with the basics only (src/lib/server/autoAdd.ts): photos, price, sizes and stock
 * (the last ones used are remembered on this device), a name only if the owner wants one. Add saves
 * it at once and the form is ready for the next one: the AI writes the name and descriptions and
 * makes the pictures in the background (one per angle in the owner's prompt, AI pictures first,
 * the owner's photo last), then puts it in the shop. The list below shows each one's progress.
 * Anything can be changed later in the full editor.
 */

const MAX_PHOTOS = 8;

/** A photo picked for the item being added: its local preview and its upload (the stored address). */
interface Pic {
  id: string;
  file: File;
  preview: string;
  upload: Promise<string>;
}

/** Shrink the photo on the phone and store it (PNG, JPEG or WebP through the shop's checks): its address. */
function uploadPhoto(file: File): Promise<string> {
  const upload = (async () => {
    const res = await postJson<{ url?: string; message?: string }>('/api/admin/images', { image: await shrinkPhoto(file) });
    if (!res.ok || !res.data.url) throw new Error(res.data.message || 'The photo could not be uploaded.');
    return res.data.url;
  })();
  // Failures are reported where the photo is used (in the item's row), never unhandled.
  upload.catch(() => undefined);
  return upload;
}

/** An item added here that is still on its way to the server (or failed: Try again, same key). */
interface Sending {
  key: string;
  label: string;
  preview: string;
  photos: Pic[];
  /** The set's other pieces (the pillow cover, the comforter), uploading like the photos. */
  pieces: Partial<Record<SetPieceKind, Pic>>;
  body: Record<string, unknown>;
  failed?: string;
}
const REMEMBER = 'buh:quick-add';

export interface AutoJobView {
  id: string;
  productId: string;
  title: string;
  cover: string;
  state: 'queued' | 'writing' | 'pictures' | 'waiting' | 'done' | 'needs_you';
  made: number;
  planned: number;
  note: string;
  until: string | null;
  active: boolean;
  updatedAt?: string;
}

export interface AutoStatusView {
  on: boolean;
  writer: boolean;
  pictures: boolean;
  angles: string[];
  why: string;
  jobs: AutoJobView[];
}

const field = 'w-full min-h-11 px-3 py-2 rounded-xl border border-line-strong bg-surface text-ink text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-gold';
const label = 'block text-sm font-semibold text-ink mb-1';
const stepBtn = 'w-11 h-11 rounded-xl border border-line-strong bg-surface flex items-center justify-center disabled:opacity-30';

function remembered(): { sizes?: Record<string, number>; category?: string } {
  try {
    return JSON.parse(localStorage.getItem(REMEMBER) || '{}') as { sizes?: Record<string, number>; category?: string };
  } catch {
    return {};
  }
}

/** One line on where a product is. */
export function jobLine(j: AutoJobView): string {
  if (j.state === 'queued') return 'Waiting its turn…';
  if (j.state === 'writing') return 'AI is writing the name and description…';
  if (j.state === 'pictures') return `Making picture ${Math.min(j.made + 1, j.planned)} of ${j.planned}…`;
  if (j.state === 'waiting') return `The AI service asked to wait: trying again${j.until ? ` at ${new Date(j.until).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : ''} by itself.`;
  return j.note || (j.state === 'done' ? 'Done.' : 'Needs you.');
}

/** The products being made (or just made), with their progress; refreshed while any is still working. */
export function useAutoJobs(open: boolean, onSettled?: () => void) {
  const [status, setStatus] = useState<AutoStatusView | null>(null);
  /** Each job's last state seen: one that has just finished reloads the product list (it is in the shop now). */
  const seen = useRef(new Map<string, string>());
  const settled = useRef(onSettled);
  useEffect(() => {
    settled.current = onSettled;
  }, [onSettled]);
  const load = useCallback(async () => {
    const { ok, data } = await getJson<AutoStatusView>('/api/admin/products/quick');
    if (!ok) return null;
    const finished = data.jobs.some((j) => (j.state === 'done' || j.state === 'needs_you') && seen.current.has(j.id) && seen.current.get(j.id) !== j.state);
    seen.current = new Map(data.jobs.map((j) => [j.id, j.state]));
    setStatus(data);
    if (finished) settled.current?.();
    return data;
  }, []);
  useEffect(() => {
    if (!open) return;
    let on = true;
    let t: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      const s = await load();
      if (!on) return;
      const working = s?.jobs.some((j) => j.state !== 'done' && j.state !== 'needs_you');
      t = setTimeout(() => void tick(), working ? 4000 : 30000);
    };
    void tick();
    return () => {
      on = false;
      if (t) clearTimeout(t);
    };
  }, [open, load]);
  const dismiss = async (id: string) => {
    await sendJson('DELETE', '/api/admin/products/quick', { id });
    await load();
  };
  return { status, reload: load, dismiss };
}

export function AutoJobsList({ jobs, onOpen, onDismiss }: { jobs: AutoJobView[]; onOpen: (productId: string) => void; onDismiss: (id: string) => void }) {
  if (!jobs.length) return null;
  return (
    <ul className="space-y-2" data-testid="auto-jobs">
      {jobs.map((j) => {
        const working = j.state !== 'done' && j.state !== 'needs_you';
        return (
          <li key={j.id} className={`flex items-center gap-2 rounded-xl border p-2 min-w-0 ${j.state === 'needs_you' ? 'border-warning-line bg-warning-soft' : 'border-line bg-surface'}`} data-testid="auto-job" data-state={j.state}>
            {j.cover ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={j.cover} alt="" className="w-12 aspect-[4/5] object-cover rounded-lg border border-line shrink-0" />
            ) : (
              <span className="w-12 aspect-[4/5] rounded-lg border border-line shrink-0" />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-ink break-words">{j.title || 'New product'}</p>
              <p className="text-xs text-ink-soft break-words flex items-start gap-1" role={working ? 'status' : undefined}>
                {working ? <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0 mt-0.5" aria-hidden="true" /> : j.state === 'done' ? <Check className="w-3.5 h-3.5 text-success shrink-0 mt-0.5" aria-hidden="true" /> : null}
                <span>{jobLine(j)}</span>
              </p>
            </div>
            {/* Editing while the AI works would put the editor's copy over the AI's (the server refuses it too). */}
            {!working && (
              <button type="button" onClick={() => onOpen(j.productId)} className="min-h-11 px-3 rounded-xl border border-line-strong bg-surface text-xs font-semibold shrink-0">
                {j.state === 'needs_you' ? 'Finish' : 'Edit'}
              </button>
            )}
            {!working && (
              <button type="button" onClick={() => onDismiss(j.id)} className="w-11 h-11 rounded-xl border border-line-strong bg-surface flex items-center justify-center shrink-0" aria-label={`Clear from the list: ${j.title || 'new product'}`}>
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function QuickAdd({
  catalog,
  onClose,
  onAdded,
  onFullEditor,
  onOpenProduct,
  onSettled,
}: {
  catalog: CatalogSettings;
  onClose: () => void;
  /** A product was saved (reload the list). */
  onAdded: (p: Product) => void;
  /** The step-by-step editor instead (everything by hand). */
  onFullEditor: () => void;
  /** Open a product in the editor (from the list). */
  onOpenProduct: (productId: string) => void;
  /** A product the AI was making is finished (reload the list: it is in the shop now). */
  onSettled?: () => void;
}) {
  const titleId = useId();
  const [memory] = useState(remembered);
  const [category, setCategory] = useState(() => catalog.categories.find((c) => c.id === memory.category)?.id ?? catalog.categories[0]?.id ?? '');
  const simple = defaultTypeFor(catalog, category) === 'simple';
  const startSizes = (): Record<string, number> => {
    const m = memory.sizes ?? {};
    const known = Object.fromEntries(Object.entries(m).filter(([id]) => catalog.sizes.some((s) => s.id === id)));
    if (Object.keys(known).length) return known;
    const king = catalog.sizes.find((s) => s.id === 'king') ?? catalog.sizes[0];
    return king ? { [king.id]: 1 } : {};
  };
  const [sizes, setSizes] = useState<Record<string, number>>(startSizes);
  const [oneStock, setOneStock] = useState(1);
  /** The photos for this item: shown at once (a local preview) while each one uploads. */
  const [photos, setPhotos] = useState<Pic[]>([]);
  /** The pillow cover photo, and the comforter (off by default): the AI pictures copy each piece from its own photo. */
  const [pieces, setPieces] = useState<Partial<Record<SetPieceKind, Pic>>>({});
  const [hasComforter, setHasComforter] = useState(false);
  const [price, setPrice] = useState('');
  const [title, setTitle] = useState('');
  const [publish, setPublish] = useState(true);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  /** The list of items being made: folded into one line so the form stays in view (opened on a tap, or when one failed). */
  const [showMade, setShowMade] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  /** Items already added here, still uploading their photos or being sent (or that failed: Try again). */
  const [sending, setSending] = useState<Sending[]>([]);
  const key = useRef(newKey('q'));
  const { status, reload, dismiss } = useAutoJobs(true, onSettled);
  const needsName = status ? !status.writer : false;

  const addPhotos = (files: FileList | null) => {
    if (!files?.length) return;
    setError('');
    const list = Array.from(files).slice(0, Math.max(0, MAX_PHOTOS - photos.length));
    // Each photo uploads on its own straight away; Add does not wait for it.
    const fresh = list.map((file): Pic => ({ id: newKey('p'), file, preview: URL.createObjectURL(file), upload: uploadPhoto(file) }));
    setPhotos((p) => [...p, ...fresh].slice(0, MAX_PHOTOS));
  };

  const toggleSize = (id: string) => setSizes((s) => (id in s ? Object.fromEntries(Object.entries(s).filter(([k]) => k !== id)) : { ...s, [id]: 1 }));
  const setQty = (id: string, q: number) => setSizes((s) => ({ ...s, [id]: Math.max(0, Math.min(100000, q)) }));

  /** One item: its photos finish uploading, then it is sent (safe to send again: same key). */
  const send = async (item: Sending) => {
    setSending((all) => all.map((x) => (x.key === item.key ? { ...x, failed: undefined } : x)));
    const fail = (message: string) => setSending((all) => all.map((x) => (x.key === item.key ? { ...x, failed: message } : x)));
    let urls: string[];
    const setPhotos: Partial<Record<SetPieceKind, string>> = {};
    // A photo whose upload failed (a weak connection) is uploaded again on Try again.
    const uploaded = (p: Pic) =>
      p.upload.catch(() => {
        p.upload = uploadPhoto(p.file);
        return p.upload;
      });
    try {
      urls = await Promise.all(item.photos.map(uploaded));
      for (const [kind, p] of Object.entries(item.pieces) as Array<[SetPieceKind, Pic]>) setPhotos[kind] = await uploaded(p);
    } catch (err) {
      return fail(err instanceof Error ? err.message : 'A photo could not be uploaded.');
    }
    const res = await postJson<{ product?: Product; message?: string }>('/api/admin/products/quick', { ...item.body, key: item.key, photos: urls, ...(Object.keys(setPhotos).length ? { setPhotos } : {}) });
    if (!res.ok || !res.data.product) return fail(res.data.message || 'Could not add it. Please try again.');
    setSending((all) => all.filter((x) => x.key !== item.key));
    for (const p of [...item.photos, ...Object.values(item.pieces)]) URL.revokeObjectURL(p.preview);
    onAdded(res.data.product);
    void reload();
  };

  /** A failed item taken off the list (it was not added). */
  const drop = (item: Sending) => {
    setSending((all) => all.filter((x) => x.key !== item.key));
    for (const p of [...item.photos, ...Object.values(item.pieces)]) URL.revokeObjectURL(p.preview);
  };

  const add = () => {
    setError('');
    setDone('');
    // Whether a name is needed depends on the AI being set up: known in a moment.
    if (!status) return setError('One moment: checking the AI setup.');
    if (!photos.length) return setError('Add a photo first.');
    if (!(Number(price) > 0)) return setError('Enter the price in AED.');
    if (needsName && !title.trim()) return setError('Give it a name (AI writing is not set up).');
    const chosen = simple ? [{ stock: oneStock }] : catalog.sizes.filter((s) => s.id in sizes).map((s) => ({ id: s.id, stock: sizes[s.id] }));
    if (!chosen.length) return setError('Choose at least one size.');
    const item: Sending = {
      key: key.current,
      label: title.trim(),
      preview: photos[0].preview,
      photos,
      // The comforter only when the set has one (off by default).
      pieces: { ...(pieces.pillow ? { pillow: pieces.pillow } : {}), ...(hasComforter && pieces.comforter ? { comforter: pieces.comforter } : {}) },
      body: { price: Number(price), category, sizes: chosen, ...(title.trim() ? { title: title.trim() } : {}), publish },
    };
    try {
      localStorage.setItem(REMEMBER, JSON.stringify({ sizes, category }));
    } catch {
      // Remembering is a convenience only.
    }
    // Ready for the next one at once: a new key, no photos or name; the price, sizes and stock stay.
    // The photos finish uploading and the item is sent in the background.
    key.current = newKey('q');
    setPhotos([]);
    setPieces({});
    setHasComforter(false);
    setTitle('');
    setSending((all) => [...all, item]);
    setDone(status?.writer || status?.pictures ? 'The AI is finishing it in the background (name, description, pictures) and puts it in the shop by itself. Add the next item:' : `It is ${publish ? 'in the shop' : 'saved, hidden'}. Add the next item:`);
    // Back to the top, ready for the next item: the camera is one tap away (reported: the form
    // stayed scrolled down after Add, so it didn't look open for the next item).
    scroller.current?.scrollTo({ top: 0, behavior: 'smooth' });
    window.setTimeout(() => camera.current?.focus({ preventScroll: true }), 50);
    void send(item);
  };

  // Items still uploading their photos would be lost: asked once before closing.
  const close = () => {
    if (sending.length && !window.confirm(sending.some((x) => !x.failed) ? 'Some items are still uploading their photos. Close anyway? They may not be added.' : 'Some items were not added (see Being made). Close anyway and lose them?')) return;
    onClose();
  };

  return (
    <Sheet labelledBy={titleId} onClose={close} variant="full" wide>
      <div className="px-4 pt-4 pb-2 flex items-start gap-2 border-b border-line">
        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="font-serif font-bold text-base text-ink">
            Quick add
          </h3>
          <p className="text-xs text-ink-soft">
            {status?.writer || status?.pictures
              ? `Just the basics: the AI writes ${status.writer ? 'the name and description' : ''}${status.writer && status.pictures ? ' and ' : ''}${status.pictures ? `makes ${status.angles.length || 'the'} pictures` : ''}, then it goes in the shop.`
              : 'Photos, price and stock.'}
            {status?.why ? ` ${status.why}` : ''}
          </p>
        </div>
        <button type="button" onClick={close} className="w-11 h-11 rounded-xl border border-line-strong flex items-center justify-center shrink-0" aria-label="Close">
          <X className="w-5 h-5" aria-hidden="true" />
        </button>
      </div>
      <div ref={scroller} className="flex-1 overflow-y-auto px-4 py-3 space-y-4" data-testid="quick-add">
        {done && (
          <div role="status" className="rounded-xl border border-success-line bg-success-soft p-3 text-sm text-ink" data-testid="quick-added">
            <p className="font-bold flex items-center gap-1.5">
              <Check className="w-4 h-4 text-success shrink-0" aria-hidden="true" /> Added
            </p>
            <p className="text-xs text-ink-soft mt-0.5">{done}</p>
          </div>
        )}
        {(() => {
          const made = status ? visibleJobs(status.jobs, 'form') : [];
          const count = sending.length + made.length;
          if (!count) return null;
          const failed = sending.some((x) => x.failed) || made.some((j) => j.state === 'needs_you');
          const working = sending.filter((x) => !x.failed).length + made.filter((j) => j.state !== 'done' && j.state !== 'needs_you').length;
          return (
            <button type="button" onClick={() => setShowMade((v) => !v)} aria-expanded={showMade || failed} aria-controls="quick-being-made" className={`w-full min-h-11 px-3 rounded-xl border text-left text-xs font-semibold flex items-center gap-2 ${failed ? 'border-warning-line bg-warning-soft text-ink' : 'border-line bg-surface text-ink'}`} data-testid="quick-made-summary">
              {working > 0 ? <Loader2 className="w-4 h-4 animate-spin shrink-0" aria-hidden="true" /> : <Check className="w-4 h-4 text-success shrink-0" aria-hidden="true" />}
              <span className="flex-1">
                {working > 0 ? `${working} being made by AI` : 'All finished'}
                {failed ? ' · one needs you' : ''}
              </span>
              <span className="text-ink-soft">{showMade || failed ? 'Hide' : 'See them'}</span>
            </button>
          );
        })()}
        <section className="space-y-2" aria-label="Photos">
          <div className="grid grid-cols-2 gap-2">
            <label className={`min-h-12 rounded-xl bg-ink text-paper font-bold flex items-center justify-center gap-2 cursor-pointer focus-within:ring-2 focus-within:ring-gold ${photos.length >= MAX_PHOTOS ? 'opacity-50' : ''}`}>
              <Camera className="w-5 h-5" aria-hidden="true" /> Camera
              <input ref={camera} type="file" accept="image/*" capture="environment" className="sr-only" aria-label="Take a photo with the camera" onChange={(e) => { addPhotos(e.target.files); e.target.value = ''; }} disabled={photos.length >= MAX_PHOTOS} />
            </label>
            <label className={`min-h-12 rounded-xl border border-ink bg-surface text-ink font-bold flex items-center justify-center gap-2 cursor-pointer focus-within:ring-2 focus-within:ring-gold ${photos.length >= MAX_PHOTOS ? 'opacity-50' : ''}`}>
              <ImagePlus className="w-5 h-5" aria-hidden="true" /> Gallery
              <input type="file" accept="image/*" multiple className="sr-only" aria-label="Choose photos from the gallery" onChange={(e) => { addPhotos(e.target.files); e.target.value = ''; }} disabled={photos.length >= MAX_PHOTOS} />
            </label>
          </div>
          {photos.length > 0 && (
            <ul className="flex flex-wrap gap-2" data-testid="quick-photos">
              {photos.map((p, i) => (
                <li key={p.id} className="relative w-20 shrink-0">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p.preview} alt={i === 0 ? 'Photo 1 (the AI works from this one)' : `Photo ${i + 1}`} className="w-20 aspect-[4/5] object-cover rounded-xl border border-line" />
                  <button type="button" onClick={() => setPhotos((all) => all.filter((x) => x.id !== p.id))} className="absolute -top-2 -right-2 w-8 h-8 rounded-full bg-surface border border-line-strong flex items-center justify-center" aria-label={`Remove photo ${i + 1}`}>
                    <X className="w-4 h-4" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <SetPiecesField
          pieces={pieces}
          hasComforter={hasComforter}
          onComforter={(on) => {
            setHasComforter(on);
            if (!on) setPieces(({ comforter: _c, ...rest }) => (void _c, rest));
          }}
          onPick={(kind, file) => setPieces((all) => ({ ...all, [kind]: { id: newKey('p'), file, preview: URL.createObjectURL(file), upload: uploadPhoto(file) } }))}
          onRemove={(kind) => setPieces(({ [kind]: _gone, ...rest }) => (void _gone, rest))}
        />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={label} htmlFor={`${titleId}-price`}>
              Price (AED)
            </label>
            <input id={`${titleId}-price`} className={field} type="number" min={1} step="0.01" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
          </div>
          {catalog.categories.length > 1 && (
            <div>
              <label className={label} htmlFor={`${titleId}-cat`}>
                Category
              </label>
              <select id={`${titleId}-cat`} className={field} value={category} onChange={(e) => setCategory(e.target.value)}>
                {catalog.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {simple ? (
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-ink flex-1">In stock</span>
            <button type="button" className={stepBtn} onClick={() => setOneStock((q) => Math.max(0, q - 1))} disabled={oneStock === 0} aria-label="One fewer">
              <Minus className="w-4 h-4" aria-hidden="true" />
            </button>
            <span className="w-10 text-center font-bold tabular-nums" aria-live="polite">
              {oneStock}
            </span>
            <button type="button" className={stepBtn} onClick={() => setOneStock((q) => q + 1)} aria-label="One more">
              <Plus className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
        ) : (
          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold text-ink mb-1">Sizes and stock</legend>
            <div className="flex flex-wrap gap-2">
              {catalog.sizes.map((s) => (
                <button key={s.id} type="button" onClick={() => toggleSize(s.id)} aria-pressed={s.id in sizes} className={`min-h-11 px-3 rounded-xl border text-sm font-semibold ${s.id in sizes ? 'bg-ink text-paper border-ink' : 'bg-surface text-ink border-line-strong'}`}>
                  {s.name}
                </button>
              ))}
            </div>
            {catalog.sizes
              .filter((s) => s.id in sizes)
              .map((s) => (
                <div key={s.id} className="flex items-center gap-2">
                  <span className="text-sm text-ink flex-1 min-w-0 break-words">{s.name}</span>
                  <button type="button" className={stepBtn} onClick={() => setQty(s.id, (sizes[s.id] ?? 0) - 1)} disabled={(sizes[s.id] ?? 0) === 0} aria-label={`One fewer ${shortSizeName(s)}`}>
                    <Minus className="w-4 h-4" aria-hidden="true" />
                  </button>
                  <span className="w-10 text-center font-bold tabular-nums" aria-live="polite">
                    {sizes[s.id] ?? 0}
                  </span>
                  <button type="button" className={stepBtn} onClick={() => setQty(s.id, (sizes[s.id] ?? 0) + 1)} aria-label={`One more ${shortSizeName(s)}`}>
                    <Plus className="w-4 h-4" aria-hidden="true" />
                  </button>
                </div>
              ))}
          </fieldset>
        )}

        <div>
          <label className={label} htmlFor={`${titleId}-name`}>
            Name {needsName ? '' : <span className="font-normal text-ink-soft">(optional: the AI writes one)</span>}
          </label>
          <input id={`${titleId}-name`} className={field} value={title} maxLength={160} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <label className="flex items-center gap-3 min-h-11 text-sm text-ink">
          <input type="checkbox" className="w-5 h-5" checked={publish} onChange={(e) => setPublish(e.target.checked)} /> Put it in the shop {status?.writer || status?.pictures ? 'when it is ready' : 'now'}
        </label>

        {error && (
          <p role="alert" className="text-sm font-semibold text-danger">
            {error}
          </p>
        )}

        {(sending.length > 0 || (status && visibleJobs(status.jobs, 'form').length > 0)) && (showMade || sending.some((x) => x.failed) || Boolean(status?.jobs.some((j) => j.state === 'needs_you'))) && (
          <section id="quick-being-made" className="space-y-2" aria-label="Being made">
            <h4 className="text-sm font-bold text-ink">Being made</h4>
            {sending.length > 0 && (
              <ul className="space-y-2" data-testid="quick-sending">
                {sending.map((x) => (
                  <li key={x.key} className={`flex items-center gap-2 rounded-xl border p-2 min-w-0 ${x.failed ? 'border-danger-line bg-danger-soft' : 'border-line bg-surface'}`}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={x.preview} alt="" className="w-12 aspect-[4/5] object-cover rounded-lg border border-line shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-ink break-words">{x.label || 'New product'}</p>
                      <p className="text-xs text-ink-soft break-words flex items-start gap-1" role={x.failed ? 'alert' : 'status'}>
                        {!x.failed && <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0 mt-0.5" aria-hidden="true" />}
                        <span>{x.failed ? `Not added yet: ${x.failed}` : 'Uploading the photo and sending it…'}</span>
                      </p>
                    </div>
                    {x.failed && (
                      <>
                        <button type="button" onClick={() => void send(x)} className="min-h-11 px-3 rounded-xl border border-line-strong bg-surface text-xs font-semibold shrink-0">
                          Try again
                        </button>
                        <button type="button" onClick={() => drop(x)} className="w-11 h-11 rounded-xl border border-line-strong bg-surface flex items-center justify-center shrink-0" aria-label={`Remove: ${x.label || 'new product'} (not added)`}>
                          <X className="w-4 h-4" aria-hidden="true" />
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {status && <AutoJobsList jobs={visibleJobs(status.jobs, 'form')} onOpen={onOpenProduct} onDismiss={(id) => void dismiss(id)} />}
          </section>
        )}
        <button type="button" onClick={onFullEditor} className="text-sm font-semibold underline min-h-11">
          Use the full editor instead (everything by hand)
        </button>
      </div>
      <div className="px-4 py-3 border-t border-line">
        <button type="button" onClick={add} className="w-full min-h-12 rounded-xl bg-ink text-paper font-bold flex items-center justify-center gap-2 disabled:opacity-50" data-testid="quick-add-save">
          <Sparkles className="w-5 h-5 text-gold" aria-hidden="true" />
          {status?.writer || status?.pictures ? 'Add, AI does the rest' : 'Add product'}
        </button>
      </div>
    </Sheet>
  );
}
