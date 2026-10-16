'use client';

import React from 'react';
import { MapPin } from 'lucide-react';
import type { BrandSettings } from '@/types';
import { useShop } from '@/lib/client/shop';
import { BrandLogo } from '@/components/common/Header';
import { FestiveGreeting } from './FestiveGreeting';

interface HeroBannerProps {
  brand: BrandSettings;
  /** Pieces in the shop now (shown like a profile's post count). */
  pieces: number | null;
}

/**
 * The top of the shop, like a boutique's profile: the logo, the name and tagline, where the shop
 * is and how it delivers, all from Settings. During a festival its greeting sits on top, in the
 * festival's accent with its motif (Settings → Festival themes).
 */
export const HeroBanner: React.FC<HeroBannerProps> = ({ brand, pieces }) => {
  const { festival, store, delivery, chat } = useShop();
  // A festival's look (3 weeks before to 1 week after it, or as the admin chose).
  const f = festival?.festivalId && festival.showBanner ? festival : null;
  const where = store.storeAddress?.trim();
  return (
    <section aria-label="About the shop" className="space-y-5">
      {f && <FestiveGreeting theme={f.theme} />}
      <div className="flex items-center gap-4 sm:gap-5">
        <span className="rounded-full p-[1.5px] bg-gradient-to-tr from-gold-deep via-festive-glow to-gold-light shrink-0">
          <span className="block rounded-full p-[3px] bg-ivory">
            <BrandLogo brand={brand} className="w-16 h-16 sm:w-20 sm:h-20 text-2xl" />
          </span>
        </span>
        <div className="min-w-0 space-y-1">
          <h1 className="font-serif text-[22px] sm:text-3xl text-ink leading-tight tracking-[0.08em] uppercase break-anywhere">{brand.storeName || 'Beautiful UAE Home'}</h1>
          {brand.tagline && <p className="label-caps text-ink-muted !text-[10px] sm:!text-[11px] leading-snug">{brand.tagline}</p>}
          <p className="text-xs text-ink-soft flex flex-wrap gap-x-3 gap-y-0.5 pt-0.5">
            {pieces !== null && <span><span className="text-ink font-medium">{pieces}</span> {pieces === 1 ? 'piece' : 'pieces'}</span>}
            <span className="inline-flex items-center gap-1 min-w-0">
              <MapPin className="w-3.5 h-3.5 text-gold-deep shrink-0" aria-hidden="true" strokeWidth={1.5} />
              <span className="break-anywhere">{where || 'UAE'}</span>
            </span>
          </p>
        </div>
      </div>
      <p className="text-[13px] text-ink-soft leading-relaxed max-w-2xl">
        Free delivery in {delivery.standardDays || '1–2 days'} to all seven emirates · Cash on delivery or bank transfer{chat ? ' · Questions? Ask us in the chat.' : '.'}
      </p>
    </section>
  );
};
