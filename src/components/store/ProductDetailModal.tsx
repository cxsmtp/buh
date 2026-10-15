'use client';

import React, { useState } from 'react';
import { Product, BedProfileMeasurement } from '@/types';
import { formatAed, toFils } from '@/lib/money';
import { piecesLeft, useShop, whatsappLink } from '@/lib/client/shop';
import { X, Sparkles, Check, Truck, ShieldCheck, Ruler, Layers, ChevronRight, MessageCircle } from 'lucide-react';

interface ProductDetailModalProps {
  product: Product | null;
  onClose: () => void;
  onAddToCart: (product: Product, profile: BedProfileMeasurement, color: string, quantity: number) => void;
}

export const ProductDetailModal: React.FC<ProductDetailModalProps> = (props) => {
  // Keyed by product so choices reset when another product opens, and so the
  // hooks below always run in the same order.
  if (!props.product) return null;
  return <ProductDetailContent key={props.product.id} {...props} product={props.product} />;
};

const ProductDetailContent: React.FC<ProductDetailModalProps & { product: Product }> = ({
  product,
  onClose,
  onAddToCart,
}) => {

  const { store, lowStockThreshold, supportEmail } = useShop();
  // Start on the default size if it is in stock, else the first size that is.
  const inStock = (id: string) => piecesLeft(product, id) > 0;
  const initialProfile =
    product.profiles.find((p) => p.id === product.defaultProfileId && inStock(p.id)) ||
    product.profiles.find((p) => inStock(p.id)) ||
    product.profiles.find((p) => p.id === product.defaultProfileId) ||
    product.profiles[0];
  const [selectedProfile, setSelectedProfile] = useState<BedProfileMeasurement>(initialProfile);
  const [selectedColor, setSelectedColor] = useState<string>(product.colors[0]?.name || 'Standard');
  const [quantity, setQuantity] = useState<number>(1);
  const [activeImageIndex, setActiveImageIndex] = useState<number>(0);

  // Gallery images list (showcase images)
  const allImages = [
    product.aiTransformedImage || product.featuredImage,
    ...(product.galleryImages || []),
  ].filter(Boolean);

  const currentMainImage = allImages[activeImageIndex] || product.featuredImage;

  // Calculate final unit price based on selected size profile
  const unitFils = toFils(product.price) + toFils(selectedProfile.priceDelta || 0);
  const unitPrice = formatAed(unitFils);
  const left = piecesLeft(product, selectedProfile.id);
  const soldOut = left === 0;
  const qty = Math.min(quantity, Math.max(1, left));
  const totalPrice = formatAed(unitFils * qty);

  const handleAddToCart = () => {
    if (soldOut) return;
    onAddToCart(product, selectedProfile, selectedColor, qty);
    onClose();
  };

  const inquiry = whatsappLink(
    store,
    soldOut
      ? `Hello! ${product.title} in ${selectedProfile.name} shows as sold out. Will it come back, or is there something similar?`
      : `Hello! I have a question about ${product.title} in ${selectedProfile.name} (AED ${unitPrice}).`
  );
  const emailInquiry = `mailto:${supportEmail}?subject=${encodeURIComponent(`${product.title} (${selectedProfile.name})`)}`;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-0 sm:p-4 md:p-6 overflow-y-auto">
      <div className="bg-white w-full max-w-2xl md:max-w-5xl sm:rounded-3xl max-h-[94vh] flex flex-col overflow-hidden shadow-2xl animate-in slide-in-from-bottom duration-200">
        {/* Modal Header */}
        <div className="px-4 sm:px-6 py-3.5 border-b border-stone-200 flex items-center justify-between bg-stone-50">
          <div className="flex items-center gap-2">
            <span className="font-serif font-bold text-sm sm:text-base text-[#0f1c2e]">
              Beautiful UAE Home • Artisan Sizing & Specifications
            </span>
            <span className="text-[10px] bg-amber-100 text-amber-900 border border-amber-300 font-semibold px-2 py-0.5 rounded-full hidden xs:inline-block">
              UAE Standard Sizes
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-stone-500 hover:text-stone-800 rounded-full hover:bg-stone-200 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Scrollable Body: 2 Columns on Laptop / Tablet, 1 Column on Mobile */}
        <div className="p-4 sm:p-6 overflow-y-auto flex-1 md:grid md:grid-cols-12 md:gap-8 space-y-6 md:space-y-0">
          
          {/* LEFT COLUMN: Visual Media Showcase in One Go */}
          <div className="md:col-span-6 space-y-3">
            <div className="relative aspect-[4/3] sm:aspect-[16/11] bg-stone-100 rounded-2xl overflow-hidden shadow-sm border border-stone-200 group">
              {/* Main High-Res Image */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={currentMainImage}
                alt={product.title}
                className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-102"
              />

              {/* Luxury Badge */}
              <div className="absolute top-3 left-3 bg-[#0f1c2e]/85 backdrop-blur-md text-amber-200 text-[10px] font-semibold px-3 py-1 rounded-full shadow border border-amber-300/30 flex items-center gap-1.5">
                <Sparkles className="w-3 h-3 text-[#c5a059]" />
                <span>Handprinted Block Linen</span>
              </div>

              {/* Bottom Spec Badge */}
              <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between text-[10px] bg-black/65 backdrop-blur-md text-white px-3 py-1.5 rounded-xl">
                <span>{product.material}</span>
                <span className="font-bold text-amber-300">40cm Deep Mattress Pocket</span>
              </div>
            </div>

            {/* Thumbnail Gallery Strip */}
            {allImages.length > 1 && (
              <div className="flex items-center gap-2 overflow-x-auto no-scrollbar py-1">
                {allImages.map((img, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => setActiveImageIndex(idx)}
                    className={`relative w-16 h-16 rounded-xl overflow-hidden shrink-0 border-2 transition-all ${
                      activeImageIndex === idx
                        ? 'border-[#c5a059] ring-2 ring-amber-300/50 scale-102'
                        : 'border-stone-200 hover:border-stone-300 opacity-75 hover:opacity-100'
                    }`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={img}
                      alt={`Thumbnail ${idx + 1}`}
                      className="w-full h-full object-cover"
                    />
                  </button>
                ))}
              </div>
            )}

            {/* Quality & Craftsmanship Summary */}
            <div className="text-[11px] text-stone-500 font-medium pt-1 flex items-center justify-between">
              <span>{product.threadCount} TC • {product.weave} Weave</span>
              <span className="text-emerald-700 font-semibold">✓ 100% Fit Guarantee</span>
            </div>

            {/* Quality & Craftsmanship Summary (Desktop left column addition) */}
            <div className="hidden md:block bg-stone-50 rounded-2xl p-4 border border-stone-200 text-xs space-y-2">
              <span className="font-bold text-stone-900 block uppercase tracking-wider text-[11px]">
                Artisanal Provenance & Fit Guarantee
              </span>
              <p className="text-stone-600 leading-relaxed text-[11px]">
                Handcrafted using ancestral block stamps and skin-safe mineral dyes. Every fitted sheet features deep 40cm elasticated pockets designed specifically to hug thick pillow-top luxury mattresses in UAE residences without corner slip-offs.
              </p>
              <div className="flex items-center gap-4 text-stone-700 text-[11px] pt-1 font-medium">
                <span className="flex items-center gap-1">
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
                  Pre-Washed & Colorfast
                </span>
                <span className="flex items-center gap-1">
                  <Truck className="w-3.5 h-3.5 text-[#c5a059]" />
                  Complimentary UAE Delivery
                </span>
              </div>
            </div>
          </div>

          {/* RIGHT COLUMN: Details, Sizes, Measurements Table & Actions (col-span-6 on desktop) */}
          <div className="md:col-span-6 space-y-5 flex flex-col justify-between">
            <div className="space-y-4">
              {/* Product Title & Basic Info */}
              <div>
                <h2 className="font-serif text-lg sm:text-2xl font-bold text-stone-900 leading-snug">
                  {product.title}
                </h2>
                <p className="text-xs sm:text-sm text-stone-600 mt-1.5 leading-relaxed">
                  {product.description}
                </p>
              </div>

              {/* 1. SELECT BED SIZE PROFILE */}
              <div className="space-y-2 pt-2 border-t border-stone-200">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-bold text-stone-900 uppercase tracking-wider flex items-center gap-1.5">
                    <Ruler className="w-4 h-4 text-[#c5a059]" />
                    <span>1. Select Bed Profile & Size:</span>
                  </label>
                  <span className="text-[11px] text-[#c5a059] font-medium">
                    {selectedProfile.name}
                  </span>
                </div>

                {/* Profile Selection Pills */}
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {product.profiles.map((profile) => {
                    const isSelected = selectedProfile.id === profile.id;
                    const pieces = piecesLeft(product, profile.id);
                    return (
                      <button
                        key={profile.id}
                        type="button"
                        aria-pressed={isSelected}
                        aria-label={`${profile.name}${pieces === 0 ? ', sold out' : pieces <= lowStockThreshold ? `, only ${pieces} left` : ''}`}
                        onClick={() => {
                          setSelectedProfile(profile);
                          setQuantity(1);
                        }}
                        className={`p-2.5 rounded-xl text-left border transition-all relative ${
                          isSelected
                            ? 'border-[#0f1c2e] bg-[#0f1c2e] text-white shadow-md ring-2 ring-[#c5a059]/40'
                            : pieces === 0
                            ? 'border-stone-200 bg-stone-50 text-stone-400'
                            : 'border-stone-200 bg-white text-stone-800 hover:border-stone-400'
                        }`}
                      >
                        {pieces === 0 ? (
                          <span className="absolute -top-2 right-2 text-[9px] font-bold uppercase bg-stone-500 text-white px-1.5 rounded">Sold out</span>
                        ) : pieces <= lowStockThreshold ? (
                          <span className="absolute -top-2 right-2 text-[9px] font-bold uppercase bg-amber-500 text-white px-1.5 rounded">Only {pieces} left</span>
                        ) : null}
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs font-bold">{profile.name.split(' ')[0]}</span>
                          {isSelected ? (
                            <Check className="w-3.5 h-3.5 text-amber-300" />
                          ) : (
                            <span className="text-[10px] text-stone-500 font-medium">
                              {profile.priceDelta > 0 ? `+AED ${profile.priceDelta}` : 'Standard'}
                            </span>
                          )}
                        </div>
                        <div className={`text-[10px] leading-tight truncate ${isSelected ? 'text-amber-200' : 'text-stone-500'}`}>
                          {profile.mattressSize.split('(')[0]}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 2. EXACT MEASUREMENTS TABLE (Customer Shopping View) */}
              <div className="bg-gradient-to-br from-amber-50/50 via-stone-50 to-amber-50/30 rounded-2xl p-3.5 sm:p-4 border border-amber-200/60 shadow-sm space-y-2.5">
                <div className="flex items-center justify-between border-b border-amber-200/50 pb-2">
                  <div className="flex items-center gap-1.5">
                    <Layers className="w-4 h-4 text-[#c5a059]" />
                    <span className="text-xs font-bold text-stone-900">
                      Exact Measurements for {selectedProfile.name}
                    </span>
                  </div>
                  <span className="text-[11px] font-bold px-2.5 py-0.5 rounded-full bg-amber-200 text-amber-900">
                    {selectedProfile.piecesIncluded} Pieces Complete Set
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                  {/* Mattress Fit */}
                  <div className="bg-white p-2.5 rounded-xl border border-stone-200/70">
                    <span className="text-[10px] text-stone-500 block font-medium">Mattress Fit</span>
                    <span className="font-semibold text-stone-900">{selectedProfile.mattressSize}</span>
                  </div>

                  {/* Fitted Sheet */}
                  <div className="bg-white p-2.5 rounded-xl border border-stone-200/70">
                    <span className="text-[10px] text-stone-500 block font-medium">Fitted Sheet</span>
                    <span className="font-semibold text-stone-900">{selectedProfile.fittedSheet}</span>
                  </div>

                  {/* Flat Sheet */}
                  <div className="bg-white p-2.5 rounded-xl border border-stone-200/70">
                    <span className="text-[10px] text-stone-500 block font-medium">Flat Top Sheet</span>
                    <span className="font-semibold text-stone-900">{selectedProfile.flatSheet}</span>
                  </div>

                  {/* Pillowcases */}
                  <div className="bg-white p-2.5 rounded-xl border border-stone-200/70">
                    <span className="text-[10px] text-stone-500 block font-medium">Pillowcases</span>
                    <span className="font-semibold text-stone-900">{selectedProfile.pillowcases}</span>
                  </div>

                  {/* Duvet Cover if included */}
                  {selectedProfile.duvetCover && (
                    <div className="bg-white p-2.5 rounded-xl border border-stone-200/70 sm:col-span-2">
                      <span className="text-[10px] text-stone-500 block font-medium">Duvet Cover / Blanket Drape</span>
                      <span className="font-semibold text-stone-900">{selectedProfile.duvetCover}</span>
                    </div>
                  )}
                </div>

                <p className="text-[10px] text-stone-500 italic">
                  * Tailored to hug deep-pocket UAE luxury mattresses up to 40cm height seamlessly.
                </p>
              </div>

              {/* 3. COLOR SELECTOR */}
              <div className="space-y-2">
                <label className="text-xs font-bold text-stone-900 uppercase tracking-wider block">
                  2. Select Palette: <span className="font-normal text-stone-600">{selectedColor}</span>
                </label>
                <div className="flex items-center gap-2 flex-wrap">
                  {product.colors.map((c) => {
                    const isSelected = selectedColor === c.name;
                    return (
                      <button
                        key={c.name}
                        onClick={() => setSelectedColor(c.name)}
                        className={`flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs border transition-all ${
                          isSelected
                            ? 'border-[#0f1c2e] bg-[#0f1c2e] text-white shadow-sm ring-1 ring-[#c5a059]'
                            : 'border-stone-200 bg-white text-stone-700 hover:bg-stone-50'
                        }`}
                      >
                        <span
                          className="w-3.5 h-3.5 rounded-full border border-stone-300 shadow-inner"
                          style={{ backgroundColor: c.hex }}
                        ></span>
                        <span>{c.name}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 4. QUANTITY & WHATSAPP */}
              <div className="flex items-center justify-between gap-3 pt-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-stone-600 font-medium">Quantity:</span>
                  <div className="flex items-center border border-stone-300 rounded-lg overflow-hidden bg-white">
                    <button
                      type="button"
                      onClick={() => setQuantity(Math.max(1, qty - 1))}
                      disabled={qty <= 1}
                      aria-label="One fewer"
                      className="px-3 py-1 text-sm font-bold text-stone-600 hover:bg-stone-100 disabled:opacity-30"
                    >
                      -
                    </button>
                    <span className="px-3.5 py-1 text-xs font-bold text-stone-900" aria-live="polite">{soldOut ? 0 : qty}</span>
                    <button
                      type="button"
                      onClick={() => setQuantity(Math.min(left, qty + 1))}
                      disabled={qty >= left}
                      aria-label="One more"
                      className="px-3 py-1 text-sm font-bold text-stone-600 hover:bg-stone-100 disabled:opacity-30"
                    >
                      +
                    </button>
                  </div>
                </div>

                {/* WhatsApp Quick Ask (the shop's number from Settings), else email */}
                <a
                  href={inquiry ?? emailInquiry}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-xs text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-300 px-3.5 py-2 rounded-xl transition-colors font-medium"
                >
                  <MessageCircle className="w-3.5 h-3.5" />
                  <span>{inquiry ? 'Ask on WhatsApp' : 'Ask by email'}</span>
                </a>
              </div>

              {/* Delivery Note */}
              <div className="bg-stone-100 rounded-xl p-3 flex items-center justify-between text-[11px] text-stone-600">
                <div className="flex items-center gap-1.5">
                  <Truck className="w-4 h-4 text-[#c5a059]" />
                  <span>UAE Express Delivery: <strong>24-48 Hours across all Emirates</strong></span>
                </div>
                <div className="flex items-center gap-1">
                  <ShieldCheck className="w-4 h-4 text-emerald-600" />
                  <span>Cash on Delivery & Bank Transfer</span>
                </div>
              </div>
            </div>

            {/* Desktop / Mobile Bottom Action Bar */}
            <div className="pt-4 border-t border-stone-200 flex items-center justify-between gap-4 mt-auto">
              <div>
                <div className="text-[10px] text-stone-500 uppercase font-semibold">Total Price</div>
                <div className="text-2xl font-bold text-[#0f1c2e]">AED {totalPrice}</div>
                <div className="text-[10px] text-emerald-600 font-semibold">Complimentary UAE Delivery</div>
              </div>

              {soldOut ? (
                <a
                  href={inquiry ?? emailInquiry}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 bg-stone-200 text-stone-700 font-bold text-sm py-3.5 px-6 rounded-xl flex items-center justify-center gap-2"
                >
                  <span>{selectedProfile.name.split(' ')[0]} sold out · Ask us</span>
                </a>
              ) : (
                <button
                  type="button"
                  onClick={handleAddToCart}
                  className="flex-1 bg-gradient-to-r from-[#c5a059] to-[#dfc082] hover:brightness-105 active:scale-95 text-[#0f1c2e] font-bold text-sm py-3.5 px-6 rounded-xl shadow-lg flex items-center justify-center gap-2 transition-all"
                >
                  <span>Add to Bag ({selectedProfile.name.split(' ')[0]})</span>
                  <ChevronRight className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
