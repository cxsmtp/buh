/**
 * The shop's service worker (served at /sw.js by src/app/sw.js/route.ts): hand-written, no library.
 *
 * What it keeps on the phone (docs/security.md, "What the installed app keeps on the phone"):
 *  - the offline page (/offline);
 *  - the shop's own scripts, styles and fonts (/_next/static/…: public, named by their content,
 *    so a file never changes under the same name), for fast repeat opens;
 *  - the app's icons and manifest;
 *  - uploaded product photos (/api/images/…: public, named by their content), the latest 120.
 *
 * What it never touches (the request goes to the server as if there were no worker):
 *  - anything that is not a GET (orders, checkout, sign-in, every change);
 *  - every other /api/ address: products and prices, orders, order tracking, the chat, phone
 *    codes, live updates, and all of /api/admin/;
 *  - other sites (Unsplash photos, Google sign-in scripts).
 *
 * Pages always come from the server while online (never from the cache), so a new version of the
 * shop shows at once and the version switch works as before. Offline, a page request gets the
 * calm offline page instead of the browser's error.
 *
 * Updates: the worker's text carries the shop's version, so each release is a new worker. It
 * installs in the background and then waits; the page offers "New version ready — refresh",
 * which sends SKIP_WAITING. Otherwise it takes over when the shop is next opened. On taking over
 * it deletes the old version's caches.
 *
 * The source is plain JavaScript in a string (no build step, nothing from the app bundled in),
 * written without template-literal placeholders so the version is the only thing inserted.
 */
export function serviceWorkerSource(version: string): string {
  const v = JSON.stringify(String(version).replace(/[^\w.-]/g, '').slice(0, 40) || 'dev');
  return `'use strict';
const VERSION = ${v};
${SW_BODY}`;
}

const SW_BODY = String.raw`const SHELL = 'buh-shell-' + VERSION;
const STATIC = 'buh-static-' + VERSION;
const IMAGES = 'buh-images';
const OFFLINE = '/offline';
const MAX_STATIC = 300;
const MAX_IMAGES = 120;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const shell = await caches.open(SHELL);
      await shell.addAll([OFFLINE, '/manifest.webmanifest']);
      // The scripts and styles the shop's front page uses, so the next open is fast.
      try {
        const res = await fetch('/', { cache: 'no-store', credentials: 'omit' });
        const html = await res.text();
        const found = html.match(/\/_next\/static\/[^"'\s()<>\\]+/g) || [];
        const urls = [...new Set(found)].filter((u) => /\.(js|css|woff2?)$/.test(u)).slice(0, 80);
        const cache = await caches.open(STATIC);
        await Promise.all(urls.map((u) => cache.add(u).catch(() => {})));
      } catch (e) {
        // offline while installing: the files are cached as they are used instead
      }
      // No skipWaiting here: a new version waits for the page's go-ahead or the next open.
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith('buh-') && key !== SHELL && key !== STATIC && key !== IMAGES) await caches.delete(key);
      }
      if (self.registration.navigationPreload) {
        try {
          await self.registration.navigationPreload.enable();
        } catch (e) {}
      }
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Orders, checkout, sign-in, every change: straight to the server, never through here.
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const path = url.pathname;
  if (path.startsWith('/api/images/')) {
    event.respondWith(cacheFirst(event, IMAGES, MAX_IMAGES));
    return;
  }
  // Prices, stock, orders, tracking, chat, codes, live updates and all of /api/admin/: never cached.
  if (path.startsWith('/api/') || path === '/sw.js') return;
  if (req.mode === 'navigate') {
    event.respondWith(pageOrOffline(event));
    return;
  }
  if (path.startsWith('/_next/static/')) {
    event.respondWith(cacheFirst(event, STATIC, MAX_STATIC));
    return;
  }
  if (path.startsWith('/icons/') || path === '/manifest.webmanifest') {
    event.respondWith(freshOrCached(event, SHELL));
  }
});

/** Pages: always the server's latest; the offline page only when there is no network. */
async function pageOrOffline(event) {
  try {
    const preloaded = await event.preloadResponse;
    if (preloaded) return preloaded;
    return await fetch(event.request);
  } catch (e) {
    const offline = await caches.match(OFFLINE, { cacheName: SHELL });
    return offline || new Response('You are offline. Please try again when you are connected.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}

/** Files named by their content: the copy on the phone if there is one, else the network (and keep it). */
async function cacheFirst(event, name, max) {
  const cache = await caches.open(name);
  const hit = await cache.match(event.request);
  if (hit) return hit;
  const res = await fetch(event.request);
  if (cacheable(res)) {
    const copy = res.clone();
    event.waitUntil(cache.put(event.request, copy).then(() => trim(cache, max)).catch(() => {}));
  }
  return res;
}

/** Icons and the manifest: the network's latest (and keep it), the kept copy when offline. */
async function freshOrCached(event, name) {
  const cache = await caches.open(name);
  try {
    const res = await fetch(event.request);
    if (cacheable(res)) {
      const copy = res.clone();
      event.waitUntil(cache.put(event.request, copy).catch(() => {}));
    }
    return res;
  } catch (e) {
    const hit = await cache.match(event.request, { ignoreSearch: true });
    if (hit) return hit;
    throw e;
  }
}

function cacheable(res) {
  if (!res || !res.ok || res.type !== 'basic' || res.status !== 200) return false;
  const cc = (res.headers.get('Cache-Control') || '').toLowerCase();
  return !cc.includes('no-store') && !cc.includes('private');
}

async function trim(cache, max) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}
`;
