/**
 * The storefront gaps the review's first round left open, in a real browser against the real build
 * (NEXT_PUBLIC_APP_URL not set, the shop named "Noor Linen", orders from a photo on), at phone
 * (375 px) and laptop (1280 px) width, in English and Arabic:
 * - the phone's Back button closes Track Order and the photo sheets and stays in the shop, also
 *   when they are opened and closed quickly; Back from checkout of a deal returns to the deal;
 * - Arabic checkout says the server's refusals in Arabic (a box left empty, too many orders), and
 *   English shows the server's own sentence;
 * - the chat: the greeting, an answer and the hand-over notice in the customer's language;
 * - messages to the shop name the shop as Settings → Brand does;
 * - the shop's own photos are offered in smaller widths (srcset + sizes) and the phone downloads
 *   a small one; the copies keep the original's headers;
 * - <html lang/dir> follow the visitor's language before the shop paints;
 * - robots.txt, the sitemap and a product's canonical are never built from an unknown Host header.
 * Skipped without a build.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { hasBuild, rawFetch, startServer, type RunningServer } from './server.mjs';
import { ownerPassword, wrongLogin } from './fixtures/fake.mjs';
import { makePng } from './fixtures/png.mjs';

type PW = typeof import('playwright');
const pw: PW | null = hasBuild ? await import('playwright').catch(() => null) : null;
const skip = !hasBuild || !pw;
type Page = import('playwright').Page;
const OWNER_PASSWORD = ownerPassword();
const SHOP = 'Noor Linen';
const ARABIC = /[؀-ۿ]/;

let server: RunningServer;
let browser: import('playwright').Browser;
let cookie = '';
let products: Array<{ id: string; title: string; featuredImage: string; profiles: Array<{ id: string; name: string }> }> = [];
let photoUrl = '';
let photoProduct = '';

const api = (method: string, p: string, body?: unknown) =>
  fetch(`${server.base}${p}`, { method, headers: { 'content-type': 'application/json', origin: server.base, cookie }, body: body === undefined ? undefined : JSON.stringify(body) });

/** A picture as detailed as a photo, 1200 px wide (so the smaller copies are worth making). */
const bigPhoto = () => {
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 0x1f;
  return makePng(1200, 900, (x, y) => [(60 + ((x >> 3) % 120) + next()) % 256, (80 + ((y >> 3) % 100) + next()) % 256, (150 + next()) % 256]);
};
/** A PNG's width, from its header. */
const pngWidth = (bytes: Buffer) => bytes.readUInt32BE(16);

/** A plain request with any Host header (fetch cannot set one). */
function withHost(pathname: string, host: string): Promise<{ status: number; body: string }> {
  const { hostname, port } = new URL(server.base);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path: pathname, method: 'GET', headers: { Host: host } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  if (skip) return;
  server = await startServer({ NEXT_PUBLIC_APP_URL: '' });
  const h = { 'content-type': 'application/json', origin: server.base };
  await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify(wrongLogin()) });
  let once: string | undefined;
  for (let i = 0; i < 100 && !(once = server.log().match(/Password: (\S+)/)?.[1]); i++) await new Promise((r) => setTimeout(r, 100));
  const login = await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'admin@beautifuluaehome.com', password: once }) });
  const first = (login.headers.get('set-cookie') || '').split(';')[0];
  const changed = await fetch(`${server.base}/api/admin/password`, { method: 'POST', headers: { ...h, cookie: first }, body: JSON.stringify({ currentPassword: once, newPassword: OWNER_PASSWORD }) });
  cookie = (changed.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie);
  const store = await api('PUT', '/api/admin/settings/store', { settings: { whatsappNumber: '+971509998877', photoOrders: true } });
  assert.equal(store.status, 200, await store.clone().text());
  const brand = (await (await rawFetch(`${server.base}/api/settings/public`)).json()).brand;
  const named = await api('PUT', '/api/admin/settings/brand', { settings: { ...brand, storeName: SHOP } });
  assert.equal(named.status, 200, await named.clone().text());
  // A product with one of the shop's own uploaded photos.
  const up = await api('POST', '/api/admin/images', { image: `data:image/png;base64,${bigPhoto().toString('base64')}` });
  assert.equal(up.status, 201, await up.clone().text());
  photoUrl = (await up.json()).url;
  const sizes = (await (await api('GET', '/api/admin/settings')).json()).catalog.value.sizes.filter((s: { id: string }) => s.id === 'king');
  const made = await api('POST', '/api/admin/products', { product: { title: 'Own Photo Set', category: 'bedsheets', price: 410, featuredImage: photoUrl, galleryImages: [photoUrl], profiles: sizes, defaultProfileId: 'king', stockBySize: { king: 3 }, active: true } });
  assert.equal(made.status, 201, await made.clone().text());
  products = (await (await rawFetch(`${server.base}/api/products`)).json()).products;
  photoProduct = products.find((p) => p.title === 'Own Photo Set')!.id;
  browser = await pw!.chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.stop();
});

const WORDS = {
  en: { track: 'Track your order', trackClose: 'Close Track Order', photo: 'Order from your photo', deal: 'Your order', cont: /Continue: address & payment/, checkout: /Proceed to Checkout/, name: 'Full Name', area: /Area \/ Neigh/, help: 'Help and chat', closeChat: 'Close chat', person: 'Talk to a person' },
  ar: { track: 'تتبّع طلبك', trackClose: 'إغلاق تتبّع الطلب', photo: 'اطلب من صورتك', deal: 'طلبك', cont: /متابعة: العنوان والدفع/, checkout: /المتابعة لإتمام الطلب/, name: 'الاسم الكامل', area: /المنطقة/, help: 'المساعدة والدردشة', closeChat: 'إغلاق الدردشة', person: 'تحدث مع موظف' },
} as const;
type Lang = keyof typeof WORDS;

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 || [...document.querySelectorAll('[role="dialog"] .overflow-y-auto')].some((e) => e.scrollWidth > e.clientWidth + 1));

async function openShop(width: number, lang: Lang, pathname = '/', bag: Array<{ productId: string; profileId: string; quantity: number }> = []) {
  const ctx = await browser.newContext({ locale: lang === 'ar' ? 'ar-AE' : 'en-GB', viewport: { width, height: width < 600 ? 812 : 900 }, serviceWorkers: 'block' });
  if (bag.length) {
    await ctx.addInitScript((lines) => {
      if (!localStorage.getItem('buh_cart_v2') && !sessionStorage.getItem('test-bag-set')) {
        localStorage.setItem('buh_cart_v2', JSON.stringify(lines));
        sessionStorage.setItem('test-bag-set', '1');
      }
    }, bag);
  }
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(server.base + pathname, { waitUntil: 'load' });
  return { ctx, page, errors };
}
const dialog = (page: Page, title: string) => page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
/** The button that opens Track Order: in the bottom bar on a phone, in the header on a laptop. */
const trackButton = (page: Page, width: number, lang: Lang) =>
  width < 768 ? page.locator('nav button').filter({ hasText: lang === 'ar' ? /طلب/ : /Order/ }).last() : page.locator('header button').filter({ hasText: lang === 'ar' ? 'تتبع الطلب' : 'Track Order' });
const inShop = async (page: Page) => {
  assert.equal(new URL(page.url()).origin, server.base, 'still in the shop');
  await page.getByTestId('feed').waitFor();
};

for (const width of [375, 1280]) {
  for (const lang of ['en', 'ar'] as const) {
    const w = WORDS[lang];

    test(`${width}px, ${lang}: Back closes Track Order and Order from your photo and stays in the shop, also when opened and closed quickly; <html> is in the visitor's language`, { skip }, async () => {
      const { ctx, page, errors } = await openShop(width, lang, '/?open=track');
      // The page's language and direction, set before the shop paints.
      assert.equal(await page.evaluate(() => document.documentElement.lang), lang === 'ar' ? 'ar-AE' : 'en');
      assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).direction), lang === 'ar' ? 'rtl' : 'ltr');
      const tracker = dialog(page, w.track);
      await tracker.waitFor();
      assert.equal(await overflow(page), false, 'no sideways scroll');
      // Keyboard: focus is inside, Escape closes it.
      assert.ok(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))), 'focus is inside Track Order');
      await page.goBack();
      await tracker.waitFor({ state: 'detached' });
      await inShop(page);

      // Opened with its button, closed with ✕, opened again at once: one step in the history, so one Back closes it.
      const open = trackButton(page, width, lang);
      await open.click();
      await tracker.waitFor();
      await tracker.getByRole('button', { name: w.trackClose }).click();
      await open.click();
      await tracker.waitFor();
      await page.waitForTimeout(800);
      assert.equal(await tracker.count(), 1, 'Track Order stays open (its earlier step back did not take it along)');
      await page.goBack();
      await tracker.waitFor({ state: 'detached' });
      await inShop(page);
      // Escape, then straight back in, then Back.
      await open.click();
      await tracker.waitFor();
      await page.keyboard.press('Escape');
      await tracker.waitFor({ state: 'detached' });
      await open.click();
      await tracker.waitFor();
      await page.goBack();
      await tracker.waitFor({ state: 'detached' });
      await inShop(page);
      // Open and close several times quickly: the shop is still there and Back does not reopen anything.
      for (let i = 0; i < 3; i++) {
        await open.click();
        await tracker.getByRole('button', { name: w.trackClose }).click();
      }
      await page.waitForTimeout(800);
      assert.equal(await tracker.count(), 0);
      await inShop(page);

      // Order from your photo (its shared link).
      await page.goto(`${server.base}/order-by-photo`, { waitUntil: 'load' });
      const sheet = dialog(page, w.photo);
      await sheet.waitFor();
      assert.equal(await overflow(page), false, 'no sideways scroll');
      await page.screenshot({ path: path.join(server.dataDir, `photo-sheet-${width}-${lang}.png`) });
      await page.goBack();
      await sheet.waitFor({ state: 'detached' });
      await inShop(page);
      assert.deepEqual(errors, []);
      await ctx.close();
    });

    test(`${width}px, ${lang}: a deal link: Back from checkout returns to the deal, Back again closes it; nothing leaves the shop`, { skip }, async () => {
      const made = await api('POST', '/api/admin/deals', { photos: [`data:image/png;base64,${makePng(160, 120, () => [40, 60, 160]).toString('base64')}`], note: 'Queen set', pieces: 1, amount: 260, payments: ['cod'], days: 3 });
      assert.equal(made.status, 201, await made.clone().text());
      const link: string = (await made.json()).deal.link;
      const { ctx, page, errors } = await openShop(width, lang, new URL(link, server.base).pathname);
      const deal = dialog(page, w.deal);
      await deal.waitFor();
      await deal.getByRole('button', { name: w.cont }).click();
      const checkout = page.getByRole('dialog').filter({ has: page.locator('#checkout-title') });
      await checkout.waitFor();
      await deal.waitFor({ state: 'detached' });
      await page.goBack();
      await checkout.waitFor({ state: 'detached' });
      await deal.waitFor();
      assert.equal(new URL(page.url()).origin, server.base);
      await page.waitForTimeout(600);
      assert.equal(await deal.count(), 1, 'the deal stays open');
      await page.goBack();
      await deal.waitFor({ state: 'detached' });
      assert.equal(new URL(page.url()).origin, server.base, 'still in the shop');
      assert.deepEqual(errors, []);
      await ctx.close();
    });

    test(`${width}px, ${lang}: checkout says the server's refusals in the customer's language (a box left empty, too many orders)`, { skip }, async () => {
      const p = products.find((x) => x.id !== photoProduct)!;
      const { ctx, page, errors } = await openShop(width, lang, '/?open=bag', [{ productId: p.id, profileId: p.profiles[0].id, quantity: 1 }]);
      await page.getByRole('button', { name: w.checkout }).click();
      const checkout = page.getByRole('dialog').filter({ has: page.locator('#checkout-title') });
      await checkout.waitFor();
      await page.getByLabel(w.name, { exact: false }).first().fill('Mariam Gaps');
      await page.locator('#checkout-phone').fill(`50${7400000 + width + (lang === 'ar' ? 1 : 0)}`);
      await page.getByRole('combobox', { name: w.area }).fill('Dubai Marina');
      await page.keyboard.press('Escape');
      await page.locator('#checkout-street').fill('Marina Walk');
      await page.locator('#checkout-building').fill('Marina Gate 1');
      await page.locator('#checkout-flat').fill('Apt 1402');
      // The real server refuses an order whose name is blank (the page's own check is passed by changing the request on its way).
      const blankName = async (route: import('playwright').Route) => {
        const body = JSON.parse(route.request().postData() || '{}');
        body.customer.fullName = '';
        await route.continue({ postData: JSON.stringify(body) });
      };
      await page.route('**/api/orders', blankName);
      const place = checkout.locator('button[type="submit"]').last();
      await place.click();
      const said = checkout.getByRole('alert').filter({ hasText: lang === 'ar' ? /الاسم الكامل/ : /Full name is required\./ });
      await said.waitFor();
      const text = ((await said.textContent()) ?? '').replace(/[\u2068\u2069]/g, '');
      if (lang === 'ar') assert.ok(!/Full name|required/.test(text), `no English: ${text}`);
      else assert.match(text, /Full name is required\./);
      await page.unroute('**/api/orders', blankName);
      // Too many orders from one connection (the server's answer, as it sends it).
      const tooMany = async (route: import('playwright').Route) =>
        route.fulfill({ status: 429, contentType: 'application/json', headers: { 'Retry-After': '1800' }, body: JSON.stringify({ success: false, code: 'rate_limited', retryAfterSec: 1800, message: 'Too many orders from this connection. Please try again later.' }) });
      await page.route('**/api/orders', tooMany);
      await place.click();
      const limited = checkout.getByRole('alert').filter({ hasText: lang === 'ar' ? /محاولات كثيرة/ : /Too many orders from this connection\. Please try again later\./ });
      await limited.waitFor();
      if (lang === 'ar') assert.doesNotMatch((await limited.textContent()) ?? '', /Too many|connection/);
      assert.equal(await overflow(page), false, 'no sideways scroll');
      await page.screenshot({ path: path.join(server.dataDir, `refusal-${width}-${lang}.png`) });
      assert.deepEqual(errors, []);
      await ctx.close();
    });

    test(`${width}px, ${lang}: the chat greets, answers and hands over in the customer's language; the WhatsApp link names the shop`, { skip }, async () => {
      const { ctx, page, errors } = await openShop(width, lang);
      await page.getByTestId('feed').waitFor();
      await page.getByRole('button', { name: w.help }).click();
      const chat = page.getByRole('dialog').filter({ has: page.locator('#chat-input') });
      await chat.waitFor();
      const greeting = (await chat.locator('[aria-live="polite"]').textContent()) ?? '';
      if (lang === 'ar') assert.ok(ARABIC.test(greeting) && !/Hello|delivery/.test(greeting), greeting);
      else assert.match(greeting, /Hello! I can help with sizes, delivery, payment and care\./);
      // The WhatsApp link under the chat starts with the shop's own name.
      const wa = await chat.locator('a[href*="wa.me"]').first().getAttribute('href');
      assert.match(decodeURIComponent(wa ?? ''), new RegExp(`Hello ${SHOP}! I have a question about your bed linen\\.`));
      assert.ok(!decodeURIComponent(wa ?? '').includes('Beautiful UAE Home'));
      // A question about delivery: answered from the shop's entry.
      const input = page.locator('#chat-input');
      await input.fill(lang === 'ar' ? 'كم يستغرق التوصيل؟' : 'How long is delivery?');
      await input.press('Enter');
      const answer = chat.locator('div.justify-start').filter({ hasText: lang === 'ar' ? /نوصّل إلى باب منزلك/ : /We deliver to your door\./ });
      await answer.waitFor();
      if (lang === 'ar') assert.doesNotMatch((await answer.last().textContent()) ?? '', /We deliver/);
      // A question it cannot answer: handed to the team, said in the customer's language.
      await input.fill(lang === 'ar' ? 'هل القماش قطن عضوي من جايبور؟' : 'Is the fabric organic cotton from Jaipur?');
      await input.press('Enter');
      const notice = chat.locator('p.text-center').filter({ hasText: lang === 'ar' ? /حوّلته إلى الفريق/ : /I’ve passed your question to the team\./ });
      await notice.waitFor();
      const noticeText = (await notice.textContent()) ?? '';
      if (lang === 'ar') assert.ok(!/[A-Za-z]{4,}/.test(noticeText), `no English: ${noticeText}`);
      else assert.match(noticeText, /We will reply here as soon as we can\. So we can get back to you even if you leave, please add your phone number or email below\./);
      // A wrong phone number for the contact: the refusal in the customer's language.
      await chat.locator('form input[required]').fill('12');
      await chat.locator('form button[type="submit"]').first().click();
      const problem = chat.getByRole('alert');
      await problem.waitFor();
      const problemText = (await problem.textContent()) ?? '';
      if (lang === 'ar') assert.ok(ARABIC.test(problemText) && !/[A-Za-z]{4,}/.test(problemText), problemText);
      else assert.equal(problemText, 'Please check the phone number or email.');
      assert.equal(await overflow(page), false, 'no sideways scroll');
      await page.screenshot({ path: path.join(server.dataDir, `chat-${width}-${lang}.png`) });
      // Keyboard: Escape closes the chat.
      await input.focus();
      await page.keyboard.press('Escape');
      await chat.waitFor({ state: 'detached' });
      assert.deepEqual(errors, []);
      await ctx.close();
    });
  }

  test(`${width}px: the shop's own photo is offered in smaller widths and the card downloads a small one; the product sheet too`, { skip }, async () => {
    const { ctx, page, errors } = await openShop(width, 'en');
    const card = page.locator(`img[src="${photoUrl}"]`).first();
    await card.waitFor();
    assert.equal(await card.getAttribute('srcset'), `${photoUrl}?w=240 240w, ${photoUrl}?w=540 540w, ${photoUrl}?w=1080 1080w, ${photoUrl} 1600w`);
    assert.ok(await card.getAttribute('sizes'), 'the card says how wide it is shown');
    await card.scrollIntoViewIfNeeded();
    await page.waitForFunction((src) => {
      const img = document.querySelector(`img[src="${src}"]`) as HTMLImageElement | null;
      return Boolean(img && img.complete && img.naturalWidth > 0);
    }, photoUrl);
    const picked = await card.evaluate((img: HTMLImageElement) => ({ src: img.currentSrc, natural: img.naturalWidth, shown: img.getBoundingClientRect().width }));
    assert.match(picked.src, /\?w=540$/, `a ${Math.round(picked.shown)} px card takes the 540 px copy, not the original: ${picked.src}`);
    assert.ok(picked.natural > 0, 'and it loaded');
    const downloaded = await page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('/api/images/')));
    assert.ok(!downloaded.some((n) => n.endsWith('.png')), `the 1200 px original was not downloaded for a card: ${downloaded.join(', ')}`);
    // The product sheet's gallery.
    await page.goto(`${server.base}/p/${photoProduct}`, { waitUntil: 'load' });
    const sheetImg = page.getByRole('dialog').locator(`img[src="${photoUrl}"]`).first();
    await sheetImg.waitFor();
    assert.match((await sheetImg.getAttribute('srcset')) ?? '', /\?w=540 540w/);
    assert.ok(await sheetImg.getAttribute('sizes'));
    assert.equal(await overflow(page), false, 'no sideways scroll');
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

test('the smaller copies: the right width, the original’s headers, never bigger than the original, and only the widths on the list', { skip }, async () => {
  const full = await rawFetch(`${server.base}${photoUrl}`);
  const original = Buffer.from(await full.arrayBuffer());
  assert.equal(pngWidth(original), 1200);
  for (const w of [240, 540, 1080]) {
    const res = await rawFetch(`${server.base}${photoUrl}?w=${w}`);
    assert.equal(res.status, 200);
    const bytes = Buffer.from(await res.arrayBuffer());
    // A copy is only sent when it is lighter than the original (a detailed PNG can come out heavier at 1080): else the original.
    if (w < 1080 || !bytes.equals(original)) {
      assert.equal(pngWidth(bytes), w, `${w} px wide`);
      assert.ok(bytes.length < original.length, `${w}: lighter than the original (${bytes.length} < ${original.length})`);
    }
    for (const h of ['content-type', 'cache-control', 'x-content-type-options', 'content-security-policy']) assert.equal(res.headers.get(h), full.headers.get(h), h);
  }
  assert.equal(full.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  for (const q of ['?w=1600', '?w=2000', '?w=541', '?w=abc']) {
    const res = await rawFetch(`${server.base}${photoUrl}${q}`);
    assert.equal(Buffer.from(await res.arrayBuffer()).equals(original), true, `${q}: the original`);
  }
  assert.equal((await rawFetch(`${server.base}/api/images/${'0'.repeat(64)}.png?w=540`)).status, 404);
});

test('robots.txt, the sitemap and a product’s canonical use this computer’s own address, never an unknown Host header', { skip }, async () => {
  const own = new URL(server.base).host;
  const product = products[0].id;
  // Asked on its own address (a shop on the owner's laptop): full addresses, as before.
  const robots = await withHost('/robots.txt', own);
  assert.match(robots.body, new RegExp(`Sitemap: http://${own.replace(/\./g, '\\.')}/sitemap\\.xml`));
  assert.match(robots.body, /Disallow: \/api\//);
  const sitemap = await withHost('/sitemap.xml', own);
  assert.match(sitemap.body, new RegExp(`<loc>http://${own.replace(/\./g, '\\.')}/p/`));
  const page = await withHost(`/p/${product}`, own);
  assert.match(page.body, new RegExp(`<link rel="canonical" href="http://${own.replace(/\./g, '\\.')}/p/${product}"`));

  // Asked with someone else's name: that name appears nowhere.
  for (const host of ['evil.example', 'evil.example:3000', 'localhost.evil.example', '127.0.0.1.evil.example']) {
    const r = await withHost('/robots.txt', host);
    assert.equal(r.status, 200);
    assert.match(r.body, /Disallow: \/api\//, 'the rules are still there');
    assert.ok(!r.body.includes('evil.example'), `robots.txt names ${host}: ${r.body}`);
    assert.doesNotMatch(r.body, /Sitemap:|Host:/);
    const s = await withHost('/sitemap.xml', host);
    assert.equal(s.status, 200);
    assert.match(s.body, /<urlset/);
    assert.ok(!s.body.includes('evil.example') && !/<loc>/.test(s.body), 'a valid, empty sitemap');
    const p = await withHost(`/p/${product}`, host);
    assert.equal(p.status, 200);
    assert.ok(!p.body.includes('evil.example'), 'the product page does not name it');
    assert.doesNotMatch(p.body, /rel="canonical"/);
    assert.match(p.body, /<title>/);
    const feed = await withHost('/feeds/meta.csv', host);
    assert.ok(!feed.body.includes('evil.example'));
  }
});
