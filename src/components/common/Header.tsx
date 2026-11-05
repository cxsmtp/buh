'use client';

import React from 'react';
import { ShoppingBag, Search, MapPin } from 'lucide-react';
import { BrandSettings } from '@/types';
import { PALETTE } from '@/lib/design/tokens';
import { useT, type Words } from '@/lib/i18n';
import { LanguageSwitch } from './LanguageSwitch';

const WORDS = {
  top: { en: '{name}: top of the shop', ar: '{name}: أعلى المتجر' },
  search: { en: 'Search products', ar: 'ابحث في المنتجات' },
  track: { en: 'Track Order', ar: 'تتبع الطلب' },
  bag: { en: 'View shopping bag', ar: 'عرض سلة التسوق' },
  bagCount1: { en: 'View shopping bag, {n} piece', ar: 'عرض سلة التسوق، قطعة واحدة' },
  bagCountN: { en: 'View shopping bag, {n} pieces', ar: 'عرض سلة التسوق، {n} قطع' },
} as const satisfies Words;

interface HeaderProps {
  cartCount: number;
  onOpenCart: () => void;
  onOpenSearch: () => void;
  onOpenTrack: () => void;
  brandSettings?: BrandSettings;
  /** The logo (and name) take the shopper back to the top of the shop. */
  onHome?: () => void;
}

/** The shop's logo: the uploaded image, or its letters on the brand colour. */
export function BrandLogo({ brand, className = 'w-9 h-9 text-base' }: { brand?: BrandSettings; className?: string }) {
  if (brand?.logoType === 'image' && brand.logoImageUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={brand.logoImageUrl} alt="" className={`${className} shrink-0 object-contain rounded-full bg-surface border border-line`} />;
  }
  return (
    <span
      aria-hidden="true"
      className={`${className} shrink-0 rounded-full flex items-center justify-center text-white font-serif font-semibold tracking-[0.04em]`}
      style={{ background: `linear-gradient(135deg, ${brand?.accentColor || PALETTE.gold}, ${PALETTE['gold-deep']})` }}
    >
      {brand?.logoText || 'BU'}
    </span>
  );
}

/**
 * The slim bar that stays at the top while scrolling: the logo and name, and the bag. On wider
 * screens also search and Track Order (on phones those are in the tab bar at the bottom).
 */
export const Header: React.FC<HeaderProps> = ({ cartCount, onOpenCart, onOpenSearch, onOpenTrack, brandSettings, onHome }) => {
  const name = brandSettings?.storeName || 'Beautiful UAE Home';
  const t = useT(WORDS);
  return (
    <header className="bg-ivory/95 backdrop-blur-md border-b border-line">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-3">
        <button
          type="button"
          className="flex items-center gap-2.5 min-w-0 rounded-full text-start"
          onClick={() => onHome?.()}
          aria-label={t('top', { name })}
        >
          <BrandLogo brand={brandSettings} />
          <span className="min-w-0">
            <span className="block font-serif text-[13px] min-[380px]:text-[15px] sm:text-lg text-ink leading-tight tracking-[0.04em] min-[380px]:tracking-[0.06em] sm:tracking-[0.12em] uppercase truncate" dir="auto">{name}</span>
            {brandSettings?.tagline && <span className="hidden sm:block text-[10px] text-ink-muted tracking-[0.14em] uppercase truncate">{brandSettings.tagline}</span>}
          </span>
        </button>

        <div className="flex items-center gap-1 sm:gap-2 shrink-0">
          <button type="button" onClick={onOpenSearch} className="hidden md:flex w-10 h-10 items-center justify-center rounded-full text-ink hover:bg-sand-deep/60" aria-label={t('search')}>
            <Search className="w-5 h-5" aria-hidden="true" />
          </button>
          <button type="button" onClick={onOpenTrack} className="hidden md:flex items-center gap-1.5 h-10 px-3 rounded-full text-sm text-ink hover:bg-sand-deep/60">
            <MapPin className="w-4 h-4 text-gold-deep" aria-hidden="true" />
            <span>{t('track')}</span>
          </button>
          <LanguageSwitch />
          <button type="button" onClick={onOpenCart} className="relative w-10 h-10 flex items-center justify-center rounded-full bg-ink text-paper hover:bg-ink-2" aria-label={cartCount ? t(cartCount === 1 ? 'bagCount1' : 'bagCountN', { n: cartCount }) : t('bag')}>
            <ShoppingBag className="w-5 h-5 text-gold-light" aria-hidden="true" />
            {cartCount > 0 && (
              <span className="absolute -top-1 -end-1 bg-gold text-ink text-[11px] font-semibold min-w-5 h-5 px-1 rounded-full flex items-center justify-center ring-2 ring-ivory" aria-hidden="true">
                {cartCount}
              </span>
            )}
          </button>
        </div>
      </div>
    </header>
  );
};
