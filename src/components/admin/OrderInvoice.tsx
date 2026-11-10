'use client';

import React, { useState } from 'react';
import { Download, FileText, Loader2, Mail, MessageCircle, RefreshCw } from 'lucide-react';
import type { Order } from '@/types';
import { postJson } from '@/lib/apiClient';
import { safeFirstName } from '@/lib/bankMessages';
import { waMeLink } from '@/lib/whatsappConfirm';

type Invoice = NonNullable<Order['invoice']>;

/** Kept in step with the server (src/lib/server/invoices.ts invoiceBlocker). */
export function invoiceReady(order: Order): boolean {
  if (order.status === 'cancelled') return false;
  if (order.photoOrder && !order.photoOrder.confirmedAt) return false;
  return ['confirmed', 'dispatched', 'out_for_delivery', 'delivered'].includes(order.status) || order.whatsappCheck?.status === 'confirmed';
}

const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/**
 * The order's PDF invoice (asked by the owner): once the order is confirmed, "Make invoice" issues
 * it (numbered INV-<year>-…, audited, the same one if tapped again); then download it, email it to
 * the customer with the PDF attached, or send its private link on WhatsApp. Owner only.
 */
export function OrderInvoice({ order, shopName }: { order: Order; shopName?: string }) {
  const [invoice, setInvoice] = useState<Invoice | undefined>(order.invoice);
  const [busy, setBusy] = useState<'' | 'issue' | 'email' | 'regenerate'>('');
  const [problem, setProblem] = useState('');
  const [note, setNote] = useState('');
  const current = invoice ?? order.invoice;
  if (!current && !invoiceReady(order)) return null;

  const act = async (action: 'issue' | 'email' | 'shared' | 'regenerate') => {
    if (action === 'regenerate' && !window.confirm(`Regenerate ${current?.number ?? 'the invoice'} from the order as it is now? It keeps its number; the earlier version is kept, and the PDF says "Revised". Send it to the customer again after.`)) return;
    if (action !== 'shared') setBusy(action);
    setProblem('');
    setNote('');
    const { ok, data } = await postJson<{ invoice?: Invoice; emailed?: boolean; changed?: boolean; message?: string }>(`/api/admin/orders/${encodeURIComponent(order.id)}/invoice-pdf`, { action });
    setBusy('');
    if (data.invoice) setInvoice(data.invoice);
    if (!ok) return setProblem(data.message || 'Not done. Please try again.');
    if (action === 'email' && data.emailed) setNote(`Emailed to ${order.customer.email}.`);
    if (action === 'regenerate') setNote(data.changed ? 'Regenerated: open or send the PDF again.' : 'Nothing changed: the invoice is already up to date.');
  };

  const link = current ? current.pdfUrl ?? (typeof window === 'undefined' ? undefined : `${window.location.origin}${current.pdfPath}`) : undefined;
  const wa = current && link ? waMeLink(order.customer.phone, `Dear ${safeFirstName(order.customer.fullName) || 'customer'}, here is your invoice ${current.number} for order ${order.id}${shopName ? ` from ${shopName}` : ''}: ${link}`) : null;
  const button = 'min-h-8 px-2 rounded-lg text-[11px] font-semibold inline-flex items-center justify-center gap-1.5 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold';

  return (
    <div data-testid="order-invoice" className="rounded-xl border border-line bg-ivory px-2.5 py-1.5 text-[11px] min-w-0 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
        <FileText className="w-3.5 h-3.5 text-gold-deep shrink-0" aria-hidden="true" />
        {current ? (
          <>
            <strong className="text-ink">Invoice {current.number}</strong>
            <span className="text-ink-soft">
              issued {when(current.issuedAt)}
              {current.emailedAt ? ` · emailed ${when(current.emailedAt)}` : ''}
              {current.sentCount && !current.emailedAt ? ` · sent ${current.sentCount}×` : ''}
            </span>
          </>
        ) : (
          <strong className="text-ink">Invoice: not made yet</strong>
        )}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {!current && (
          <button type="button" disabled={Boolean(busy)} onClick={() => void act('issue')} className={`${button} bg-ink text-paper`}>
            {busy === 'issue' ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <FileText className="w-4 h-4" aria-hidden="true" />} Make invoice (PDF)
          </button>
        )}
        {current && (
          <>
            <a href={`/api/admin/orders/${encodeURIComponent(order.id)}/invoice-pdf`} target="_blank" rel="noopener noreferrer" className={`${button} bg-surface text-ink border border-line-strong`}>
              <Download className="w-4 h-4" aria-hidden="true" /> Open PDF
            </a>
            {order.customer.email && (
              <button type="button" disabled={Boolean(busy)} onClick={() => void act('email')} className={`${button} bg-surface text-ink border border-line-strong`}>
                {busy === 'email' ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Mail className="w-4 h-4" aria-hidden="true" />} {current.emailedAt ? 'Email again' : 'Email to customer'}
              </button>
            )}
            {order.status !== 'cancelled' && current.number.startsWith('INV-') && (
              <button type="button" disabled={Boolean(busy)} onClick={() => void act('regenerate')} className={`${button} bg-surface text-ink border border-line-strong`} data-testid="invoice-regenerate">
                {busy === 'regenerate' ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="w-4 h-4" aria-hidden="true" />} Regenerate
              </button>
            )}
            {wa && (
              <a href={wa} target="_blank" rel="noopener noreferrer" onClick={() => void act('shared')} className={`${button} bg-whatsapp text-paper`}>
                <MessageCircle className="w-4 h-4" aria-hidden="true" /> Send on WhatsApp
              </a>
            )}
          </>
        )}
      </div>
      {note && (
        <p role="status" className="text-success font-semibold">
          {note}
        </p>
      )}
      {problem && (
        <p role="alert" className="text-danger font-semibold break-anywhere">
          {problem}
        </p>
      )}
    </div>
  );
}
