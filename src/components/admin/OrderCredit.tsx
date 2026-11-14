'use client';

import React, { useId, useRef, useState } from 'react';
import { ArrowRightLeft, Loader2 } from 'lucide-react';
import type { Order } from '@/types';
import { postJson } from '@/lib/apiClient';
import { dueOnDeliveryFils, heldFils } from '@/lib/orderMoney';

const aed = (f: number) => (f / 100).toFixed(2);

/** Not yet with the courier, delivered or cancelled: what it collects can still change. */
const open = (o: Order) => !['cancelled', 'delivered', 'dispatched', 'out_for_delivery'].includes(o.status) && o.courier.bookingState !== 'booked';

/**
 * A paid order's money moved onto another order instead of a refund (asked by the owner): pick
 * the other order (same customer first) and the amount; this order is cancelled if it isn't yet,
 * and the other collects that much less on delivery. The server checks both orders and audits it.
 * Also lists the moves already made, on both orders. Owner only.
 */
export function OrderCredit({ order, orders, onOrderChanged }: { order: Order; orders: Order[]; onOrderChanged: (order: Order) => void }) {
  const id = useId();
  const held = heldFils(order);
  const movable = held > 0 && order.status !== 'delivered' && order.status !== 'dispatched' && order.status !== 'out_for_delivery' && order.courier.bookingState !== 'booked';
  const targets = orders
    .filter((o) => o.id !== order.id && open(o) && dueOnDeliveryFils(o) > 0)
    .sort((a, b) => Number(b.customer.phone === order.customer.phone) - Number(a.customer.phone === order.customer.phone) || b.createdAt.localeCompare(a.createdAt));
  const [show, setShow] = useState(false);
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  // One key per move asked for (this order, that order, this amount): a second tap or a retry after
  // a lost answer is the same move on the server, never a second one.
  const attempt = useRef<{ what: string; key: string }>({ what: '', key: '' });
  const history = [
    ...(order.creditsOut ?? []).map((c) => `AED ${c.amount.toFixed(2)} moved to ${c.toOrderId}`),
    ...(order.creditsIn ?? []).map((c) => `AED ${c.amount.toFixed(2)} paid on ${c.fromOrderId} (comes off what is collected)`),
  ];
  if (!movable && !history.length) return null;

  const target = targets.find((t) => t.id === to);
  const most = target ? Math.min(held, dueOnDeliveryFils(target)) : held;
  const pick = (value: string) => {
    setTo(value);
    const t = targets.find((x) => x.id === value);
    if (t) setAmount(aed(Math.min(held, dueOnDeliveryFils(t))));
  };
  const move = async () => {
    const value = Number(amount);
    if (!target) return setProblem('Choose the order to use it on.');
    if (!Number.isFinite(value) || value <= 0 || Math.round(value * 100) > most) return setProblem(`Amount: up to AED ${aed(most)}.`);
    const cancelNote = order.status === 'cancelled' ? '' : ` ${order.id} is cancelled (its pieces go back on sale).`;
    if (!window.confirm(`Move AED ${value.toFixed(2)} paid on ${order.id} to ${target.id} (${target.customer.fullName})?${cancelNote} The courier then collects AED ${aed(dueOnDeliveryFils(target) - Math.round(value * 100))} for ${target.id}. No refund is made for this amount.`)) return;
    setBusy(true);
    setProblem('');
    const what = `${target.id}|${Math.round(value * 100)}`;
    if (attempt.current.what !== what) attempt.current = { what, key: crypto.randomUUID() };
    const { ok, data } = await postJson<{ from?: Order; to?: Order; message?: string }>(`/api/admin/orders/${encodeURIComponent(order.id)}/credit`, { toOrderId: target.id, amount: Math.round(value * 100) / 100, key: attempt.current.key });
    setBusy(false);
    if (!ok || !data.from || !data.to) return setProblem(data.message || 'Not moved. Please try again.');
    attempt.current = { what: '', key: '' };
    onOrderChanged(data.from);
    onOrderChanged(data.to);
    setShow(false);
    setTo('');
  };

  const field = 'w-full min-w-0 min-h-10 px-3 rounded-xl border border-line-strong bg-surface text-ink text-xs focus:outline-none focus:ring-2 focus:ring-gold';
  // Nothing to do (no open order to use it on, nothing moved yet): no box at all.
  if (movable && !targets.length && !history.length) return null;
  return (
    <div data-testid="order-credit" className={`rounded-xl border border-line bg-ivory text-[11px] min-w-0 ${show ? 'p-3 space-y-2' : 'px-2.5 py-1.5 flex flex-wrap items-center gap-x-2 gap-y-1'}`}>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <ArrowRightLeft className="w-3.5 h-3.5 text-gold-deep shrink-0" aria-hidden="true" />
        {movable ? <strong className="text-ink">AED {aed(held)} paid on this order can be used on another order</strong> : <strong className="text-ink">Payment moved</strong>}
      </p>
      {history.length > 0 && (
        <ul className="text-ink-soft space-y-0.5" data-testid="credit-history">
          {history.map((h) => (
            <li key={h}>{h}</li>
          ))}
        </ul>
      )}
      {movable && !show && (
        <button type="button" onClick={() => setShow(true)} disabled={!targets.length} className="min-h-8 px-2 rounded-lg border border-line-strong bg-surface text-ink font-semibold disabled:opacity-50 ml-auto" title={targets.length ? undefined : 'No open order with something to collect on delivery'}>
          Use it on another order
        </button>
      )}
      {movable && !targets.length && <p className="text-ink-muted">No open order has anything to collect on delivery. Use it on an order before it is booked with the courier.</p>}
      {movable && show && (
        <div className="grid grid-cols-1 min-[420px]:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_auto] gap-2 items-end">
          <div className="min-w-0">
            <label htmlFor={`${id}-to`} className="block text-[11px] font-semibold text-ink-soft mb-1">Use it on</label>
            <select id={`${id}-to`} className={field} value={to} onChange={(e) => pick(e.target.value)}>
              <option value="">Choose an order…</option>
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.id} · {t.customer.fullName}
                  {t.customer.phone === order.customer.phone ? ' (same customer)' : ''} · collects AED {aed(dueOnDeliveryFils(t))}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={`${id}-amount`} className="block text-[11px] font-semibold text-ink-soft mb-1">Amount (AED)</label>
            <input id={`${id}-amount`} className={field} type="number" inputMode="decimal" min={0.01} step="0.01" max={most / 100} value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <button type="button" disabled={busy} onClick={() => void move()} className="min-h-10 px-3 rounded-lg bg-ink text-paper font-semibold inline-flex items-center justify-center gap-1.5 disabled:opacity-50">
            {busy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />} Move
          </button>
        </div>
      )}
      {problem && (
        <p role="alert" className="text-danger font-semibold break-anywhere">
          {problem}
        </p>
      )}
    </div>
  );
}
