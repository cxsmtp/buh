'use client';

import React from 'react';
import { ShoppingBag, ShieldCheck, Search, MapPin, Layers, Sparkles, Palette } from 'lucide-react';
import { BrandSettings } from '@/types';
import { MarqueeBar } from './MarqueeBar';

interface HeaderProps {
  cartCount: number;
  onOpenCart: () => void;
  onOpenSearch: () => void;
  onOpenTrack: () => void;
  isAdminMode: boolean;
  onToggleAdminMode: () => void;
  pendingOrdersCount?: number;
  brandSettings?: BrandSettings;
}

export const Header: React.FC<HeaderProps> = ({
  cartCount,
  onOpenCart,
  onOpenSearch,
  onOpenTrack,
  isAdminMode,
  onToggleAdminMode,
  pendingOrdersCount = 0,
  brandSettings,
}) => {
  return (
    <header className="sticky top-0 z-40 bg-white/95 backdrop-blur-md border-b border-stone-200 shadow-xs">
      {/* Running Marquee Small Announcement Line */}
      {brandSettings && <MarqueeBar brandSettings={brandSettings} />}

      {/* Main Navigation Bar */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3.5 flex items-center justify-between gap-3 sm:gap-4">
        {/* Brand Logo & Title */}
        <div 
          className="flex items-center gap-3 cursor-pointer min-w-0"
          onClick={() => isAdminMode && onToggleAdminMode()}
          title={isAdminMode ? 'Click to return to Storefront' : brandSettings?.storeName || 'Beautiful UAE Home'}
        >
          {brandSettings?.logoType === 'image' && brandSettings?.logoImageUrl ? (
            <img
              src={brandSettings.logoImageUrl}
              alt={brandSettings.storeName || 'Logo'}
              className="w-10 h-10 shrink-0 object-contain rounded-xl border border-stone-200 shadow-xs"
            />
          ) : (
            <div 
              className="w-10 h-10 shrink-0 rounded-xl flex items-center justify-center text-white shadow font-serif text-lg font-bold"
              style={{
                background: `linear-gradient(135deg, ${brandSettings?.accentColor || '#c5a059'}, #dfc082)`,
              }}
            >
              {brandSettings?.logoText || 'BU'}
            </div>
          )}
          {/* min-w-0 + truncate: on phones the name and tagline shorten instead of pushing the buttons off-screen */}
          <div className="min-w-0">
            <div className="font-serif tracking-wide text-base sm:text-xl font-bold text-[#0f1c2e] leading-tight flex items-center gap-2">
              <span className="truncate">{brandSettings?.storeName || 'BEAUTIFUL UAE HOME'}</span>
              {brandSettings?.badgeText && (
                <span className="text-[10px] uppercase font-sans font-semibold tracking-wider px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 border border-amber-300 hidden sm:inline-block">
                  {brandSettings.badgeText}
                </span>
              )}
            </div>
            <p className="text-[10px] text-stone-600 tracking-wider font-medium truncate">
              {brandSettings?.tagline || 'HANDPRINTED & MACHINE BLOCK LINENS • DUBAI'}
            </p>
          </div>
        </div>

        {/* Desktop Centered Navigation Links (Laptop and Desktop view) */}
        {!isAdminMode && (
          <nav className="hidden lg:flex items-center gap-6 text-xs font-semibold text-stone-700">
            <span className="text-[#c5a059] hover:text-[#9f7e38] cursor-pointer transition-colors">
              Block Print Editions
            </span>
            <span className="hover:text-stone-900 cursor-pointer transition-colors">
              Artisan Heritage
            </span>
            <span className="hover:text-stone-900 cursor-pointer transition-colors">
              Mattress Sizing Guide
            </span>
            <span
              onClick={onOpenTrack}
              className="hover:text-stone-900 cursor-pointer transition-colors flex items-center gap-1"
            >
              <MapPin className="w-3.5 h-3.5 text-[#c5a059]" />
              <span>Track Order</span>
            </span>
          </nav>
        )}

        {/* Right Action Icons */}
        <div className="flex items-center gap-2.5 shrink-0">
          {/* Track Order Button (Mobile/Tablet) */}
          <button
            onClick={onOpenTrack}
            className="hidden sm:flex lg:hidden items-center gap-1.5 text-xs text-stone-700 hover:text-stone-900 bg-stone-100 hover:bg-stone-200 px-3 py-2 rounded-xl transition-colors font-medium"
            title="Track Order Status"
          >
            <MapPin className="w-3.5 h-3.5 text-[#c5a059]" />
            <span>Track Order</span>
          </button>

          {/* Search Button */}
          <button
            onClick={onOpenSearch}
            className="p-2.5 text-stone-600 hover:text-stone-900 rounded-xl hover:bg-stone-100 transition-colors"
            aria-label="Search products"
          >
            <Search className="w-5 h-5" />
          </button>

          {/* Admin Mode Toggle Pill */}
          <button
            onClick={onToggleAdminMode}
            className={`flex items-center gap-1.5 text-xs font-semibold px-3.5 py-2.5 rounded-xl transition-all shadow-xs ${
              isAdminMode
                ? 'bg-amber-600 text-white ring-2 ring-amber-400'
                : 'bg-stone-900 text-white hover:bg-stone-800'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            <span className="hidden xs:inline">{isAdminMode ? 'Admin Hub' : 'Admin Hub'}</span>
            {pendingOrdersCount > 0 && (
              <span className="w-4 h-4 rounded-full bg-red-500 text-[10px] font-bold text-white flex items-center justify-center animate-bounce">
                {pendingOrdersCount}
              </span>
            )}
          </button>

          {/* Cart Button */}
          {!isAdminMode && (
            <button
              onClick={onOpenCart}
              className="relative p-2.5 bg-[#0f1c2e] hover:bg-stone-800 text-white rounded-xl shadow transition-transform active:scale-95"
              aria-label="View shopping bag"
            >
              <ShoppingBag className="w-5 h-5 text-amber-200" />
              {cartCount > 0 && (
                <span className="absolute -top-1.5 -right-1.5 bg-[#c5a059] text-stone-900 text-[11px] font-bold w-5 h-5 rounded-full flex items-center justify-center shadow-md">
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
