'use client';

import React from 'react';
import { Product } from '@/types';
import { useShop } from '@/lib/client/shop';
import { LocalPrice } from '@/lib/client/currency';
import { isOnSale, productPhoto } from '@/lib/catalogFilter';
import { feedSizes, photoSources } from '@/lib/client/photos';

interface ProductCardProps {
  product: Product;
  onSelect: (product: Product) => void;
  /** The first few cards on the screen load straight away; the rest as they scroll near. */
  eager?: boolean;
  /** Phones: one big photo per row, edge to edge, or two across. Wider screens: always a grid. */
  layout?: 'one' | 'grid';
}

/**
 * One piece in the shop's feed: a big photo, its name, the price (and the price before, when
 * reduced), and a small note when only a few are left or it has sold out. A link to the product's
 * own page (shareable, opens in a new tab), opening the product sheet when tapped.
 *
 * One per row on a phone, the photo spans the screen like a post; the words keep the page margin.
 */
export const ProductCard: React.FC<ProductCardProps> = ({ product, onSelect, eager = false, layout = 'grid' }) => {
  const { lowStockThreshold } = useShop();
  const soldOut = product.stockCount === 0;
  const fewLeft = !soldOut && product.stockCount <= lowStockThreshold;
  const sale = isOnSale(product);
  const photo = photoSources(productPhoto(product));
  // Made by AI from the real photo ("Style in a bedroom"): said so, small and plain.
  const styled = Boolean(product.stagedPhotos?.[productPhoto(product)]);
  const one = layout === 'one';
  const round = one ? 'sm:rounded-lg' : 'rounded-lg';

  return (
    <article className={`group min-w-0 ${one ? '-mx-4 sm:mx-0' : ''}`} data-layout={layout}>
      <a
        href={`/p/${encodeURIComponent(product.id)}`}
        onClick={(e) => {
          // A normal tap opens the sheet; Ctrl/⌘-click or a middle click still opens a new tab.
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
          e.preventDefault();
          onSelect(product);
        }}
        className={`block focus-visible:outline-offset-4 ${round}`}
      >
        <div className={`relative aspect-[4/5] overflow-hidden bg-sand-deep ${round}`} data-testid="feed-photo">
          {photo.src && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={photo.src}
              srcSet={photo.srcSet}
              sizes={photo.srcSet ? feedSizes(layout) : undefined}
              alt=""
              width={one ? 1080 : 540}
              height={one ? 1350 : 675}
              loading={eager ? 'eager' : 'lazy'}
              fetchPriority={eager && one ? 'high' : undefined}
              decoding="async"
              draggable={false}
              className={`photo absolute inset-0 w-full h-full object-cover transition-transform duration-500 motion-safe:group-hover:scale-[1.03] ${soldOut ? 'grayscale-[60%]' : ''}`}
            />
          )}
          {styled && (
            <span className="pointer-events-none absolute left-2 bottom-2 rounded-full bg-surface/90 px-2 py-0.5 text-[11px] font-semibold text-ink shadow-sm" data-testid="styled-tag">
              Styled image
            </span>
          )}
        </div>
        <div className={`pt-3 space-y-1 ${one ? 'px-4 sm:px-0.5' : 'px-0.5'}`}>
          <h3 className={`font-serif leading-snug text-ink line-clamp-2 transition-colors group-hover:text-gold-deep ${one ? 'text-xl sm:text-lg' : 'text-base'}`}>
            {product.title}
          </h3>
          <p className={`flex items-baseline flex-wrap gap-x-2 ${one ? 'text-[15px] sm:text-sm' : 'text-sm'}`}>
            <span className="text-ink tracking-[0.02em]">{`AED ${product.price}`}</span>
            {sale && (
              <span className="text-xs text-ink-muted line-through decoration-ink-muted/60">
                <span className="sr-only">was </span>
                {`AED ${product.compareAtPrice}`}
              </span>
            )}
            {sale && <span className="label-caps !text-[10px] text-rose-deep">Reduced</span>}
          </p>
          <LocalPrice aed={product.price} className="text-[11px] block" />
          {(soldOut || fewLeft) && (
            <p className={`text-[11px] tracking-[0.04em] ${soldOut ? 'text-ink-muted' : 'text-warning'}`}>
              {soldOut ? 'Sold out' : product.stockCount === 1 ? 'Only 1 left' : `Only ${product.stockCount} left`}
            </p>
          )}
        </div>
      </a>
    </article>
  );
};
