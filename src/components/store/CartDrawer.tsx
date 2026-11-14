'use client';

import React from 'react';
import { CartItem } from '@/types';
import { cartFils, formatAed, lineFils, toFils } from '@/lib/money';
import { piecesLeft, useShop } from '@/lib/client/shop';
import { LocalPrice } from '@/lib/client/currency';
import { encodeBag, inAppBrowser } from '@/lib/client/landing';
import { sheetRow } from '@/lib/measurements';
import { X, Trash2, ArrowRight, ShoppingBag, Truck, ShieldCheck } from 'lucide-react';
import { useLocale, useT, type Words } from '@/lib/i18n';
import { productTitle } from '@/lib/i18n/product';
import { useDialogFocus } from '@/components/common/Sheet';
import { BAG_LIMIT_WORDS, bagLimitMessage, bagOverLimit, deliveryName as deliveryNameIn, payWays, servedPlaces } from './checkoutWords';

const WORDS = {
  title: { en: 'Your bag', ar: 'حقيبتك' },
  item: { en: 'item', ar: 'قطعة' },
  items: { en: 'items', ar: 'قطع' },
  close: { en: 'Close bag', ar: 'إغلاق الحقيبة' },
  toAll: { en: '{name} to {places}', ar: '{name} إلى {places}' },
  empty: { en: 'Your bag is empty', ar: 'حقيبتك فارغة' },
  emptyText: { en: 'Browse our luxury bed sheet collections tailored for UAE homes and add to your bag.', ar: 'تصفّح مجموعات مفارش السرير الفاخرة المصمّمة لبيوت الإمارات وأضف ما يعجبك إلى حقيبتك.' },
  explore: { en: 'Explore the collection', ar: 'استكشف المجموعة' },
  justSoldOut: { en: 'Just sold out: please remove it to check out.', ar: 'نفدت للتو: يُرجى إزالتها لإتمام الطلب.' },
  onlyLeft: { en: 'Only {n} left', ar: 'بقي {n} فقط' },
  fewer: { en: 'One fewer {title}', ar: 'قطعة أقل من {title}' },
  more: { en: 'One more {title}', ar: 'قطعة أخرى من {title}' },
  removeItem: { en: 'Remove item', ar: 'إزالة القطعة' },
  remove: { en: 'Remove {title}', ar: 'إزالة {title}' },
  subtotal: { en: 'Subtotal', ar: 'المجموع الفرعي' },
  delivery: { en: 'Delivery to {places}', ar: 'التوصيل إلى {places}' },
  door: { en: 'Delivered to your door', ar: 'التوصيل حتى باب منزلك' },
  total: { en: 'Total · {name}', ar: 'الإجمالي · {name}' },
  checkout: { en: 'Proceed to Checkout', ar: 'المتابعة لإتمام الطلب' },
  myBag: { en: 'My bag', ar: 'حقيبتي' },
  copiedInApp: { en: 'Link copied: paste it into Safari or Chrome to continue there.', ar: 'تم نسخ الرابط: الصقه في Safari أو Chrome للمتابعة هناك.' },
  copied: { en: 'Link copied.', ar: 'تم نسخ الرابط.' },
  continueBrowser: { en: 'Continue in your browser (copy a link to this bag)', ar: 'تابع في متصفحك (انسخ رابط هذه الحقيبة)' },
  saveLink: { en: 'Save or send this bag as a link', ar: 'احفظ هذه الحقيبة أو أرسلها كرابط' },
} as const satisfies Words;

interface CartDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  items: CartItem[];
  onUpdateQuantity: (index: number, newQty: number) => void;
  onRemoveItem: (index: number) => void;
  onCheckout: () => void;
}

export const CartDrawer: React.FC<CartDrawerProps> = ({
  isOpen,
  onClose,
  items,
  onUpdateQuantity,
  onRemoveItem,
  onCheckout,
}) => {
  const { lowStockThreshold, delivery, pay, bagLimit } = useShop();
  const t = useT(WORDS);
  const tLimit = useT(BAG_LIMIT_WORDS);
  const { locale } = useLocale();
  // Keyboard: focus moves into the bag, Tab stays inside it, Escape closes it.
  const panel = useDialogFocus<HTMLDivElement>(isOpen, onClose);
  if (!isOpen) return null;

  // Standard delivery: what Settings → Delivery calls it and charges (the server charges the same).
  const deliveryName = deliveryNameIn('standard', delivery, locale);
  // Where we deliver and the ways to pay: what the shop's settings say now (never a fixed promise).
  const places = servedPlaces(delivery.emirates, locale);
  // The small bag the server takes while a number is not yet confirmed: said here, before checkout.
  // (Card orders only: checkout says it when Card is chosen.)
  const limit = bagLimit?.applies === 'all' ? bagLimit : null;
  const over = bagOverLimit(items, limit);
  const perItem = (item: CartItem) => items.filter((i) => i.product.id === item.product.id && i.selectedProfile.id === item.selectedProfile.id).reduce((n, i) => n + i.quantity, 0);
  const deliveryFils = toFils(Number(delivery.standardFee) || 0);
  const subtotal = formatAed(cartFils(items));
  const grandTotal = formatAed(cartFils(items) + deliveryFils);
  // A sold-out line (someone bought the last piece) must be removed before checkout.
  const unavailable = items.some((i) => piecesLeft(i.product, i.selectedProfile.id) < i.quantity);

  return (
    <div ref={panel} tabIndex={-1} className="fixed inset-0 z-50 overflow-hidden overscroll-contain outline-none" role="dialog" aria-modal="true" aria-labelledby="bag-title">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-scrim/45 transition-opacity"
        aria-hidden="true"
        onClick={onClose}
      />

      {/* Up to 28rem wide, leaving a strip of the page showing on phones (never wider than the screen). */}
      <div className="fixed top-0 bottom-0 end-0 start-8 sm:start-auto flex justify-end">
        <div className="w-full sm:w-[28rem] h-[100dvh] bg-surface border-s border-line flex flex-col pt-safe pb-safe slide-in-right">
          {/* Header */}
          <div className="sticky top-0 px-4 py-3.5 border-b border-line flex items-center justify-between gap-3 bg-surface">
            <div className="flex items-baseline gap-2.5 min-w-0">
              <h2 id="bag-title" className="font-serif text-2xl text-ink">{t('title')}</h2>
              <span className="label-caps text-ink-muted">
                {items.length} {t(items.length === 1 ? 'item' : 'items')}
              </span>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={t('close')}
              className="shrink-0 w-10 h-10 -me-1.5 flex items-center justify-center text-ink rounded-full hover:bg-sand transition-colors"
            >
              <X className="w-5 h-5" strokeWidth={1.5} />
            </button>
          </div>

          {/* Standard delivery */}
          <div className="px-4 py-2.5 bg-ivory border-b border-line">
            <span className="flex items-center gap-2 text-xs text-ink-soft tracking-[0.02em]">
              <Truck className="w-4 h-4 text-gold-deep" strokeWidth={1.5} />
              <span>{t('toAll', { name: deliveryName, places })}</span>
            </span>
          </div>

          {/* Cart Items List */}
          <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-4 divide-y divide-line">
            {items.length === 0 ? (
              <div className="py-16 text-center text-ink-muted space-y-3">
                <ShoppingBag className="w-12 h-12 mx-auto text-sand stroke-1" />
                <p className="font-serif text-xl text-ink">{t('empty')}</p>
                <p className="text-xs text-ink-muted max-w-xs mx-auto">
                  {t('emptyText')}
                </p>
                <button
                  onClick={onClose}
                  className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-gold-deep hover:underline"
                >
                  {t('explore')}
                </button>
              </div>
            ) : (
              items.map((item, idx) => {
                const itemTotalPrice = formatAed(lineFils(item));
                const left = piecesLeft(item.product, item.selectedProfile.id);
                // The set's sheet, only when the owner gave its size.
                const sheet = sheetRow(item.product, item.selectedProfile);
                return (
                  <div
                    key={`${item.product.id}-${item.selectedProfile.id}-${idx}`}
                    className="flex gap-3.5 py-4 relative min-w-0"
                  >
                    {/* Item Thumbnail */}
                    <div className="w-20 h-24 rounded-md overflow-hidden bg-sand shrink-0">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={item.product.featuredImage}
                        alt={productTitle(item.product, locale)}
                        className="w-full h-full object-cover"
                      />
                    </div>

                    {/* Item Details */}
                    <div className="flex-1 min-w-0 flex flex-col justify-between">
                      <div>
                        {/* Room for the remove button on the page's own side (an English name in the Arabic shop keeps clear of it). */}
                        <div className="pe-8">
                          <h4 className="font-serif text-base leading-snug text-ink line-clamp-2" dir="auto">
                            {productTitle(item.product, locale)}
                          </h4>
                        </div>
                        <div className="flex flex-wrap items-center gap-x-1 text-[11px] text-ink-soft mt-1 min-w-0">
                          <span>{item.selectedProfile.name}</span>
                          {item.selectedColor && (
                            <>
                              <span className="text-sand" aria-hidden="true">•</span>
                              <span className="text-ink-muted font-normal">{item.selectedColor}</span>
                            </>
                          )}
                        </div>
                        {sheet && (
                          <div className="text-[10px] text-ink-soft truncate mt-0.5">
                            {sheet.label}: {sheet.value}
                          </div>
                        )}
                        {left === 0 ? (
                          <div className="text-[10px] font-semibold text-danger mt-0.5" role="status">{t('justSoldOut')}</div>
                        ) : left <= lowStockThreshold ? (
                          <div className="text-[10px] font-semibold text-warning mt-0.5">{t('onlyLeft', { n: left })}</div>
                        ) : null}
                      </div>

                      {/* Quantity & Price */}
                      <div className="flex items-center justify-between gap-2 mt-2.5">
                        <div className="flex items-center border border-line rounded-full bg-surface overflow-hidden">
                          <button
                            type="button"
                            onClick={() => onUpdateQuantity(idx, item.quantity - 1)}
                            aria-label={t('fewer', { title: productTitle(item.product, locale) })}
                            className="w-8 h-8 text-sm text-ink hover:bg-sand"
                          >
                            -
                          </button>
                          <span className="min-w-7 text-center text-xs text-ink">
                            {item.quantity}
                          </span>
                          <button
                            type="button"
                            onClick={() => onUpdateQuantity(idx, item.quantity + 1)}
                            disabled={item.quantity >= left || Boolean(limit && perItem(item) >= limit.perItem)}
                            aria-label={t('more', { title: productTitle(item.product, locale) })}
                            className="w-8 h-8 text-sm text-ink hover:bg-sand disabled:opacity-30"
                          >
                            +
                          </button>
                        </div>

                        <div className="text-end">
                          <span className="text-sm text-ink">
                            AED {itemTotalPrice}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Remove Item */}
                    <button
                      onClick={() => onRemoveItem(idx)}
                      className="absolute top-3 end-0 w-8 h-8 flex items-center justify-center rounded-full text-ink-muted hover:text-danger transition-colors"
                      title={t('removeItem')}
                      aria-label={t('remove', { title: productTitle(item.product, locale) })}
                    >
                      <Trash2 className="w-4 h-4" strokeWidth={1.5} />
                    </button>
                  </div>
                );
              })
            )}
            {items.length > 0 && (
              <div className="py-4 space-y-3">
                <div className="space-y-1.5 text-xs text-ink-soft">
                  <div className="flex flex-wrap justify-between gap-x-3">
                    <span>{t('subtotal')}</span>
                    <span className="text-ink">AED {subtotal}</span>
                  </div>
                  <div className="flex flex-wrap justify-between gap-x-3">
                    <span>{t('delivery', { places })}</span>
                    <span className={deliveryFils ? 'text-ink' : 'text-success'}>{deliveryFils ? `AED ${formatAed(deliveryFils)}` : deliveryName}</span>
                  </div>
                </div>
                {limit && !over && (
                  <p data-testid="bag-limit" className="text-[11px] rounded-xl border px-2.5 py-2 leading-relaxed bg-ivory text-ink-soft border-line">
                    {tLimit('note', { each: limit.perItem, lines: limit.lines })}
                  </p>
                )}
                <BagLinkButton items={items} />
                <p className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[10px] text-ink-soft text-center">
                  <span className="flex items-center gap-1">
                    <ShieldCheck className="w-3.5 h-3.5 text-gold-deep" strokeWidth={1.5} />
                    <span data-testid="bag-pay-ways">{payWays(pay ?? { card: false, bank: false }, locale)}</span>
                  </span>
                  <span>{t('door')}</span>
                </p>
              </div>
            )}
          </div>

          {/* The bag's details scroll with it; the total and the checkout button stay on the screen. */}
          {items.length > 0 && (
            <div className="shrink-0 px-4 pt-3 pb-4 bg-ivory border-t border-line space-y-3">
              {limit && over && (
                <p data-testid="bag-limit" role="alert" className="text-[11px] rounded-xl border px-2.5 py-2 leading-relaxed bg-warning-soft text-warning border-warning-line font-semibold">
                  {bagLimitMessage(over, limit, false, locale)}
                </p>
              )}
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm text-ink">
                <span className="label-caps text-ink-muted">{t('total', { name: deliveryName.toLowerCase() })}</span>
                <span className="text-end tracking-[0.02em]">
                  AED {grandTotal}
                  <LocalPrice aed={Number(grandTotal)} className="text-[10px] block" />
                </span>
              </div>
              <button
                type="button"
                disabled={unavailable || Boolean(over)}
                onClick={() => {
                  onClose();
                  onCheckout();
                }}
                className="w-full bg-ink hover:bg-ink-2 text-ivory font-medium tracking-[0.04em] text-sm py-3.5 px-3 rounded-xl flex items-center justify-center gap-2 transition-colors disabled:opacity-50"
              >
                <span>{t('checkout')}</span>
                <ArrowRight className="w-4 h-4 shrink-0 text-gold-light rtl:-scale-x-100" />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

/**
 * "Save my bag as a link": shoppers coming from Instagram or WhatsApp often
 * browse inside the app's own browser, whose bag is separate from Safari's or
 * Chrome's. The link carries the bag to any browser or device.
 */
function BagLinkButton({ items }: { items: CartItem[] }) {
  const [done, setDone] = React.useState('');
  const t = useT(WORDS);
  const [inApp] = React.useState(() => typeof navigator !== 'undefined' && inAppBrowser());
  const share = async () => {
    const url = `${window.location.origin}/?bag=${encodeBag(items.map((i) => ({ productId: i.product.id, profileId: i.selectedProfile.id, color: i.selectedColor, quantity: i.quantity })))}`;
    try {
      if (navigator.share && !inApp) {
        await navigator.share({ title: t('myBag'), url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setDone(inApp ? t('copiedInApp') : t('copied'));
    } catch {
      setDone('');
    }
  };
  return (
    <div className="text-center">
      <button type="button" onClick={() => void share()} className="text-[11px] font-semibold text-ink underline">
        {inApp ? t('continueBrowser') : t('saveLink')}
      </button>
      {done && <p role="status" className="text-[10px] text-success mt-0.5">{done}</p>}
    </div>
  );
}
