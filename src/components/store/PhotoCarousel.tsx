'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { SHEET_SIZES, photoSources } from '@/lib/client/photos';

interface PhotoCarouselProps {
  images: string[];
  /** "Photos of …" for screen readers. */
  title: string;
  children?: React.ReactNode;
}

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * A product's photos, one at a time, swiped sideways with a finger (native scrolling with snap
 * points, so it is smooth on every phone) or dragged with a mouse. Previous / next buttons, the
 * dots, and the arrow keys (when the photos have focus) do the same.
 */
export function PhotoCarousel({ images, title, children }: PhotoCarouselProps) {
  const track = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const drag = useRef<{ x: number; left: number; from: number } | null>(null);
  const count = images.length;

  const go = useCallback(
    (i: number) => {
      const el = track.current;
      if (!el || !count) return;
      const next = Math.max(0, Math.min(count - 1, i));
      el.scrollTo({ left: next * el.clientWidth, behavior: reducedMotion() ? 'auto' : 'smooth' });
      setIndex(next);
    },
    [count]
  );

  // Keep the dots in step with a finger swipe.
  const onScroll = () => {
    const el = track.current;
    if (!el || drag.current) return;
    const i = Math.round(el.scrollLeft / Math.max(1, el.clientWidth));
    if (i !== index) setIndex(Math.max(0, Math.min(count - 1, i)));
  };

  // A resize (phone turned sideways) keeps the same photo in view.
  useEffect(() => {
    const onResize = () => {
      const el = track.current;
      if (el) el.scrollLeft = index * el.clientWidth;
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [index]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowRight') go(index + 1);
    else if (e.key === 'ArrowLeft') go(index - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(count - 1);
    else return;
    e.preventDefault();
  };

  // Mouse drag (touch uses the browser's own swipe).
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse' || e.button !== 0 || count < 2 || !track.current) return;
    drag.current = { x: e.clientX, left: track.current.scrollLeft, from: index };
    track.current.setPointerCapture(e.pointerId);
    track.current.style.scrollSnapType = 'none';
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !track.current) return;
    track.current.scrollLeft = d.left - (e.clientX - d.x);
  };
  const endDrag = (e: React.PointerEvent) => {
    const d = drag.current;
    const el = track.current;
    if (!d || !el) return;
    drag.current = null;
    el.style.scrollSnapType = '';
    const dx = e.clientX - d.x;
    // A short flick is enough: the photo the drag started on (even mid-slide), plus or minus one.
    go(dx < -40 ? d.from + 1 : dx > 40 ? d.from - 1 : d.from);
  };

  if (!count) return <div className="aspect-[4/5] bg-[#efe8dc]" />;

  return (
    <div className="relative select-none" role="group" aria-roledescription="carousel" aria-label={`Photos of ${title}`}>
      <div
        ref={track}
        tabIndex={0}
        aria-label={`Photo ${index + 1} of ${count}. Use the arrow keys for the others.`}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className={`flex overflow-x-auto no-scrollbar snap-x snap-mandatory overscroll-x-contain aspect-[4/5] bg-[#efe8dc] ${count > 1 ? 'cursor-grab active:cursor-grabbing' : ''}`}
        data-testid="photo-track"
      >
        {images.map((img, i) => {
          const s = photoSources(img);
          return (
            <div key={`${img}-${i}`} role="group" aria-roledescription="slide" aria-label={`${i + 1} of ${count}`} className="relative w-full h-full shrink-0 snap-center snap-always">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={s.src}
                srcSet={s.srcSet}
                sizes={s.srcSet ? SHEET_SIZES : undefined}
                alt={i === 0 ? title : `${title}, photo ${i + 1}`}
                width={720}
                height={900}
                loading={i === 0 ? 'eager' : 'lazy'}
                decoding="async"
                draggable={false}
                className="photo absolute inset-0 w-full h-full object-cover"
              />
            </div>
          );
        })}
      </div>
      {children}
      {count > 1 && (
        <>
          <button
            type="button"
            onClick={() => go(index - 1)}
            disabled={index === 0}
            aria-label="Previous photo"
            className="absolute left-2 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-white/90 text-stone-900 shadow flex items-center justify-center disabled:opacity-0 transition-opacity"
          >
            <ChevronLeft className="w-5 h-5" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => go(index + 1)}
            disabled={index === count - 1}
            aria-label="Next photo"
            className="absolute right-2 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-white/90 text-stone-900 shadow flex items-center justify-center disabled:opacity-0 transition-opacity"
          >
            <ChevronRight className="w-5 h-5" aria-hidden="true" />
          </button>
          <div className="absolute bottom-2.5 inset-x-0 flex justify-center gap-1">
            {images.map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => go(i)}
                aria-label={`Show photo ${i + 1}`}
                aria-current={i === index ? 'true' : undefined}
                className="p-1.5 -m-0.5"
              >
                <span className={`block h-1.5 rounded-full shadow transition-all ${i === index ? 'w-4 bg-white' : 'w-1.5 bg-white/60'}`} />
              </button>
            ))}
          </div>
          <p className="sr-only" aria-live="polite">
            Photo {index + 1} of {count}
          </p>
        </>
      )}
    </div>
  );
}
