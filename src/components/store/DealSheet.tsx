'use client';

import React, { useId, useState } from 'react';
import { ChevronLeft, ChevronRight, MessageCircle, ShieldCheck, X } from 'lucide-react';
import { formatAed } from '@/lib/money';
import { useShop } from '@/lib/client/shop';
import type { DealView, PaymentMethod } from '@/types';
import { useLocale, useT, type Locale, type Words } from '@/lib/i18n';
import { useDialogFocus } from '@/components/common/Sheet';
import { deliveryName as deliveryNameIn } from './checkoutWords';

const PAY_NAMES: Record<Locale, Record<PaymentMethod, string>> = {
  en: { online_card: 'card', cod: 'cash on delivery', bank_transfer: 'bank transfer' },
  ar: { online_card: 'البطاقة', cod: 'الدفع عند الاستلام', bank_transfer: 'التحويل البنكي' },
};

/** "card, cash on delivery or bank transfer" */
function payList(list: PaymentMethod[], locale: Locale): string {
  const names = (['online_card', 'cod', 'bank_transfer'] as PaymentMethod[]).filter((p) => list.includes(p)).map((p) => PAY_NAMES[locale][p]);
  const or = locale === 'ar' ? ' أو ' : ' or ';
  const comma = locale === 'ar' ? '، ' : ', ';
  return names.length > 1 ? `${names.slice(0, -1).join(comma)}${or}${names[names.length - 1]}` : (names[0] ?? '');
}

const WORDS = {
  title: { en: 'Your order', ar: 'طلبك' },
  close: { en: 'Close your order', ar: 'إغلاق طلبك' },
  pictures: { en: 'Pictures of your order', ar: 'صور طلبك' },
  pictureOf: { en: 'Picture {n} of {count}', ar: 'الصورة {n} من {count}' },
  prev: { en: 'Previous picture', ar: 'الصورة السابقة' },
  next: { en: 'Next picture', ar: 'الصورة التالية' },
  show: { en: 'Show picture {n}', ar: 'عرض الصورة {n}' },
  piece: { en: 'piece', ar: 'قطعة' },
  pieces: { en: 'pieces', ar: 'قطع' },
  fixed: { en: 'Fixed price, {delivery} included. Pay by {pay}.', ar: 'سعر ثابت يشمل التوصيل. الدفع: {pay}.' },
  link: { en: 'This private link is for you and works until {until}. Next: your address and how you pay, then one WhatsApp message to confirm.', ar: 'هذا الرابط الخاص لك ويعمل حتى {until}. التالي: عنوانك وطريقة الدفع، ثم رسالة واتساب واحدة للتأكيد.' },
  cont: { en: 'Continue: address & payment', ar: 'متابعة: العنوان والدفع' },
} as const satisfies Words;

/**
 * The owner's photo deal (/deal/<token>): the pictures the owner chose, what it is, and the fixed
 * price with delivery included. The customer can't change the price; they continue to their
 * address and one of the ways to pay the owner allowed.
 */
export function DealSheet({ deal, onClose, onContinue }: { deal: DealView; onClose: () => void; onContinue: () => void }) {
  const id = useId();
  const { locale } = useLocale();
  const t = useT(WORDS);
  const { delivery } = useShop();
  const deliveryName = deliveryNameIn('standard', delivery, locale).toLowerCase();
  // Keyboard: focus moves into the sheet, Tab stays inside it, Escape closes it.
  const panel = useDialogFocus<HTMLDivElement>(true, onClose);
  const [shown, setShown] = useState(0);
  const count = deal.photos.length;
  const until = new Date(deal.expiresAt).toLocaleDateString(locale === 'ar' ? 'ar-AE-u-nu-latn' : 'en-GB', { day: 'numeric', month: 'long', timeZone: 'Asia/Dubai' });

  return (
    <div ref={panel} tabIndex={-1} className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/45 p-3 sm:p-4 overscroll-contain sheet-fade outline-none" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} data-testid="deal-sheet">
      <div className="bg-surface rounded-3xl max-w-lg w-full min-w-0 max-h-[calc(100dvh-1.5rem)] overflow-y-auto overflow-x-hidden overscroll-contain px-5 pb-5 border border-line space-y-4">
        <div className="sticky top-0 z-10 -mx-5 px-5 pt-4 pb-3 !mb-4 bg-surface flex items-center justify-between gap-3 border-b border-line">
          <div className="flex items-center gap-2 min-w-0">
            <MessageCircle className="w-5 h-5 text-gold-deep shrink-0" strokeWidth={1.5} aria-hidden="true" />
            <h2 id={`${id}-title`} className="font-serif text-2xl text-ink">
              {t('title')}
            </h2>
          </div>
          <button type="button" onClick={onClose} aria-label={t('close')} className="shrink-0 w-10 h-10 -me-2 flex items-center justify-center text-ink rounded-full hover:bg-sand">
            <X className="w-5 h-5" strokeWidth={1.5} />
          </button>
        </div>

        {count > 0 && (
          <figure className="space-y-2" aria-roledescription="carousel" aria-label={t('pictures')}>
            <div className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={deal.photos[shown]} alt={t('pictureOf', { n: shown + 1, count })} className="w-full aspect-square object-cover rounded-2xl border border-line bg-sand" data-testid="deal-photo" />
              {count > 1 && (
                <>
                  <button type="button" onClick={() => setShown((n) => (n - 1 + count) % count)} aria-label={t('prev')} className="absolute start-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-surface/90 border border-line flex items-center justify-center">
                    <ChevronLeft className="w-5 h-5 rtl:-scale-x-100" aria-hidden="true" />
                  </button>
                  <button type="button" onClick={() => setShown((n) => (n + 1) % count)} aria-label={t('next')} className="absolute end-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-surface/90 border border-line flex items-center justify-center">
                    <ChevronRight className="w-5 h-5 rtl:-scale-x-100" aria-hidden="true" />
                  </button>
                </>
              )}
            </div>
            {count > 1 && (
              <ul className="flex gap-2 overflow-x-auto pb-1" data-testid="deal-thumbs">
                {deal.photos.map((src, i) => (
                  <li key={src} className="shrink-0">
                    <button type="button" onClick={() => setShown(i)} aria-label={t('show', { n: i + 1 })} aria-current={i === shown} className={`block rounded-xl border-2 ${i === shown ? 'border-ink' : 'border-transparent'}`}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={src} alt="" className="w-14 h-14 object-cover rounded-lg" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </figure>
        )}

        {deal.note && <p className="text-sm text-ink break-anywhere" data-testid="deal-note">{deal.note}</p>}

        <div className="rounded-2xl border border-line bg-ivory p-4 space-y-1" data-testid="deal-price">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm text-ink-soft">
              {deal.pieces} {deal.pieces === 1 ? t('piece') : t('pieces')}
            </span>
            <span className="font-serif text-2xl text-ink">AED {formatAed(deal.amountFils)}</span>
          </div>
          <p className="text-xs text-ink-soft">{t('fixed', { delivery: deliveryName, pay: payList(deal.payments, locale) })}</p>
        </div>

        <p className="text-xs text-ink-soft flex items-start gap-1.5">
          <ShieldCheck className="w-4 h-4 shrink-0 text-gold" aria-hidden="true" />
          <span>{t('link', { until })}</span>
        </p>

        <button type="button" onClick={onContinue} className="w-full min-h-12 rounded-xl bg-ink text-paper text-sm font-bold">
          {t('cont')}
        </button>
      </div>
    </div>
  );
}
