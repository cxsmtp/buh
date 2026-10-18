'use client';

import React, { useState } from 'react';
import { CheckCircle2, ChevronRight, MessageCircle, Phone, Send, XCircle } from 'lucide-react';
import type { Order } from '@/types';
import { getJson, postJson } from '@/lib/apiClient';
import { safeFirstName } from '@/lib/bankMessages';
import { askToConfirmMessage, confirmedReply, timeLeft, waMeLink } from '@/lib/whatsappConfirm';
import { normalizePhoneNumber } from '@/lib/phoneNumber';

/** True while an order still needs the customer's WhatsApp message (and is not cancelled). */
export function awaitingWhatsApp(order: Order): boolean {
  return (order.whatsappCheck?.status === 'awaiting' || order.whatsappCheck?.status === 'mismatch' || order.attention?.kind === 'call_customer') && order.status !== 'cancelled';
}

/** Held by Settings → Store & contact "Hold orders until confirmed on WhatsApp". */
export function heldForWhatsApp(order: Order): boolean {
  return Boolean(order.whatsappCheck?.hold && order.whatsappCheck.status !== 'confirmed' && order.status !== 'cancelled');
}

const when = (iso?: string) => (iso ? new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

type Answer = 'confirmed' | 'mismatch' | 'call' | 'use_sender' | 'correct_phone';

/**
 * The order's confirmation, for the owner's phone first: the code and the phone number to compare
 * with the WhatsApp sender, when an unconfirmed order is cancelled (Settings → Phone check), and
 * the big buttons: "Confirmed on WhatsApp", "Number didn't match", "Confirmed by phone call", and,
 * after a mismatch, "Use the number it came from". An "Ask to confirm" message to the customer's
 * WhatsApp. The server looks the order up, checks the number, audits the tap and ignores a second
 * one. After confirming, a one-tap reply to the customer.
 */
export function OrderWhatsAppCheck({ order, onOrderChanged, shopName }: { order: Order; onOrderChanged: (order: Order) => void; shopName?: string }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [sender, setSender] = useState('');
  const [correction, setCorrection] = useState('');
  const check = order.whatsappCheck;
  const callOnly = !check && order.attention?.kind === 'call_customer';
  if (!check && !callOnly) return null;

  const answer = async (result: Answer) => {
    const typed = (result === 'correct_phone' ? correction : sender).trim();
    // The number exactly as the server will store it (same rules; the server checks it again).
    const shown = normalizePhoneNumber(typed);
    if (result === 'use_sender' && !window.confirm(`Change the phone number on ${order.id} from ${order.customer.phone} to ${shown}, and mark it confirmed? The old number stays in the order's history.`)) return;
    if (result === 'correct_phone' && !window.confirm(`Correct the phone number on ${order.id} from ${order.customer.phone} to ${shown}? The old number stays in the order's history (and still finds the order in Track Order).`)) return;
    setBusy(true);
    setProblem('');
    const { ok, data } = await postJson<{ order?: Order; message?: string }>(`/api/admin/orders/${encodeURIComponent(order.id)}/whatsapp`, result === 'use_sender' || result === 'correct_phone' ? { result, phone: typed } : { result });
    setBusy(false);
    if (ok && data.order) {
      setSender('');
      setCorrection('');
      onOrderChanged(data.order);
    } else setProblem(data.message || 'Not saved. Please try again.');
  };

  const reply = waMeLink(order.customer.phone, confirmedReply(order.id));
  const ask = waMeLink(order.customer.phone, askToConfirmMessage(order.id, safeFirstName(order.customer.fullName), shopName));
  const button = 'min-h-11 px-3 py-2 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold';
  const status = check?.status ?? 'awaiting';
  const open = status !== 'confirmed' && order.status !== 'cancelled';
  const byCall = check?.method === 'call';

  return (
    <div data-testid="whatsapp-check" className={`rounded-xl border p-3 space-y-2 text-xs ${status === 'confirmed' ? 'border-success-line bg-success-soft/50' : status === 'mismatch' ? 'border-danger-line bg-danger-soft/60' : 'border-warning-line bg-warning-soft/60'}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {byCall || callOnly ? <Phone className="w-4 h-4 text-ink-soft shrink-0" aria-hidden="true" /> : <MessageCircle className="w-4 h-4 text-whatsapp shrink-0" aria-hidden="true" />}
        {callOnly && <strong className="text-warning">Not confirmed: no WhatsApp number set — call the customer</strong>}
        {check && status === 'awaiting' && (
          <strong className="text-warning">
            Awaiting WhatsApp
            {check.openBy && order.status !== 'cancelled'
              ? ` — auto-cancels in ${timeLeft(check.openBy)} unless the customer opens WhatsApp`
              : check.cancelAt && order.status !== 'cancelled'
                ? ` — auto-cancels in ${timeLeft(check.cancelAt)}`
                : ' confirmation'}{' '}
            · code <span className="font-mono text-sm">{check.code}</span>
          </strong>
        )}
        {check && status === 'confirmed' && (
          <strong className="text-success">
            {byCall ? 'Confirmed by phone call' : 'Confirmed on WhatsApp'}
            {check.checkedBy ? ` by ${check.checkedBy}` : ''}
            {check.checkedAt ? ` at ${when(check.checkedAt)}` : ''}
          </strong>
        )}
        {check && status === 'mismatch' && (
          <strong className="text-danger">
            Number didn&apos;t match · code <span className="font-mono">{check.code}</span>
            {check.checkedAt ? ` (${when(check.checkedAt)})` : ''}
            {check.cancelAt && order.status !== 'cancelled' ? ` — auto-cancels in ${timeLeft(check.cancelAt)}` : ''}
          </strong>
        )}
        {heldForWhatsApp(order) && <span className="px-1.5 py-0.5 rounded-full bg-surface border border-warning-line text-warning font-bold text-[10px] uppercase tracking-wider">Held</span>}
      </div>
      <p className="text-ink-soft">
        Order phone: <a href={`tel:${order.customer.phone}`} className="font-mono font-bold text-ink text-sm">{order.customer.phone}</a>
        {check && status !== 'confirmed' && <span className="block text-ink-muted">The message &ldquo;Confirm my order {order.id} · code {check.code}&rdquo; should come from this number.</span>}
        {check?.openedAt && status === 'awaiting' && <span className="block text-ink-muted">Customer opened WhatsApp at {when(check.openedAt)}.</span>}
      </p>
      {open && (
        <div className="grid grid-cols-1 min-[380px]:grid-cols-2 gap-2">
          {check && (
            <button type="button" disabled={busy} onClick={() => void answer('confirmed')} className={`${button} bg-success text-white`}>
              <CheckCircle2 className="w-4 h-4" aria-hidden="true" /> Confirmed on WhatsApp
            </button>
          )}
          {check && status === 'awaiting' && (
            <button type="button" disabled={busy} onClick={() => void answer('mismatch')} className={`${button} bg-surface text-danger border border-danger-line`}>
              <XCircle className="w-4 h-4" aria-hidden="true" /> Number didn&apos;t match
            </button>
          )}
          <button type="button" disabled={busy} onClick={() => void answer('call')} className={`${button} bg-surface text-ink border border-line-strong`}>
            <Phone className="w-4 h-4" aria-hidden="true" /> Confirmed by phone call
          </button>
          {ask && (
            <a href={ask} target="_blank" rel="noopener noreferrer" className={`${button} bg-whatsapp text-white`}>
              <Send className="w-4 h-4" aria-hidden="true" /> Ask to confirm
            </a>
          )}
        </div>
      )}
      {open && status === 'mismatch' && (
        <form
          className="flex flex-col min-[380px]:flex-row gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (sender.trim()) void answer('use_sender');
          }}
        >
          <label className="sr-only" htmlFor={`sender-${order.id}`}>Number the message came from</label>
          <input
            id={`sender-${order.id}`}
            type="tel"
            inputMode="tel"
            maxLength={20}
            placeholder="Number it came from, e.g. 050 123 4567"
            value={sender}
            onChange={(e) => setSender(e.target.value)}
            className="flex-1 min-w-0 px-3 py-2 rounded-xl border border-line-strong bg-surface text-ink text-xs focus:outline-none focus:ring-2 focus:ring-gold"
          />
          <button type="submit" disabled={busy || !sender.trim()} className={`${button} bg-ink text-white`}>
            Use the number it came from
          </button>
        </form>
      )}
      {status === 'confirmed' && order.status !== 'cancelled' && order.status !== 'delivered' && (
        <details className="text-ink-soft">
          <summary className="min-h-9 flex items-center cursor-pointer font-semibold">Correct the phone number</summary>
          <form
            className="mt-1 flex flex-col min-[380px]:flex-row gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (correction.trim()) void answer('correct_phone');
            }}
          >
            <label className="sr-only" htmlFor={`correct-${order.id}`}>The correct phone number</label>
            <input
              id={`correct-${order.id}`}
              type="tel"
              inputMode="tel"
              maxLength={20}
              placeholder="Correct number, e.g. 050 123 4567"
              value={correction}
              onChange={(e) => setCorrection(e.target.value)}
              className="flex-1 min-w-0 px-3 py-2 rounded-xl border border-line-strong bg-surface text-ink text-xs focus:outline-none focus:ring-2 focus:ring-gold"
            />
            <button type="submit" disabled={busy || !correction.trim()} className={`${button} bg-ink text-white`}>
              Save the number
            </button>
          </form>
        </details>
      )}
      {status === 'confirmed' && reply && (
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
    case 'phone_call_confirmed':
      return `Confirmed by phone call by ${e.actor}`;
    case 'phone_changed':
      return `Phone ${e.detail?.correction ? 'corrected' : 'changed'} from ${String(e.detail?.from ?? '')} to ${String(e.detail?.to ?? '')} (${e.actor})`;
    case 'ship_unconfirmed':
      return `Shipped without WhatsApp confirmation (${e.actor})`;
    case 'auto_cancelled_unconfirmed':
      return `Cancelled: not confirmed within ${Number(e.detail?.hours) || ''} h (pieces back on sale)`;
    case 'auto_cancelled_unopened':
      return `Cancelled: WhatsApp never opened within ${Number(e.detail?.hours) || ''} h (pieces back on sale)`;
    case 'bank_unconfirmed_flagged':
      return `Bank transfer not confirmed after ${Number(e.detail?.hours) || ''} h: flagged (not cancelled)`;
    case 'bank_email_limited':
      return 'Bank details email not sent: that address (or connection) had enough today';
    case 'auto_cancel_skipped':
      return 'Not auto-cancelled: transfer screenshot or payment in';
    case 'call_customer':
      return 'No WhatsApp number set: call the customer';
    case 'whatsapp_mismatch':
      return `Number didn't match (${e.actor})`;
    case 'bank_link_made':
      return 'Private payment page made (bank details only there)';
    case 'bank_emailed':
      return 'Bank details emailed to the customer';
    case 'bank_email_failed':
      return 'Bank details email failed: send them on WhatsApp';
    case 'transfer_uploaded':
      return `Transfer screenshot uploaded${Number(e.detail?.n) > 1 ? ` (#${Number(e.detail?.n)})` : ''}`;
    case 'bank_paid':
      return `Payment received (${e.actor})`;
    case 'bank_not_received':
      return `Transfer not received yet (${e.actor})`;
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
