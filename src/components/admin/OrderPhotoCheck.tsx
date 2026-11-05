'use client';

import React, { useId, useState } from 'react';
import { Camera, CheckCircle2, Loader2 } from 'lucide-react';
import type { Order } from '@/types';
import { postJson } from '@/lib/apiClient';

/**
 * An order from a photo (Settings → Store & contact → "Order from your photo"): the customer's
 * photos, what they wrote, and the amount they typed (agreed on WhatsApp). "Confirm amount"
 * (corrected if needed) is what lets it be confirmed and booked with the courier; until then the
 * booking buttons say so. Owner only.
 */
export function OrderPhotoCheck({ order, onOrderChanged }: { order: Order; onOrderChanged: (order: Order) => void }) {
  const id = useId();
  const p = order.photoOrder;
  const line = order.items[0];
  const [amount, setAmount] = useState(line ? String(line.totalPrice) : '');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  if (!p || !line) return null;

  // From the owner's photo deal: the price was the owner's, fixed in the link (nothing to confirm).
  const fromDeal = Boolean(p.dealId);
  const closed = fromDeal || order.status === 'cancelled' || order.status === 'delivered' || order.status === 'dispatched' || order.status === 'out_for_delivery';
  // Paid by card: the amount is what Stripe took; only confirming it (the same amount) is possible.
  const byCard = order.paymentMethod === 'online_card';
  const confirm = async () => {
    const value = Number(amount.replace(/,/g, ''));
    if (!Number.isFinite(value) || value <= 0) return setProblem('Type the amount in AED, e.g. 350.');
    if (value !== line.totalPrice && !window.confirm(`Change ${order.id} from AED ${line.totalPrice} to AED ${value}? Tell the customer on WhatsApp.`)) return;
    setBusy(true);
    setProblem('');
    const { ok, data } = await postJson<{ order?: Order; message?: string }>(`/api/admin/orders/${encodeURIComponent(order.id)}/photo-amount`, { amount: value });
    setBusy(false);
    if (ok && data.order) onOrderChanged(data.order);
    else setProblem(data.message || 'Not saved. Please try again.');
  };

  const editor = (
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-0">
            <label htmlFor={`${id}-amount`} className="block text-[11px] font-semibold text-ink-soft mb-1">
              Agreed total, with standard delivery (AED)
            </label>
            <input id={`${id}-amount`} readOnly={byCard} title={byCard ? 'Paid by card: the amount the customer paid' : undefined} type="number" inputMode="decimal" min={1} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-32 min-h-11 px-3 rounded-xl border border-line-strong bg-surface text-ink text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
          </div>
          <button type="button" disabled={busy} onClick={() => void confirm()} className="min-h-11 px-3 py-2 rounded-xl bg-success text-paper text-xs font-bold inline-flex items-center gap-1.5 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <CheckCircle2 className="w-4 h-4" aria-hidden="true" />}
            {p.confirmedAt ? 'Change amount' : 'Confirm amount'}
          </button>
        </div>
  );

  return (
    <div data-testid="photo-order-check" className={`rounded-xl border text-xs ${p.confirmedAt ? 'px-3 py-2 space-y-1.5' : 'p-3 space-y-2'} ${p.confirmedAt ? 'border-success-line bg-success-soft' : 'border-warning-line bg-warning-soft'}`}>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Camera className="w-4 h-4 text-gold-deep shrink-0" aria-hidden="true" />
        <strong className={p.confirmedAt ? 'text-success' : 'text-warning'}>{fromDeal ? `Photo deal ${p.dealId} · your fixed price` : p.confirmedAt ? 'Order from a photo · amount confirmed' : 'Order from a photo · check the photos and confirm the amount'}</strong>
      </p>
      <ul className="flex flex-wrap gap-2">
        {Array.from({ length: p.photos }, (_, i) => {
          const src = `/api/admin/orders/${encodeURIComponent(order.id)}/photos/${i + 1}`;
          return (
            <li key={i}>
              <a href={src} target="_blank" rel="noopener noreferrer" className="block rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-gold" aria-label={`Open photo ${i + 1} of ${order.id}`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={src} alt={fromDeal ? `Picture ${i + 1} of the deal` : `Photo ${i + 1} from the customer`} className={`${p.confirmedAt ? 'w-11 h-11' : 'w-20 h-20'} object-cover rounded-lg border border-line bg-surface`} loading="lazy" />
              </a>
            </li>
          );
        })}
      </ul>
      {p.note && <p className="text-ink break-anywhere">&ldquo;{p.note}&rdquo;</p>}
      <p className="text-ink-soft">
        {p.pieces} {p.pieces === 1 ? 'piece' : 'pieces'} · {fromDeal ? 'your price' : 'the customer typed'} <strong className="text-ink">AED {p.agreedTotal}</strong>
        {p.confirmedAt && !fromDeal && <> · confirmed AED {line.totalPrice}{p.confirmedBy ? ` by ${p.confirmedBy}` : ''} on {new Date(p.confirmedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</>}
      </p>
      {!closed && p.confirmedAt && (
        <details className="text-ink-soft">
          <summary className="min-h-8 inline-flex items-center cursor-pointer font-semibold text-[11px]">Change the amount</summary>
          {editor}
        </details>
      )}
      {!closed && !p.confirmedAt && editor}
      {problem && (
        <p role="alert" className="font-semibold text-danger">
          {problem}
        </p>
      )}
    </div>
  );
}
