'use client';

import React, { useState } from 'react';
import { Product, BedProfileMeasurement } from '@/types';
import { formatAed, toFils } from '@/lib/money';
import { askWhatsAppLink, instagramLink, openChat, piecesLeft, useShop } from '@/lib/client/shop';
import { isOnSale, shortSize } from '@/lib/catalogFilter';
import { InstagramIcon } from '@/components/common/InstagramIcon';
import { Sheet } from '@/components/common/Sheet';
import { LocalPrice } from '@/lib/client/currency';
import { PhotoCarousel } from './PhotoCarousel';
import { X, Check, Truck, ShieldCheck, Ruler, MessageCircle, MessagesSquare, Share2, Minus, Plus } from 'lucide-react';

interface ProductDetailModalProps {
  product: Product | null;
  onClose: () => void;
  onAddToCart: (product: Product, profile: BedProfileMeasurement, color: string, quantity: number) => void;
}

/**
 * A product, full screen on phones (like opening a post): swipeable photos, the name and price,
 * sizes with what is left of each, colours, Add to Bag, and Ask in chat / on WhatsApp / on
 * Instagram. On a computer, a dialog with the photos beside the details.
 */
export const ProductDetailModal: React.FC<ProductDetailModalProps> = (props) => {
  // Keyed by product so choices reset when another product opens, and so the
  // hooks below always run in the same order.
  if (!props.product) return null;
  return <ProductDetailContent key={props.product.id} {...props} product={props.product} />;
};

const ProductDetailContent: React.FC<ProductDetailModalProps & { product: Product }> = ({ product, onClose, onAddToCart }) => {
  const { store, lowStockThreshold, supportEmail, chat, delivery } = useShop();
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

  const images = [product.aiTransformedImage || product.featuredImage, ...(product.galleryImages || [])].filter((x, i, all): x is string => Boolean(x) && all.indexOf(x) === i);

  // The price for the chosen size (sizes can cost more), in fils like the server.
  const unitFils = toFils(product.price) + toFils(selectedProfile.priceDelta || 0);
  const unitPrice = formatAed(unitFils);
  const left = piecesLeft(product, selectedProfile.id);
  const soldOut = left === 0;
  const qty = Math.min(quantity, Math.max(1, left));
  const totalPrice = formatAed(unitFils * qty);
  const sale = isOnSale(product);
  const wasFils = sale ? toFils(product.compareAtPrice!) + toFils(selectedProfile.priceDelta || 0) : 0;
  const sizeShort = shortSize(selectedProfile.name);

  const handleAddToCart = () => {
    if (soldOut) return;
    onAddToCart(product, selectedProfile, selectedColor, qty);
    onClose();
  };

  const inquiry = askWhatsAppLink(
    store,
    soldOut
      ? `Hello! ${product.title} in ${selectedProfile.name} shows as sold out. Will it come back, or is there something similar?`
      : `Hello! I have a question about ${product.title} in ${selectedProfile.name} (AED ${unitPrice}).`
  );
  const instagram = instagramLink(store);
  const [igNote, setIgNote] = useState('');
  // Instagram can't pre-fill a message: copy the product's link so the customer can paste it.
  const copyLinkForInstagram = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/p/${encodeURIComponent(product.id)}`);
      setIgNote('Link to this product copied: paste it in your Instagram message.');
    } catch {
      setIgNote('Tell us the product name in your Instagram message.');
    }
  };
  // Share this product: the phone's share sheet, or WhatsApp.
  const share = async () => {
    const url = `${window.location.origin}/p/${encodeURIComponent(product.id)}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: product.title, text: `${product.title} · AED ${unitPrice}`, url });
        return;
      }
    } catch {
      return; // the customer closed the share sheet
    }
    window.open(`https://wa.me/?text=${encodeURIComponent(`${product.title} · AED ${unitPrice}\n${url}`)}`, '_blank', 'noopener');
  };
  const emailInquiry = `mailto:${supportEmail}?subject=${encodeURIComponent(`${product.title} (${selectedProfile.name})`)}`;
  const titleId = `product-title-${product.id}`;
  const askClass = 'inline-flex items-center gap-1.5 text-xs font-medium px-3.5 py-2.5 rounded-full border transition-colors';

  return (
    <Sheet labelledBy={titleId} onClose={onClose} variant="full" wide>
      {/* Top bar: close, name (once scrolled), share */}
      <div className="flex items-center gap-2 px-2 sm:px-3 h-12 border-b border-stone-200 shrink-0 bg-white">
        <button type="button" onClick={onClose} aria-label="Close" data-autofocus className="w-10 h-10 rounded-full flex items-center justify-center text-stone-800 hover:bg-stone-100">
          <X className="w-5 h-5" aria-hidden="true" />
        </button>
        <span className="flex-1 min-w-0 truncate text-sm font-semibold text-stone-900 md:invisible" aria-hidden="true">
          {product.title}
        </span>
        <button type="button" onClick={() => void share()} aria-label="Share" className="w-10 h-10 rounded-full flex items-center justify-center text-stone-800 hover:bg-stone-100">
          <Share2 className="w-5 h-5" aria-hidden="true" />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain md:grid md:grid-cols-2 md:grid-rows-[minmax(0,1fr)] md:overflow-hidden">
        <div className="md:overflow-y-auto md:p-5">
          <div className="md:rounded-2xl md:overflow-hidden">
            <PhotoCarousel images={images} title={product.title}>
              {sale && (
                <span className="absolute top-3 left-3 rounded-full bg-white/95 text-[#7a2e1d] text-[11px] font-bold uppercase tracking-wider px-2.5 py-1 shadow-sm">Sale</span>
              )}
            </PhotoCarousel>
          </div>
        </div>

        <div className="md:overflow-y-auto px-4 sm:px-5 pt-4 pb-6 space-y-5">
          <div className="space-y-1.5">
            <h2 id={titleId} className="font-serif text-xl sm:text-2xl leading-snug text-stone-900">
              {product.title}
            </h2>
            <p className="flex items-baseline flex-wrap gap-x-2">
              <span className="text-xl font-semibold text-[#0f1c2e]">{`AED ${unitPrice}`}</span>
              {sale && (
                <span className="text-sm text-stone-600 line-through">
                  <span className="sr-only">was </span>
                  {`AED ${formatAed(wasFils)}`}
                </span>
              )}
              <LocalPrice aed={Number(unitPrice)} className="text-xs" />
            </p>
            <p className="text-xs text-stone-600">
              {product.material} · {product.threadCount} TC · {product.weave}
            </p>
          </div>

          {/* Size */}
          <fieldset className="space-y-2">
            <legend className="text-xs font-bold text-stone-900 uppercase tracking-wider flex items-center gap-1.5 mb-2">
              <Ruler className="w-4 h-4 text-[#9f7e38]" aria-hidden="true" />
              Size: <span className="font-medium normal-case tracking-normal text-stone-700">{selectedProfile.name}</span>
            </legend>
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
                    className={`px-3 py-2 rounded-xl text-left border transition-colors ${
                      isSelected ? 'border-[#0f1c2e] bg-[#0f1c2e] text-white' : pieces === 0 ? 'border-stone-200 bg-stone-50 text-stone-600' : 'border-stone-300 bg-white text-stone-900 hover:border-stone-500'
                    }`}
                  >
                    <span className="flex items-center justify-between gap-1">
                      <span className={`text-sm font-semibold ${pieces === 0 && !isSelected ? 'line-through' : ''}`}>{shortSize(profile.name)}</span>
                      {isSelected && <Check className="w-4 h-4 text-amber-200" aria-hidden="true" />}
                    </span>
                    <span className={`block text-[11px] leading-tight truncate ${isSelected ? 'text-amber-100' : 'text-stone-600'}`}>
                      {pieces === 0 ? 'Sold out' : pieces <= lowStockThreshold ? `Only ${pieces} left` : profile.mattressSize.split('(')[0].trim()}
                      {profile.priceDelta > 0 && pieces > 0 ? ` · +AED ${profile.priceDelta}` : ''}
                    </span>
                  </button>
                );
              })}
            </div>
            <details className="rounded-xl border border-stone-200 bg-[#fbf9f5] text-xs">
              <summary className="cursor-pointer px-3 py-2.5 font-semibold text-stone-800">Measurements for {sizeShort} ({selectedProfile.piecesIncluded} pieces)</summary>
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 px-3 pb-3 text-stone-900">
                <div><dt className="text-[11px] text-stone-600">Mattress</dt><dd className="font-medium">{selectedProfile.mattressSize}</dd></div>
                <div><dt className="text-[11px] text-stone-600">Fitted sheet</dt><dd className="font-medium">{selectedProfile.fittedSheet}</dd></div>
                <div><dt className="text-[11px] text-stone-600">Flat sheet</dt><dd className="font-medium">{selectedProfile.flatSheet}</dd></div>
                <div><dt className="text-[11px] text-stone-600">Pillowcases</dt><dd className="font-medium">{selectedProfile.pillowcases}</dd></div>
                {selectedProfile.duvetCover && (
                  <div className="sm:col-span-2"><dt className="text-[11px] text-stone-600">Duvet cover</dt><dd className="font-medium">{selectedProfile.duvetCover}</dd></div>
                )}
              </dl>
            </details>
          </fieldset>

          {/* Colour */}
          {product.colors.length > 0 && (
            <fieldset className="space-y-2">
              <legend className="text-xs font-bold text-stone-900 uppercase tracking-wider mb-2">
                Colour: <span className="font-medium normal-case tracking-normal text-stone-700">{selectedColor}</span>
              </legend>
              <div className="flex items-center gap-2 flex-wrap">
                {product.colors.map((c) => {
                  const isSelected = selectedColor === c.name;
                  return (
                    <button
                      key={c.name}
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => setSelectedColor(c.name)}
                      className={`flex items-center gap-2 pl-1.5 pr-3 py-1.5 rounded-full text-xs border transition-colors ${
                        isSelected ? 'border-[#0f1c2e] ring-1 ring-[#0f1c2e] bg-white text-stone-900 font-semibold' : 'border-stone-300 bg-white text-stone-800 hover:border-stone-500'
                      }`}
                    >
                      <span className="w-5 h-5 rounded-full border border-stone-300" style={{ backgroundColor: c.hex }} aria-hidden="true" />
                      <span>{c.name}</span>
                    </button>
                  );
                })}
              </div>
            </fieldset>
          )}

          {/* Quantity */}
          <div className="flex items-center gap-3">
            <span className="text-xs font-bold text-stone-900 uppercase tracking-wider" id={`${titleId}-qty`}>Quantity</span>
            <div className="flex items-center border border-stone-300 rounded-full overflow-hidden bg-white" role="group" aria-labelledby={`${titleId}-qty`}>
              <button type="button" onClick={() => setQuantity(Math.max(1, qty - 1))} disabled={qty <= 1} aria-label="One fewer" className="w-9 h-9 flex items-center justify-center text-stone-800 hover:bg-stone-100 disabled:opacity-30">
                <Minus className="w-4 h-4" aria-hidden="true" />
              </button>
              <span className="w-8 text-center text-sm font-semibold text-stone-900" aria-live="polite">{soldOut ? 0 : qty}</span>
              <button type="button" onClick={() => setQuantity(Math.min(left, qty + 1))} disabled={qty >= left} aria-label="One more" className="w-9 h-9 flex items-center justify-center text-stone-800 hover:bg-stone-100 disabled:opacity-30">
                <Plus className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>
          </div>

          {/* Ask: the chat, WhatsApp, Instagram (each only when switched on in Settings); email if none */}
          <div className="space-y-2">
            <p className="text-xs text-stone-700">Questions about this piece? Ask us:</p>
            <div className="flex flex-wrap gap-2">
              {chat && (
                <button type="button" onClick={() => openChat(`About ${product.title} (${selectedProfile.name}): `)} className={`${askClass} text-[#0f1c2e] bg-amber-50 hover:bg-amber-100 border-amber-300`}>
                  <MessagesSquare className="w-4 h-4" aria-hidden="true" />
                  <span>Ask in chat</span>
                </button>
              )}
              {inquiry && (
                <a href={inquiry} target="_blank" rel="noopener noreferrer" className={`${askClass} text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border-emerald-300`}>
                  <MessageCircle className="w-4 h-4" aria-hidden="true" />
                  <span>Ask on WhatsApp</span>
                </a>
              )}
              {instagram && (
                <a href={instagram} target="_blank" rel="noopener noreferrer" onClick={() => void copyLinkForInstagram()} className={`${askClass} text-pink-800 bg-pink-50 hover:bg-pink-100 border-pink-300`}>
                  <InstagramIcon className="w-4 h-4" />
                  <span>Ask on Instagram</span>
                </a>
              )}
              {!chat && !inquiry && !instagram && (
                <a href={emailInquiry} target="_blank" rel="noopener noreferrer" className={`${askClass} text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border-emerald-300`}>
                  <MessageCircle className="w-4 h-4" aria-hidden="true" />
                  <span>Ask by email</span>
                </a>
              )}
            </div>
            {igNote && <p role="status" className="text-[11px] text-pink-800">{igNote}</p>}
          </div>

          <p className="text-sm text-stone-700 leading-relaxed">{product.description}</p>

          <ul className="text-xs text-stone-700 space-y-1.5">
            <li className="flex items-center gap-2">
              <Truck className="w-4 h-4 text-[#9f7e38]" aria-hidden="true" />
              Free delivery in {delivery.standardDays || '1–2 days'} to all seven emirates
            </li>
            <li className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-emerald-700" aria-hidden="true" />
              Cash on delivery or bank transfer
            </li>
          </ul>
        </div>
      </div>

      {/* Always in reach: the total and Add to Bag */}
      <div className="shrink-0 border-t border-stone-200 bg-white px-4 py-3 pb-safe flex items-center gap-3">
        <div className="min-w-0">
          <div className="text-[11px] text-stone-600">Total</div>
          <div className="text-lg font-semibold text-[#0f1c2e] leading-tight">{`AED ${totalPrice}`}</div>
        </div>
        {soldOut ? (
          !inquiry && chat ? (
            <button type="button" onClick={() => openChat(`${product.title} in ${selectedProfile.name} shows as sold out. Will it come back? `)} className="flex-1 bg-stone-200 text-stone-800 font-semibold text-sm py-3.5 px-4 rounded-full text-center">
              {sizeShort} sold out · Ask us
            </button>
          ) : (
            <a href={inquiry ?? emailInquiry} target="_blank" rel="noopener noreferrer" className="flex-1 bg-stone-200 text-stone-800 font-semibold text-sm py-3.5 px-4 rounded-full text-center">
              {sizeShort} sold out · Ask us
            </a>
          )
        ) : (
          <button type="button" onClick={handleAddToCart} className="flex-1 bg-[#0f1c2e] hover:bg-[#1c2c44] active:scale-[0.98] text-white font-semibold text-sm py-3.5 px-4 rounded-full shadow transition-transform">
            Add to Bag ({sizeShort})
          </button>
        )}
      </div>
    </Sheet>
  );
};
