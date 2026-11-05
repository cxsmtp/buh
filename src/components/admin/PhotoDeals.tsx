'use client';

import React, { useCallback, useEffect, useId, useState } from 'react';
import { Camera, Copy, ImagePlus, Link2, Loader2, MessageCircle, Plus, X } from 'lucide-react';
import { getJson, postJson } from '@/lib/apiClient';
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

const message = (d: Pick<Deal, 'amount' | 'url'>) => `Here is your order: AED ${d.amount}, delivery included. See the pictures, add your address and pay here: ${d.url}`;

/**
 * Orders → Photo deals: the owner's own "order from a photo". Pictures (up to 12), what it is, the
 * fixed price with delivery, the ways the customer may pay and how long the link works; then a
 * private link to send on WhatsApp. The customer can't change the price. Owner only.
 */
export function PhotoDeals() {
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
  const [copied, setCopied] = useState('');

  const load = useCallback(async () => {
    const { ok, data } = await getJson<{ deals?: Deal[] }>('/api/admin/deals');
    if (ok && data.deals) setDeals(data.deals);
  }, []);
  useEffect(() => {
    let alive = true;
    void getJson<{ deals?: Deal[] }>('/api/admin/deals').then(({ ok, data }) => {
      if (alive && ok && data.deals) setDeals(data.deals);
    });
    return () => {
      alive = false;
    };
  }, []);

  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    setError('');
    const room = LIMITS.maxPhotos - photos.length;
    const picked = Array.from(files).slice(0, Math.max(0, room));
    if (files.length > room) setError(`At most ${LIMITS.maxPhotos} pictures.`);
    setPreparing((n) => n + picked.length);
    for (const file of picked) {
      try {
        const url = await shrinkPhoto(file, 1400, PHOTO_URL_MAX);
        setPhotos((list) => (list.length < LIMITS.maxPhotos ? [...list, url] : list));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'This picture could not be read. Please try another one.');
      } finally {
        setPreparing((n) => n - 1);
      }
    }
  };

  const reset = () => {
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
    if (!photos.length) return setError('Add at least one picture.');
    if (!Number.isFinite(price) || price < 1 || price > LIMITS.maxAmount) return setError(`Price: from AED 1 to AED ${LIMITS.maxAmount.toLocaleString('en-US')}.`);
    if (!pays.length) return setError('Choose at least one way to pay.');
    setBusy(true);
    setError('');
    const { ok, data } = await postJson<{ deal?: Deal; message?: string }>('/api/admin/deals', {
      photos,
      note: note.trim(),
      forWhom: forWhom.trim(),
      pieces: Number(pieces),
      amount: Math.round(price * 100) / 100,
      payments: pays,
      days: Number(days),
    });
    setBusy(false);
    if (!ok || !data.deal) return setError(data.message || 'Not saved. Please try again.');
    setMade(data.deal);
    reset();
    void load();
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

  const field = 'w-full min-w-0 px-3 py-2 min-h-11 rounded-xl border border-line-strong bg-surface text-ink text-sm focus:outline-none focus:ring-2 focus:ring-gold';
  const pick = 'min-h-11 rounded-xl border border-ink bg-surface text-ink text-sm font-semibold flex items-center justify-center gap-2 cursor-pointer focus-within:ring-2 focus-within:ring-gold';
  const small = 'min-h-10 px-3 rounded-lg border border-line-strong bg-surface text-ink text-xs font-semibold inline-flex items-center gap-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold';
  const shareButtons = (d: Deal) =>
    d.url && (
      <div className="flex flex-wrap gap-2">
        <a href={`https://wa.me/?text=${encodeURIComponent(message(d))}`} target="_blank" rel="noopener noreferrer" className={`${small} !bg-success !text-paper !border-success`}>
          <MessageCircle className="w-4 h-4" aria-hidden="true" /> Send on WhatsApp
        </a>
        <button type="button" className={small} onClick={() => void copy(d, 'link')}>
          <Copy className="w-4 h-4" aria-hidden="true" /> {copied === `${d.id}:link` ? 'Copied' : 'Copy link'}
        </button>
      </div>
    );

  return (
    <section aria-labelledby={`${id}-title`} data-testid="photo-deals" className="rounded-2xl border border-line bg-surface p-3 sm:p-4 space-y-3 min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`${id}-title`} className="text-sm font-bold text-ink flex items-center gap-1.5">
          <Link2 className="w-4 h-4 text-gold-deep" aria-hidden="true" /> Photo deals
        </h2>
        <button type="button" onClick={() => { setOpen((v) => !v); setMade(null); }} aria-expanded={open} className="min-h-11 px-3 rounded-xl bg-ink text-paper text-xs font-bold inline-flex items-center gap-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold">
          {open ? <X className="w-4 h-4" aria-hidden="true" /> : <Plus className="w-4 h-4" aria-hidden="true" />} {open ? 'Close' : 'New photo deal'}
        </button>
      </div>
      <p className="text-xs text-ink-soft">For a piece agreed on WhatsApp: add its pictures and your price with delivery, then send the link. The customer sees the pictures and the fixed price, adds their address and pays. They can&rsquo;t change the price.</p>

      {made?.url && (
        <div role="status" data-testid="deal-made" className="rounded-xl border border-success-line bg-success-soft p-3 space-y-2 text-xs">
          <p className="font-semibold text-success">Link ready for {made.forWhom || made.id}: AED {made.amount}, delivery included.</p>
          <code className="block min-w-0 break-all rounded-lg bg-surface px-2 py-1 text-ink" data-testid="deal-link">{made.url}</code>
          {shareButtons(made)}
        </div>
      )}

      {open && (
        <form onSubmit={create} className="space-y-3 border-t border-line pt-3" data-testid="deal-form">
          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold text-ink">
              Pictures <span className="font-normal text-ink-soft">(1 to {LIMITS.maxPhotos}: the whole piece, a close-up of the print, how it looks on the bed)</span>
            </legend>
            {photos.length > 0 && (
              <ul className="flex flex-wrap gap-2" data-testid="deal-form-photos">
                {photos.map((src, i) => (
                  <li key={i} className="relative w-20">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={src} alt={`Picture ${i + 1}`} className="w-20 h-20 object-cover rounded-xl border border-line" />
                    <button type="button" onClick={() => setPhotos((list) => list.filter((_, j) => j !== i))} className="absolute -top-2 -right-2 w-8 h-8 rounded-full bg-surface border border-line-strong flex items-center justify-center" aria-label={`Remove picture ${i + 1}`}>
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
            {photos.length < LIMITS.maxPhotos && (
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
            {busy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />} Make the link
          </button>
        </form>
      )}

      {deals && deals.length > 0 && (
        <ul className="divide-y divide-line border-t border-line" data-testid="deal-list">
          {deals.slice(0, 10).map((d) => (
            <li key={d.id} className="py-2.5 flex flex-wrap items-start gap-3 text-xs min-w-0">
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
                {d.state === 'open' && (
                  <div className="flex flex-wrap gap-2">
                    {shareButtons(d)}
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
    </section>
  );
}
