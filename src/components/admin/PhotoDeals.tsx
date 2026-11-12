'use client';

import React, { useCallback, useEffect, useId, useState } from 'react';
import { Camera, Copy, ImagePlus, Link2, Loader2, MessageCircle, Pencil, Plus, X } from 'lucide-react';
import { getJson, postJson, sendJson } from '@/lib/apiClient';
import { shrinkPhoto } from '@/lib/shrinkPhoto';
import { PHOTO_URL_MAX } from '@/components/store/PhotoOrderSheet';
import type { PaymentMethod } from '@/types';

/** Kept in step with the server (src/lib/server/photoDeals.ts DEAL_LIMITS). */
const LIMITS = { maxPhotos: 12, maxAmount: 20_000, maxPieces: 20, noteMax: 300, forMax: 60, maxDays: 30 };
const PAYS: Array<{ id: PaymentMethod; label: string }> = [
  { id: 'online_card', label: 'Card' },
  { id: 'cod', label: 'Cash on delivery' },
  { id: 'bank_transfer', label: 'Bank transfer' },
];

interface Deal {
  id: string;
  createdAt: string;
  forWhom?: string;
  note?: string;
  pieces: number;
  amount: number;
  payments: PaymentMethod[];
  photos: number;
  expiresAt: string;
  state: 'open' | 'ordered' | 'expired' | 'cancelled';
  orderId?: string;
  url?: string;
}

const STATE: Record<Deal['state'], { text: string; cls: string }> = {
  open: { text: 'Waiting for the customer', cls: 'bg-warning-soft text-warning border-warning-line' },
  ordered: { text: 'Ordered', cls: 'bg-success-soft text-success border-success-line' },
  expired: { text: 'Expired', cls: 'bg-sand text-ink-soft border-line' },
  cancelled: { text: 'Stopped', cls: 'bg-sand text-ink-soft border-line' },
};

/** Days the link still works (1 when expired: saving makes it work again), for the edit form. */
function daysLeft(expiresAt: string): number {
  return Math.max(1, Math.min(LIMITS.maxDays, Math.ceil((Date.parse(expiresAt) - Date.now()) / 86_400_000) || 1));
}

const message = (d: Pick<Deal, 'amount' | 'url'>) => `Here is your order: AED ${d.amount}, delivery included. See the pictures, add your address and pay here: ${d.url}`;

/**
 * Orders → Photo deals: the owner's own "order from a photo". Pictures (up to 12), what it is, the
 * fixed price with delivery, the ways the customer may pay and how long the link works; then a
 * private link to send on WhatsApp. The customer can't change the price. Owner only. A link can be
 * edited (pictures, price, ways to pay, how long it works) until it is ordered; the link stays the same.
 * limit: only the latest few (the Orders page shows 3; "See all" opens the Photo orders tab).
 */
export function PhotoDeals({ limit, onShowAll }: { limit?: number; onShowAll?: () => void } = {}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [deals, setDeals] = useState<Deal[] | null>(null);
  const [photos, setPhotos] = useState<string[]>([]);
  const [preparing, setPreparing] = useState(0);
  const [note, setNote] = useState('');
  const [forWhom, setForWhom] = useState('');
  const [pieces, setPieces] = useState('1');
  const [amount, setAmount] = useState('');
  const [pays, setPays] = useState<PaymentMethod[]>(['online_card', 'cod', 'bank_transfer']);
  const [days, setDays] = useState('7');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [made, setMade] = useState<Deal | null>(null);
  // Editing a deal: its id, and the numbers of its own pictures kept (the new ones are in photos).
  const [editing, setEditing] = useState<Deal | null>(null);
  const [keep, setKeep] = useState<number[]>([]);
  const [copied, setCopied] = useState('');
  // The customer upload page (/order-by-photo): the same switches as Settings → Store & contact, here too.
  const [page, setPage] = useState<{ photoOrders: boolean; photoOrdersOnHome: boolean; photoOrdersCard?: boolean; whatsappNumber: string } | null>(null);
  const [pageNote, setPageNote] = useState('');

  const load = useCallback(async () => {
    const { ok, data } = await getJson<{ deals?: Deal[] }>('/api/admin/deals');
    if (ok && data.deals) setDeals(data.deals);
  }, []);
  useEffect(() => {
    let alive = true;
    void getJson<{ deals?: Deal[] }>('/api/admin/deals').then(({ ok, data }) => {
      if (alive && ok && data.deals) setDeals(data.deals);
    });
    void getJson<{ store?: { value: { photoOrders: boolean; photoOrdersOnHome: boolean; photoOrdersCard?: boolean; whatsappNumber: string } } }>('/api/admin/settings').then(({ ok, data }) => {
      if (alive && ok && data.store) setPage(data.store.value);
    });
    return () => {
      alive = false;
    };
  }, []);

  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    setError('');
    const room = LIMITS.maxPhotos - photos.length - keep.length;
    const picked = Array.from(files).slice(0, Math.max(0, room));
    if (files.length > room) setError(`At most ${LIMITS.maxPhotos} pictures.`);
    setPreparing((n) => n + picked.length);
    for (const file of picked) {
      try {
        const url = await shrinkPhoto(file, 1400, PHOTO_URL_MAX);
        setPhotos((list) => (list.length + keep.length < LIMITS.maxPhotos ? [...list, url] : list));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'This picture could not be read. Please try another one.');
      } finally {
        setPreparing((n) => n - 1);
      }
    }
  };

  const reset = () => {
    setEditing(null);
    setKeep([]);
    setPhotos([]);
    setNote('');
    setForWhom('');
    setPieces('1');
    setAmount('');
    setDays('7');
    setError('');
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const price = Number(amount.replace(/,/g, ''));
    if (!photos.length && !keep.length) return setError('Add at least one picture.');
    if (!Number.isFinite(price) || price < 1 || price > LIMITS.maxAmount) return setError(`Price: from AED 1 to AED ${LIMITS.maxAmount.toLocaleString('en-US')}.`);
    if (!pays.length) return setError('Choose at least one way to pay.');
    setBusy(true);
    setError('');
    const fields = { note: note.trim(), forWhom: forWhom.trim(), pieces: Number(pieces), amount: Math.round(price * 100) / 100, payments: pays, days: Number(days) };
    const { ok, data } = editing
      ? await sendJson<{ deal?: Deal; message?: string }>('PATCH', `/api/admin/deals/${encodeURIComponent(editing.id)}`, { ...fields, keep, photos })
      : await postJson<{ deal?: Deal; message?: string }>('/api/admin/deals', { ...fields, photos });
    setBusy(false);
    if (!ok || !data.deal) return setError(data.message || 'Not saved. Please try again.');
    // The list first, so it never shows the old price beside "Link ready" with the new one.
    await load();
    setMade(data.deal);
    setOpen(false);
    reset();
  };

  // Edit: the form, filled in with the deal; its pictures kept unless removed.
  const edit = (d: Deal) => {
    reset();
    setEditing(d);
    setKeep(Array.from({ length: d.photos }, (_, i) => i + 1));
    setNote(d.note ?? '');
    setForWhom(d.forWhom ?? '');
    setPieces(String(d.pieces));
    setAmount(String(d.amount));
    setPays(d.payments);
    setDays(String(daysLeft(d.expiresAt)));
    setMade(null);
    setOpen(true);
  };

  const copy = async (d: Deal, what: 'link' | 'message') => {
    if (!d.url) return;
    try {
      await navigator.clipboard.writeText(what === 'link' ? d.url : message(d));
      setCopied(`${d.id}:${what}`);
      setTimeout(() => setCopied(''), 2000);
    } catch {
      window.prompt('Copy the link:', d.url);
    }
  };

  const stop = async (d: Deal) => {
    if (!window.confirm(`Stop the link for ${d.id}? The customer won't be able to order with it.`)) return;
    const { ok, data } = await postJson<{ deal?: Deal; message?: string }>(`/api/admin/deals/${encodeURIComponent(d.id)}`, { action: 'cancel' });
    if (!ok) window.alert(data.message || 'Not stopped. Please try again.');
    void load();
  };

  const savePage = async (patch: Partial<NonNullable<typeof page>>) => {
    if (!page) return;
    const before = page;
    setPage({ ...page, ...patch });
    setPageNote('');
    const { ok, data } = await sendJson<{ message?: string }>('PUT', '/api/admin/settings/store', { settings: patch });
    if (!ok) {
      setPage(before);
      setPageNote(data.message || 'Not saved. Please try again.');
    } else setPageNote('Saved.');
  };
  const pageLink = typeof window === 'undefined' ? '/order-by-photo' : `${window.location.origin}/order-by-photo`;

  const field = 'w-full min-w-0 px-3 py-2 min-h-11 rounded-xl border border-line-strong bg-surface text-ink text-sm focus:outline-none focus:ring-2 focus:ring-gold';
  const pick = 'min-h-11 rounded-xl border border-ink bg-surface text-ink text-sm font-semibold flex items-center justify-center gap-2 cursor-pointer focus-within:ring-2 focus-within:ring-gold';
  const small = 'min-h-9 px-2.5 rounded-lg border border-line-strong bg-surface text-ink text-xs font-semibold inline-flex items-center gap-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold';
  const shareButtons = (d: Deal) =>
    d.url && (
      <>
        <a href={`https://wa.me/?text=${encodeURIComponent(message(d))}`} target="_blank" rel="noopener noreferrer" className={`${small} !bg-success !text-paper !border-success`}>
          <MessageCircle className="w-4 h-4" aria-hidden="true" /> Send on WhatsApp
        </a>
        <button type="button" className={small} onClick={() => void copy(d, 'link')}>
          <Copy className="w-4 h-4" aria-hidden="true" /> {copied === `${d.id}:link` ? 'Copied' : 'Copy link'}
        </button>
      </>
    );

  return (
    <section aria-labelledby={`${id}-title`} data-testid="photo-deals" className="rounded-2xl border border-line bg-surface p-3 sm:p-4 space-y-3 min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`${id}-title`} className="text-sm font-bold text-ink flex items-center gap-1.5">
          <Link2 className="w-4 h-4 text-gold-deep" aria-hidden="true" /> Orders from a photo
        </h2>
        <button type="button" onClick={() => { setOpen((v) => !v); setMade(null); reset(); }} aria-expanded={open} className="min-h-11 px-3 rounded-xl bg-ink text-paper text-xs font-bold inline-flex items-center gap-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold">
          {open ? <X className="w-4 h-4" aria-hidden="true" /> : <Plus className="w-4 h-4" aria-hidden="true" />} {open ? 'Close' : 'New photo deal'}
        </button>
      </div>
      <p className="text-xs text-ink-soft"><strong className="text-ink">Your deal links:</strong> for a piece agreed on WhatsApp, add its pictures and your price with delivery, then send the link. The customer sees the pictures and the fixed price, adds their address and pays. They can&rsquo;t change the price.</p>

      {page && (
        <details className="rounded-xl border border-line bg-ivory p-3 text-xs" data-testid="photo-page-settings">
          <summary className="min-h-9 flex items-center cursor-pointer font-semibold text-ink">
            Customer upload page: {page.photoOrders ? 'on' : 'off'}
          </summary>
          <div className="mt-2 space-y-2">
            <p className="text-ink-soft">The customer adds their own photos and the amount you agreed; you check it with &ldquo;Confirm amount&rdquo; on the order.</p>
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-0.5" checked={page.photoOrders} onChange={(e) => void savePage({ photoOrders: e.target.checked })} />
              <span>Take orders from the customer&rsquo;s own photos {!page.whatsappNumber && <span className="text-ink-muted">(set the shop&rsquo;s WhatsApp in Settings first)</span>}</span>
            </label>
            {page.photoOrders && (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <code className="min-w-0 break-all rounded-lg bg-surface px-2 py-1 text-ink" data-testid="photo-page-link">{pageLink}</code>
                  <button type="button" className={small} onClick={() => void navigator.clipboard?.writeText(pageLink).then(() => setPageNote('Link copied.'))}>
                    <Copy className="w-4 h-4" aria-hidden="true" /> Copy link
                  </button>
                </div>
                <label className="flex items-start gap-2">
                  <input type="checkbox" className="mt-0.5" checked={page.photoOrdersOnHome} onChange={(e) => void savePage({ photoOrdersOnHome: e.target.checked })} />
                  <span>Show its banner on the home page</span>
                </label>
                <label className="flex items-start gap-2">
                  <input type="checkbox" className="mt-0.5" checked={page.photoOrdersCard !== false} onChange={(e) => void savePage({ photoOrdersCard: e.target.checked })} />
                  <span>Card payment on this page <span className="text-ink-muted">(off: cash on delivery or bank transfer, so you check the amount first)</span></span>
                </label>
              </>
            )}
            {pageNote && <p role="status" className="text-ink-soft">{pageNote}</p>}
          </div>
        </details>
      )}

      {made?.url && (
        <div role="status" data-testid="deal-made" className="rounded-xl border border-success-line bg-success-soft p-3 space-y-2 text-xs">
          <p className="font-semibold text-success">Link ready for {made.forWhom || made.id}: AED {made.amount}, delivery included.</p>
          <code className="block min-w-0 break-all rounded-lg bg-surface px-2 py-1 text-ink" data-testid="deal-link">{made.url}</code>
          <div className="flex flex-wrap gap-2">{shareButtons(made)}</div>
        </div>
      )}

      {open && (
        <form onSubmit={create} className="space-y-3 border-t border-line pt-3" data-testid="deal-form">
          {editing && (
            <p className="text-xs font-semibold text-ink" data-testid="deal-editing">
              Editing {editing.forWhom || editing.id}: the link stays the same. A customer who already opened it sees the new details when they reload.
            </p>
          )}
          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold text-ink">
              Pictures <span className="font-normal text-ink-soft">(1 to {LIMITS.maxPhotos}: the whole piece, a close-up of the print, how it looks on the bed)</span>
            </legend>
            {photos.length + keep.length > 0 && (
              <ul className="flex flex-wrap gap-2" data-testid="deal-form-photos">
                {editing &&
                  keep.map((n) => (
                    <li key={`kept-${n}`} className="relative w-20">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={`/api/admin/deals/${encodeURIComponent(editing.id)}/photos/${n}`} alt={`Picture ${n}`} className="w-20 h-20 object-cover rounded-xl border border-line" />
                      <button type="button" onClick={() => setKeep((list) => list.filter((x) => x !== n))} className="absolute -top-2 -right-2 w-8 h-8 rounded-full bg-surface border border-line-strong flex items-center justify-center" aria-label={`Remove picture ${n}`}>
                        <X className="w-4 h-4" aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                {photos.map((src, i) => (
                  <li key={i} className="relative w-20">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={src} alt={`New picture ${i + 1}`} className="w-20 h-20 object-cover rounded-xl border border-line" />
                    <button type="button" onClick={() => setPhotos((list) => list.filter((_, j) => j !== i))} className="absolute -top-2 -right-2 w-8 h-8 rounded-full bg-surface border border-line-strong flex items-center justify-center" aria-label={`Remove new picture ${i + 1}`}>
                      <X className="w-4 h-4" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {preparing > 0 && (
              <p role="status" className="text-xs text-ink-soft flex items-center gap-1.5">
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> Preparing the picture…
              </p>
            )}
            {photos.length + keep.length < LIMITS.maxPhotos && (
              <div className="grid grid-cols-2 gap-2 max-w-sm">
                <label className={pick}>
                  <Camera className="w-4 h-4" aria-hidden="true" /> Camera
                  <input type="file" accept="image/*" capture="environment" className="sr-only" aria-label="Take a picture with the camera" onChange={(e) => { void add(e.target.files); e.target.value = ''; }} />
                </label>
                <label className={pick}>
                  <ImagePlus className="w-4 h-4" aria-hidden="true" /> Gallery
                  <input type="file" accept="image/*" multiple className="sr-only" aria-label="Choose pictures from the gallery" data-testid="deal-file" onChange={(e) => { void add(e.target.files); e.target.value = ''; }} />
                </label>
              </div>
            )}
          </fieldset>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="sm:col-span-2">
              <label htmlFor={`${id}-note`} className="block text-xs font-semibold text-ink mb-1">What it is <span className="font-normal text-ink-soft">(the customer sees this)</span></label>
              <textarea id={`${id}-note`} className={`${field} min-h-[4rem]`} maxLength={LIMITS.noteMax} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. King bedsheet set, blue block print, 2 pillow covers" />
            </div>
            <div>
              <label htmlFor={`${id}-for`} className="block text-xs font-semibold text-ink mb-1">For <span className="font-normal text-ink-soft">(optional, only you see it)</span></label>
              <input id={`${id}-for`} className={field} maxLength={LIMITS.forMax} value={forWhom} onChange={(e) => setForWhom(e.target.value)} placeholder="e.g. Fatima, Marina" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor={`${id}-pieces`} className="block text-xs font-semibold text-ink mb-1">Pieces</label>
                <input id={`${id}-pieces`} className={field} type="number" inputMode="numeric" min={1} max={LIMITS.maxPieces} step={1} value={pieces} onChange={(e) => setPieces(e.target.value)} required />
              </div>
              <div>
                <label htmlFor={`${id}-days`} className="block text-xs font-semibold text-ink mb-1">Link works (days)</label>
                <input id={`${id}-days`} className={field} type="number" inputMode="numeric" min={1} max={LIMITS.maxDays} step={1} value={days} onChange={(e) => setDays(e.target.value)} required />
              </div>
            </div>
            <div>
              <label htmlFor={`${id}-amount`} className="block text-xs font-semibold text-ink mb-1">Price with delivery (AED)</label>
              <input id={`${id}-amount`} className={field} type="number" inputMode="decimal" min={1} max={LIMITS.maxAmount} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 350" required />
            </div>
            <fieldset>
              <legend className="block text-xs font-semibold text-ink mb-1">The customer may pay by</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {PAYS.map((p) => (
                  <label key={p.id} className="inline-flex items-center gap-2 min-h-11 text-sm text-ink">
                    <input type="checkbox" checked={pays.includes(p.id)} onChange={(e) => setPays((list) => (e.target.checked ? [...list, p.id] : list.filter((x) => x !== p.id)))} />
                    {p.label}
                  </label>
                ))}
              </div>
              <p className="text-[11px] text-ink-muted">Card and bank transfer show only while they are set up in Settings → Payments. A card fee set there is added at checkout.</p>
            </fieldset>
          </div>
          {error && (
            <p role="alert" className="text-xs font-semibold text-danger">
              {error}
            </p>
          )}
          <button type="submit" disabled={busy || preparing > 0} className="w-full sm:w-auto min-h-11 px-4 rounded-xl bg-ink text-paper text-sm font-bold inline-flex items-center justify-center gap-2 disabled:opacity-50">
            {busy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />} {editing ? 'Save changes' : 'Make the link'}
          </button>
        </form>
      )}

      {deals && deals.length > 0 && (
        <ul className="divide-y divide-line border-t border-line" data-testid="deal-list">
          {deals.slice(0, limit ?? deals.length).map((d) => (
            <li key={d.id} className="py-2 flex items-start gap-2.5 text-xs min-w-0">
              {d.photos > 0 && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`/api/admin/deals/${encodeURIComponent(d.id)}/photos/1`} alt="" className="w-12 h-12 object-cover rounded-lg border border-line shrink-0" loading="lazy" />
              )}
              <div className="min-w-0 flex-1 space-y-1">
                <p className="flex flex-wrap items-center gap-2">
                  <strong className="text-ink">{d.forWhom || d.id}</strong>
                  <span className={`px-2 py-0.5 rounded-full border text-[11px] font-semibold ${STATE[d.state].cls}`}>{STATE[d.state].text}</span>
                </p>
                <p className="text-ink-soft break-anywhere">
                  AED {d.amount} · {d.pieces} {d.pieces === 1 ? 'piece' : 'pieces'} · {d.photos} {d.photos === 1 ? 'picture' : 'pictures'}
                  {d.note ? ` · ${d.note.length > 50 ? `${d.note.slice(0, 49)}…` : d.note}` : ''}
                  {d.orderId ? ` · order ${d.orderId}` : d.state === 'open' ? ` · until ${new Date(d.expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''}
                </p>
                {(d.state === 'open' || d.state === 'expired') && (
                  <div className="flex flex-wrap gap-1.5">
                    {shareButtons(d)}
                    <button type="button" className={small} onClick={() => edit(d)} data-testid="deal-edit">
                      <Pencil className="w-4 h-4" aria-hidden="true" /> Edit
                    </button>
                    <button type="button" className={small} onClick={() => void stop(d)}>
                      <X className="w-4 h-4" aria-hidden="true" /> Stop link
                    </button>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {limit !== undefined && deals && deals.length > limit && onShowAll && (
        <button type="button" onClick={onShowAll} data-testid="deal-see-all" className="min-h-10 text-xs font-semibold text-ink underline focus:outline-none focus-visible:ring-2 focus-visible:ring-gold rounded">
          See all {deals.length} photo deal links in Photo orders
        </button>
      )}
    </section>
  );
}
