'use client';

import React, { useState } from 'react';
import { CheckCircle2, ChevronRight, MessageCircle, XCircle } from 'lucide-react';
import type { Order } from '@/types';
import { getJson, postJson } from '@/lib/apiClient';
import { confirmedReply, waMeLink } from '@/lib/whatsappConfirm';

/** True while an order still needs the customer's WhatsApp message (and is not cancelled). */
export function awaitingWhatsApp(order: Order): boolean {
  return order.whatsappCheck?.status === 'awaiting' && order.status !== 'cancelled';
}

/** Held by Settings → Store & contact "Hold orders until confirmed on WhatsApp". */
export function heldForWhatsApp(order: Order): boolean {
  return Boolean(order.whatsappCheck?.hold && order.whatsappCheck.status !== 'confirmed' && order.status !== 'cancelled');
}

const when = (iso?: string) => (iso ? new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

/**
 * The order's "Confirm on WhatsApp" state, for the owner's phone first: the code and the phone
 * number to compare with the WhatsApp sender, and two big buttons. The server looks the order
 * up, audits the tap and ignores a second one. After confirming, a one-tap reply to the customer.
 */
export function OrderWhatsAppCheck({ order, onOrderChanged }: { order: Order; onOrderChanged: (order: Order) => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const check = order.whatsappCheck;
  if (!check) return null;

  const answer = async (result: 'confirmed' | 'mismatch') => {
    setBusy(true);
    setProblem('');
    const { ok, data } = await postJson<{ order?: Order; message?: string }>(`/api/admin/orders/${encodeURIComponent(order.id)}/whatsapp`, { result });
    setBusy(false);
    if (ok && data.order) onOrderChanged(data.order);
    else setProblem(data.message || 'Not saved. Please try again.');
  };

  const reply = waMeLink(order.customer.phone, confirmedReply(order.id));
  const button = 'min-h-11 px-3 py-2 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold';

  return (
    <div className={`rounded-xl border p-3 space-y-2 text-xs ${check.status === 'confirmed' ? 'border-success-line bg-success-soft/50' : check.status === 'mismatch' ? 'border-danger-line bg-danger-soft/60' : 'border-warning-line bg-warning-soft/60'}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <MessageCircle className="w-4 h-4 text-whatsapp shrink-0" aria-hidden="true" />
        {check.status === 'awaiting' && (
          <strong className="text-warning">
            Awaiting WhatsApp confirmation · code <span className="font-mono text-sm">{check.code}</span>
          </strong>
        )}
        {check.status === 'confirmed' && (
          <strong className="text-success">
            Confirmed on WhatsApp{check.checkedBy ? ` by ${check.checkedBy}` : ''}{check.checkedAt ? ` at ${when(check.checkedAt)}` : ''}
          </strong>
        )}
        {check.status === 'mismatch' && (
          <strong className="text-danger">
            Number didn&apos;t match · code <span className="font-mono">{check.code}</span>{check.checkedAt ? ` (${when(check.checkedAt)})` : ''}
          </strong>
        )}
        {heldForWhatsApp(order) && <span className="px-1.5 py-0.5 rounded-full bg-surface border border-warning-line text-warning font-bold text-[10px] uppercase tracking-wider">Held</span>}
      </div>
      <p className="text-ink-soft">
        Order phone: <a href={`tel:${order.customer.phone}`} className="font-mono font-bold text-ink text-sm">{order.customer.phone}</a>
        {check.status !== 'confirmed' && <span className="block text-ink-muted">The message &ldquo;Confirm my order {order.id} · code {check.code}&rdquo; should come from this number.</span>}
        {check.openedAt && check.status === 'awaiting' && <span className="block text-ink-muted">Customer opened WhatsApp at {when(check.openedAt)}.</span>}
      </p>
      {check.status !== 'confirmed' && order.status !== 'cancelled' && (
        <div className="grid grid-cols-1 min-[380px]:grid-cols-2 gap-2">
          <button type="button" disabled={busy} onClick={() => void answer('confirmed')} className={`${button} bg-success text-white`}>
            <CheckCircle2 className="w-4 h-4" aria-hidden="true" /> Confirmed on WhatsApp
          </button>
          {check.status === 'awaiting' && (
            <button type="button" disabled={busy} onClick={() => void answer('mismatch')} className={`${button} bg-surface text-danger border border-danger-line`}>
              <XCircle className="w-4 h-4" aria-hidden="true" /> Number didn&apos;t match
            </button>
          )}
        </div>
      )}
      {check.status === 'confirmed' && reply && (
        <a href={reply} target="_blank" rel="noopener noreferrer" className={`${button} bg-whatsapp text-white w-full min-[380px]:w-auto inline-flex`}>
          <MessageCircle className="w-4 h-4" aria-hidden="true" /> Reply on WhatsApp
        </a>
      )}
      {problem && <p role="alert" className="text-danger font-semibold">{problem}</p>}
    </div>
  );
}

interface OrderEvent {
  at: string;
  actor: string;
  event: string;
  detail: Record<string, unknown> | null;
}

function describe(e: OrderEvent): string {
  switch (e.event) {
    case 'created':
      return 'Order placed';
    case 'whatsapp_asked':
      return 'WhatsApp confirmation asked';
    case 'whatsapp_opened':
      return 'Customer opened WhatsApp';
    case 'whatsapp_confirmed':
      return `Confirmed on WhatsApp by ${e.actor}`;
    case 'whatsapp_mismatch':
      return `Number didn't match (${e.actor})`;
    case 'courier':
      return `Courier: ${String(e.detail?.provider ?? '')} ${String(e.detail?.awb ?? '')}`.trim();
    case 'updated': {
      const s = e.detail?.status as { to?: string } | undefined;
      return s?.to ? `Status: ${s.to.replace(/_/g, ' ')} (${e.actor})` : `Updated by ${e.actor}`;
    }
    default:
      return e.event.replace(/_/g, ' ');
  }
}

/** The order's history (loaded when opened): placed, WhatsApp asked / opened / confirmed, status changes. */
export function OrderTimeline({ orderId }: { orderId: string }) {
  const [events, setEvents] = useState<OrderEvent[] | null>(null);
  const [open, setOpen] = useState(false);
  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next) {
      const { ok, data } = await getJson<{ events?: OrderEvent[] }>(`/api/admin/orders/${encodeURIComponent(orderId)}`);
      setEvents(ok && data.events ? data.events : []);
    }
  };
  return (
    <div className="text-[11px]">
      <button type="button" onClick={() => void toggle()} aria-expanded={open} className="min-h-9 flex items-center gap-1 font-semibold text-ink-soft hover:text-ink">
        <ChevronRight className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true" /> History
      </button>
      {open && (
        <ol className="mt-1 space-y-1 border-l border-line pl-3">
          {events === null ? (
            <li className="text-ink-muted">Loading…</li>
          ) : events.length === 0 ? (
            <li className="text-ink-muted">Nothing recorded.</li>
          ) : (
            events.map((e, i) => (
              <li key={i} className="text-ink-soft">
                <span className="text-ink-muted">{when(e.at)}</span> · {describe(e)}
              </li>
            ))
          )}
        </ol>
      )}
    </div>
  );
}
