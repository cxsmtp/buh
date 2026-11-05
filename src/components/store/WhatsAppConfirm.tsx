'use client';

import React from 'react';
import { CheckCircle2, MessageCircle } from 'lucide-react';
import type { WhatsAppCheck } from '@/types';
import { useShop } from '@/lib/client/shop';
import { confirmLink } from '@/lib/whatsappConfirm';
import { useT, type Words } from '@/lib/i18n';

const WORDS = {
  confirmOnWa: { en: 'Confirm on WhatsApp', ar: 'أكّد عبر واتساب' },
  confirmed: { en: 'Your number is confirmed on WhatsApp. Thank you.', ar: 'تم تأكيد رقمك عبر واتساب. شكراً لك.' },
  again: { en: 'Didn’t send it? Open WhatsApp again', ar: 'لم ترسلها؟ افتح واتساب مرة أخرى' },
  itSays: { en: 'It says:', ar: 'نص الرسالة:' },
  tapSend: { en: 'Just tap Send.', ar: 'فقط اضغط إرسال.' },
  ownWa: { en: 'Please send it from your own WhatsApp', ar: 'يرجى إرسالها من واتساب الخاص بك' },
  lastStep: { en: 'Last step: confirm on WhatsApp', ar: 'الخطوة الأخيرة: أكّد عبر واتساب' },
  mismatch: { en: 'Your message came from a different number. Send it from the WhatsApp on the number you ordered with.', ar: 'وصلتنا رسالتك من رقم مختلف. أرسلها من واتساب الرقم الذي طلبت به.' },
  toConfirm: { en: 'To confirm your order, tap to send us a WhatsApp message.', ar: 'لتأكيد طلبك، اضغط لإرسال رسالة واتساب إلينا.' },
  yours: { en: 'Tap to send us a WhatsApp message so we know this number is yours.', ar: 'اضغط لإرسال رسالة واتساب إلينا لنتأكد أن هذا الرقم رقمك.' },
  within: { en: 'Please tap within {open} hours: orders not confirmed within {cancel} hours are cancelled (after {open} hours if WhatsApp is never opened).', ar: 'يرجى الضغط خلال {open} ساعات: الطلبات غير المؤكدة خلال {cancel} ساعة تُلغى (وبعد {open} ساعات إذا لم يُفتح واتساب).' },
  cancelled: { en: 'Orders not confirmed within {cancel} hours are cancelled.', ar: 'الطلبات غير المؤكدة خلال {cancel} ساعة تُلغى.' },
  hold: { en: 'We’ll start your order once we get your message.', ar: 'سنبدأ تجهيز طلبك فور وصول رسالتك.' },
  either: { en: 'Your order is placed either way.', ar: 'طلبك مسجّل في كل الأحوال.' },
} as const satisfies Words;

/**
 * "Confirm on WhatsApp": one large button that opens the customer's WhatsApp with
 * "Confirm my order BUH-… · code 1234" to the shop already typed. Sending it from their own
 * WhatsApp shows the shop the number is theirs. Nothing without the shop's WhatsApp number.
 * A bank-transfer order's message also asks for the bank details (never on the website).
 * With Settings → Phone check "WhatsApp (free)" (cancelHours given) this message is the order's
 * confirmation: said plainly, with the hours after which an unconfirmed order is cancelled (and the
 * sooner hours when the button is never tapped).
 */
export function WhatsAppConfirm({
  orderId,
  phone,
  check,
  bankDetails = false,
  cancelHours,
  openHours,
  buttonLabel,
  lead = false,
  tapped = false,
  onTapped,
  glow = false,
  ariaLabel,
}: {
  orderId: string;
  phone: string;
  check: Pick<WhatsAppCheck, 'status' | 'code' | 'hold'>;
  bankDetails?: boolean;
  cancelHours?: number | null;
  /** Sooner: the order is cancelled after this many hours if the button is never tapped. */
  openHours?: number | null;
  /** "Confirm & ask for bank details on WhatsApp" for a bank transfer "on request" (the one button). */
  buttonLabel?: string;
  /**
   * The order page's main action (the page's heading says "Last step: confirm your order on
   * WhatsApp"): the button only, large, without this box's own heading and text.
   */
  lead?: boolean;
  /** The customer already tapped it (the button then reads "Open WhatsApp again"). */
  tapped?: boolean;
  onTapped?: () => void;
  /** The order page's last step: the button glows gold so it is the one thing to do. */
  glow?: boolean;
  /** What screen readers say when the visible label is short ("Tap to confirm →"). */
  ariaLabel?: string;
}) {
  const t = useT(WORDS);
  const link = confirmLink(useShop().store.whatsappNumber, orderId, check.code, { bankDetails });
  if (!link) return null;

  if (check.status === 'confirmed') {
    return (
      <p role="status" className="flex items-center justify-center gap-1.5 text-xs font-semibold text-success bg-success-soft border border-success-line rounded-xl px-3 py-2">
        <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" /> {t('confirmed')}
      </p>
    );
  }

  // Note that WhatsApp opened (for the shop's timeline). Never holds up the link.
  const opened = () => {
    onTapped?.();
    void fetch('/api/orders/whatsapp-opened', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      keepalive: true,
      body: JSON.stringify({ orderId, phone }),
    }).catch(() => {});
  };

  const button = (
    <a
      href={link}
      target="_blank"
      rel="noopener noreferrer"
      onClick={opened}
      data-testid="wa-confirm-button"
      aria-label={!tapped && ariaLabel ? ariaLabel : undefined}
      className={`w-full ${(glow || !lead) && !tapped ? 'cta-glow ' : ''}${lead && !tapped ? 'min-h-14 text-base' : 'min-h-12 text-sm'} ${tapped ? 'bg-surface text-ink border border-success-line hover:bg-success-soft' : 'bg-whatsapp text-paper hover:brightness-110'} font-semibold py-3 px-4 rounded-xl flex items-center justify-center gap-2 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2`}
    >
      <MessageCircle className="w-5 h-5 shrink-0" aria-hidden="true" />
      <span>{tapped ? t('again') : (buttonLabel ?? t('confirmOnWa'))}</span>
    </a>
  );
  const says = (
    <p className="text-[11px] text-ink-muted text-center break-anywhere">
      {t('itSays')} <span lang="en" dir="ltr">&ldquo;Confirm my order <span className="font-mono">{orderId}</span> · code <span className="font-mono">{check.code}</span>{bankDetails ? ', and please send me the bank details' : ''}&rdquo;</span>. {t('tapSend')}
    </p>
  );

  if (lead) {
    return (
      <div className="space-y-2" data-testid="wa-confirm-lead">
        {button}
        {says}
      </div>
    );
  }

  return (
    <section aria-labelledby={`wa-confirm-${orderId}`} className="rounded-2xl border border-success-line bg-success-soft/60 p-4 space-y-3 text-start">
      <h3 id={`wa-confirm-${orderId}`} className="text-sm font-semibold text-ink">
        {check.status === 'mismatch' ? t('ownWa') : t('lastStep')}
      </h3>
      <p className="text-xs text-ink-soft leading-relaxed">
        {check.status === 'mismatch'
          ? t('mismatch')
          : cancelHours
            ? t('toConfirm')
            : t('yours')}{' '}
        {cancelHours
          ? openHours && openHours < cancelHours
            ? t('within', { open: openHours, cancel: cancelHours })
            : t('cancelled', { cancel: cancelHours })
          : check.hold
            ? t('hold')
            : t('either')}
      </p>
      {button}
      {says}
    </section>
  );
}
