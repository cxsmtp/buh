'use client';

import React from 'react';
import { CheckCircle2, MessageCircle } from 'lucide-react';
import type { WhatsAppCheck } from '@/types';
import { useShop } from '@/lib/client/shop';
import { confirmLink } from '@/lib/whatsappConfirm';

/**
 * "Confirm on WhatsApp": one large button that opens the customer's WhatsApp with
 * "Confirm my order BUH-… · code 1234" to the shop already typed. Sending it from their own
 * WhatsApp shows the shop the number is theirs. Nothing without the shop's WhatsApp number.
 */
export function WhatsAppConfirm({ orderId, phone, check }: { orderId: string; phone: string; check: Pick<WhatsAppCheck, 'status' | 'code' | 'hold'> }) {
  const link = confirmLink(useShop().store.whatsappNumber, orderId, check.code);
  if (!link) return null;

  if (check.status === 'confirmed') {
    return (
      <p role="status" className="flex items-center justify-center gap-1.5 text-xs font-semibold text-success bg-success-soft border border-success-line rounded-xl px-3 py-2">
        <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" /> Your number is confirmed on WhatsApp. Thank you.
      </p>
    );
  }

  // Note that WhatsApp opened (for the shop's timeline). Never holds up the link.
  const opened = () => {
    void fetch('/api/orders/whatsapp-opened', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      keepalive: true,
      body: JSON.stringify({ orderId, phone }),
    }).catch(() => {});
  };

  return (
    <section aria-labelledby={`wa-confirm-${orderId}`} className="rounded-2xl border border-success-line bg-success-soft/60 p-4 space-y-3 text-left">
      <h3 id={`wa-confirm-${orderId}`} className="text-sm font-semibold text-ink">
        {check.status === 'mismatch' ? 'Please send it from your own WhatsApp' : 'One last step'}
      </h3>
      <p className="text-xs text-ink-soft leading-relaxed">
        {check.status === 'mismatch'
          ? 'Your message came from a different number. Send it from the WhatsApp on the number you ordered with.'
          : 'Tap to send us a WhatsApp message so we know this number is yours.'}{' '}
        {check.hold ? 'We’ll start your order once we get your message.' : 'Your order is placed either way.'}
      </p>
      <a
        href={link}
        target="_blank"
        rel="noopener noreferrer"
        onClick={opened}
        className="w-full min-h-12 bg-whatsapp hover:brightness-110 text-white font-semibold text-sm py-3 px-4 rounded-xl flex items-center justify-center gap-2 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2"
      >
        <MessageCircle className="w-5 h-5 shrink-0" aria-hidden="true" />
        <span>Confirm on WhatsApp</span>
      </a>
      <p className="text-[11px] text-ink-muted text-center break-anywhere">
        It says: &ldquo;Confirm my order <span className="font-mono">{orderId}</span> · code <span className="font-mono">{check.code}</span>&rdquo;. Just tap Send.
      </p>
    </section>
  );
}
