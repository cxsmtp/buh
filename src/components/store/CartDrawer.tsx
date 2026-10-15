'use client';

import React from 'react';
import { CartItem } from '@/types';
import { cartFils, formatAed, lineFils } from '@/lib/money';
import { piecesLeft, useShop } from '@/lib/client/shop';
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
    <div className="fixed inset-0 z-50 overflow-hidden">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity"
        onClick={onClose}
      />

      <div className="fixed inset-y-0 right-0 max-w-full flex pl-10">
        <div className="w-screen max-w-md bg-white shadow-2xl flex flex-col">
          {/* Header */}
          <div className="p-4 border-b border-stone-200 flex items-center justify-between bg-stone-50">
            <div className="flex items-center gap-2">
              <ShoppingBag className="w-5 h-5 text-[#c5a059]" />
              <h2 className="font-serif font-bold text-base text-[#0f1c2e]">Your Shopping Bag</h2>
              <span className="text-xs bg-stone-200 text-stone-700 font-semibold px-2 py-0.5 rounded-full">
                {items.length} {items.length === 1 ? 'item' : 'items'}
              </span>
            </div>
            <button
              onClick={onClose}
              className="p-1.5 text-stone-400 hover:text-stone-700 rounded-full hover:bg-stone-200 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Free delivery */}
          <div className="px-4 py-3 bg-amber-50/70 border-b border-amber-100">
            <span className="flex items-center gap-1 text-xs font-medium text-emerald-700">
              <Truck className="w-3.5 h-3.5 text-[#c5a059]" />
              <strong>Free delivery to all 7 Emirates</strong>
            </span>
          </div>

          {/* Cart Items List */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {items.length === 0 ? (
              <div className="py-16 text-center text-stone-400 space-y-3">
                <ShoppingBag className="w-12 h-12 mx-auto text-stone-300 stroke-1" />
                <p className="text-sm font-medium text-stone-600">Your shopping bag is empty.</p>
                <p className="text-xs text-stone-400 max-w-xs mx-auto">
                  Browse our luxury bed sheet collections tailored for UAE homes and add to your bag.
                </p>
                <button
                  onClick={onClose}
                  className="mt-2 inline-flex items-center gap-1 text-xs font-bold text-[#c5a059] hover:underline"
                >
                  Explore Bed Sheet Sets →
                </button>
              </div>
            ) : (
              items.map((item, idx) => {
                const itemTotalPrice = formatAed(lineFils(item));
                const left = piecesLeft(item.product, item.selectedProfile.id);
                return (
                  <div
                    key={`${item.product.id}-${item.selectedProfile.id}-${idx}`}
                    className="flex gap-3 p-3 bg-stone-50 rounded-2xl border border-stone-200/80 relative"
                  >
                    {/* Item Thumbnail */}
                    <div className="w-20 h-20 rounded-xl overflow-hidden bg-stone-200 shrink-0">
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
                        <h4 className="font-serif font-bold text-xs text-stone-900 truncate">
                          {item.product.title}
                        </h4>
                        <div className="flex items-center gap-1 text-[11px] text-[#c5a059] font-semibold mt-0.5">
                          <span>{item.selectedProfile.name}</span>
                          {item.selectedColor && (
                            <>
                              <span className="text-stone-300">•</span>
                              <span className="text-stone-500 font-normal">{item.selectedColor}</span>
                            </>
                          )}
                        </div>
                        <div className="text-[10px] text-stone-600 truncate mt-0.5">
                          {item.selectedProfile.fittedSheet}
                        </div>
                        {left === 0 ? (
                          <div className="text-[10px] font-bold text-red-700 mt-0.5" role="status">Just sold out: please remove it to check out.</div>
                        ) : left <= lowStockThreshold ? (
                          <div className="text-[10px] font-bold text-amber-700 mt-0.5">Only {left} left</div>
                        ) : null}
                      </div>

                      {/* Quantity & Price */}
                      <div className="flex items-center justify-between mt-2 pt-1 border-t border-stone-200/60">
                        <div className="flex items-center border border-stone-300 rounded-lg bg-white overflow-hidden">
                          <button
                            type="button"
                            onClick={() => onUpdateQuantity(idx, item.quantity - 1)}
                            aria-label={`One fewer ${item.product.title}`}
                            className="px-2 py-0.5 text-xs font-bold text-stone-500 hover:bg-stone-100"
                          >
                            -
                          </button>
                          <span className="px-2.5 py-0.5 text-xs font-semibold text-stone-800">
                            {item.quantity}
                          </span>
                          <button
                            type="button"
                            onClick={() => onUpdateQuantity(idx, item.quantity + 1)}
                            disabled={item.quantity >= left}
                            aria-label={`One more ${item.product.title}`}
                            className="px-2 py-0.5 text-xs font-bold text-stone-500 hover:bg-stone-100 disabled:opacity-30"
                          >
                            +
                          </button>
                        </div>

                        <div className="text-right">
                          <span className="text-xs font-bold text-[#0f1c2e]">
                            AED {itemTotalPrice}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Remove Item */}
                    <button
                      onClick={() => onRemoveItem(idx)}
                      className="absolute top-2 right-2 text-stone-400 hover:text-red-500 p-1 transition-colors"
                      title="Remove item"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })
            )}
          </div>

          {/* Footer with Checkout CTA */}
          {items.length > 0 && (
            <div className="p-4 bg-stone-50 border-t border-stone-200 space-y-3">
              <div className="space-y-1.5 text-xs text-stone-600">
                <div className="flex justify-between">
                  <span>Subtotal</span>
                  <span className="font-semibold text-stone-800">AED {subtotal}</span>
                </div>
                <div className="flex justify-between">
                  <span>UAE Delivery (All 7 Emirates)</span>
                  <span className="font-semibold text-stone-800">
                    <span className="text-emerald-600 font-bold">FREE</span>
                  </span>
                </div>
                <div className="flex justify-between text-sm font-bold text-[#0f1c2e] pt-1.5 border-t border-stone-200">
                  <span>Total Amount</span>
                  <span>AED {grandTotal}</span>
                </div>
              </div>

              <button
                type="button"
                disabled={unavailable}
                onClick={() => {
                  onClose();
                  onCheckout();
                }}
                className="w-full bg-[#0f1c2e] hover:bg-stone-800 active:scale-95 text-white font-bold text-sm py-3.5 rounded-xl shadow-lg flex items-center justify-center gap-2 transition-all disabled:opacity-50"
              >
                <span>Proceed to Checkout</span>
                <ArrowRight className="w-4 h-4 text-amber-300" />
              </button>

              <div className="flex items-center justify-center gap-3 text-[10px] text-stone-600 text-center">
                <span className="flex items-center gap-1">
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
                  COD / Bank Transfer
                </span>
                <span>•</span>
                <span>Priority UAE Doorstep Delivery</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
