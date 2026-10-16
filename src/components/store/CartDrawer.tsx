'use client';

import React from 'react';
import { CartItem } from '@/types';
import { cartFils, formatAed, lineFils } from '@/lib/money';
import { piecesLeft, useShop } from '@/lib/client/shop';
import { LocalPrice } from '@/lib/client/currency';
import { encodeBag, inAppBrowser } from '@/lib/client/landing';
import { X, Trash2, ArrowRight, ShoppingBag, Truck, ShieldCheck } from 'lucide-react';

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
  const { lowStockThreshold } = useShop();
  if (!isOpen) return null;

  // Delivery is free across the UAE (the server charges no delivery fee).
  const subtotal = formatAed(cartFils(items));
  const grandTotal = subtotal;
  // A sold-out line (someone bought the last piece) must be removed before checkout.
  const unavailable = items.some((i) => piecesLeft(i.product, i.selectedProfile.id) < i.quantity);

  return (
    <div className="fixed inset-0 z-50 overflow-hidden overscroll-contain" role="dialog" aria-modal="true" aria-labelledby="bag-title">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-ink/45 transition-opacity"
        aria-hidden="true"
        onClick={onClose}
      />

      {/* Up to 28rem wide, leaving a strip of the page showing on phones (never wider than the screen). */}
      <div className="fixed top-0 bottom-0 right-0 left-8 sm:left-auto flex justify-end">
        <div className="w-full sm:w-[28rem] h-[100dvh] bg-surface border-l border-line flex flex-col pt-safe pb-safe slide-in-right">
          {/* Header */}
          <div className="sticky top-0 px-4 py-3.5 border-b border-line flex items-center justify-between gap-3 bg-surface">
            <div className="flex items-baseline gap-2.5 min-w-0">
              <h2 id="bag-title" className="font-serif text-2xl text-ink">Your bag</h2>
              <span className="label-caps text-ink-muted">
                {items.length} {items.length === 1 ? 'item' : 'items'}
              </span>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close bag"
              className="shrink-0 w-10 h-10 -mr-1.5 flex items-center justify-center text-ink rounded-full hover:bg-sand transition-colors"
            >
              <X className="w-5 h-5" strokeWidth={1.5} />
            </button>
          </div>

          {/* Free delivery */}
          <div className="px-4 py-2.5 bg-ivory border-b border-line">
            <span className="flex items-center gap-2 text-xs text-ink-soft tracking-[0.02em]">
              <Truck className="w-4 h-4 text-gold-deep" strokeWidth={1.5} />
              <span>Free delivery to all seven emirates</span>
            </span>
          </div>

          {/* Cart Items List */}
          <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-4 divide-y divide-line">
            {items.length === 0 ? (
              <div className="py-16 text-center text-ink-muted space-y-3">
                <ShoppingBag className="w-12 h-12 mx-auto text-sand stroke-1" />
                <p className="font-serif text-xl text-ink">Your bag is empty</p>
                <p className="text-xs text-ink-muted max-w-xs mx-auto">
                  Browse our luxury bed sheet collections tailored for UAE homes and add to your bag.
                </p>
                <button
                  onClick={onClose}
                  className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-gold-deep hover:underline"
                >
                  Explore the collection
                </button>
              </div>
            ) : (
              items.map((item, idx) => {
                const itemTotalPrice = formatAed(lineFils(item));
                const left = piecesLeft(item.product, item.selectedProfile.id);
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
                        alt={item.product.title}
                        className="w-full h-full object-cover"
                      />
                    </div>

                    {/* Item Details */}
                    <div className="flex-1 min-w-0 flex flex-col justify-between">
                      <div>
                        <h4 className="font-serif text-base leading-snug text-ink line-clamp-2 pr-8">
                          {item.product.title}
                        </h4>
                        <div className="flex flex-wrap items-center gap-x-1 text-[11px] text-ink-soft mt-1 min-w-0">
                          <span>{item.selectedProfile.name}</span>
                          {item.selectedColor && (
                            <>
                              <span className="text-sand" aria-hidden="true">•</span>
                              <span className="text-ink-muted font-normal">{item.selectedColor}</span>
                            </>
                          )}
                        </div>
                        <div className="text-[10px] text-ink-soft truncate mt-0.5">
                          {item.selectedProfile.fittedSheet}
                        </div>
                        {left === 0 ? (
                          <div className="text-[10px] font-semibold text-danger mt-0.5" role="status">Just sold out: please remove it to check out.</div>
                        ) : left <= lowStockThreshold ? (
                          <div className="text-[10px] font-semibold text-warning mt-0.5">Only {left} left</div>
                        ) : null}
                      </div>

                      {/* Quantity & Price */}
                      <div className="flex items-center justify-between gap-2 mt-2.5">
                        <div className="flex items-center border border-line rounded-full bg-surface overflow-hidden">
                          <button
                            type="button"
                            onClick={() => onUpdateQuantity(idx, item.quantity - 1)}
                            aria-label={`One fewer ${item.product.title}`}
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
                            disabled={item.quantity >= left}
                            aria-label={`One more ${item.product.title}`}
                            className="w-8 h-8 text-sm text-ink hover:bg-sand disabled:opacity-30"
                          >
                            +
                          </button>
                        </div>

                        <div className="text-right">
                          <span className="text-sm text-ink">
                            AED {itemTotalPrice}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Remove Item */}
                    <button
                      onClick={() => onRemoveItem(idx)}
                      className="absolute top-3 right-0 w-8 h-8 flex items-center justify-center rounded-full text-ink-muted hover:text-danger transition-colors"
                      title="Remove item"
                      aria-label={`Remove ${item.product.title}`}
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
                    <span>Subtotal</span>
                    <span className="text-ink">AED {subtotal}</span>
                  </div>
                  <div className="flex flex-wrap justify-between gap-x-3">
                    <span>Delivery to all seven emirates</span>
                    <span className="text-success">Free</span>
                  </div>
                </div>
                <BagLinkButton items={items} />
                <p className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[10px] text-ink-soft text-center">
                  <span className="flex items-center gap-1">
                    <ShieldCheck className="w-3.5 h-3.5 text-gold-deep" strokeWidth={1.5} />
                    Cash on delivery or bank transfer
                  </span>
                  <span>Delivered to your door</span>
                </p>
              </div>
            )}
          </div>

          {/* The bag's details scroll with it; the total and the checkout button stay on the screen. */}
          {items.length > 0 && (
            <div className="shrink-0 px-4 pt-3 pb-4 bg-ivory border-t border-line space-y-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm text-ink">
                <span className="label-caps text-ink-muted">Total · free delivery</span>
                <span className="text-right tracking-[0.02em]">
                  AED {grandTotal}
                  <LocalPrice aed={Number(grandTotal)} className="text-[10px] block" />
                </span>
              </div>
              <button
                type="button"
                disabled={unavailable}
                onClick={() => {
                  onClose();
                  onCheckout();
                }}
                className="w-full bg-ink hover:bg-ink-2 text-ivory font-medium tracking-[0.04em] text-sm py-3.5 px-3 rounded-xl flex items-center justify-center gap-2 transition-colors disabled:opacity-50"
              >
                <span>Proceed to Checkout</span>
                <ArrowRight className="w-4 h-4 shrink-0 text-gold-light" />
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
  const [inApp] = React.useState(() => typeof navigator !== 'undefined' && inAppBrowser());
  const share = async () => {
    const url = `${window.location.origin}/?bag=${encodeBag(items.map((i) => ({ productId: i.product.id, profileId: i.selectedProfile.id, color: i.selectedColor, quantity: i.quantity })))}`;
    try {
      if (navigator.share && !inApp) {
        await navigator.share({ title: 'My bag', url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setDone(inApp ? 'Link copied: paste it into Safari or Chrome to continue there.' : 'Link copied.');
    } catch {
      setDone('');
    }
  };
  return (
    <div className="text-center">
      <button type="button" onClick={() => void share()} className="text-[11px] font-semibold text-ink underline">
        {inApp ? 'Continue in your browser (copy a link to this bag)' : 'Save or send this bag as a link'}
      </button>
      {done && <p role="status" className="text-[10px] text-success mt-0.5">{done}</p>}
    </div>
  );
}
