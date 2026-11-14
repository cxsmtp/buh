'use client';

import React, { useId, useState } from 'react';
import { Camera, ImagePlus, Loader2, MessageCircle, X } from 'lucide-react';
import { shrinkPhoto } from '@/lib/shrinkPhoto';
import { useShop } from '@/lib/client/shop';
import { useLocale, useT, type Words } from '@/lib/i18n';
import { useDialogFocus } from '@/components/common/Sheet';
import { deliveryName as deliveryNameIn } from './checkoutWords';
import type { PaymentMethod } from '@/types';

/** What the customer fills in before the address and payment (the server checks it all again). */
export interface PhotoOrderDraft {
  photos: string[];
  note: string;
  pieces: number;
  /** The amount agreed on WhatsApp, in fils. */
  amountFils: number;
  /** From the owner's deal link: its pictures and fixed price (the server takes them from the deal, never from here) and the ways to pay. */
  deal?: { token: string; payments: PaymentMethod[]; photoUrls: string[] };
}

/** Kept in step with the server (src/lib/server/orders.ts PHOTO_ORDER). */
export const PHOTO_ORDER_LIMITS = { maxPhotos: 8, maxAmount: 20_000, maxPieces: 20, noteMax: 300 };
/** About 0.6 MB once decoded, so 8 photos fit in one order (the server takes up to 1.2 MB each). */
export const PHOTO_URL_MAX = 800_000;

/**
 * "Order from your photo": for a piece agreed on WhatsApp that is not in the shop. The customer
 * adds the photos (camera or gallery), what it is, how many pieces and the amount agreed; the
 * address, payment and the WhatsApp confirmation follow in checkout. The shop confirms the amount
 * before anything is booked with the courier.
 */
const WORDS = {
  maxPhotos: { en: 'At most {n} photos.', ar: 'بحد أقصى {n} صور.' },
  unreadable: { en: 'This photo could not be read. Please try another one.', ar: 'تعذّرت قراءة هذه الصورة. جرّب صورة أخرى.' },
  addPhoto: { en: 'Add at least one photo of the piece you want.', ar: 'أضف صورة واحدة على الأقل للقطعة التي تريدها.' },
  amountRule: { en: 'Type the total we agreed on WhatsApp, with delivery, in AED (from 1 to {max}).', ar: 'اكتب المبلغ الذي اتفقنا عليه في واتساب شاملاً التوصيل بالدرهم (من 1 إلى {max}).' },
  piecesRule: { en: 'Pieces: a whole number from 1 to {max}.', ar: 'عدد القطع: رقم صحيح من 1 إلى {max}.' },
  title: { en: 'Order from your photo', ar: 'اطلب من صورتك' },
  close: { en: 'Close Order from your photo', ar: 'إغلاق الطلب من صورتك' },
  intro: { en: 'Agreed a piece with us on WhatsApp? Add its photos and the total we agreed, with delivery. Next come your address and how you pay, then you confirm on WhatsApp. We check the amount before it ships, and you can follow the courier with your order number.', ar: 'اتفقت معنا على قطعة عبر واتساب؟ أضف صورها والمبلغ الذي اتفقنا عليه شاملاً التوصيل. بعدها عنوانك وطريقة الدفع، ثم تؤكد عبر واتساب. نراجع المبلغ قبل الشحن، ويمكنك تتبع المندوب برقم طلبك.' },
  photosLegend: { en: 'Photos of the piece', ar: 'صور القطعة' },
  photosRange: { en: '(1 to {n})', ar: '(من 1 إلى {n})' },
  photoN: { en: 'Photo {n}', ar: 'الصورة {n}' },
  removePhoto: { en: 'Remove photo {n}', ar: 'حذف الصورة {n}' },
  preparing: { en: 'Preparing the photo…', ar: 'جارٍ تجهيز الصورة…' },
  camera: { en: 'Camera', ar: 'الكاميرا' },
  cameraLabel: { en: 'Take a photo with the camera', ar: 'التقط صورة بالكاميرا' },
  gallery: { en: 'Gallery', ar: 'المعرض' },
  galleryLabel: { en: 'Choose photos from the gallery', ar: 'اختر صوراً من المعرض' },
  waPhotos: { en: 'The photos sent on WhatsApp are fine (save them to your gallery first).', ar: 'الصور المرسلة عبر واتساب مناسبة (احفظها في المعرض أولاً).' },
  what: { en: 'What is it?', ar: 'ما هي القطعة؟' },
  optional: { en: '(optional)', ar: '(اختياري)' },
  whatPh: { en: 'e.g. King bedsheet set, blue block print', ar: 'مثال: طقم شراشف كينج، طباعة يدوية زرقاء' },
  pieces: { en: 'Bedsheets / pieces', ar: 'الشراشف / القطع' },
  amount: { en: 'Total agreed, with delivery (AED)', ar: 'المبلغ المتفق عليه شاملاً التوصيل (درهم)' },
  amountPh: { en: 'e.g. 350', ar: 'مثال: 350' },
  totalNote: { en: 'The total we agreed on WhatsApp for everything in the photos, {delivery} included: nothing is added for it at checkout.', ar: 'المبلغ الذي اتفقنا عليه في واتساب لكل ما في الصور، شاملاً التوصيل: لا يُضاف شيء عند إتمام الطلب.' },
  cont: { en: 'Continue: address & payment', ar: 'متابعة: العنوان والدفع' },
} as const satisfies Words;

export function PhotoOrderSheet({ onClose, onContinue, draft }: { onClose: () => void; onContinue: (draft: PhotoOrderDraft) => void; draft?: PhotoOrderDraft | null }) {
  const id = useId();
  const t = useT(WORDS);
  const { delivery } = useShop();
  const { locale } = useLocale();
  const deliveryName = deliveryNameIn('standard', delivery, locale).toLowerCase();
  // Keyboard: focus moves into the sheet, Tab stays inside it, Escape closes it.
  const panel = useDialogFocus<HTMLDivElement>(true, onClose);
  const [photos, setPhotos] = useState<string[]>(draft?.photos ?? []);
  const [busy, setBusy] = useState(0);
  const [note, setNote] = useState(draft?.note ?? '');
  const [pieces, setPieces] = useState(String(draft?.pieces ?? 1));
  const [amount, setAmount] = useState(draft ? String(draft.amountFils / 100) : '');
  const [error, setError] = useState('');

  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    setError('');
    const room = PHOTO_ORDER_LIMITS.maxPhotos - photos.length;
    const picked = Array.from(files).slice(0, Math.max(0, room));
    if (files.length > room) setError(t('maxPhotos', { n: PHOTO_ORDER_LIMITS.maxPhotos }));
    setBusy((n) => n + picked.length);
    for (const file of picked) {
      try {
        const url = await shrinkPhoto(file, 1400, PHOTO_URL_MAX);
        setPhotos((list) => (list.length < PHOTO_ORDER_LIMITS.maxPhotos ? [...list, url] : list));
      } catch (err) {
        // The reader's own words are English: in Arabic, the sheet's plain line.
        setError(err instanceof Error && locale !== 'ar' ? err.message : t('unreadable'));
      } finally {
        setBusy((n) => n - 1);
      }
    }
  };

  const amountNumber = Number(amount.replace(/,/g, ''));
  const piecesNumber = Number(pieces);
  const amountOk = amount.trim() !== '' && Number.isFinite(amountNumber) && amountNumber >= 1 && amountNumber <= PHOTO_ORDER_LIMITS.maxAmount && Math.abs(amountNumber * 100 - Math.round(amountNumber * 100)) < 1e-6;
  const piecesOk = Number.isInteger(piecesNumber) && piecesNumber >= 1 && piecesNumber <= PHOTO_ORDER_LIMITS.maxPieces;
  const ready = photos.length > 0 && busy === 0 && amountOk && piecesOk;

  const next = (e: React.FormEvent) => {
    e.preventDefault();
    if (!photos.length) return setError(t('addPhoto'));
    if (!amountOk) return setError(t('amountRule', { max: PHOTO_ORDER_LIMITS.maxAmount.toLocaleString('en-US') }));
    if (!piecesOk) return setError(t('piecesRule', { max: PHOTO_ORDER_LIMITS.maxPieces }));
    onContinue({ photos, note: note.trim(), pieces: piecesNumber, amountFils: Math.round(amountNumber * 100) });
  };

  const field = 'w-full min-w-0 px-3.5 py-2.5 rounded-xl border border-line-strong bg-surface text-ink text-sm placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-gold';
  const pick = 'min-h-11 rounded-xl border border-ink bg-surface text-ink text-sm font-semibold flex items-center justify-center gap-2 cursor-pointer focus-within:ring-2 focus-within:ring-gold';

  return (
    <div ref={panel} tabIndex={-1} className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/45 p-3 sm:p-4 overscroll-contain sheet-fade outline-none" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} data-testid="photo-order">
      <form onSubmit={next} className="bg-surface rounded-3xl max-w-lg w-full min-w-0 max-h-[calc(100dvh-1.5rem)] overflow-y-auto overflow-x-hidden overscroll-contain px-5 pb-5 border border-line space-y-4">
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

        <p className="text-sm text-ink-soft">
          {t('intro')}
        </p>

        <fieldset className="space-y-2">
          <legend className="text-sm font-semibold text-ink">
            {t('photosLegend')} <span className="font-normal text-ink-soft">{t('photosRange', { n: PHOTO_ORDER_LIMITS.maxPhotos })}</span>
          </legend>
          {photos.length > 0 && (
            <ul className="flex flex-wrap gap-2" data-testid="photo-order-photos">
              {photos.map((src, i) => (
                <li key={i} className="relative w-20">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={src} alt={t('photoN', { n: i + 1 })} className="w-20 h-20 object-cover rounded-xl border border-line" />
                  <button type="button" onClick={() => setPhotos((list) => list.filter((_, j) => j !== i))} className="absolute -top-2 -end-2 w-8 h-8 rounded-full bg-surface border border-line-strong flex items-center justify-center" aria-label={t('removePhoto', { n: i + 1 })}>
                    <X className="w-4 h-4" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {busy > 0 && (
            <p role="status" className="text-xs text-ink-soft flex items-center gap-1.5">
              <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> {t('preparing')}
            </p>
          )}
          {photos.length < PHOTO_ORDER_LIMITS.maxPhotos && (
            <div className="grid grid-cols-2 gap-2">
              <label className={pick}>
                <Camera className="w-4 h-4" aria-hidden="true" /> {t('camera')}
                <input type="file" accept="image/*" capture="environment" className="sr-only" aria-label={t('cameraLabel')} onChange={(e) => { void add(e.target.files); e.target.value = ''; }} />
              </label>
              <label className={pick}>
                <ImagePlus className="w-4 h-4" aria-hidden="true" /> {t('gallery')}
                <input type="file" accept="image/*" multiple className="sr-only" aria-label={t('galleryLabel')} data-testid="photo-order-file" onChange={(e) => { void add(e.target.files); e.target.value = ''; }} />
              </label>
            </div>
          )}
          <p className="text-xs text-ink-soft">{t('waPhotos')}</p>
        </fieldset>

        <div>
          <label htmlFor={`${id}-note`} className="block text-sm font-semibold text-ink mb-1">
            {t('what')} <span className="font-normal text-ink-soft">{t('optional')}</span>
          </label>
          <textarea id={`${id}-note`} className={`${field} min-h-[4.5rem]`} maxLength={PHOTO_ORDER_LIMITS.noteMax} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('whatPh')} />
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-3">
          <div>
            <label htmlFor={`${id}-pieces`} className="block text-sm font-semibold text-ink mb-1">
              {t('pieces')}
            </label>
            <input id={`${id}-pieces`} className={field} type="number" inputMode="numeric" min={1} max={PHOTO_ORDER_LIMITS.maxPieces} step={1} value={pieces} onChange={(e) => setPieces(e.target.value)} />
          </div>
          <div>
            <label htmlFor={`${id}-amount`} className="block text-sm font-semibold text-ink mb-1">
              {t('amount')}
            </label>
            <input id={`${id}-amount`} className={field} type="number" inputMode="decimal" min={1} max={PHOTO_ORDER_LIMITS.maxAmount} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={t('amountPh')} required />
          </div>
        </div>
        <p className="text-xs text-ink-soft" data-testid="photo-order-total-note">{t('totalNote', { delivery: deliveryName })}</p>

        {error && (
          <p role="alert" className="text-xs font-semibold text-danger">
            {error}
          </p>
        )}
        <button type="submit" disabled={!ready} className="w-full min-h-12 rounded-xl bg-ink text-paper text-sm font-bold disabled:opacity-50">
          {t('cont')}
        </button>
      </form>
    </div>
  );
}
