'use client';

import { useEffect, useRef } from 'react';

/**
 * Watch /api/events (or /api/admin/events) and call back when something
 * changed: the page reloads just that data in the background, so prices, stock
 * and settings stay current without a refresh and without losing the bag or a
 * half-filled form. If the shop itself was updated (a new version), onNewVersion
 * is called once. EventSource reconnects by itself.
 */

type Versions = { catalog?: number; settings?: number; orders?: number; app?: string };

export function useLiveUpdates(
  url: string | null,
  handlers: { onCatalog?: () => void; onSettings?: () => void; onOrders?: () => void; onNewVersion?: () => void }
) {
  const ref = useRef(handlers);
  useEffect(() => {
    ref.current = handlers;
  });

  useEffect(() => {
    if (!url || typeof EventSource === 'undefined') return;
    const ownVersion = process.env.NEXT_PUBLIC_APP_VERSION ?? '';
    let last: Versions | null = null;
    let told = false;
    let source: EventSource;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let delay = 5000;
    let stopped = false;
    const open = () => {
      source = new EventSource(url);
      source.onopen = () => {
        delay = 5000;
      };
      // EventSource gives up for good after an HTTP error (a 502 during a restart, a 429):
      // open a new one, waiting longer each time (up to 5 minutes).
      source.onerror = () => {
        if (source.readyState !== EventSource.CLOSED || stopped) return;
        retry = setTimeout(open, delay);
        delay = Math.min(delay * 2, 300_000);
      };
      source.onmessage = onMessage;
    };
    const onMessage = (e: MessageEvent) => {
      let v: Versions;
      try {
        v = JSON.parse(e.data) as Versions;
      } catch {
        return;
      }
      if (last) {
        if (v.catalog !== last.catalog) ref.current.onCatalog?.();
        if (v.settings !== last.settings) ref.current.onSettings?.();
        if (v.orders !== undefined && v.orders !== last.orders) ref.current.onOrders?.();
      }
      if (v.app && ownVersion && v.app !== ownVersion && !told) {
        told = true;
        ref.current.onNewVersion?.();
      }
      last = v;
    };
    open();
    return () => {
      stopped = true;
      clearTimeout(retry);
      source.close();
    };
  }, [url]);
}
