'use client';

import React from 'react';
import { MapPin } from 'lucide-react';
import type { BrandSettings } from '@/types';
import { useShop } from '@/lib/client/shop';
import { BrandLogo } from '@/components/common/Header';

interface HeroBannerProps {
  brand: BrandSettings;
  /** Pieces in the shop now (shown like a profile's post count). */
  pieces: number | null;
}

/**
 * The top of the shop, like a boutique's Instagram profile: the logo, the name and tagline, where
 * the shop is and how it delivers, all from Settings. During a festival its greeting sits on top in
 * the festival's colours (Settings → Festival themes).
 */
export const HeroBanner: React.FC<HeroBannerProps> = ({ brand, pieces }) => {
  const { festival, store, delivery, chat } = useShop();
  // A festival's look (3 weeks before to 1 week after it, or as the admin chose).
  const f = festival?.festivalId && festival.showBanner ? festival : null;
  const where = store.storeAddress?.trim();
  return (
    <section aria-label="About the shop" className="space-y-3">
      {f && (
        <div
          role="note"
          className="rounded-2xl px-4 py-3 text-white shadow-sm flex flex-wrap items-center gap-x-2 gap-y-0.5"
          style={{ backgroundImage: `linear-gradient(110deg, ${f.theme.gradient[0]}, ${f.theme.gradient[1]})` }}
        >
          {f.theme.ornament && <span aria-hidden="true" className="text-base">{f.theme.ornament}</span>}
          <strong className="text-sm font-semibold tracking-wide">{f.theme.greeting}</strong>
          {f.theme.headline && <span className="text-xs text-white/90">{f.theme.headline}</span>}
        </div>
      )}
      <div className="flex items-center gap-4">
        <span className="rounded-full p-[3px] bg-gradient-to-tr from-[#9f7e38] via-[#c5a059] to-[#e8cf98] shrink-0">
          <span className="block rounded-full p-[2px] bg-[#fbf9f5]">
            <BrandLogo brand={brand} className="w-16 h-16 sm:w-20 sm:h-20 text-2xl" />
          </span>
        </span>
        <div className="min-w-0 space-y-0.5">
          <h1 className="font-serif text-lg sm:text-2xl font-bold text-[#0f1c2e] leading-tight">{brand.storeName || 'Beautiful UAE Home'}</h1>
          {brand.tagline && <p className="text-xs sm:text-sm text-stone-700 leading-snug">{brand.tagline}</p>}
          <p className="text-xs text-stone-700 flex flex-wrap gap-x-3 gap-y-0.5 pt-0.5">
            {pieces !== null && <span><strong className="font-semibold text-stone-900">{pieces}</strong> {pieces === 1 ? 'piece' : 'pieces'}</span>}
            <span className="inline-flex items-center gap-1">
              <MapPin className="w-3.5 h-3.5 text-[#9f7e38]" aria-hidden="true" />
              {where || 'UAE'}
            </span>
          </p>
        </div>
      </div>
      <p className="text-[13px] text-stone-700 leading-relaxed max-w-2xl">
        Free delivery in {delivery.standardDays || '1–2 days'} to all seven emirates · Cash on delivery or bank transfer{chat ? ' · Questions? Ask us in the chat.' : '.'}
      </p>
    </section>
  );
};
