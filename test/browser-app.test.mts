/**
 * The shop as an app on a phone or tablet (Chromium against the production build), at 375, 412,
 * 768 and 1280 px: big photos (one per row on phones, edge to edge, with a two-across toggle that
 * the device remembers; sharp but not oversized), the product photo full screen with zoom, the
 * installable app (a valid manifest whose icons load), the service worker (registers, keeps the
 * shop's files, serves the offline page with the network off, and never answers admin or API
 * requests), padding for the notch and home bar, tabs that keep the scroll, the install offer
 * (Android and iPhone, once, never during checkout), the festival colour in the status bar, no
 * sideways scrolling and no page errors. Skipped without a build or Playwright.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { hasBuild, startServer, type RunningServer } from './server.mjs';

type PW = typeof import('playwright');
const pw: PW | null = hasBuild ? await import('playwright').catch(() => null) : null;
const skip = !pw;

let server: RunningServer;
let browser: import('playwright').Browser;
/** A stand-in photo (the tests have no internet): Unsplash addresses get this, and we note the width asked for. */
let fakePhoto: Buffer;

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

before(async () => {
  if (skip) return;
  server = await startServer();
  browser = await pw!.chromium.launch();
  const p = await browser.newPage({ viewport: { width: 40, height: 50 } });
  await p.setContent('<body style="margin:0;background:repeating-linear-gradient(45deg,#1e2c3d 0 4px,#c5a059 4px 8px)"></body>');
  fakePhoto = await p.screenshot({ type: 'jpeg' });
  await p.close();
});
after(async () => {
  await browser?.close();
  server?.stop();
});

type Ctx = { ctx: import('playwright').BrowserContext; page: import('playwright').Page; errors: string[]; photoWidths: number[] };

async function open(width: number, opts: { dpr?: number; ua?: string; sw?: boolean; path?: string; reducedMotion?: 'reduce' } = {}): Promise<Ctx> {
  const phone = width < 768;
  const ctx = await browser.newContext({
    viewport: { width, height: phone ? 860 : width < 1100 ? 1024 : 900 },
    deviceScaleFactor: opts.dpr ?? 1,
    isMobile: phone,
    hasTouch: width < 1100,
    userAgent: opts.ua,
    serviceWorkers: opts.sw ? 'allow' : 'block',
    reducedMotion: opts.reducedMotion,
  });
  const photoWidths: number[] = [];
  await ctx.route(/images\.unsplash\.com/, (r) => {
    photoWidths.push(Number(new URL(r.request().url()).searchParams.get('w')));
    return r.fulfill({ status: 200, contentType: 'image/jpeg', body: fakePhoto });
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|ERR_|unsplash/i.test(m.text())) errors.push(m.text());
  });
  await page.goto(`${server.base}${opts.path ?? '/'}`, { waitUntil: 'domcontentloaded' });
  await page.locator('main h3').first().waitFor();
  return { ctx, page, errors, photoWidths };
}

async function overflow(page: import('playwright').Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}
const photoBox = (page: import('playwright').Page) => page.locator('[data-testid=feed-photo]').first().boundingBox();

for (const width of [375, 412, 768, 1280]) {
  const phone = width < 640;
  test(`feed at ${width}px: ${phone ? 'one big photo per row, edge to edge; the grid toggle works and is remembered' : 'a grid of large photos'}`, { skip }, async () => {
    const dpr = width === 412 ? 2.625 : width === 375 ? 3 : 1;
    const { ctx, page, errors, photoWidths } = await open(width, { dpr });
    const box = (await photoBox(page))!;
    if (phone) {
      assert.ok(box.width >= 0.9 * width, `photo ${box.width}px of ${width}px`);
      assert.ok(Math.abs(box.height / box.width - 1.25) < 0.02, '4:5 like a post');
      // Sharp on this screen (at least its pixels across), and no bigger than the next size up.
      await page.waitForFunction(() => (document.querySelector('[data-testid=feed-photo] img') as HTMLImageElement | null)?.complete);
      const first = photoWidths[0];
      assert.ok(first >= width * dpr && first <= 1440, `asked for ${first}px for ${width * dpr} device pixels`);
      assert.ok(first < width * dpr * 1.4, `not oversized: ${first}px for ${width * dpr}`);

      const toggle = page.getByRole('group', { name: 'Photo size' });
      assert.equal(await toggle.getByRole('button', { name: 'Show one big photo per row' }).getAttribute('aria-pressed'), 'true');
      await toggle.getByRole('button', { name: 'Show two photos per row' }).click();
      await page.waitForFunction(() => document.querySelector('main article')?.getAttribute('data-layout') === 'grid');
      const half = (await photoBox(page))!;
      assert.ok(half.width < 0.55 * width && half.width > 0.4 * width, `two across: ${half.width}`);
      // Remembered on this device.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('main h3').first().waitFor();
      await page.waitForFunction(() => document.querySelector('main article')?.getAttribute('data-layout') === 'grid');
      assert.equal(await toggle.getByRole('button', { name: 'Show two photos per row' }).getAttribute('aria-pressed'), 'true');
      await toggle.getByRole('button', { name: 'Show one big photo per row' }).click();
      await page.waitForFunction(() => document.querySelector('main article')?.getAttribute('data-layout') === 'one');
      assert.ok((await photoBox(page))!.width >= 0.9 * width);
      assert.equal(await page.evaluate(() => localStorage.getItem('buh_feed_layout')), 'one');
    } else {
      assert.equal(await page.getByRole('group', { name: 'Photo size' }).isVisible(), false, 'no toggle where the grid is roomy');
      const across = width < 1024 ? 2 : width < 1280 ? 3 : 4;
      const tops = await page.locator('[data-testid=feed-photo]').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
      assert.equal(tops.filter((t) => t === tops[0]).length, Math.min(across, tops.length), `${across} across`);
      assert.ok(box.width >= (width < 1024 ? 0.4 : 0.2) * width, `large photos: ${box.width}px`);
    }
    assert.equal(await overflow(page), 0);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test(`product photos at ${width}px: full width on phones; tap to see full screen, zoom in, Escape and Back close the zoom only`, { skip }, async () => {
    const { ctx, page, errors } = await open(width);
    await page.locator('main article a').first().click();
    const sheet = page.getByRole('dialog', { name: /Mughal Botanical/ });
    await sheet.waitFor();
    const track = (await sheet.getByTestId('photo-track').boundingBox())!;
    if (width < 768) assert.ok(track.width >= width - 1, `photo ${track.width}px across`);
    // Tablets held upright: one column, a big photo; sideways or a computer: side by side.
    if (width === 768) assert.ok(track.width > 0.7 * width, 'upright tablet: big photo');
    await sheet.getByRole('button', { name: 'Zoom photo' }).click();
    const zoom = page.getByTestId('photo-zoom');
    await zoom.waitFor();
    const img = zoom.locator('img');
    assert.equal(await img.getAttribute('data-scale'), '1.00');
    await zoom.getByRole('button', { name: 'Zoom in' }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid=photo-zoom] img')?.getAttribute('data-scale') === '1.50');
    // Double-tap (two quick clicks) goes back to the whole photo.
    const z = (await img.boundingBox())!;
    await page.mouse.click(z.x + z.width / 2, z.y + z.height / 2);
    await page.mouse.click(z.x + z.width / 2, z.y + z.height / 2);
    await page.waitForFunction(() => document.querySelector('[data-testid=photo-zoom] img')?.getAttribute('data-scale') === '1.00');
    await zoom.getByRole('button', { name: 'Next photo' }).click();
    await zoom.getByText('2 / 3').waitFor();
    assert.ok(await page.evaluate(() => Boolean(document.activeElement?.closest('[data-testid=photo-zoom]'))), 'keyboard inside the zoom');
    await page.keyboard.press('Escape');
    await zoom.waitFor({ state: 'detached' });
    assert.ok(await sheet.isVisible(), 'the product stays open');
    await page.waitForFunction(() => /Photo 2 of/.test(document.querySelector('[data-testid=photo-track]')!.getAttribute('aria-label')!), null, { timeout: 3000 });
    // The phone's Back button closes the zoom, then the product.
    await sheet.getByRole('button', { name: 'Zoom photo' }).click();
    await zoom.waitFor();
    await page.goBack();
    await zoom.waitFor({ state: 'detached' });
    assert.ok(await sheet.isVisible());
    await page.goBack();
    await sheet.waitFor({ state: 'detached' });
    assert.equal(await overflow(page), 0);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

test('tablet sideways (1024×768): the product shows photos and details side by side', { skip }, async () => {
  const { ctx, page } = await open(768);
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.locator('main article a').first().click();
  const sheet = page.getByRole('dialog', { name: /Mughal Botanical/ });
  await sheet.waitFor();
  await page.waitForTimeout(400); // faded in
  await page.waitForFunction(() => matchMedia('(min-width: 768px) and (orientation: landscape)').matches);
  const photo = (await sheet.getByTestId('photo-track').boundingBox())!;
  const title = (await sheet.getByRole('heading', { name: /Mughal Botanical/ }).boundingBox())!;
  assert.ok(title.x > photo.x + photo.width - 1, 'details to the right of the photos');
  assert.ok(Math.abs(title.y - photo.y) < 80, 'side by side');
  await ctx.close();
});

test('the manifest is valid for Chrome, and every icon loads at its size', { skip }, async () => {
  const { ctx, page, errors } = await open(412, { ua: ANDROID_UA });
  assert.equal(await page.locator('link[rel=manifest]').getAttribute('href'), '/manifest.webmanifest');
  const cdp = await ctx.newCDPSession(page);
  const { errors: problems, data } = (await cdp.send('Page.getAppManifest' as never)) as unknown as { errors: Array<{ message: string; critical: number }>; data: string };
  assert.deepEqual(problems.filter((p) => p.critical), [], JSON.stringify(problems));
  const m = JSON.parse(data);
  assert.equal(m.display, 'standalone');
  assert.equal(m.orientation, 'portrait-primary', 'upright on a phone');
  assert.equal(m.name, 'Beautiful UAE Home');
  assert.ok(m.short_name.length <= 12);
  assert.deepEqual(m.shortcuts.map((s: { url: string }) => s.url), ['/?open=bag', '/?open=track']);
  const tablet = await (await fetch(`${server.base}/manifest.webmanifest`, { headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 14; SM-X710) Chrome/141.0 Safari/537.36' } })).json();
  assert.equal(tablet.orientation, 'any', 'tablets turn freely');
  for (const icon of [...m.icons, { src: '/icons/apple-touch-icon.png', sizes: '180x180' }]) {
    const res = await fetch(`${server.base}${icon.src}`);
    assert.equal(res.status, 200, icon.src);
    assert.equal(res.headers.get('content-type'), 'image/png');
    const png = Buffer.from(await res.arrayBuffer());
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)];
    assert.equal(`${w}x${h}`, icon.sizes, icon.src);
  }
  assert.ok(m.icons.some((i: { purpose: string; sizes: string }) => i.purpose === 'maskable' && i.sizes === '512x512'));
  assert.equal((await fetch(`${server.base}/icons/evil.svg`)).status, 404);
  // The shortcuts open the bag and Track Order.
  await page.goto(`${server.base}/?open=track`, { waitUntil: 'domcontentloaded' });
  await page.getByText('Track Your UAE Bedding Order').waitFor();
  assert.equal(new URL(page.url()).search, '', 'the shortcut leaves a clean address');
  await page.goto(`${server.base}/?open=bag`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Your Shopping Bag' }).waitFor();
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('CSP and headers: the worker and manifest from this site only; the worker can control the site and is never cached', { skip }, async () => {
  const res = await fetch(server.base);
  const csp = res.headers.get('content-security-policy') || '';
  assert.match(csp, /worker-src 'self' blob:(;|$)/);
  assert.match(csp, /manifest-src 'self'(;|$)/);
  const sw = await fetch(`${server.base}/sw.js`);
  assert.equal(sw.status, 200);
  assert.match(sw.headers.get('content-type') || '', /javascript/);
  assert.match(sw.headers.get('cache-control') || '', /no-cache/);
  assert.equal(sw.headers.get('service-worker-allowed'), '/');
  assert.match(await sw.text(), /const VERSION = "BUH-\d\d\.\d\d\.\d\d";/);
});

test('service worker at 412px: registers for the whole site, keeps the shell, never answers API or admin requests, and shows the offline page with the network off', { skip }, async () => {
  const { ctx, page, errors } = await open(412, { sw: true });
  const state = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
    const w = reg.active!;
    if (w.state !== 'activated') await new Promise((r) => w.addEventListener('statechange', () => w.state === 'activated' && r(null)));
    return { scope: reg.scope, active: w.state };
  });
  assert.equal(state.scope, `${server.base}/`);
  assert.equal(state.active, 'activated');

  // A second open: the shop's files come from the phone; every API answer from the server.
  const fromWorker: Record<string, boolean> = {};
  page.on('response', (r) => {
    const u = new URL(r.url());
    if (u.origin === server.base) fromWorker[u.pathname] = r.fromServiceWorker();
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('main h3').first().waitFor();
  // Some API calls of every kind, including the admin's and an order (a POST).
  await page.evaluate(async () => {
    await fetch('/api/admin/session');
    await fetch('/api/admin/orders');
    await fetch('/api/orders/lookup?id=BUH-NOPE&phone=0501234567');
    await fetch('/api/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  });
  await page.waitForTimeout(300);
  const apis = Object.entries(fromWorker).filter(([p]) => p.startsWith('/api/') && !p.startsWith('/api/images/'));
  assert.ok(apis.length >= 5, JSON.stringify(apis));
  assert.deepEqual(apis.filter(([, sw]) => sw), [], 'no API answer came through the worker');
  const statics = Object.entries(fromWorker).filter(([p]) => p.startsWith('/_next/static/'));
  assert.ok(statics.length > 3 && statics.every(([, sw]) => sw), 'the shop’s files are served from the phone');

  const cached = await page.evaluate(async () => {
    const out: Record<string, string[]> = {};
    for (const name of await caches.keys()) out[name] = (await (await caches.open(name)).keys()).map((r) => new URL(r.url).pathname);
    return out;
  });
  const names = Object.keys(cached);
  assert.ok(names.some((n) => /^buh-shell-BUH-/.test(n)) && names.some((n) => /^buh-static-BUH-/.test(n)), names.join());
  const all = Object.values(cached).flat();
  assert.ok(all.includes('/offline'));
  assert.ok(all.filter((p) => p.startsWith('/_next/static/')).length > 3);
  assert.deepEqual(all.filter((p) => p.startsWith('/api/') && !p.startsWith('/api/images/')), [], 'nothing personal is kept');
  assert.deepEqual(all.filter((p) => p === '/' || p.startsWith('/p/')), [], 'pages are never kept: a new version shows at once');

  // Offline: a calm page, not the browser's error. The API is not faked.
  await ctx.setOffline(true);
  await page.goto(`${server.base}/p/prod-01`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'You are offline' }).waitFor();
  await page.getByText('Your bag is saved on this phone.').waitFor();
  assert.equal(await overflow(page), 0);
  const api = await page.evaluate(() => fetch('/api/products').then((r) => r.status, () => 'network error'));
  assert.equal(api, 'network error', 'API requests are not answered from a cache');
  // Try again while still offline: the offline page again. Back online: the shop opens by itself.
  await page.getByRole('button', { name: 'Try again' }).click();
  await page.getByRole('heading', { name: 'You are offline' }).waitFor();
  await ctx.setOffline(false);
  await page.locator('main h3').first().waitFor();
  assert.match(page.url(), /\/p\/prod-01$/);
  await page.getByRole('dialog', { name: /Mughal Botanical/ }).waitFor();
  assert.deepEqual(errors.filter((e) => !/Failed to fetch|NetworkError|net::/i.test(e)), []);
  await ctx.close();
});

test('safe areas: the header, tab bar, sheets and footer buttons keep clear of a notch and the home bar', { skip }, async () => {
  const { ctx, page, errors } = await open(375);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setSafeAreaInsetsOverride' as never, { insets: { top: 44, bottom: 34, left: 0, right: 0 } } as never);
  await page.waitForTimeout(100);
  const pad = (sel: string, side: string) => page.evaluate(([s, p]) => getComputedStyle(document.querySelector(s)!).getPropertyValue(p), [sel, side]);
  assert.equal(await pad('header', 'padding-top'), '44px');
  assert.equal(await pad('nav[aria-label=Shop]', 'padding-bottom'), '34px');
  // The tab bar's buttons sit above the home bar.
  const nav = (await page.getByRole('navigation', { name: 'Shop' }).boundingBox())!;
  const home = (await page.getByRole('navigation', { name: 'Shop' }).getByRole('button', { name: 'Home' }).boundingBox())!;
  assert.ok(home.y + home.height <= nav.y + nav.height - 34 + 1);
  // The product sheet, full screen: below the status bar; Add to Bag above the home bar.
  await page.locator('main article a').first().click();
  await page.getByRole('dialog').waitFor();
  await page.waitForTimeout(400); // the sheet has slid up
  assert.equal(await pad('[role=dialog]', 'padding-top'), '44px');
  const add = (await page.getByRole('button', { name: /Add to Bag/ }).boundingBox())!;
  assert.ok(add.y + add.height <= 860 - 34, `Add to Bag ends at ${add.y + add.height}`);
  await page.keyboard.press('Escape');
  // The bag drawer too.
  await page.getByRole('navigation', { name: 'Shop' }).getByRole('button', { name: /^Bag/ }).click();
  await page.getByRole('heading', { name: 'Your Shopping Bag' }).waitFor();
  await page.waitForTimeout(400);
  const head = (await page.getByRole('heading', { name: 'Your Shopping Bag' }).boundingBox())!;
  assert.ok(head.y >= 44, 'bag title below the status bar');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('app feel: no tap flash, taps without delay, sheets hold their scroll, the tabs keep the feed where it was', { skip }, async () => {
  const { ctx, page, errors } = await open(375);
  const style = await page.evaluate(() => ({
    tap: getComputedStyle(document.body).getPropertyValue('-webkit-tap-highlight-color'),
    touch: getComputedStyle(document.querySelector('nav[aria-label=Shop] button')!).touchAction,
    nav: getComputedStyle(document.querySelector('nav[aria-label=Shop]')!).position,
  }));
  assert.equal(style.tap, 'rgba(0, 0, 0, 0)');
  assert.equal(style.touch, 'manipulation');
  assert.equal(style.nav, 'fixed');
  await page.evaluate(() => window.scrollTo(0, 900));
  await page.waitForFunction(() => Math.abs(window.scrollY - 900) < 2);
  const nav = page.getByRole('navigation', { name: 'Shop' });
  // Orders, Bag, Search: each opens over the feed and closes back to the same place.
  await nav.getByRole('button', { name: 'Orders' }).click();
  await page.getByText('Track Your UAE Bedding Order').waitFor();
  await page.getByRole('button', { name: 'Close Track Order' }).click();
  await page.getByText('Track Your UAE Bedding Order').waitFor({ state: 'detached' });
  assert.ok(Math.abs((await page.evaluate(() => window.scrollY)) - 900) < 2, 'feed kept its place after Orders');
  await nav.getByRole('button', { name: /^Bag/ }).click();
  await page.getByRole('heading', { name: 'Your Shopping Bag' }).waitFor();
  await page.getByRole('button', { name: 'Close bag' }).click();
  await page.getByRole('heading', { name: 'Your Shopping Bag' }).waitFor({ state: 'detached' });
  assert.ok(Math.abs((await page.evaluate(() => window.scrollY)) - 900) < 2, 'feed kept its place after the bag');
  await nav.getByRole('button', { name: 'Search' }).click();
  const search = page.getByRole('dialog', { name: 'Search the shop' });
  await search.waitFor();
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('[role=dialog]')!).overscrollBehaviorY), 'contain');
  assert.ok(await page.evaluate(() => document.documentElement.classList.contains('sheet-open')), 'the page behind does not pull to reload');
  await page.keyboard.press('Escape');
  await search.waitFor({ state: 'detached' });
  assert.ok(Math.abs((await page.evaluate(() => window.scrollY)) - 900) < 2, 'feed kept its place after Search');
  // Home: back to the top, like an app.
  await nav.getByRole('button', { name: 'Home' }).click();
  await page.waitForFunction(() => window.scrollY === 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('skeletons while the shop loads (no spinner), in the chosen layout', { skip }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, serviceWorkers: 'block' });
  await ctx.route('**/api/products', async (r) => {
    await new Promise((res) => setTimeout(res, 800));
    await r.continue();
  });
  const page = await ctx.newPage();
  await page.goto(server.base, { waitUntil: 'domcontentloaded' });
  const sk = page.getByTestId('feed-skeleton');
  await sk.waitFor();
  const w = (await sk.locator('div').first().boundingBox())!.width;
  assert.ok(w >= 0.9 * 375, `skeleton ${w}px: one big photo per row`);
  assert.equal(await page.locator('.animate-spin').count(), 0);
  await page.locator('main h3').first().waitFor();
  await ctx.close();
});

test('festival colour: the status bar (theme-color) follows the festival look', { skip }, async () => {
  const { ctx, page } = await open(412);
  const pub = await (await fetch(`${server.base}/api/settings/public`)).json();
  const want = pub.festival?.festivalId ? pub.festival.theme.gradient[0] : '#0f1c2e';
  await page.waitForFunction((c) => document.querySelector('meta[name=theme-color]')?.getAttribute('content') === c, want);
  await ctx.close();
});

test('install offer on Android: shown once after a few seconds, Install asks the phone, never again', { skip }, async () => {
  const { ctx, page, errors } = await open(412, { ua: ANDROID_UA });
  const offer = () =>
    page.evaluate(() => {
      const e = new Event('beforeinstallprompt', { cancelable: true }) as Event & { prompt?: () => Promise<void>; userChoice?: Promise<{ outcome: string }> };
      e.prompt = async () => void ((window as unknown as { __prompted: number }).__prompted = 1);
      e.userChoice = Promise.resolve({ outcome: 'accepted' });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    });
  assert.equal(await offer(), true, 'our card instead of the browser’s banner');
  const card = page.getByRole('region', { name: 'Install the app' });
  assert.equal(await card.count(), 0, 'not straight away');
  await card.waitFor({ timeout: 9000 });
  await card.getByText(/Open the shop from your home screen/).waitFor();
  // Above the tab bar, covering none of it.
  const c = (await card.boundingBox())!;
  const nav = (await page.getByRole('navigation', { name: 'Shop' }).boundingBox())!;
  assert.ok(c.y + c.height <= nav.y, 'above the tab bar');
  assert.ok(c.x >= 0 && c.x + c.width <= 412);
  await card.getByRole('button', { name: 'Install' }).click();
  await card.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => (window as unknown as { __prompted?: number }).__prompted), 1);
  // Once: after a reload, the offer is not shown again.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('main h3').first().waitFor();
  await offer();
  await page.waitForTimeout(7500);
  assert.equal(await card.count(), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('install offer: never during checkout; Not now closes it for good', { skip }, async () => {
  const { ctx, page } = await open(375, { ua: ANDROID_UA });
  await page.evaluate(() => {
    const e = new Event('beforeinstallprompt') as Event & { prompt?: () => Promise<void>; userChoice?: Promise<unknown> };
    e.prompt = async () => {};
    e.userChoice = Promise.resolve({ outcome: 'dismissed' });
    window.dispatchEvent(e);
  });
  await page.locator('main article a').first().click();
  await page.getByRole('button', { name: /Add to Bag/ }).click();
  await page.getByRole('button', { name: /Proceed to Checkout/ }).click();
  await page.locator('#checkout-phone').waitFor();
  await page.waitForTimeout(7500);
  const card = page.getByRole('region', { name: 'Install the app' });
  assert.equal(await card.count(), 0, 'not during checkout');
  // Checkout and the bag closed: now it shows; Not now closes it for good.
  await page.getByRole('button', { name: 'Close checkout' }).click();
  await page.locator('#checkout-phone').waitFor({ state: 'detached' });
  if (await page.getByRole('button', { name: 'Close bag' }).isVisible()) await page.getByRole('button', { name: 'Close bag' }).click();
  await card.waitFor({ timeout: 3000 });
  await card.getByRole('button', { name: 'Not now' }).click();
  await card.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => localStorage.getItem('buh_install_prompt')), 'dismissed');
  await ctx.close();
});

test('install offer on an iPhone: Share, then Add to Home Screen; Got it closes it', { skip }, async () => {
  const { ctx, page, errors } = await open(375, { ua: IPHONE_UA });
  const card = page.getByRole('region', { name: 'Install the app' });
  await card.waitFor({ timeout: 9000 });
  await card.getByText('Add to Home Screen').waitFor();
  await card.getByText('Share', { exact: true }).waitFor();
  assert.equal(await card.getByRole('button', { name: 'Install' }).count(), 0, 'Safari has no install button');
  await card.getByRole('button', { name: 'Got it' }).click();
  await card.waitFor({ state: 'detached' });
  assert.equal(await overflow(page), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});
