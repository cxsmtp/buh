'use client';

import React from 'react';
import { MapPin } from 'lucide-react';
import type { BrandSettings } from '@/types';
import { useShop } from '@/lib/client/shop';
import { FestiveGreeting } from './FestiveGreeting';
import { useT, type Words } from '@/lib/i18n';

const WORDS = {
  about: { en: 'About the shop', ar: 'عن المتجر' },
  piece: { en: 'piece', ar: 'قطعة' },
  pieces: { en: 'pieces', ar: 'قطعة' },
  uae: { en: 'UAE', ar: 'الإمارات' },
  standard: { en: 'Standard delivery', ar: 'توصيل عادي' },
  days: { en: '1–2 days', ar: '1–2 يوم' },
  inDays: { en: '{name} in {days}', ar: '{name} خلال {days}' },
  more: { en: ' to all seven emirates · Cash on delivery or bank transfer', ar: ' إلى الإمارات السبع · الدفع عند الاستلام أو التحويل البنكي' },
  chat: { en: ' · Questions? Ask us in the chat.', ar: ' · لديك سؤال؟ اسألنا في المحادثة.' },
} as const satisfies Words;

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
  const t = useT(WORDS);
  return (
    <section aria-label={t('about')} className="space-y-3">
      <h1 className="sr-only">
        {brand.storeName || 'Beautiful UAE Home'}
        {brand.tagline ? ` · ${brand.tagline}` : ''}
      </h1>
      {f && <FestiveGreeting theme={f.theme} compact />}
      <p className="text-[13px] text-ink-soft leading-relaxed flex flex-wrap items-center gap-x-3 gap-y-1">
        {/* On a phone one short line (the piece count shows again just above the products). */}
        {pieces !== null && (
          <span className="hidden sm:inline">
            <span className="text-ink font-medium">{pieces}</span> {t(pieces === 1 ? 'piece' : 'pieces')}
          </span>
        )}
        <span className="inline-flex items-center gap-1 min-w-0">
          <MapPin className="w-3.5 h-3.5 text-gold-deep shrink-0" aria-hidden="true" strokeWidth={1.5} />
          <span className="break-anywhere">{where || t('uae')}</span>
        </span>
        <span>
          {t('inDays', { name: delivery.standardName || t('standard'), days: delivery.standardDays || t('days') })}<span className="hidden sm:inline">{t('more')}{chat ? t('chat') : '.'}</span>
        </span>
      </p>
    </section>
  );
};
