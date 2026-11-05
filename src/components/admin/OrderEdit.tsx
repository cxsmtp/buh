'use client';

import React, { useId, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import type { Emirate, Order } from '@/types';
import { postJson } from '@/lib/apiClient';
import { UAE_EMIRATES } from '@/data/initialData';

/** Not booked with the courier yet (no label), not cancelled or delivered: it can be edited. Kept in step with the server. */
export function orderEditable(o: Order): boolean {
  return !['cancelled', 'delivered', 'dispatched', 'out_for_delivery'].includes(o.status) && o.courier.bookingState !== 'booked' && o.courier.bookingState !== 'uncertain';
}
/** The amounts can change too (cash on delivery or unpaid transfer, no VAT/invoice/deal). The server checks again. */
export function moneyEditable(o: Order): boolean {
  return o.paymentMethod !== 'online_card' && o.bankTransfer?.state !== 'paid' && !o.invoice && !o.photoOrder?.dealId;
}

/**
 * "Edit order" (asked by the owner: before the label is made, edit all the data if needed): the
 * customer's name, phone, email and address; for a cash (or unpaid transfer) order also each line's
 * quantity and unit price (0 removes a line) and the delivery charge. The server checks every field,
 * moves the stock, works out the totals and audits it; this only sends what was typed.
 */
export function OrderEdit({ order, onClose, onSaved }: { order: Order; onClose: () => void; onSaved: (o: Order) => void }) {
  const id = useId();
  const c = order.customer;
  const [f, setF] = useState({ fullName: c.fullName, phone: c.phone, email: c.email ?? '', emirate: c.emirate, area: c.area, streetAddress: c.streetAddress, buildingVilla: c.buildingVilla, flatVillaNo: c.flatVillaNo, landmark: c.landmark ?? '' });
  const [lines, setLines] = useState(order.items.map((i) => ({ quantity: String(i.quantity), unitPrice: String(i.unitPrice) })));
  const [delivery, setDelivery] = useState(String(order.deliveryFee));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const money = moneyEditable(order);
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));

  const preview = lines.reduce((s, l) => s + Math.round((Number(l.unitPrice) || 0) * 100) * (Number(l.quantity) || 0), 0) + Math.round((Number(delivery) || 0) * 100);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setProblem('');
    const customer: Record<string, string> = {};
    for (const [k, v] of Object.entries(f)) {
      const before = (order.customer as unknown as Record<string, string | undefined>)[k] ?? '';
      if (v.trim() !== before) customer[k] = v.trim();
    }
    const body: Record<string, unknown> = {};
    if (Object.keys(customer).length) body.customer = customer;
    if (money) {
      const changedLines = lines.some((l, i) => Number(l.quantity) !== order.items[i].quantity || Number(l.unitPrice) !== order.items[i].unitPrice);
      if (changedLines) body.lines = lines.map((l) => ({ quantity: Number(l.quantity), unitPrice: Number(l.unitPrice) }));
      if (Number(delivery) !== order.deliveryFee) body.deliveryFee = Number(delivery);
    }
    if (!Object.keys(body).length) return onClose();
    setBusy(true);
    const { ok, data } = await postJson<{ order?: Order; message?: string }>(`/api/admin/orders/${encodeURIComponent(order.id)}/details`, body);
    setBusy(false);
    if (!ok || !data.order) return setProblem(data.message || 'Not saved. Please try again.');
    onSaved(data.order);
    onClose();
  };

  const field = 'w-full min-w-0 min-h-10 px-3 rounded-xl border border-line-strong bg-surface text-ink text-xs focus:outline-none focus:ring-2 focus:ring-gold';
  const label = 'block text-[11px] font-semibold text-ink-soft mb-1';
  const input = (k: keyof typeof f, l: string, opts: { type?: string; max?: number; wide?: boolean } = {}) => (
    <div className={opts.wide ? 'sm:col-span-2' : ''}>
      <label className={label} htmlFor={`${id}-${k}`}>{l}</label>
      <input id={`${id}-${k}`} className={field} type={opts.type ?? 'text'} maxLength={opts.max ?? 120} value={f[k]} onChange={(e) => set(k, e.target.value)} />
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/45 p-3 sm:p-4 overscroll-contain" role="dialog" aria-modal="true" aria-labelledby={`${id}-t`} data-testid="order-edit">
      <form onSubmit={save} className="bg-surface rounded-3xl max-w-xl w-full min-w-0 max-h-[calc(100dvh-1.5rem)] overflow-y-auto overflow-x-hidden px-5 pb-5 border border-line space-y-3 text-xs">
        <div className="sticky top-0 z-10 -mx-5 px-5 pt-4 pb-3 bg-surface flex items-center justify-between gap-3 border-b border-line">
          <h2 id={`${id}-t`} className="font-serif text-xl text-ink">Edit order {order.id}</h2>
          <button type="button" onClick={onClose} aria-label="Close Edit order" className="shrink-0 w-10 h-10 -mr-2 flex items-center justify-center text-ink rounded-full hover:bg-sand">
            <X className="w-5 h-5" />
          </button>
        </div>
        <p className="text-ink-soft">Change anything before the courier label is made. Phone changes keep the old number in the order&rsquo;s history (it still finds the order in Track Order).</p>
        <fieldset className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <legend className="text-sm font-semibold text-ink mb-1">Customer</legend>
          {input('fullName', 'Full name')}
          {input('phone', 'Mobile (UAE)', { type: 'tel', max: 20 })}
          {input('email', 'Email (optional)', { type: 'email', max: 254, wide: true })}
          <div>
            <label className={label} htmlFor={`${id}-emirate`}>Emirate</label>
            <select id={`${id}-emirate`} className={field} value={f.emirate} onChange={(e) => set('emirate', e.target.value as Emirate)}>
              {UAE_EMIRATES.map((e) => (
                <option key={e} value={e}>{e}</option>
              ))}
            </select>
          </div>
          {input('area', 'Area')}
          {input('streetAddress', 'Street address', { max: 200, wide: true })}
          {input('buildingVilla', 'Building / villa')}
          {input('flatVillaNo', 'Flat / villa number', { max: 40 })}
          {input('landmark', 'Landmark (optional)', { max: 200, wide: true })}
        </fieldset>
        <fieldset className="space-y-2">
          <legend className="text-sm font-semibold text-ink mb-1">Items {money ? '' : <span className="font-normal text-ink-muted">(amounts can&rsquo;t change: {order.paymentMethod === 'online_card' ? 'paid by card' : 'paid or invoiced'})</span>}</legend>
          {order.items.map((it, i) => (
            <div key={i} className="grid grid-cols-[minmax(0,1fr)_4.5rem_6rem] gap-2 items-end" data-testid="edit-line">
              <p className="text-ink break-anywhere self-center">{it.title} <span className="text-ink-muted">({it.profileName})</span></p>
              <div>
                <label className={label} htmlFor={`${id}-q${i}`}>Qty</label>
                <input id={`${id}-q${i}`} className={field} type="number" inputMode="numeric" min={0} max={20} disabled={!money || it.productType === 'photo'} value={lines[i].quantity} onChange={(e) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, quantity: e.target.value } : l)))} />
              </div>
              <div>
                <label className={label} htmlFor={`${id}-p${i}`}>Unit AED</label>
                <input id={`${id}-p${i}`} className={field} type="number" inputMode="decimal" min={0} step="0.01" disabled={!money} value={lines[i].unitPrice} onChange={(e) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, unitPrice: e.target.value } : l)))} />
              </div>
            </div>
          ))}
          <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-2 items-end">
            <p className="text-ink self-center">Delivery charge</p>
            <div>
              <label className={label} htmlFor={`${id}-d`}>AED</label>
              <input id={`${id}-d`} className={field} type="number" inputMode="decimal" min={0} step="0.01" disabled={!money} value={delivery} onChange={(e) => setDelivery(e.target.value)} />
            </div>
          </div>
          {money && <p className="text-ink-soft" data-testid="edit-preview">Items and delivery: AED {(preview / 100).toFixed(2)} (the total is worked out on the server, with any fees and extra).</p>}
        </fieldset>
        {problem && (
          <p role="alert" className="text-danger font-semibold break-anywhere">
            {problem}
          </p>
        )}
        <div className="flex gap-2 justify-end">
          <button type="button" onClick={onClose} className="min-h-11 px-4 rounded-xl border border-line-strong bg-surface text-ink font-semibold">Cancel</button>
          <button type="submit" disabled={busy} className="min-h-11 px-4 rounded-xl bg-ink text-paper font-bold inline-flex items-center gap-2 disabled:opacity-50">
            {busy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />} Save changes
          </button>
        </div>
      </form>
    </div>
  );
}
