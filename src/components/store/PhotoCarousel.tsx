'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Expand } from 'lucide-react';
import { PhotoZoom } from './PhotoZoom';
import { SHEET_SIZES, photoSources } from '@/lib/client/photos';

interface PhotoCarouselProps {
  images: string[];
  /** "Photos of …" for screen readers. */
  title: string;
  /** Photos styled by AI from the real one: each shows a small "Styled image" tag. */
  styled?: ReadonlySet<string>;
  children?: React.ReactNode;
}

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * A product's photos, one at a time, swiped sideways with a finger (native scrolling with snap
 * points, so it is smooth on every phone) or dragged with a mouse. Previous / next buttons, the
 * dots, and the arrow keys (when the photos have focus) do the same. A tap on a photo (or the
 * expand button) shows it full screen, to pinch and zoom into.
 */
export function PhotoCarousel({ images, title, styled, children }: PhotoCarouselProps) {
  const track = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const drag = useRef<{ x: number; left: number; from: number } | null>(null);
  // The photo shown full screen to zoom into (tap a photo, or the expand button).
  const [zoom, setZoom] = useState<number | null>(null);
  // A mouse drag that moved the photos is not a tap.
  const dragged = useRef(false);
  const count = images.length;

  // The photo a button, dot, key or drag is sliding to. While the slide is under way the scroll
  // position still points at the photos it passes (it starts on the old one), so the counter must
  // not follow it: a second tap or arrow key in that moment counted from the old photo, and screen
  // readers heard "photo 1" right after "photo 2".
  const target = useRef<number | null>(null);

  const go = useCallback(
    (i: number, instant = false) => {
      const el = track.current;
      if (!el || !count) return;
      const next = Math.max(0, Math.min(count - 1, i));
      const left = next * el.clientWidth;
      // Already there: no scroll will happen (and nothing would clear the target).
      target.current = Math.abs(el.scrollLeft - left) < 2 ? null : next;
      el.scrollTo({ left, behavior: instant || reducedMotion() ? 'auto' : 'smooth' });
      setIndex(next);
    },
    [count]
  );

  // Keep the dots in step with a finger swipe (not with a slide we started: see target).
  const lastScroll = useRef(0);
  const onScroll = () => {
    lastScroll.current = performance.now();
    const el = track.current;
    if (!el || drag.current) return;
    const w = Math.max(1, el.clientWidth);
    if (target.current !== null) {
      if (Math.abs(el.scrollLeft - target.current * w) < 2) target.current = null; // arrived
      return;
    }
    const i = Math.max(0, Math.min(count - 1, Math.round(el.scrollLeft / w)));
    if (i !== index) setIndex(i);
  };
  // A slide that stopped short of its photo (the browser gave up on it) must not leave the counter
  // stuck. But scrollend also fires when our own next slide interrupts the previous one, with a new
  // slide already under way: so only once the track has really stopped moving.
  const onScrollEnd = () => {
    if (target.current === null || drag.current) return;
    const ended = performance.now();
    setTimeout(() => {
      const el = track.current;
      if (!el || target.current === null || drag.current || lastScroll.current > ended) return;
      target.current = null;
      const i = Math.max(0, Math.min(count - 1, Math.round(el.scrollLeft / Math.max(1, el.clientWidth))));
      setIndex(i);
    }, 300);
  };
  // A finger takes over from a slide we started.
  const release = () => {
    target.current = null;
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
    target.current = null;
    drag.current = { x: e.clientX, left: track.current.scrollLeft, from: index };
    dragged.current = false;
    track.current.setPointerCapture(e.pointerId);
    track.current.style.scrollSnapType = 'none';
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !track.current) return;
    if (Math.abs(e.clientX - d.x) > 6) dragged.current = true;
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

  if (!count) return <div className="aspect-[4/5] bg-sand-deep" />;

  return (
    <div className="relative select-none" role="group" aria-roledescription="carousel" aria-label={`Photos of ${title}`}>
      <div
        ref={track}
        tabIndex={0}
        aria-label={`Photo ${index + 1} of ${count}. Use the arrow keys for the others.`}
        onScroll={onScroll}
        onScrollEnd={onScrollEnd}
        onTouchStart={release}
        onWheel={release}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className={`flex overflow-x-auto no-scrollbar snap-x snap-mandatory overscroll-x-contain aspect-[4/5] bg-sand-deep ${count > 1 ? 'cursor-grab active:cursor-grabbing' : ''}`}
        data-testid="photo-track"
      >
        {images.map((img, i) => {
          const s = photoSources(img);
          return (
            <div
              key={`${img}-${i}`}
              role="group"
              aria-roledescription="slide"
              aria-label={`${i + 1} of ${count}`}
              className="relative w-full h-full shrink-0 snap-center snap-always cursor-zoom-in"
              onClick={() => {
                if (dragged.current) {
                  dragged.current = false;
                  return;
                }
                setZoom(i);
              }}
            >
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
              {styled?.has(img) && (
                <span className="pointer-events-none absolute left-3 bottom-3 rounded-full bg-surface/90 px-2 py-0.5 text-[11px] font-semibold text-ink shadow-sm" data-testid="styled-tag">
                  Styled image
                </span>
              )}
            </div>
          );
        })}
      </div>
      {children}
      <button
        type="button"
        onClick={() => setZoom(index)}
        aria-label="Zoom photo"
        className="absolute right-3 top-3 w-10 h-10 rounded-full bg-surface/90 text-ink flex items-center justify-center"
      >
        <Expand className="w-4 h-4" aria-hidden="true" />
      </button>
      {zoom !== null && (
        <PhotoZoom
          images={images}
          start={zoom}
          title={title}
          onClose={(i) => {
            setZoom(null);
            // Back on the photo last seen full screen (no slide: it was out of sight).
            go(i, true);
          }}
        />
      )}
      {count > 1 && (
        <>
          <button
            type="button"
            onClick={() => go(index - 1)}
            disabled={index === 0}
            aria-label="Previous photo"
            className="absolute left-2 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-surface/90 text-ink flex items-center justify-center disabled:opacity-0 transition-opacity"
          >
            <ChevronLeft className="w-5 h-5" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => go(index + 1)}
            disabled={index === count - 1}
            aria-label="Next photo"
            className="absolute right-2 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-surface/90 text-ink flex items-center justify-center disabled:opacity-0 transition-opacity"
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
                <span className={`block h-1.5 rounded-full  transition-all ${i === index ? 'w-4 bg-surface' : 'w-1.5 bg-surface/60'}`} />
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
