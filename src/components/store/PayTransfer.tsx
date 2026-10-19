'use client';

import React, { useRef, useState } from 'react';
import Link from 'next/link';
import { Building2, Check, CheckCircle2, Copy, Loader2, MessageCircle, Upload } from 'lucide-react';
import type { BankState, BankTransferDetails } from '@/types';
import { postJson } from '@/lib/apiClient';
import { formatAed, toFils } from '@/lib/money';

interface PayTransferProps {
  token: string;
  shopName: string;
  order: { id: string; total: number; firstName: string; state: BankState; uploads: number };
  bank: BankTransferDetails;
  /** Bank transfer "on request": no account on this page; the customer asks for it. */
  onRequest?: boolean;
  /** The shop's WhatsApp, with the request typed (null without the shop's number). */
  askLink?: string | null;
  /** The link is the order's WhatsApp confirmation (with its code), which also asks for the details. */
  askConfirms?: boolean;
  /** Where to ask instead when the shop has no WhatsApp number. */
  supportEmail?: string;
}

const MAX_BYTES = 5 * 1024 * 1024;

/** One detail with a copy button (the IBAN, the reference). */
function CopyLine({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(label === 'IBAN' ? value.replace(/\s+/g, '') : value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // the clipboard is not available: the value is on screen to copy by hand
    }
  };
  return (
    <div className="flex items-center justify-between gap-3 py-2 border-b border-line last:border-b-0 min-w-0">
      <div className="min-w-0">
        <span className="block text-[11px] text-ink-muted">{label}</span>
        <strong className={`block text-ink break-anywhere ${mono ? 'font-mono text-[13px]' : 'text-sm'}`}>{value}</strong>
      </div>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={`Copy ${label}`}
        className="shrink-0 min-h-10 inline-flex items-center gap-1 px-3 rounded-xl border border-line-strong bg-surface text-[11px] font-semibold text-ink hover:bg-ivory focus:outline-none focus-visible:ring-2 focus-visible:ring-gold"
      >
        {copied ? <Check className="w-3.5 h-3.5 text-success" aria-hidden="true" /> : <Copy className="w-3.5 h-3.5" aria-hidden="true" />}
        <span>{copied ? 'Copied' : 'Copy'}</span>
      </button>
    </div>
  );
}

/**
 * The customer's private page for a bank-transfer order: what to pay, where, with which
 * reference, and an upload for the transfer screenshot (an image or a PDF, up to 5 MB). Sending
 * another replaces it; the shop keeps the earlier ones.
 */
export function PayTransfer({ token, shopName, order, bank, onRequest = false, askLink, askConfirms = false, supportEmail = '' }: PayTransferProps) {
  const [uploads, setUploads] = useState(order.uploads);
  const [state, setState] = useState<BankState>(order.state);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [justSent, setJustSent] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const amount = `AED ${formatAed(toFils(order.total))}`;

  const send = (file: File | undefined) => {
    setProblem('');
    setJustSent(false);
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setProblem('That file is larger than 5 MB. Please choose a smaller screenshot or PDF.');
      return;
    }
    if (!/^(image\/(png|jpeg|webp)|application\/pdf)$/.test(file.type)) {
      setProblem('Please choose a screenshot (PNG, JPEG or WebP) or a PDF.');
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setProblem('That file could not be read. Please try another one.');
    reader.onload = async () => {
      setBusy(true);
      const { ok, data } = await postJson<{ uploads?: number; message?: string }>(`/api/pay/${encodeURIComponent(token)}`, { file: reader.result });
      setBusy(false);
      if (input.current) input.current.value = '';
      if (!ok) {
        setProblem(data.message || 'The screenshot could not be sent. Please try again.');
        return;
      }
      setUploads(data.uploads ?? uploads + 1);
      setState('uploaded');
      setJustSent(true);
    };
    reader.readAsDataURL(file);
  };

  const details: Array<[string, string, boolean?]> = [
    ['Bank', bank.bankName],
    ['Account name', bank.accountName],
    ['IBAN', bank.iban, true],
    ['Account number', bank.accountNumber, true],
    ['SWIFT', bank.swiftCode, true],
    ['Branch', bank.branch],
  ];

  return (
    <main className="min-h-[100dvh] w-full px-4 py-6 sm:py-10 pt-safe">
      <div className="max-w-lg mx-auto space-y-5 min-w-0">
        <header className="text-center space-y-1">
          <Link href="/" prefetch={false} className="font-serif text-xl text-ink hover:text-gold-deep">{shopName}</Link>
          <h1 className="font-serif text-3xl text-ink">Pay by bank transfer</h1>
          <p className="text-[13px] text-ink-soft leading-relaxed">
            {order.firstName ? `Thank you, ${order.firstName}. ` : 'Thank you. '}Please transfer the amount below, then upload a screenshot of the transfer here.
          </p>
        </header>

        <section aria-label="Your order" className="bg-surface rounded-2xl border border-line p-4 text-xs space-y-2">
          <div className="flex justify-between items-center gap-3">
            <span className="text-ink-muted font-medium">Order number</span>
            <span className="font-mono text-sm text-ink break-anywhere text-right">{order.id}</span>
          </div>
          <div className="flex justify-between items-center gap-3 pt-2 border-t border-line">
            <span className="font-semibold text-ink">Amount to transfer</span>
            <span data-testid="pay-amount" className="font-semibold text-lg text-ink">{amount}</span>
          </div>
        </section>

        <section aria-labelledby="pay-bank-title" className="bg-surface rounded-2xl border border-line p-4 space-y-1">
          <h2 id="pay-bank-title" className="text-sm font-semibold text-ink flex items-center gap-1.5 mb-1">
            <Building2 className="w-4 h-4 text-gold-deep" aria-hidden="true" /> Our bank account
          </h2>
          {details.filter(([, v]) => v && v.trim()).map(([label, value, mono]) => (
            <CopyLine key={label} label={label} value={value} mono={mono} />
          ))}
          {onRequest && !askLink && (
            <p data-testid="pay-ask-bank-email" className="text-xs text-ink-soft leading-relaxed pb-1 break-anywhere">
              {supportEmail ? (
                <>
                  Email us at{' '}
                  <a className="font-semibold text-ink underline" href={`mailto:${supportEmail}?subject=${encodeURIComponent(`Bank details for order ${order.id}`)}`}>
                    {supportEmail}
                  </a>{' '}
                  and we&rsquo;ll send you our bank details.
                </>
              ) : (
                'We’ll contact you on the phone number of your order with our bank details.'
              )}
            </p>
          )}
          {askLink && (
            <div className="space-y-2 pb-1">
              <p className="text-xs text-ink-soft leading-relaxed">
                {askConfirms ? 'Confirm your order on WhatsApp and we’ll send you our bank details. The message is already typed: just tap Send.' : 'Message us on WhatsApp and we’ll send you our bank details.'}
              </p>
              <a
                data-testid="pay-ask-bank"
                href={askLink}
                target="_blank"
                rel="noopener noreferrer"
                className="w-full min-h-12 bg-whatsapp hover:brightness-110 text-paper font-semibold text-sm py-3 px-4 rounded-xl flex items-center justify-center gap-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2"
              >
                <MessageCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span>{askConfirms ? 'Confirm & ask for bank details on WhatsApp' : 'Ask for bank details on WhatsApp'}</span>
              </a>
            </div>
          )}
          <div className="pt-2">
            <CopyLine label="Reference" value={order.id} mono />
            <p className="text-[11px] text-ink-soft leading-relaxed mt-1">Please use your order number as the transfer reference, so we can match it.</p>
            {bank.instructions && <p className="text-[11px] text-ink-soft leading-relaxed mt-1">{bank.instructions}</p>}
          </div>
        </section>

        <section aria-labelledby="pay-upload-title" className="bg-surface rounded-2xl border border-line p-4 space-y-3 text-xs">
          <h2 id="pay-upload-title" className="text-sm font-semibold text-ink">Upload your transfer screenshot</h2>
          {justSent || (state === 'uploaded' && uploads > 0) ? (
            <p role="status" className="flex items-start gap-1.5 font-semibold text-success bg-success-soft border border-success-line rounded-xl px-3 py-2">
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-px" aria-hidden="true" />
              <span>Thank you, we&apos;ll confirm your order once we see the transfer.</span>
            </p>
          ) : state === 'not_received' ? (
            <p className="text-ink-soft leading-relaxed bg-warning-soft border border-warning-line rounded-xl px-3 py-2">
              We haven&apos;t seen your transfer in our account yet. Transfers can take a little while; if you have a new screenshot, please upload it.
            </p>
          ) : (
            <p className="text-ink-soft leading-relaxed">A screenshot or PDF of the transfer from your banking app (up to 5 MB). Or send it to us on WhatsApp or by email.</p>
          )}
          <label className={`w-full min-h-12 flex items-center justify-center gap-2 px-4 rounded-xl text-sm font-semibold cursor-pointer focus-within:ring-2 focus-within:ring-gold focus-within:ring-offset-2 ${busy ? 'opacity-60 pointer-events-none' : ''} ${uploads > 0 ? 'bg-surface text-ink border border-line-strong hover:bg-ivory' : 'bg-ink text-ivory hover:bg-ink-2'}`}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Upload className="w-4 h-4" aria-hidden="true" />}
            <span>{busy ? 'Sending…' : uploads > 0 ? 'Upload a different screenshot' : 'Choose screenshot or PDF'}</span>
            <input
              ref={input}
              type="file"
              accept="image/png,image/jpeg,image/webp,application/pdf"
              disabled={busy}
              onChange={(e) => send(e.target.files?.[0])}
              className="sr-only"
            />
          </label>
          {uploads > 0 && !busy && <p className="text-[11px] text-ink-muted text-center">{uploads === 1 ? 'We have your screenshot.' : `We have ${uploads} screenshots from you; the latest is the one we check.`}</p>}
          {problem && (
            <p role="alert" className="text-danger font-semibold">
              {problem}
            </p>
          )}
        </section>

        <p className="text-[11px] text-ink-muted text-center leading-relaxed">This page is only for you: please don&apos;t share its link.</p>
      </div>
    </main>
  );
}
