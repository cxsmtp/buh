'use client';

import React, { useState } from 'react';
import { Building2, Check, CheckCircle2, Clock, Copy, Eye, MessageCircle, XCircle } from 'lucide-react';
import type { BankTransferDetails, Order } from '@/types';
import { postJson, safeLinkHref } from '@/lib/apiClient';
import { bankDetailsReply, bankDetailsSaved, BANK_DETAILS_PLACEHOLDER, notReceivedReply, paymentReceivedReply } from '@/lib/bankMessages';
import { waMeLink } from '@/lib/whatsappConfirm';

/** A bank transfer with a screenshot waiting for the owner's look (not paid, not cancelled). */
export function transferToCheck(order: Order): boolean {
  return order.bankTransfer?.state === 'uploaded' && order.status !== 'cancelled';
}

const when = (iso?: string) => (iso ? new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

const BADGES = {
  awaiting: { text: 'Waiting for bank transfer', tone: 'border-warning-line bg-warning-soft/60', icon: Clock, ink: 'text-warning' },
  uploaded: { text: 'Transfer screenshot received', tone: 'border-gold bg-ivory', icon: Eye, ink: 'text-ink' },
  not_received: { text: 'Transfer not received yet', tone: 'border-warning-line bg-warning-soft/60', icon: XCircle, ink: 'text-warning' },
  paid: { text: 'Payment received', tone: 'border-success-line bg-success-soft/50', icon: CheckCircle2, ink: 'text-success' },
} as const;

/**
 * A bank-transfer order, for the owner's phone first: where it stands (waiting → screenshot
 * received → paid), the screenshot (through the hub-only receipt address), and two big buttons,
 * "Payment received" and "Not received yet" (checked, made idempotent and audited by the server).
 * Plus the one-tap WhatsApp messages: the bank details with the order's private link, and the
 * replies. The bank account is only ever in these private messages, never on the website.
 */
export function OrderBankTransfer({ order, bank, shopName, onOrderChanged }: { order: Order; bank: BankTransferDetails; shopName?: string; onOrderChanged: (order: Order) => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [copied, setCopied] = useState(false);
  const bt = order.bankTransfer;
  if (order.paymentMethod !== 'bank_transfer' || !bt) return null;

  const cancelled = order.status === 'cancelled';
  const badge = BADGES[bt.state];
  const Icon = badge.icon;
  // The full link comes from the shop's configured address (NEXT_PUBLIC_APP_URL), never this browser's.
  const link = bt.payUrl ?? '';

  const answer = async (result: 'received' | 'not_received') => {
    if (result === 'received' && !window.confirm(`Confirm that AED ${order.total} for ${order.id} has arrived in the bank account?`)) return;
    setBusy(true);
    setProblem('');
    const { ok, data } = await postJson<{ order?: Order; message?: string }>(`/api/admin/orders/${encodeURIComponent(order.id)}/bank`, { result });
    setBusy(false);
    if (ok && data.order) onOrderChanged(data.order);
    else setProblem(data.message || 'Not saved. Please try again.');
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setProblem('Copying is not available here: press and hold the link to copy it.');
    }
  };

  // The saved account, or "[your bank details]" for the owner to type in WhatsApp before sending.
  const details = waMeLink(order.customer.phone, bankDetailsReply({ orderId: order.id, total: order.total, bank, link: link || undefined, firstName: order.customer.fullName, shopName }));
  const onRequest = order.bankDetailsBy === 'whatsapp';
  const accountSaved = bankDetailsSaved(bank);
  const reply = bt.state === 'paid' ? waMeLink(order.customer.phone, paymentReceivedReply(order.id)) : bt.state === 'not_received' ? waMeLink(order.customer.phone, notReceivedReply(order.id, order.total, link || undefined)) : null;
  const button = 'min-h-11 px-3 py-2 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold';
  const receipt = safeLinkHref(order.paymentReceiptUrl) || `/api/admin/orders/${encodeURIComponent(order.id)}/receipt`;

  return (
    <div data-testid="bank-transfer" className={`rounded-xl border p-3 space-y-2 text-xs ${badge.tone}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Building2 className="w-4 h-4 text-gold-deep shrink-0" aria-hidden="true" />
        <strong data-testid="bank-badge" className={`flex items-center gap-1 ${badge.ink}`}>
          <Icon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" /> {badge.text}
        </strong>
        <span className="text-ink-soft">AED {order.total} · reference <span className="font-mono">{order.id}</span></span>
      </div>
      {onRequest && (
        <p data-testid="bank-on-request" className="font-semibold text-ink flex items-center gap-1.5">
          <MessageCircle className="w-3.5 h-3.5 text-whatsapp shrink-0" aria-hidden="true" /> Bank transfer: customer will ask for details on WhatsApp
        </p>
      )}
      {bt.state === 'paid' && bt.checkedAt && <p className="text-ink-soft">Marked received{bt.checkedBy ? ` by ${bt.checkedBy}` : ''} at {when(bt.checkedAt)}.</p>}
      {bt.uploads > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <a href={receipt} target="_blank" rel="noopener noreferrer" className={`${button} bg-surface text-ink border border-line-strong`}>
            <Eye className="w-4 h-4" aria-hidden="true" /> View transfer screenshot
          </a>
          {bt.uploadedAt && <span className="text-ink-muted">Uploaded {when(bt.uploadedAt)}</span>}
          {bt.uploads > 1 && (
            <span className="flex flex-wrap gap-x-2 text-ink-muted">
              Earlier:
              {/* The server keeps the latest 5 (src/lib/server/orders.ts: RECEIPT_LIMITS.versions): the 4 before this one. */}
              {Array.from({ length: Math.min(bt.uploads - 1, 4) }, (_, i) => bt.uploads - Math.min(bt.uploads - 1, 4) + i).map((v) => (
                <a key={v} href={`${receipt}?v=${v}`} target="_blank" rel="noopener noreferrer" className="underline text-ink-soft">
                  #{v}
                </a>
              ))}
            </span>
          )}
        </div>
      )}
      {bt.state !== 'paid' && !cancelled && (
        <div className="grid grid-cols-1 min-[380px]:grid-cols-2 gap-2">
          <button type="button" disabled={busy} onClick={() => void answer('received')} className={`${button} bg-success text-paper`}>
            <CheckCircle2 className="w-4 h-4" aria-hidden="true" /> Payment received
          </button>
          {bt.state !== 'not_received' && (
            <button type="button" disabled={busy} onClick={() => void answer('not_received')} className={`${button} bg-surface text-danger border border-danger-line`}>
              <XCircle className="w-4 h-4" aria-hidden="true" /> Not received yet
            </button>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {reply && (
          <a href={reply} target="_blank" rel="noopener noreferrer" className={`${button} bg-whatsapp text-paper`}>
            <MessageCircle className="w-4 h-4" aria-hidden="true" /> Tell the customer on WhatsApp
          </a>
        )}
        {bt.state !== 'paid' && !cancelled && details && (
          <a href={details} target="_blank" rel="noopener noreferrer" className={`${button} ${reply ? 'bg-surface text-ink border border-line-strong' : 'bg-whatsapp text-paper'}`}>
            <MessageCircle className="w-4 h-4" aria-hidden="true" /> {onRequest ? 'Reply with bank details on WhatsApp' : 'Send bank details on WhatsApp'}
          </a>
        )}
      </div>
      {link && (
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-ink-muted shrink-0">Private link:</span>
          <a href={link} target="_blank" rel="noopener noreferrer" className="font-mono text-[11px] text-ink-soft truncate min-w-0">{link}</a>
          <button type="button" onClick={() => void copyLink()} aria-label="Copy the private link" className="shrink-0 min-h-9 px-2.5 rounded-lg border border-line-strong bg-surface font-semibold text-ink inline-flex items-center gap-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold">
            {copied ? <Check className="w-3.5 h-3.5 text-success" aria-hidden="true" /> : <Copy className="w-3.5 h-3.5" aria-hidden="true" />} {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}
      {!link && bt.payPath && (
        <p data-testid="bank-no-shop-url" className="text-ink-muted">
          The private link is left out of messages until the shop&apos;s address is set (NEXT_PUBLIC_APP_URL in the shop&apos;s settings file, see the deployment guide).
        </p>
      )}
      {bt.state !== 'paid' && !cancelled && (
        <p className="text-ink-muted">
          {onRequest
            ? bt.emailedAt
              ? `Emailed the customer how to ask on WhatsApp at ${when(bt.emailedAt)}.`
              : 'The customer was shown a button to ask on WhatsApp.'
            : bt.emailedAt
              ? `Bank details emailed to the customer at ${when(bt.emailedAt)}.`
              : order.customer.email
                ? 'Not emailed yet (or email is not set up): you can send the details on WhatsApp.'
                : 'No email on this order: send the bank details on WhatsApp.'}
          {!accountSaved && ` No bank account is saved (Settings → Branding & bank): the reply has ${BANK_DETAILS_PLACEHOLDER} for you to fill in.`}
        </p>
      )}
      {problem && <p role="alert" className="text-danger font-semibold">{problem}</p>}
    </div>
  );
}
