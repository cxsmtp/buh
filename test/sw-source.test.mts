/**
 * The service worker's rules, run in a stand-in for the browser's worker: which requests it answers
 * (and so may cache) and which it leaves alone. Never: anything not a GET (orders, checkout,
 * sign-in), any /api/ address but the public photos (prices, orders, tracking, chat, codes, live
 * updates and all of /api/admin/), other sites. A new version installs and then waits for the
 * page's go-ahead; it clears the old version's caches when it takes over.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serviceWorkerSource } from '@/lib/serviceWorker';

type Listener = (e: unknown) => void;

function load(version = 'BUH-02.05.00') {
  const listeners: Record<string, Listener> = {};
  const deleted: string[] = [];
  const fetched: string[] = [];
  let skipped = 0;
  const store = new Map<string, Map<string, unknown>>([['buh-shell-BUH-01.00.00', new Map()], ['buh-static-BUH-01.00.00', new Map()], ['buh-images', new Map()], ['other-app', new Map()]]);
  const cacheFor = (name: string) => {
    if (!store.has(name)) store.set(name, new Map());
    const m = store.get(name)!;
    return {
      addAll: async (urls: string[]) => urls.forEach((u) => m.set(u, 'x')),
      add: async (u: string) => void m.set(u, 'x'),
      match: async (r: { url?: string } | string) => m.get(typeof r === 'string' ? r : r.url!),
      put: async (r: { url: string }, res: unknown) => void m.set(r.url, res),
      keys: async () => [...m.keys()],
      delete: async (k: string) => m.delete(k),
    };
  };
  const self = {
    location: { origin: 'https://shop.test' },
    addEventListener: (type: string, fn: Listener) => (listeners[type] = fn),
    skipWaiting: () => void skipped++,
    registration: { navigationPreload: null },
    clients: { claim: async () => {} },
  };
  const caches = {
    open: async (n: string) => cacheFor(n),
    keys: async () => [...store.keys()],
    delete: async (n: string) => (deleted.push(n), store.delete(n)),
    match: async (u: string, o?: { cacheName?: string }) => (o?.cacheName ? store.get(o.cacheName)?.get(u) : undefined),
  };
  const fakeFetch = async (r: string | { url: string }) => {
    const url = typeof r === 'string' ? r : r.url;
    fetched.push(url);
    return { ok: true, status: 200, type: 'basic', headers: new Map([['Cache-Control', 'public']]), clone() { return this; }, text: async () => '<script src="/_next/static/chunks/a1.js"></script><link href="/_next/static/css/b2.css">' };
  };
  new Function('self', 'caches', 'fetch', 'Response', 'URL', serviceWorkerSource(version))(self, caches, fakeFetch, class {}, URL);

  /** Does the worker answer this request (respondWith), or leave it to the network? */
  const answers = (url: string, init: { method?: string; mode?: string } = {}) => {
    let answered = false;
    listeners.fetch({
      request: { url: new URL(url, 'https://shop.test').href, method: init.method ?? 'GET', mode: init.mode ?? 'cors' },
      respondWith: () => (answered = true),
      waitUntil: () => {},
    });
    return answered;
  };
  return { listeners, answers, store, deleted, fetched, skipped: () => skipped };
}

test('the worker never answers orders, checkout, admin, personal data or other sites', () => {
  const sw = load();
  for (const [url, method] of [
    ['/api/orders', 'POST'],
    ['/api/otp/send', 'POST'],
    ['/api/admin/login', 'POST'],
    ['/api/admin/orders', 'GET'],
    ['/api/admin/settings', 'GET'],
    ['/api/admin/backup', 'GET'],
    ['/api/orders/lookup?id=BUH-1', 'GET'],
    ['/api/products', 'GET'],
    ['/api/settings/public', 'GET'],
    ['/api/chat/abc', 'GET'],
    ['/api/events', 'GET'],
    ['/api/health', 'GET'],
    ['/sw.js', 'GET'],
    ['https://images.unsplash.com/photo-1?w=540', 'GET'],
    ['https://www.google.com/recaptcha/api.js', 'GET'],
    ['/', 'POST'],
  ] as const) {
    assert.equal(sw.answers(url, { method }), false, `${method} ${url}`);
  }
  // Even opened as a page (a link to /api/health), an API address is left alone.
  assert.equal(sw.answers('/api/admin/orders', { mode: 'navigate' }), false);
});

test('the worker answers pages (offline fallback), the shop’s own files, icons and public photos', () => {
  const sw = load();
  for (const [url, mode] of [
    ['/', 'navigate'],
    ['/p/prod-01', 'navigate'],
    ['/_next/static/chunks/main-abc123.js', 'no-cors'],
    ['/_next/static/css/app-1.css', 'no-cors'],
    ['/icons/icon-192.png?v=1', 'no-cors'],
    ['/manifest.webmanifest', 'cors'],
    ['/api/images/' + 'a'.repeat(64) + '.jpg', 'no-cors'],
  ] as const) {
    assert.equal(sw.answers(url, { mode }), true, url);
  }
  // Anything else on the site (robots.txt, a feed) goes to the network untouched.
  assert.equal(sw.answers('/robots.txt'), false);
  assert.equal(sw.answers('/feeds/meta.csv'), false);
});

test('a new version installs (offline page and the front page’s files) and waits; it takes over only when told', async () => {
  const sw = load('BUH-02.05.00');
  let done: Promise<unknown> = Promise.resolve();
  sw.listeners.install({ waitUntil: (p: Promise<unknown>) => (done = p) });
  await done;
  const shell = sw.store.get('buh-shell-BUH-02.05.00')!;
  assert.ok(shell.has('/offline') && shell.has('/manifest.webmanifest'));
  const staticFiles = [...sw.store.get('buh-static-BUH-02.05.00')!.keys()];
  assert.deepEqual(staticFiles.sort(), ['/_next/static/chunks/a1.js', '/_next/static/css/b2.css']);
  assert.equal(sw.skipped(), 0, 'waits after installing');
  sw.listeners.message({ data: { type: 'something-else' } });
  assert.equal(sw.skipped(), 0);
  sw.listeners.message({ data: { type: 'SKIP_WAITING' } });
  assert.equal(sw.skipped(), 1, 'takes over on the page’s go-ahead');

  sw.listeners.activate({ waitUntil: (p: Promise<unknown>) => (done = p) });
  await done;
  assert.deepEqual(sw.deleted.sort(), ['buh-shell-BUH-01.00.00', 'buh-static-BUH-01.00.00'], 'old version’s caches go; photos and other apps’ caches stay');
});

test('each release is a different worker; the version cannot inject code', () => {
  assert.notEqual(serviceWorkerSource('BUH-02.05.00'), serviceWorkerSource('BUH-02.05.01'));
  const src = serviceWorkerSource('x"; alert(1); "');
  assert.match(src, /const VERSION = "xalert1";/);
  assert.doesNotMatch(src, /alert\(1\)/);
});
