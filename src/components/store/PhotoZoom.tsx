'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Minus, Plus, X } from 'lucide-react';
import { ZOOM_SIZES, photoSources } from '@/lib/client/photos';

interface PhotoZoomProps {
  images: string[];
  start: number;
  title: string;
  onClose: (index: number) => void;
}

const MAX = 4;
type View = { s: number; x: number; y: number };
const FIT: View = { s: 1, x: 0, y: 0 };

/**
 * A product photo full screen, to see the print and the weave up close: pinch to zoom and drag
 * to look around (fingers), double-tap to zoom in or out, swipe sideways for the next photo. With
 * a mouse or keyboard: the + and − buttons, the mouse wheel, the arrow keys. Escape, ✕ or the
 * phone's Back button close it, back on the same photo in the product.
 */
export function PhotoZoom({ images, start, title, onClose }: PhotoZoomProps) {
  const [index, setIndex] = useState(start);
  const [view, setView] = useState<View>(FIT);
  // A finger or the mouse is down: the photo follows it without easing.
  const [held, setHeld] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ view: View; dist: number; mid: { x: number; y: number }; at: { x: number; y: number } } | null>(null);
  const lastTap = useRef(0);
  const indexRef = useRef(index);
  useEffect(() => {
    indexRef.current = index;
  }, [index]);
  const count = images.length;

  // Coordinates relative to the middle of the stage.
  const local = (x: number, y: number) => {
    const r = stage.current!.getBoundingClientRect();
    return { x: x - r.left - r.width / 2, y: y - r.top - r.height / 2 };
  };
  const clamp = useCallback((v: View): View => {
    const r = stage.current?.getBoundingClientRect();
    const s = Math.max(1, Math.min(MAX, v.s));
    if (!r || s === 1) return { s, x: 0, y: 0 };
    const mx = ((s - 1) * r.width) / 2;
    const my = ((s - 1) * r.height) / 2;
    return { s, x: Math.max(-mx, Math.min(mx, v.x)), y: Math.max(-my, Math.min(my, v.y)) };
  }, []);
  /** Zoom to scale s keeping the point p (relative to the middle) where it is. */
  const zoomAt = useCallback((from: View, s: number, p: { x: number; y: number }) => {
    const k = Math.max(1, Math.min(MAX, s)) / from.s;
    return clamp({ s: from.s * k, x: p.x - (p.x - from.x) * k, y: p.y - (p.y - from.y) * k });
  }, [clamp]);

  const go = useCallback(
    (i: number) => {
      if (i < 0 || i >= count) return;
      setIndex(i);
      setView(FIT);
    },
    [count]
  );

  // The phone's Back button closes the zoom (not the product): a history step of its own.
  const closing = useRef(false);
  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    window.history.back();
  }, []);
  useEffect(() => {
    window.history.pushState({ zoom: true }, '', window.location.href);
    const onPop = () => {
      closing.current = true;
      onClose(indexRef.current);
    };
    window.addEventListener('popstate', onPop);
    const opener = document.activeElement as HTMLElement | null;
    closeBtn.current?.focus({ preventScroll: true });
    return () => {
      window.removeEventListener('popstate', onPop);
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    };
    // Once, on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowRight' && view.s === 1) go(index + 1);
    else if (e.key === 'ArrowLeft' && view.s === 1) go(index - 1);
    else if (e.key === '+' || e.key === '=') setView((v) => zoomAt(v, v.s * 1.5, { x: 0, y: 0 }));
    else if (e.key === '-') setView((v) => zoomAt(v, v.s / 1.5, { x: 0, y: 0 }));
    else if (e.key === 'Tab') {
      // Keep the keyboard inside.
      e.stopPropagation();
      const items = [...(root.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? [])];
      if (!items.length) return;
      const i = items.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : i === items.length - 1 ? 0 : i + 1;
      e.preventDefault();
      items[next].focus();
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    stage.current?.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    setHeld(true);
    startGesture();
  };
  const startGesture = () => {
    const pts = [...pointers.current.values()];
    if (!pts.length || !stage.current) {
      gesture.current = null;
      return;
    }
    const mid = local((pts[0].x + (pts[1]?.x ?? pts[0].x)) / 2, (pts[0].y + (pts[1]?.y ?? pts[0].y)) / 2);
    const dist = pts[1] ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
    gesture.current = { view, dist, mid, at: { x: pts[0].x, y: pts[0].y } };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId) || !gesture.current) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    const g = gesture.current;
    if (pts.length >= 2 && g.dist > 0) {
      const mid = local((pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2);
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const s = Math.max(1, Math.min(MAX, (g.view.s * dist) / g.dist));
      // The point under the fingers stays under them, and follows them.
      const p = { x: (g.mid.x - g.view.x) / g.view.s, y: (g.mid.y - g.view.y) / g.view.s };
      setView(clamp({ s, x: mid.x - p.x * s, y: mid.y - p.y * s }));
    } else if (pts.length === 1 && g.view.s > 1) {
      setView(clamp({ s: g.view.s, x: g.view.x + (pts[0].x - g.at.x), y: g.view.y + (pts[0].y - g.at.y) }));
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const g = gesture.current;
    const wasSingle = pointers.current.size === 1;
    pointers.current.delete(e.pointerId);
    if (g && wasSingle) {
      const dx = e.clientX - g.at.x;
      const dy = e.clientY - g.at.y;
      const moved = Math.hypot(dx, dy) > 10;
      if (!moved) {
        // Double-tap: zoom in where tapped, or back to the whole photo.
        const now = Date.now();
        if (now - lastTap.current < 320) {
          lastTap.current = 0;
          setView((v) => (v.s > 1 ? FIT : zoomAt(v, 2.5, local(e.clientX, e.clientY))));
        } else lastTap.current = now;
      } else if (g.view.s === 1 && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) {
        go(index + (dx < 0 ? 1 : -1));
      }
    }
    if (!pointers.current.size) setHeld(false);
    startGesture();
  };
  const onWheel = (e: React.WheelEvent) => {
    const p = local(e.clientX, e.clientY);
    setView((v) => zoomAt(v, v.s * (e.deltaY < 0 ? 1.2 : 1 / 1.2), p));
  };

  const s = photoSources(images[index], [720, 1080, 1440, 2048]);
  const btn = 'w-11 h-11 rounded-full bg-white/15 text-white flex items-center justify-center hover:bg-white/25 disabled:opacity-30 backdrop-blur';

  return createPortal(
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-label={`${title}, photo ${index + 1} of ${count}, zoomed`}
      onKeyDown={onKeyDown}
      className="fixed inset-0 z-[60] bg-black text-white flex flex-col sheet-fade"
      data-testid="photo-zoom"
    >
      <div className="absolute top-0 inset-x-0 z-10 flex items-center justify-between gap-2 px-3 pt-[calc(0.75rem+env(safe-area-inset-top,0px))]">
        <span className="text-sm text-white/90 tabular-nums" aria-live="polite">
          {index + 1} / {count}
        </span>
        <div className="flex items-center gap-2">
          <button type="button" className={btn} onClick={() => setView((v) => zoomAt(v, v.s / 1.5, { x: 0, y: 0 }))} disabled={view.s <= 1} aria-label="Zoom out">
            <Minus className="w-5 h-5" aria-hidden="true" />
          </button>
          <button type="button" className={btn} onClick={() => setView((v) => zoomAt(v, v.s * 1.5, { x: 0, y: 0 }))} disabled={view.s >= MAX} aria-label="Zoom in">
            <Plus className="w-5 h-5" aria-hidden="true" />
          </button>
          <button ref={closeBtn} type="button" className={btn} onClick={close} aria-label="Close zoom">
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>
      </div>
      <div
        ref={stage}
        className="zoom-stage relative flex-1 overflow-hidden select-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          key={images[index]}
          src={s.src}
          srcSet={s.srcSet}
          sizes={s.srcSet ? ZOOM_SIZES : undefined}
          alt={index === 0 ? title : `${title}, photo ${index + 1}`}
          draggable={false}
          className="photo absolute inset-0 w-full h-full object-contain will-change-transform"
          style={{ transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.s})`, transition: held ? 'none' : 'transform 0.2s ease-out' }}
          data-scale={view.s.toFixed(2)}
        />
      </div>
      {count > 1 && (
        <div className="absolute bottom-0 inset-x-0 flex items-center justify-between px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))]">
          <button type="button" className={btn} onClick={() => go(index - 1)} disabled={index === 0} aria-label="Previous photo">
            <ChevronLeft className="w-5 h-5" aria-hidden="true" />
          </button>
          <button type="button" className={btn} onClick={() => go(index + 1)} disabled={index === count - 1} aria-label="Next photo">
            <ChevronRight className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>
      )}
    </div>,
    document.body
  );
}
