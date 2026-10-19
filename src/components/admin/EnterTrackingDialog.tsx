'use client';

import React, { useEffect, useRef, useState } from 'react';
import type { Order } from '@/types';
import { X } from 'lucide-react';
import { postJson } from '@/lib/apiClient';

type Carrier = 'jeebly' | 'echo' | 'other';

/**
 * "Enter tracking number": the owner booked the parcel in the courier's own portal (Jeebly, Eco
 * Express or another courier) and types the real AWB in. The server checks it, audits it, and the
 * customer's Track Order then shows it (POST /api/admin/orders/[id]/tracking).
 */
export function EnterTrackingDialog({ order, onClose, onSaved }: { order: Order; onClose: () => void; onSaved: (order: Order) => void }) {
  const c = order.courier;
  const [carrier, setCarrier] = useState<Carrier>(c.provider === 'manual' ? 'other' : c.provider);
  const [carrierName, setCarrierName] = useState(c.provider === 'manual' ? c.carrierName || '' : '');
  const [awb, setAwb] = useState(c.simulated ? '' : c.awbNumber);
  const [trackingUrl, setTrackingUrl] = useState(c.simulated ? '' : c.trackingUrl);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const first = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const awbOk = /^[A-Za-z0-9-]{4,40}$/.test(awb.trim());

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!awbOk) return setError('The tracking number is 4 to 40 letters, digits or dashes.');
    setSaving(true);
    setError('');
    const body: Record<string, unknown> = { carrier, awb: awb.trim(), ...(carrier === 'other' ? { carrierName: carrierName.trim() } : {}), ...(trackingUrl.trim() ? { trackingUrl: trackingUrl.trim() } : {}) };
    const url = `/api/admin/orders/${encodeURIComponent(order.id)}/tracking`;
    let { ok, data } = await postJson<{ order?: Order; message?: string; code?: string }>(url, body);
    // A real booking is already on the order: replaced only on the owner's yes (audited).
    if (!ok && data.code === 'tracking_replace') {
      if (!window.confirm(data.message || 'Replace the tracking number already on this order?')) {
        setSaving(false);
        return;
      }
      ({ ok, data } = await postJson<{ order?: Order; message?: string; code?: string }>(url, { ...body, replace: true }));
    }
    setSaving(false);
    if (ok && data.order) onSaved(data.order);
    else setError(data.message || 'Not saved. Please try again.');
  };

  const field = 'w-full px-3 py-2 rounded-xl border border-line-strong bg-surface text-ink text-xs focus:outline-none focus:ring-2 focus:ring-gold';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/45 p-3 sm:p-4 overscroll-contain" role="dialog" aria-modal="true" aria-labelledby="tracking-title">
      <form onSubmit={submit} className="bg-surface rounded-3xl max-w-md w-full min-w-0 max-h-[calc(100dvh-1.5rem)] overflow-y-auto overflow-x-hidden p-5 border border-line space-y-3 text-xs">
        <div className="flex items-start justify-between gap-2 border-b border-line pb-3">
          <div className="min-w-0">
            <h3 id="tracking-title" className="font-serif text-xl text-ink">Enter tracking number</h3>
            <p className="text-ink-muted">Order {order.id} · booked in the courier&apos;s own portal</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="shrink-0 w-10 h-10 flex items-center justify-center text-ink rounded-full hover:bg-sand focus:outline-none focus-visible:ring-2 focus-visible:ring-gold">
            <X className="w-5 h-5" strokeWidth={1.5} />
          </button>
        </div>
        <p className="text-ink-soft leading-relaxed">
          Type the real AWB the courier gave you (Jeebly or Eco Express portal, or any other courier). The customer then sees it in Track Order.
        </p>
        {c.simulated && <p className="text-warning font-semibold">This replaces the test booking {c.awbNumber}.</p>}
        <label className="block">
          <span className="block font-semibold text-ink-soft mb-1">Courier</span>
          <select ref={first} value={carrier} onChange={(e) => setCarrier(e.target.value as Carrier)} className={field}>
            <option value="jeebly">Jeebly</option>
            <option value="echo">Eco Express</option>
            <option value="other">Another courier</option>
          </select>
        </label>
        {carrier === 'other' && (
          <label className="block">
            <span className="block font-semibold text-ink-soft mb-1">Courier name</span>
            <input value={carrierName} onChange={(e) => setCarrierName(e.target.value)} required minLength={2} maxLength={40} placeholder="e.g. Aramex" className={field} />
          </label>
        )}
        <label className="block">
          <span className="block font-semibold text-ink-soft mb-1">Tracking number (AWB)</span>
          <input value={awb} onChange={(e) => setAwb(e.target.value)} required maxLength={40} autoComplete="off" spellCheck={false} aria-invalid={awb !== '' && !awbOk} className={`${field} font-mono uppercase`} />
        </label>
        <label className="block">
          <span className="block font-semibold text-ink-soft mb-1">Tracking link (optional, https)</span>
          <input type="url" value={trackingUrl} onChange={(e) => setTrackingUrl(e.target.value)} maxLength={500} placeholder="https://…" className={field} />
          <span className="block text-ink-muted mt-1">With a link, the customer sees the courier&apos;s name and a button to its tracking page.</span>
        </label>
        {error && <p role="alert" className="text-danger font-semibold">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-xl border border-line-strong font-semibold text-ink hover:bg-sand focus:outline-none focus-visible:ring-2 focus-visible:ring-gold">
            Cancel
          </button>
          <button type="submit" disabled={saving} className="px-4 py-2 rounded-xl bg-ink text-paper font-semibold disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2">
            {saving ? 'Saving…' : 'Save tracking number'}
          </button>
        </div>
      </form>
    </div>
  );
}
