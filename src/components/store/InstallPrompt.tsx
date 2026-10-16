'use client';

import React, { useEffect, useState } from 'react';
import { Share, SquarePlus, X } from 'lucide-react';
import { isIos, isStandalone, type InstallPromptEvent } from '@/lib/client/pwa';

const SEEN_KEY = 'buh_install_prompt';
/** How long a shopper has been looking before the offer appears (never straight away). */
export const INSTALL_DELAY_MS = 6000;

function seen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) !== null;
  } catch {
    return true; // storage blocked: we could not remember a "Not now", so don't ask at all
  }
}
function markSeen(how: string) {
  try {
    localStorage.setItem(SEEN_KEY, how);
  } catch {
    // nothing to do
  }
}

interface InstallPromptProps {
  /** Something is open (checkout, the bag, a product, the admin hub): wait. */
  blocked: boolean;
  /** The logo, shown on the card. */
  logo?: React.ReactNode;
}

/**
 * "Install the app": a small card offering the shop on the home screen, like an app. On Android
 * (Chrome, Edge, Samsung Internet) it uses the phone's own install offer; on an iPhone or iPad it
 * says how (Share, then Add to Home Screen), since Safari has no button for it.
 *
 * Shown once per device (Install, Not now or ✕ all count), only after a few seconds of looking,
 * never while something is open (and so never during checkout), never inside the installed app.
 */
export function InstallPrompt({ blocked, logo }: InstallPromptProps) {
  const [offer, setOffer] = useState<InstallPromptEvent | null>(null);
  const [ios, setIos] = useState(false);
  const [ready, setReady] = useState(false);
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (isStandalone() || seen()) return;
    const onOffer = (e: Event) => {
      e.preventDefault(); // we show our own card instead of the browser's banner
      setOffer(e as InstallPromptEvent);
    };
    const onInstalled = () => {
      markSeen('installed');
      setDone(true);
    };
    window.addEventListener('beforeinstallprompt', onOffer);
    window.addEventListener('appinstalled', onInstalled);
    // Safari on iPhone/iPad (not Chrome or another app's browser there, which can't add to the home screen).
    const ua = navigator.userAgent;
    const safari = isIos() && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|Instagram|FBAN|FBAV|WhatsApp/.test(ua);
    const t = setTimeout(() => {
      if (safari) setIos(true);
      setReady(true);
    }, INSTALL_DELAY_MS);
    return () => {
      clearTimeout(t);
      window.removeEventListener('beforeinstallprompt', onOffer);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  // Appear once there is something to offer, the shopper has looked around, and nothing is open.
  const eligible = ready && !done && (offer !== null || ios);
  useEffect(() => {
    if (!eligible || blocked || open) return;
    const t = setTimeout(() => {
      setOpen(true);
      markSeen('shown'); // once per device, even if the page is closed without an answer
    }, 400);
    return () => clearTimeout(t);
  }, [eligible, blocked, open]);

  if (!open || done || blocked) return null;

  const close = () => {
    markSeen('dismissed');
    setDone(true);
  };
  const install = async () => {
    if (!offer) return;
    try {
      await offer.prompt();
      const choice = await offer.userChoice;
      markSeen(choice.outcome);
    } catch {
      // the browser withdrew the offer
    }
    setDone(true);
  };

  return (
    <section
      role="region"
      aria-label="Install the app"
      className="browser-only fixed z-[42] inset-x-3 bottom-above-tabs md:bottom-6 md:left-6 md:right-auto md:w-[360px] rounded-2xl bg-white text-stone-900 shadow-2xl border border-stone-200 p-4 rise-in"
    >
      <div className="flex items-start gap-3">
        <span className="shrink-0">{logo}</span>
        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="text-sm font-semibold text-stone-900">Install the shop as an app</h2>
          {ios ? (
            <p className="text-xs text-stone-700 leading-relaxed">
              Tap <Share className="inline w-4 h-4 -mt-0.5 text-[#0f1c2e]" aria-label="Share" /> <strong>Share</strong> at the bottom of Safari, then{' '}
              <SquarePlus className="inline w-4 h-4 -mt-0.5 text-[#0f1c2e]" aria-hidden="true" /> <strong>Add to Home Screen</strong>.
            </p>
          ) : (
            <p className="text-xs text-stone-700 leading-relaxed">Open the shop from your home screen, full screen, like an app. It takes no space and no store.</p>
          )}
        </div>
        <button type="button" onClick={close} aria-label="Close" className="shrink-0 -mt-1 -mr-1 w-9 h-9 rounded-full flex items-center justify-center text-stone-700 hover:bg-stone-100">
          <X className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>
      <div className="mt-3 flex items-center justify-end gap-2">
        <button type="button" onClick={close} className="h-10 px-4 rounded-full text-sm font-medium text-stone-800 hover:bg-stone-100">
          {ios ? 'Got it' : 'Not now'}
        </button>
        {!ios && (
          <button type="button" onClick={() => void install()} className="h-10 px-5 rounded-full bg-[#0f1c2e] text-white text-sm font-semibold hover:bg-[#1c2c44]">
            Install
          </button>
        )}
      </div>
    </section>
  );
}
