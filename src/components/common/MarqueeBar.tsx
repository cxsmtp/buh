'use client';

import React from 'react';
import { BrandSettings } from '@/types';
import { useShop } from '@/lib/client/shop';

interface MarqueeBarProps {
  brandSettings: BrandSettings;
}

export const MarqueeBar: React.FC<MarqueeBarProps> = ({ brandSettings }) => {
  const marquee = brandSettings.marquee;
  const { festival } = useShop();
  // Festival lines go first while a festival's look is on.
  const festivalLines = festival?.festivalId && festival.showMarquee ? festival.theme.marquee : [];
  const messages = [...festivalLines, ...(marquee?.enabled ? marquee.messages : [])];

  if (!marquee || messages.length === 0) {
    return null;
  }

  const duration = Math.max(10, marquee.speedSeconds || 26);
  // Repeat the messages to ensure infinite seamless scrolling
  const repeatedMessages = [...messages, ...messages];

  return (
    <aside 
      aria-label="Latest Announcements Ticker"
      className="relative z-50 overflow-hidden bg-[#0a121d] text-white border-b border-[#1c2c40] select-none text-[11px] sm:text-xs py-1.5 shadow-xs"
    >
      <div className="flex items-center">
        {/* Left Ticker Label Pill */}
        <div className="shrink-0 bg-gradient-to-r from-amber-600 to-amber-500 text-stone-950 font-bold px-2.5 py-0.5 rounded-r-md text-[9px] uppercase tracking-wider flex items-center gap-1 shadow-sm z-10">
          <span className="w-1.5 h-1.5 rounded-full bg-stone-950 animate-ping"></span>
          <span>LIVE</span>
        </div>

        {/* Running Marquee Track */}
        <div className="overflow-hidden whitespace-nowrap flex-1 ml-2">
          <div
            className="animate-marquee-runner flex items-center gap-6"
            style={{ animationDuration: `${duration}s` }}
          >
            {repeatedMessages.map((msg, idx) => (
              <div
                key={idx}
                className="inline-flex items-center gap-2 text-stone-200 hover:text-amber-300 transition-colors cursor-default shrink-0"
              >
                <span className="font-medium tracking-wide">{msg}</span>
                <span className="text-[#c5a059] opacity-80 text-xs">•</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </aside>
  );
};
