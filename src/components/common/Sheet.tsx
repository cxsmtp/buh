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
    // No rubber-band or pull-to-reload on the page behind (globals.css).
    document.documentElement.classList.add('sheet-open');
  }
}
function unlockScroll() {
  if (--locks === 0) {
    document.documentElement.style.overflow = '';
    document.documentElement.classList.remove('sheet-open');
  }
}

/**
 * The same keyboard manners for a dialog that draws itself (checkout, the bag, Track Order…):
 * while `active`, focus moves into the panel (the panel itself, so a phone's keyboard does not pop
 * up), Tab and Shift+Tab stay inside it, Escape calls onEscape, and on closing focus goes back to
 * what opened it. Give the panel `ref={panel}` and `tabIndex={-1}`.
 */
export function useDialogFocus<T extends HTMLElement = HTMLDivElement>(active: boolean, onEscape?: () => void) {
  const panel = useRef<T>(null);
  const escape = useRef(onEscape);
  useEffect(() => {
    escape.current = onEscape;
  }, [onEscape]);

  useEffect(() => {
    if (!active) return;
    const opener = document.activeElement as HTMLElement | null;
    if (panel.current && !panel.current.contains(document.activeElement)) panel.current.focus({ preventScroll: true });
    const onKeyDown = (e: KeyboardEvent) => {
      const el = panel.current;
      if (!el) return;
      const at = document.activeElement as HTMLElement | null;
      // Another dialog on top (the photo zoom, the chat) keeps its own keys.
      const other = at?.closest?.('[role="dialog"]');
      if (other && !el.contains(other) && !other.contains(el)) return;
      if (e.key === 'Escape') {
        escape.current?.();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null || x === at);
      if (!items.length) {
        e.preventDefault();
        el.focus({ preventScroll: true });
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const inside = Boolean(at && el.contains(at));
      if (e.shiftKey && (!inside || at === first || at === el)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || at === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    // On the window, above the page's own handlers: a field that handles Escape or Tab itself (the
    // area list, the pin search) stops the key there, and it never reaches this.
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      // Back to the button that opened it (if it is still on the page and nothing else took focus).
      const now = document.activeElement;
      const lost = !now || now === document.body || !document.contains(now) || Boolean(panel.current?.contains(now));
      if (lost && opener && document.contains(opener) && typeof opener.focus === 'function') opener.focus({ preventScroll: true });
    };
  }, [active]);

  return panel;
}

export interface SheetProps {
  /** The dialog's accessible name comes from this element's text. */
  labelledBy: string;
  onClose: () => void;
  children: React.ReactNode;
  /** full: the whole screen on phones and upright tablets (product); bottom: up to 90% high (filters); top: search. */
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
    // A sheet inside a sheet (the photo zoom) keeps Tab to itself.
    e.stopPropagation();
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
        ? 'items-stretch twopane:items-center justify-center twopane:p-6'
        : 'items-end sm:items-center justify-center sm:p-4';
  const shape =
    variant === 'top'
      ? 'w-full sm:max-w-xl max-h-[100dvh] sm:max-h-[80dvh] sm:rounded-3xl border-b sm:border sheet-down pt-safe sm:pt-0'
      : variant === 'full'
        ? // Full screen on phones and upright tablets (like opening a post), a dialog when side by side.
          `w-full ${wide ? 'twopane:max-w-5xl' : 'twopane:max-w-xl'} h-[100dvh] twopane:h-auto twopane:max-h-[92dvh] twopane:rounded-3xl twopane:border sheet-up twopane:[animation-name:sheet-fade] pt-safe px-safe twopane:pt-0 twopane:px-0`
        : `w-full ${wide ? 'sm:max-w-2xl' : 'sm:max-w-lg'} max-h-[90dvh] sm:max-h-[85dvh] rounded-t-3xl sm:rounded-3xl border-t sm:border sheet-up sm:[animation-name:sheet-fade] px-safe sm:px-0`;

  return (
    <div className={`fixed inset-0 z-50 flex ${layout}`} onKeyDown={onKeyDown}>
      <div className="absolute inset-0 bg-scrim/45 sheet-fade" aria-hidden="true" onClick={() => close.current()} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={`relative min-w-0 max-w-full bg-surface text-ink border-line shadow-[0_24px_60px_-30px_rgb(43_33_39/0.45)] flex flex-col overflow-hidden outline-none ${shape} ${className}`}
      >
        {children}
      </div>
    </div>
  );
}
