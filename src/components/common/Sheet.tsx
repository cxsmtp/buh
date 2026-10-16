'use client';

import React, { useEffect, useRef } from 'react';

/**
 * A dialog that slides up from the bottom on phones (full screen or a bottom sheet) and sits in
 * the middle (or at the top, for search) on bigger screens. Keyboard: focus moves into it, Tab
 * stays inside, Escape closes it, and focus goes back to what opened it. The page behind does
 * not scroll while it is open. Motion is skipped for people who asked their device for less.
 */

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

let locks = 0;
function lockScroll() {
  if (locks++ === 0) {
    document.documentElement.style.overflow = 'hidden';
  }
}
function unlockScroll() {
  if (--locks === 0) {
    document.documentElement.style.overflow = '';
  }
}

export interface SheetProps {
  /** The dialog's accessible name comes from this element's text. */
  labelledBy: string;
  onClose: () => void;
  children: React.ReactNode;
  /** full: the whole screen on phones (product); bottom: up to 90% high (filters); top: search. */
  variant?: 'full' | 'bottom' | 'top';
  /** Width on bigger screens. */
  wide?: boolean;
  /** Where focus goes first (else the first focusable thing). */
  initialFocus?: React.RefObject<HTMLElement | null>;
  className?: string;
}

export function Sheet({ labelledBy, onClose, children, variant = 'bottom', wide = false, initialFocus, className = '' }: SheetProps) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    lockScroll();
    const target = initialFocus?.current ?? panel.current?.querySelector<HTMLElement>('[data-autofocus]') ?? panel.current;
    target?.focus({ preventScroll: true });
    return () => {
      unlockScroll();
      // Back to the button that opened it (if it is still on the page).
      if (opener && document.contains(opener) && typeof opener.focus === 'function') opener.focus({ preventScroll: true });
    };
    // Only on open/close: initialFocus is a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close.current();
      return;
    }
    if (e.key !== 'Tab' || !panel.current) return;
    const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (!items.length) {
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const layout =
    variant === 'top'
      ? 'items-start justify-center sm:pt-16'
      : variant === 'full'
        ? 'items-stretch sm:items-center justify-center sm:p-4 md:p-6'
        : 'items-end sm:items-center justify-center sm:p-4';
  const shape =
    variant === 'top'
      ? 'w-full sm:max-w-xl max-h-[100dvh] sm:max-h-[80vh] sm:rounded-3xl sheet-down'
      : variant === 'full'
        ? `w-full ${wide ? 'sm:max-w-5xl' : 'sm:max-w-xl'} h-[100dvh] sm:h-auto sm:max-h-[92vh] sm:rounded-3xl sheet-up sm:[animation-name:sheet-fade]`
        : `w-full ${wide ? 'sm:max-w-2xl' : 'sm:max-w-lg'} max-h-[90dvh] sm:max-h-[85vh] rounded-t-3xl sm:rounded-3xl sheet-up sm:[animation-name:sheet-fade]`;

  return (
    <div className={`fixed inset-0 z-50 flex ${layout}`} onKeyDown={onKeyDown}>
      <div className="absolute inset-0 bg-black/55 sheet-fade" aria-hidden="true" onClick={() => close.current()} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={`relative bg-white text-stone-900 shadow-2xl flex flex-col overflow-hidden outline-none ${shape} ${className}`}
      >
        {children}
      </div>
    </div>
  );
}
