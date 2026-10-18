'use client';

import React from 'react';
import { MapPin } from 'lucide-react';
import type { BrandSettings } from '@/types';
import { useShop } from '@/lib/client/shop';
import { FestiveGreeting } from './FestiveGreeting';

interface HeroBannerProps {
  brand: BrandSettings;
  /** Pieces in the shop now (shown like a profile's post count). */
  pieces: number | null;
}

/**
 * The top of the shop, kept short so the first photos show at once: during a festival its greeting
 * as one slim line (Settings → Festival themes), then one line on what the shop is and how it
 * delivers. The logo, name and tagline are already in the header just above, so they are not
 * repeated here (the name stays the page's heading for search engines and screen readers).
 */
export const HeroBanner: React.FC<HeroBannerProps> = ({ brand, pieces }) => {
  const { festival, store, delivery, chat } = useShop();
  // A festival's look (3 weeks before to 1 week after it, or as the admin chose).
  const f = festival?.festivalId && festival.showBanner ? festival : null;
  const where = store.storeAddress?.trim();
  return (
    <section aria-label="About the shop" className="space-y-3">
      <h1 className="sr-only">
        {brand.storeName || 'Beautiful UAE Home'}
        {brand.tagline ? ` · ${brand.tagline}` : ''}
      </h1>
      {f && <FestiveGreeting theme={f.theme} compact />}
      <p className="text-[13px] text-ink-soft leading-relaxed flex flex-wrap items-center gap-x-3 gap-y-1">
        {/* On a phone one short line (the piece count shows again just above the products). */}
        {pieces !== null && (
          <span className="hidden sm:inline">
            <span className="text-ink font-medium">{pieces}</span> {pieces === 1 ? 'piece' : 'pieces'}
          </span>
        )}
        <span className="inline-flex items-center gap-1 min-w-0">
          <MapPin className="w-3.5 h-3.5 text-gold-deep shrink-0" aria-hidden="true" strokeWidth={1.5} />
          <span className="break-anywhere">{where || 'UAE'}</span>
        </span>
        <span>
          Free delivery in {delivery.standardDays || '1–2 days'}<span className="hidden sm:inline"> to all seven emirates</span> · Cash on delivery<span className="hidden sm:inline"> or bank transfer{chat ? ' · Questions? Ask us in the chat.' : '.'}</span>
        </span>
      </p>
    </section>
  );
};
