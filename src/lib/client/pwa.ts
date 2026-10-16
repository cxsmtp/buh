'use client';

/**
 * The shop as an app on a phone: the service worker (/sw.js, from src/app/sw.js/route.ts),
 * whether the shop is running as an installed app, the phone's own "Install" offer, and the
 * per-device feed layout.
 *
 * Updates: a new service worker is downloaded when a new version of the shop ships, then WAITS.
 * The page offers "New version ready — refresh"; applyUpdate() tells the waiting worker to take
 * over and reloads once it has. Without a tap it takes over by itself the next time the shop is
 * opened (every tab closed). Pages are never served from the cache while online, so a new
 * version of the page always loads straight away; only the worker's own files wait.
 */

import { useSyncExternalStore } from 'react';

let registration: ServiceWorkerRegistration | null = null;
const listeners = new Set<() => void>();
let waiting = false;

function setWaiting(v: boolean) {
  if (waiting === v) return;
  waiting = v;
  listeners.forEach((l) => l());
}

/** Register /sw.js for the whole site (production builds only; development reloads too often). */
export function registerServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  if (process.env.NODE_ENV !== 'production') return;
  // Only on a secure page (https, or localhost while testing): browsers refuse otherwise.
  if (!window.isSecureContext) return;
  navigator.serviceWorker
    .register('/sw.js', { scope: '/', updateViaCache: 'none' })
    .then((reg) => {
      registration = reg;
      const watch = (worker: ServiceWorker | null) => {
        if (!worker) return;
        const check = () => {
          // "installed" while another worker controls the page: an update, waiting for the go-ahead.
          if (worker.state === 'installed' && navigator.serviceWorker.controller) setWaiting(true);
        };
        check();
        worker.addEventListener('statechange', check);
      };
      if (reg.waiting && navigator.serviceWorker.controller) setWaiting(true);
      watch(reg.installing);
      reg.addEventListener('updatefound', () => watch(reg.installing));
    })
    .catch(() => {
      // No worker (private mode, blocked): the shop works the same, just without offline.
    });
}

/** Ask the server for a new worker now (the shop learned of a new version over /api/events). */
export function checkForUpdate(): void {
  void registration?.update().catch(() => {});
}

/** Is a new version's worker installed and waiting? (React) */
export function useUpdateWaiting(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => waiting,
    () => false
  );
}

/** Switch to the new version: the waiting worker takes over, then the page reloads (the bag is saved). */
export function applyUpdate(): void {
  const next = registration?.waiting;
  if (!next || !navigator.serviceWorker.controller) {
    window.location.reload();
    return;
  }
  let done = false;
  const reload = () => {
    if (done) return;
    done = true;
    window.location.reload();
  };
  navigator.serviceWorker.addEventListener('controllerchange', reload, { once: true });
  next.postMessage({ type: 'SKIP_WAITING' });
  // If the worker does not answer, reload anyway: pages always come from the network.
  setTimeout(reload, 3000);
}

/** Running as an installed app (from the home screen), not in a browser tab. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** iPhone or iPad Safari (no install button there: Share → Add to Home Screen). */
export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/** Chrome's install offer (beforeinstallprompt), not in TypeScript's DOM types. */
export interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

// ---- The feed layout on this device (phones): one photo per row, or two -----------------------

export type FeedLayout = 'one' | 'grid';
const LAYOUT_KEY = 'buh_feed_layout';
const layoutListeners = new Set<() => void>();

function readLayout(): FeedLayout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === 'grid' ? 'grid' : 'one';
  } catch {
    return 'one';
  }
}

export function setFeedLayout(layout: FeedLayout): void {
  try {
    localStorage.setItem(LAYOUT_KEY, layout);
  } catch {
    // storage blocked: the choice lasts until the page is closed
  }
  memoryLayout = layout;
  layoutListeners.forEach((l) => l());
}

let memoryLayout: FeedLayout | null = null;

/** The feed layout chosen on this device (one photo per row until changed). */
export function useFeedLayout(): FeedLayout {
  return useSyncExternalStore(
    (l) => {
      layoutListeners.add(l);
      return () => layoutListeners.delete(l);
    },
    () => memoryLayout ?? (memoryLayout = readLayout()),
    () => 'one'
  );
}
