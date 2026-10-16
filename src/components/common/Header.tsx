'use client';

import React from 'react';
import { ShoppingBag, Search, MapPin, Layers } from 'lucide-react';
import { BrandSettings } from '@/types';

interface HeaderProps {
  cartCount: number;
  onOpenCart: () => void;
  onOpenSearch: () => void;
  onOpenTrack: () => void;
  isAdminMode: boolean;
  onToggleAdminMode: () => void;
  pendingOrdersCount?: number;
  brandSettings?: BrandSettings;
  /** The logo (and name) take the shopper back to the top of the shop. */
  onHome?: () => void;
}

/** The shop's logo: the uploaded image, or its letters on the brand colour. */
export function BrandLogo({ brand, className = 'w-9 h-9 text-base' }: { brand?: BrandSettings; className?: string }) {
  if (brand?.logoType === 'image' && brand.logoImageUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={brand.logoImageUrl} alt="" className={`${className} shrink-0 object-contain rounded-full bg-white border border-stone-200`} />;
  }
  return (
    <span
      aria-hidden="true"
      className={`${className} shrink-0 rounded-full flex items-center justify-center text-white font-serif font-bold`}
      style={{ background: `linear-gradient(135deg, ${brand?.accentColor || '#c5a059'}, #9f7e38)` }}
    >
      {brand?.logoText || 'BU'}
    </span>
  );
}

/**
 * The slim bar that stays at the top while scrolling: the logo and name, and the bag. On wider
 * screens also search and Track Order (on phones those are in the tab bar at the bottom).
 */
export const Header: React.FC<HeaderProps> = ({ cartCount, onOpenCart, onOpenSearch, onOpenTrack, isAdminMode, onToggleAdminMode, pendingOrdersCount = 0, brandSettings, onHome }) => {
  const name = brandSettings?.storeName || 'Beautiful UAE Home';
  return (
    <header className="sticky top-0 z-40 bg-[#fbf9f5]/95 backdrop-blur-md border-b border-[#e8e1d5] pt-safe">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-3">
        <button
          type="button"
          className="flex items-center gap-2.5 min-w-0 rounded-full text-left"
          onClick={() => (isAdminMode ? onToggleAdminMode() : onHome?.())}
          aria-label={isAdminMode ? 'Back to the shop' : `${name}: top of the shop`}
        >
          <BrandLogo brand={brandSettings} />
          <span className="min-w-0">
            <span className="block font-serif text-base sm:text-lg font-bold text-[#0f1c2e] leading-tight truncate">{name}</span>
            {brandSettings?.tagline && <span className="hidden sm:block text-[11px] text-stone-600 tracking-wide truncate">{brandSettings.tagline}</span>}
          </span>
        </button>

        <div className="flex items-center gap-1 sm:gap-2 shrink-0">
          {!isAdminMode && (
            <>
              <button type="button" onClick={onOpenSearch} className="hidden md:flex w-10 h-10 items-center justify-center rounded-full text-stone-800 hover:bg-stone-200/60" aria-label="Search products">
                <Search className="w-5 h-5" aria-hidden="true" />
              </button>
              <button type="button" onClick={onOpenTrack} className="hidden md:flex items-center gap-1.5 h-10 px-3 rounded-full text-sm text-stone-800 hover:bg-stone-200/60">
                <MapPin className="w-4 h-4 text-[#9f7e38]" aria-hidden="true" />
                <span>Track Order</span>
              </button>
            </>
          )}

          {/* The owner's way in (signed-in check on the server) */}
          <button
            type="button"
            onClick={onToggleAdminMode}
            title={isAdminMode ? 'Admin Hub' : 'Admin Hub (for the shop owner)'}
            className={`relative flex items-center gap-1.5 h-10 px-2.5 rounded-full text-xs font-semibold transition-colors ${
              isAdminMode ? 'bg-amber-600 text-white' : 'text-stone-700 hover:bg-stone-200/60'
            }`}
          >
            <Layers className="w-4 h-4" aria-hidden="true" />
            <span className={isAdminMode ? 'hidden sm:inline' : 'sr-only'}>Admin Hub</span>
            {pendingOrdersCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-red-600 text-[10px] font-bold text-white flex items-center justify-center">{pendingOrdersCount}</span>
            )}
          </button>

          {!isAdminMode && (
            <button type="button" onClick={onOpenCart} className="relative w-10 h-10 flex items-center justify-center rounded-full bg-[#0f1c2e] text-white hover:bg-[#1c2c44]" aria-label={`View shopping bag${cartCount ? `, ${cartCount} ${cartCount === 1 ? 'piece' : 'pieces'}` : ''}`}>
              <ShoppingBag className="w-5 h-5 text-amber-100" aria-hidden="true" />
              {cartCount > 0 && (
                <span className="absolute -top-1 -right-1 bg-[#c5a059] text-stone-950 text-[11px] font-bold min-w-5 h-5 px-1 rounded-full flex items-center justify-center ring-2 ring-[#fbf9f5]" aria-hidden="true">
                  {cartCount}
                </span>
              )}
            </button>
          )}
        </div>
      </div>
    </header>
  );
};
