'use client';

import React, { useLayoutEffect, useRef, useState } from 'react';
import { BrandSettings } from '@/types';
import { useShop } from '@/lib/client/shop';
import { MARQUEE_MAX_ITEMS, marqueeItems } from '@/lib/marquee';

interface MarqueeBarProps {
  brandSettings: BrandSettings;
}

/** About 32 px a second: slow enough to read without chasing it. */
export const MARQUEE_PX_PER_SECOND = 32;

/**
 * The thin announcement bar at the very top: up to three short lines (Settings → Store &
 * contact), with a festival's greeting first while its look is on. It drifts slowly, pauses while
 * a finger, pointer or the keyboard is on it, and stays still (centred) when everything fits on
 * the screen or there is only one line. People who asked their device for less motion get it
 * still, every line shown once.
 */
export const MarqueeBar: React.FC<MarqueeBarProps> = ({ brandSettings }) => {
  const marquee = brandSettings.marquee;
  const { festival } = useShop();
  const festivalLine = festival?.festivalId && festival.showMarquee ? festival.theme.marquee.slice(0, 1) : [];
  const messages = [...festivalLine, ...(marquee?.enabled ? marqueeItems(marquee.messages) : [])].slice(0, MARQUEE_MAX_ITEMS);
  if (messages.length === 0) return null;
  return <MarqueeStrip messages={messages} />;
};

/** The bar itself (also the live preview in Settings → Store & contact). */
export function MarqueeStrip({ messages, label = 'Announcements', className = '' }: { messages: string[]; label?: string; className?: string }) {
  const frame = useRef<HTMLDivElement>(null);
  const copy = useRef<HTMLDivElement>(null);
  const [motion, setMotion] = useState<{ still: boolean; seconds: number }>({ still: true, seconds: 60 });
  const key = messages.join('\u0000');

  useLayoutEffect(() => {
    const measure = () => {
      const width = copy.current?.scrollWidth ?? 0;
      const room = frame.current?.clientWidth ?? 0;
      const still = messages.length < 2 || width <= room;
      setMotion({ still, seconds: Math.max(12, Math.round(width / MARQUEE_PX_PER_SECOND)) });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    if (frame.current) ro.observe(frame.current);
    return () => ro.disconnect();
    // Re-measure when the lines change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const line = (hidden: boolean) => (
    <div ref={hidden ? undefined : copy} className={`marquee-line flex items-center shrink-0 ${hidden ? 'marquee-copy' : ''}`} aria-hidden={hidden || undefined}>
      {messages.map((msg, idx) => (
        <span key={idx} className="marquee-item inline-flex items-center shrink-0">
          <span className="px-5 sm:px-7">{msg}</span>
          <span className="marquee-sep text-gold/70 text-[8px]" aria-hidden="true">◆</span>
        </span>
      ))}
    </div>
  );

  return (
    <aside
      aria-label={label}
      tabIndex={motion.still ? undefined : 0}
      className={`marquee relative z-50 overflow-hidden ${className} bg-ink text-sand select-none text-[11px] sm:text-xs tracking-[0.06em] py-2 focus-visible:outline-offset-[-2px] ${motion.still ? 'marquee-still' : ''}`}
    >
      <div ref={frame} className="overflow-hidden whitespace-nowrap">
        <div className="animate-marquee-runner items-center" style={{ ['--marquee-duration' as string]: `${motion.seconds}s` }}>
          {line(false)}
          {line(true)}
        </div>
      </div>
    </aside>
  );
}
