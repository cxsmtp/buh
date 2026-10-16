'use client';

import React from 'react';
import { Product } from '@/types';
import { useShop } from '@/lib/client/shop';
import { LocalPrice } from '@/lib/client/currency';
import { isOnSale, productPhoto } from '@/lib/catalogFilter';
import { CARD_SIZES, photoSources } from '@/lib/client/photos';

interface ProductCardProps {
  product: Product;
  onSelect: (product: Product) => void;
  /** The first few cards on the screen load straight away; the rest as they scroll near. */
  eager?: boolean;
}

/**
 * One piece in the shop's feed: a big photo, its name, the price (and the price before, when
 * reduced), and a small note when only a few are left or it has sold out. A link to the product's
 * own page (shareable, opens in a new tab), opening the product sheet when tapped.
 */
export const ProductCard: React.FC<ProductCardProps> = ({ product, onSelect, eager = false }) => {
  const { lowStockThreshold } = useShop();
  const soldOut = product.stockCount === 0;
  const fewLeft = !soldOut && product.stockCount <= lowStockThreshold;
  const sale = isOnSale(product);
  const photo = photoSources(productPhoto(product));

  return (
    <article className="group min-w-0">
      <a
        href={`/p/${encodeURIComponent(product.id)}`}
        onClick={(e) => {
          // A normal tap opens the sheet; Ctrl/⌘-click or a middle click still opens a new tab.
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
          e.preventDefault();
          onSelect(product);
        }}
        className="block rounded-2xl focus-visible:outline-offset-4"
      >
        <div className="relative aspect-[4/5] rounded-2xl overflow-hidden bg-[#efe8dc]">
          {photo.src && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={photo.src}
              srcSet={photo.srcSet}
              sizes={photo.srcSet ? CARD_SIZES : undefined}
              alt=""
              width={540}
              height={675}
              loading={eager ? 'eager' : 'lazy'}
              decoding="async"
              draggable={false}
              className={`photo absolute inset-0 w-full h-full object-cover transition-transform duration-500 motion-safe:group-hover:scale-[1.03] ${soldOut ? 'grayscale-[60%]' : ''}`}
            />
          )}
          {sale && (
            <span className="absolute top-2 left-2 rounded-full bg-white/95 text-[#7a2e1d] text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 shadow-sm">
              Sale
            </span>
          )}
        </div>
        <div className="pt-2 px-0.5 space-y-0.5">
          <h3 className="font-serif text-[13px] sm:text-sm leading-snug text-stone-900 line-clamp-2 group-hover:text-[#7d5f24]">
            {product.title}
          </h3>
          <p className="flex items-baseline flex-wrap gap-x-1.5 text-sm">
            <span className="font-semibold text-[#0f1c2e]">{`AED ${product.price}`}</span>
            {sale && (
              <span className="text-xs text-stone-600 line-through">
                <span className="sr-only">was </span>
                {`AED ${product.compareAtPrice}`}
              </span>
            )}
          </p>
          <LocalPrice aed={product.price} className="text-[11px] block" />
          {(soldOut || fewLeft) && (
            <p className={`text-[11px] font-semibold ${soldOut ? 'text-stone-600' : 'text-[#8a4b0f]'}`}>
              {soldOut ? 'Sold out' : product.stockCount === 1 ? 'Only 1 left' : `Only ${product.stockCount} left`}
            </p>
          )}
        </div>
      </a>
    </article>
  );
};
