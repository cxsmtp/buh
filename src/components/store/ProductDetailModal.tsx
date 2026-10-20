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
import { measurementRows } from '@/lib/measurements';
import { isSimple, sizeDetail } from '@/lib/productType';
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
  // Colours only when the owner gave some: none means no choice (and no colour on the order).
  const [selectedColor, setSelectedColor] = useState<string>(product.colors[0]?.name ?? '');
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
  // Only what the owner filled in on this product for this size.
  const measurements = measurementRows(product, selectedProfile);
  // Towels, cushions, decor…: plain options, no thread count or weave.
  const simple = isSimple(product);

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
      <div className="flex items-center gap-2 px-2 sm:px-3 h-12 border-b border-line shrink-0 bg-surface">
        <button type="button" onClick={onClose} aria-label="Close" data-autofocus className="w-10 h-10 rounded-full flex items-center justify-center text-ink hover:bg-sand">
          <X className="w-5 h-5" aria-hidden="true" />
        </button>
        <span className="flex-1 min-w-0 truncate font-serif text-base text-ink twopane:invisible" aria-hidden="true">
          {product.title}
        </span>
        <button type="button" onClick={() => void share()} aria-label="Share" className="w-10 h-10 rounded-full flex items-center justify-center text-ink hover:bg-sand">
          <Share2 className="w-5 h-5" aria-hidden="true" />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain twopane:grid twopane:grid-cols-2 twopane:grid-rows-[minmax(0,1fr)] twopane:overflow-hidden">
        <div className="twopane:overflow-y-auto twopane:p-5">
          <div className="twopane:rounded-2xl twopane:overflow-hidden">
            <PhotoCarousel images={images} title={product.title} styled={new Set(Object.keys(product.stagedPhotos ?? {}))} />
          </div>
        </div>

        <div className="twopane:overflow-y-auto px-4 sm:px-5 pt-4 pb-6 space-y-5">
          <div className="space-y-1.5">
            <h2 id={titleId} className="font-serif text-2xl sm:text-3xl leading-tight text-ink break-anywhere">
              {product.title}
            </h2>
            <p className="flex items-baseline flex-wrap gap-x-2">
              <span className="text-lg text-ink tracking-[0.02em]">{`AED ${unitPrice}`}</span>
              {sale && (
                <span className="text-sm text-ink-muted line-through decoration-ink-muted/60">
                  <span className="sr-only">was </span>
                  {`AED ${formatAed(wasFils)}`}
                </span>
              )}
              {sale && <span className="label-caps !text-[10px] text-rose-deep">Reduced</span>}
              <LocalPrice aed={Number(unitPrice)} className="text-xs" />
            </p>
            <p className="text-xs text-ink-soft">
              {simple ? product.material : `${product.material} · ${product.threadCount} TC · ${product.weave}`}
            </p>
          </div>

          {/* Size */}
          <fieldset className="space-y-2">
            <legend className="label-caps text-ink flex flex-wrap items-center gap-1.5 mb-2 min-w-0">
              <Ruler className="w-4 h-4 text-gold-deep" aria-hidden="true" />
              Size: <span className="font-medium normal-case tracking-normal text-ink-soft">{selectedProfile.name}</span>
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
                      isSelected ? 'border-ink bg-ivory ring-1 ring-ink text-ink' : pieces === 0 ? 'border-line bg-ivory text-ink-soft' : 'border-line-strong bg-surface text-ink hover:border-ink-muted'
                    }`}
                  >
                    <span className="flex items-center justify-between gap-1">
                      <span className={`text-sm ${pieces === 0 && !isSelected ? 'line-through' : ''}`}>{shortSize(profile.name)}</span>
                      {isSelected && <Check className="w-4 h-4 text-ink" aria-hidden="true" />}
                    </span>
                    <span className={`block text-[11px] leading-tight truncate text-ink-soft`}>
                      {pieces === 0 ? 'Sold out' : pieces <= lowStockThreshold ? `Only ${pieces} left` : sizeDetail(product, profile).split('(')[0].trim()}
                      {profile.priceDelta > 0 && pieces > 0 ? ` · +AED ${profile.priceDelta}` : ''}
                    </span>
                  </button>
                );
              })}
            </div>
            {measurements.length > 0 && (
              <details className="rounded-xl border border-line bg-ivory text-xs" data-testid="measurements">
                <summary className="cursor-pointer px-3 py-2.5 font-semibold text-ink">{simple ? 'Size details' : 'Measurements for'} {sizeShort}</summary>
                <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 px-3 pb-3 text-ink">
                  {measurements.map((m) => (
                    <div key={m.key} className="min-w-0">
                      <dt className="text-[11px] text-ink-soft">{m.label}</dt>
                      <dd className="font-medium break-words">{m.value}</dd>
                    </div>
                  ))}
                </dl>
              </details>
            )}
          </fieldset>

          {/* Colour: a choice when there are several, a plain label for one, nothing for none */}
          {product.colors.length === 1 && (
            <p className="label-caps text-ink flex items-center gap-2" data-testid="colour-label">
              Colour:
              <span className="flex items-center gap-1.5 font-medium normal-case tracking-normal text-ink-soft">
                <span className="w-4 h-4 rounded-full border border-line-strong" style={{ backgroundColor: product.colors[0].hex }} aria-hidden="true" />
                {product.colors[0].name}
              </span>
            </p>
          )}
          {product.colors.length > 1 && (
            <fieldset className="space-y-2" data-testid="colour-picker">
              <legend className="label-caps text-ink mb-2">
                Colour: <span className="font-medium normal-case tracking-normal text-ink-soft">{selectedColor}</span>
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
                        isSelected ? 'border-ink ring-1 ring-ink bg-surface text-ink font-semibold' : 'border-line-strong bg-surface text-ink hover:border-ink-muted'
                      }`}
                    >
                      <span className="w-5 h-5 rounded-full border border-line-strong" style={{ backgroundColor: c.hex }} aria-hidden="true" />
                      <span>{c.name}</span>
                    </button>
                  );
                })}
              </div>
            </fieldset>
          )}

          {/* Quantity */}
          <div className="flex items-center gap-3">
            <span className="label-caps text-ink" id={`${titleId}-qty`}>Quantity</span>
            <div className="flex items-center border border-line-strong rounded-full overflow-hidden bg-surface" role="group" aria-labelledby={`${titleId}-qty`}>
              <button type="button" onClick={() => setQuantity(Math.max(1, qty - 1))} disabled={qty <= 1} aria-label="One fewer" className="w-9 h-9 flex items-center justify-center text-ink hover:bg-sand disabled:opacity-30">
                <Minus className="w-4 h-4" aria-hidden="true" />
              </button>
              <span className="w-8 text-center text-sm font-semibold text-ink" aria-live="polite">{soldOut ? 0 : qty}</span>
              <button type="button" onClick={() => setQuantity(Math.min(left, qty + 1))} disabled={qty >= left} aria-label="One more" className="w-9 h-9 flex items-center justify-center text-ink hover:bg-sand disabled:opacity-30">
                <Plus className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>
          </div>

          {/* Ask: the chat, WhatsApp, Instagram (each only when switched on in Settings); email if none */}
          <div className="space-y-2">
            <p className="text-xs text-ink-soft">Questions about this piece? Ask us:</p>
            <div className="flex flex-wrap gap-2">
              {chat && (
                <button type="button" onClick={() => openChat(`About ${product.title} (${selectedProfile.name}): `)} className={`${askClass} text-ink bg-surface hover:bg-sand border-line-strong`}>
                  <MessagesSquare className="w-4 h-4" aria-hidden="true" />
                  <span>Ask in chat</span>
                </button>
              )}
              {inquiry && (
                <a href={inquiry} target="_blank" rel="noopener noreferrer" className={`${askClass} text-ink bg-surface hover:bg-sand border-line-strong`}>
                  <MessageCircle className="w-4 h-4" aria-hidden="true" />
                  <span>Ask on WhatsApp</span>
                </a>
              )}
              {instagram && (
                <a href={instagram} target="_blank" rel="noopener noreferrer" onClick={() => void copyLinkForInstagram()} className={`${askClass} text-ink bg-surface hover:bg-sand border-line-strong`}>
                  <InstagramIcon className="w-4 h-4" />
                  <span>Ask on Instagram</span>
                </a>
              )}
              {!chat && !inquiry && !instagram && (
                <a href={emailInquiry} target="_blank" rel="noopener noreferrer" className={`${askClass} text-ink bg-surface hover:bg-sand border-line-strong`}>
                  <MessageCircle className="w-4 h-4" aria-hidden="true" />
                  <span>Ask by email</span>
                </a>
              )}
            </div>
            {igNote && <p role="status" className="text-[11px] text-rose-deep">{igNote}</p>}
          </div>

          {product.giftLine && (
            <p className="text-sm font-semibold text-gold-deep break-words" data-testid="gift-line">
              {product.giftLine}
            </p>
          )}
          {/* Paragraphs and the highlights list ("• …" lines) as the owner wrote them. */}
          <p className="text-sm text-ink-soft leading-relaxed whitespace-pre-line break-words">{product.description}</p>

          <ul className="text-xs text-ink-soft space-y-1.5">
            <li className="flex items-center gap-2">
              <Truck className="w-4 h-4 text-gold-deep" aria-hidden="true" />
              Free delivery in {delivery.standardDays || '1–2 days'} to all seven emirates
            </li>
            <li className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-gold-deep" aria-hidden="true" />
              Cash on delivery or bank transfer
            </li>
          </ul>
        </div>
      </div>

      {/* Always in reach: the total and Add to Bag */}
      <div className="shrink-0 border-t border-line bg-surface px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))] flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0">
          <div className="label-caps !text-[10px] text-ink-muted">Total</div>
          <div className="text-lg text-ink leading-tight tracking-[0.02em]">{`AED ${totalPrice}`}</div>
        </div>
        {soldOut ? (
          !inquiry && chat ? (
            <button type="button" onClick={() => openChat(`${product.title} in ${selectedProfile.name} shows as sold out. Will it come back? `)} className="flex-1 basis-48 min-w-0 bg-sand text-ink text-sm py-3.5 px-4 rounded-full text-center border border-line">
              {sizeShort} sold out · Ask us
            </button>
          ) : (
            <a href={inquiry ?? emailInquiry} target="_blank" rel="noopener noreferrer" className="flex-1 basis-48 min-w-0 bg-sand text-ink text-sm py-3.5 px-4 rounded-full text-center border border-line">
              {sizeShort} sold out · Ask us
            </a>
          )
        ) : (
          <button type="button" onClick={handleAddToCart} className="flex-1 basis-48 min-w-0 bg-ink hover:bg-ink-2 text-ivory font-medium tracking-[0.04em] text-sm py-3.5 px-4 rounded-full transition-colors">
            Add to Bag ({sizeShort})
          </button>
        )}
      </div>
    </Sheet>
  );
};
