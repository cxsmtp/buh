/**
 * The storefront review's fixes in a real browser, against the real build (card payments on through
 * the Stripe stand-in, Phone check "WhatsApp", the shop's WhatsApp number set), at phone (375 px)
 * and laptop (1280 px) width, in English and Arabic where the words matter:
 * - the bag: the small-bag limit said before checkout, Escape and the Back button close it, Tab
 *   stays inside, the ways to pay as the settings have them (#4, #9, #11, #13);
 * - checkout: every field has its label, Tab stays inside, the delivery box and a refusal in Arabic,
 *   the wallet button says what it charges, problems are said on the page (no pop-up), and neither
 *   ✕, Escape nor Back closes it while the order is being placed (#6, #7, #9, #10, #13);
 * - a first catalogue load that fails does not wipe the saved bag (#8);
 * - a missing piece of the shop after an update: one reload by itself, then a page with Reload (#3);
 * - a cash order whose answer was lost, then Card: a clear message, and Pay works (#2, reverse);
 * - the shop's promise and the Terms page's canonical (#11, #14).
 * Skipped without a build.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { hasBuild, rawFetch, startServer, type RunningServer } from './server.mjs';
import { startStripeMock, STRIPE_JS_STUB, TEST_KEYS, type StripeMock } from './stripe-mock.mjs';
import { ownerPassword, wrongLogin } from './fixtures/fake.mjs';

type PW = typeof import('playwright');
const pw: PW | null = hasBuild ? await import('playwright').catch(() => null) : null;
const skip = !hasBuild || !pw;
type Page = import('playwright').Page;
type Ctx = import('playwright').BrowserContext;
const OWNER_PASSWORD = ownerPassword();

let server: RunningServer;
let mock: StripeMock;
let browser: import('playwright').Browser;
let cookie = '';
let products: Array<{ id: string; title: string; profiles: Array<{ id: string; name: string }> }> = [];

const api = (method: string, p: string, body?: unknown) =>
  fetch(`${server.base}${p}`, { method, headers: { 'content-type': 'application/json', origin: server.base, cookie }, body: body === undefined ? undefined : JSON.stringify(body) });

before(async () => {
  if (skip) return;
  mock = await startStripeMock();
  server = await startServer({ BUH_TEST_STRIPE_API: mock.url, CARD_SWEEP_DISABLED: '1', NEXT_PUBLIC_APP_URL: '' });
  const h = { 'content-type': 'application/json', origin: server.base };
  await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify(wrongLogin()) });
  let once: string | undefined;
  for (let i = 0; i < 100 && !(once = server.log().match(/Password: (\S+)/)?.[1]); i++) await new Promise((r) => setTimeout(r, 100));
  const login = await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'admin@beautifuluaehome.com', password: once }) });
  const first = (login.headers.get('set-cookie') || '').split(';')[0];
  const changed = await fetch(`${server.base}/api/admin/password`, { method: 'POST', headers: { ...h, cookie: first }, body: JSON.stringify({ currentPassword: once, newPassword: OWNER_PASSWORD }) });
  cookie = (changed.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie);
  const on = await api('PUT', '/api/admin/settings/payments', { settings: { cardEnabled: true, stripePublishableKey: TEST_KEYS.publishable, stripeSecretKey: TEST_KEYS.secret, stripeWebhookSecret: TEST_KEYS.webhook } });
  assert.equal(on.status, 200, await on.clone().text());
  const store = await api('PUT', '/api/admin/settings/store', { settings: { whatsappNumber: '+971509998877' } });
  assert.equal(store.status, 200, await store.clone().text());
  products = (await (await rawFetch(`${server.base}/api/products`)).json()).products;
  assert.ok(products.length >= 1);
  browser = await pw!.chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.stop();
  await mock?.close();
});

const WORDS = {
  en: { checkout: /Proceed to Checkout/, closeBag: 'Close bag', name: 'Full Name', street: 'Street Address', building: 'Building / Villa Name', flat: 'Flat / Apartment / Villa #', landmark: /Nearest Landmark/, area: /Area \/ Neighborhood/, card: /^Card/, pay: /^Pay AED/, place: /^Place order/, closeCheckout: 'Close checkout' },
  ar: { checkout: /المتابعة لإتمام الطلب/, closeBag: 'إغلاق الحقيبة', name: 'الاسم الكامل', street: 'عنوان الشارع', building: 'اسم المبنى / الفيلا', flat: 'رقم الشقة / الفيلا', landmark: /أقرب معلم/, area: /المنطقة \/ الحي/, card: /^بطاقة/, pay: /^ادفع AED/, place: /^إتمام الطلب/, closeCheckout: 'إغلاق صفحة الدفع' },
} as const;
type Lang = keyof typeof WORDS;

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 || [...document.querySelectorAll('[role="dialog"] .overflow-y-auto')].some((e) => e.scrollWidth > e.clientWidth + 1));
const bagLine = (quantity = 1, product = 0) => ({ productId: products[product].id, profileId: products[product].profiles[0].id, quantity });
const savedBag = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('buh_cart_v2') || 'null') as Array<{ productId: string; quantity: number }> | null);
let phones = 0;
const nextPhone = () => `50${String(7300000 + ++phones)}`;

/** A browser with a bag already saved (as a returning customer's), on the shop's home page. */
async function openShop(width: number, lang: Lang, bag: Array<ReturnType<typeof bagLine>>, opts: { path?: string; setup?: (ctx: Ctx) => Promise<void> } = {}) {
  const ctx = await browser.newContext({ locale: lang === 'ar' ? 'ar-AE' : 'en-GB', viewport: { width, height: width < 600 ? 812 : 900 }, serviceWorkers: 'block' });
  await ctx.route('https://js.stripe.com/**', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: STRIPE_JS_STUB }));
  await ctx.addInitScript((lines) => {
    if (!localStorage.getItem('buh_cart_v2') && !sessionStorage.getItem('test-bag-set')) {
      localStorage.setItem('buh_cart_v2', JSON.stringify(lines));
      sessionStorage.setItem('test-bag-set', '1');
    }
  }, bag);
  await opts.setup?.(ctx);
  const page = await ctx.newPage();
  const errors: string[] = [];
  const popups: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => {
    popups.push(d.message());
    void d.dismiss();
  });
  await page.goto(server.base + (opts.path ?? '/'), { waitUntil: 'load' });
  return { ctx, page, errors, popups };
}

/** Tab many times: focus never leaves the dialog. */
async function tabStaysInside(page: Page, presses: number, what: string) {
  for (let i = 0; i < presses; i++) {
    await page.keyboard.press(i % 7 === 6 ? 'Shift+Tab' : 'Tab');
    const inside = await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')));
    assert.ok(inside, `${what}: Tab ${i + 1} left the dialog`);
  }
}

async function fillAddress(page: Page, lang: Lang, phone: string) {
  const w = WORDS[lang];
  await page.getByLabel(w.name, { exact: false }).first().fill('Mariam Review');
  await page.locator('#checkout-phone').fill(phone);
  await page.getByRole('combobox', { name: w.area }).fill('Dubai Marina');
  await page.keyboard.press('Escape');
  await page.locator('#checkout-street').fill('Marina Walk');
  await page.locator('#checkout-building').fill('Marina Gate 1');
  await page.locator('#checkout-flat').fill('Apt 1402');
}

for (const width of [375, 1280]) {
  for (const lang of ['en', 'ar'] as const) {
    const w = WORDS[lang];
    test(`${width}px, ${lang}: the bag says its limit before checkout; Escape and Back close it; Tab stays inside; the ways to pay are the shop's`, { skip }, async () => {
      const { ctx, page, errors, popups } = await openShop(width, lang, [bagLine(1)], { path: '/?open=bag' });
      const bag = page.getByRole('dialog').filter({ has: page.locator('#bag-title') });
      await bag.waitFor();
      // #4: the limit is said in the bag, and + stops at it (2 of each item).
      const note = page.getByTestId('bag-limit');
      await note.waitFor();
      assert.match((await note.textContent()) ?? '', lang === 'ar' ? /حتى .*2.* من كل منتج/ : /Up to 2 of each item and 5 different items per order\./);
      // #9: focus moved into the bag when it opened.
      assert.ok(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))), 'focus moved into the bag');
      const more = bag.locator('button', { hasText: '+' }).first();
      assert.equal(await more.isEnabled(), true);
      await more.click();
      await page.waitForFunction(() => (JSON.parse(localStorage.getItem('buh_cart_v2') || '[]') as Array<{ quantity: number }>)[0]?.quantity === 2);
      assert.equal(await more.isDisabled(), true, 'no third piece of one item');
      assert.equal(await bag.getByRole('button', { name: w.checkout }).isEnabled(), true);
      // #11: only the ways to pay that are on (card and bank transfer are, here).
      assert.equal((await page.getByTestId('bag-pay-ways').textContent())?.trim(), lang === 'ar' ? 'البطاقة أو الدفع عند الاستلام أو التحويل البنكي' : 'Card, cash on delivery or bank transfer');
      // #9: Tab stays in the bag, Escape closes it.
      await tabStaysInside(page, 16, 'the bag');
      assert.equal(await overflow(page), false, 'no sideways scroll');
      await page.screenshot({ path: path.join(server.dataDir, `bag-${width}-${lang}.png`) });
      await page.keyboard.press('Escape');
      await bag.waitFor({ state: 'detached' });
      // #13: the phone's Back button closes the bag and stays in the shop.
      await page.locator('header button').last().click();
      await bag.waitFor();
      await page.goBack();
      await bag.waitFor({ state: 'detached' });
      assert.equal(new URL(page.url()).origin, server.base, 'still in the shop');
      await page.getByTestId('feed').waitFor();
      assert.deepEqual(popups, []);
      assert.deepEqual(errors, []);
      await ctx.close();
    });

    test(`${width}px, ${lang}: checkout has labelled fields, keeps Tab inside, speaks the customer's language, says problems on the page, and cannot be closed while the order is placed`, { skip }, async () => {
      const { ctx, page, errors, popups } = await openShop(width, lang, [bagLine(1)], { path: '/?open=bag' });
      await page.getByRole('button', { name: w.checkout }).click();
      const checkout = page.getByRole('dialog').filter({ has: page.locator('#checkout-title') });
      await checkout.waitFor();
      // #9: the five fields that had no label link.
      for (const [label, id] of [[w.name, 'checkout-name'], [w.street, 'checkout-street'], [w.building, 'checkout-building'], [w.flat, 'checkout-flat'], [w.landmark, 'checkout-landmark']] as const) {
        assert.equal(await checkout.getByLabel(label).first().getAttribute('id'), id, `the ${id} field is named by its label`);
      }
      assert.ok(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))), 'focus moved into checkout');
      await page.locator('[data-stub-wallet]').waitFor();
      await tabStaysInside(page, 45, 'checkout');

      // #6: the delivery box and the delivery's name in the customer's language.
      await page.getByRole('combobox', { name: w.area }).fill('Dubai Marina');
      await page.keyboard.press('Escape');
      const box = (await checkout.textContent()) ?? '';
      if (lang === 'ar') {
        assert.match(box, /نوصّل إلى/);
        assert.match(box, /Dubai Marina/);
        assert.match(box, /التوصيل العادي/);
        assert.doesNotMatch(box, /We deliver to|Standard delivery|Sorry, we/);
      } else {
        assert.match(box, /We deliver to Dubai Marina, Dubai/);
        assert.match(box, /Standard delivery in 1–2 days/);
      }
      // #11: the header names the ways to pay that are on.
      assert.match(box, lang === 'ar' ? /البطاقة أو الدفع عند الاستلام أو التحويل البنكي/ : /Standard delivery across the UAE · Card, cash on delivery or bank transfer/);

      // #10: cash on delivery is chosen, so the total shown has no card fee; the wallet button says what it charges.
      const total = Number(((await page.locator('#checkout-total').textContent()) ?? '').replace(/[^\d.]/g, ''));
      const fee = page.getByTestId('express-fee-note');
      await fee.waitFor();
      const feeText = (await fee.textContent()) ?? '';
      const charged = Number(/AED\s*⁨?([\d.]+)/.exec(feeText)?.[1]);
      assert.ok(charged > total, `the wallet's total (${feeText}) is more than the cash total ${total}`);
      assert.equal(Math.round(charged * 100), Math.round(total * 100) + Math.floor((Math.round(total * 100) * 350 + 5000) / 10000), 'the cash total and the 3.5% card fee');
      assert.match(feeText, /3\.5/);

      // #9: a problem is said on the page, never in a pop-up (card chosen, no mobile number yet).
      await page.getByRole('radio', { name: w.card }).click();
      await page.locator('[data-testid="card-element"] input[data-stub-card]').waitFor();
      await fee.waitFor({ state: 'detached' });
      await page.getByLabel(w.name).first().fill('Mariam Review');
      await page.locator('#checkout-phone').fill('12');
      await page.locator('#checkout-street').fill('Marina Walk');
      await page.locator('#checkout-building').fill('Marina Gate 1');
      await page.locator('#checkout-flat').fill('Apt 1402');
      await page.getByRole('button', { name: w.pay }).click();
      await checkout.getByRole('alert').filter({ hasText: lang === 'ar' ? /رقم جوالك الإماراتي للمندوب/ : /Please enter your UAE mobile number for the courier\./ }).waitFor();
      assert.deepEqual(popups, [], 'no pop-up');
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'checkout-phone', 'the field to fix has focus');

      // #6: a refusal from the server (here: the last piece just sold) in the customer's language.
      await page.getByRole('radio').first().click();
      await page.locator('#checkout-phone').fill(nextPhone());
      const refuse = async (route: import('playwright').Route) =>
        route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ success: false, code: 'sold_out', productId: products[0].id, title: products[0].title, size: products[0].profiles[0].name, left: 0, message: `${products[0].title} (${products[0].profiles[0].name}) has just sold out.` }) });
      await page.route('**/api/orders', refuse);
      await page.getByRole('button', { name: w.place }).click();
      const said = checkout.getByRole('alert').filter({ hasText: lang === 'ar' ? /نفد للتو/ : /has just sold out\./ });
      await said.waitFor();
      if (lang === 'ar') assert.doesNotMatch((await said.textContent()) ?? '', /has just sold out/);
      await page.unroute('**/api/orders', refuse);
      assert.equal(await overflow(page), false, 'no sideways scroll');
      await page.screenshot({ path: path.join(server.dataDir, `checkout-${width}-${lang}.png`) });

      // #7 and #13: while the order is being placed, ✕, Escape and Back leave checkout open.
      let release: () => void = () => undefined;
      const held = new Promise<void>((r) => (release = r));
      const slow = async (route: import('playwright').Route) => {
        await held;
        await route.continue();
      };
      await page.route('**/api/orders', slow);
      await page.getByRole('button', { name: w.place }).click();
      const close = checkout.getByRole('button', { name: w.closeCheckout });
      await page.waitForFunction((name) => (document.querySelector(`button[aria-label="${name}"]`) as HTMLButtonElement | null)?.disabled === true, w.closeCheckout);
      assert.equal(await close.isDisabled(), true, '✕ is off while the order is placed');
      await page.keyboard.press('Escape');
      await page.goBack();
      await page.waitForTimeout(300);
      assert.equal(await checkout.count(), 1, 'checkout is still open');
      release();
      // The confirmation is seen (the WhatsApp step: without it the order would be cancelled).
      await page.getByTestId('order-last-step').waitFor({ timeout: 15_000 });
      await page.unroute('**/api/orders', slow);
      assert.equal(await savedBag(page).then((b) => b?.length), 0, 'the bag was emptied by the order');
      await tabStaysInside(page, 10, 'the confirmation');
      // Back closes the confirmation and stays in the shop.
      await page.goBack();
      await page.getByTestId('order-last-step').waitFor({ state: 'detached' });
      assert.equal(new URL(page.url()).origin, server.base);
      await page.getByTestId('feed').waitFor();
      assert.deepEqual(popups, []);
      assert.deepEqual(errors, []);
      await ctx.close();
    });
  }
}

for (const width of [375, 1280]) {
  test(`${width}px: Add to Bag from a product opens the bag (and keeps it open); Back closes the bag, then the shop is still there`, { skip }, async () => {
    const { ctx, page, errors } = await openShop(width, 'en', []);
    await page.locator('h3, h4').filter({ hasText: products[0].title }).first().click();
    await page.getByRole('button', { name: /Add to Bag/ }).click();
    const bag = page.getByRole('dialog').filter({ has: page.locator('#bag-title') });
    await bag.waitFor();
    // The product sheet's own step back must not take the bag with it.
    await page.waitForTimeout(800);
    assert.equal(await bag.count(), 1, 'the bag stays open');
    await page.goBack();
    await bag.waitFor({ state: 'detached' });
    assert.equal(new URL(page.url()).origin, server.base, 'still in the shop');
    await page.getByTestId('feed').waitFor();
    // Straight to checkout from the bag: Back closes checkout, the bag is kept.
    await page.locator('header button').last().click();
    await page.getByRole('button', { name: /Proceed to Checkout/ }).click();
    const checkout = page.getByRole('dialog').filter({ has: page.locator('#checkout-title') });
    await checkout.waitFor();
    await page.goBack();
    await checkout.waitFor({ state: 'detached' });
    assert.equal(new URL(page.url()).origin, server.base);
    assert.equal((await savedBag(page))?.length, 1);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

test('375px: a bag over the limit (from a shared link) is said in the bag and checkout is held back until it is fixed', { skip }, async () => {
  const { ctx, page, errors } = await openShop(375, 'en', [bagLine(3)], { path: '/?open=bag' });
  const note = page.getByTestId('bag-limit');
  await note.waitFor();
  assert.equal(await note.getAttribute('role'), 'alert');
  assert.equal((await note.textContent())?.trim(), 'At most 2 of each item per order until we have confirmed your number. For more, please message us on WhatsApp.');
  const go = page.getByRole('button', { name: /Proceed to Checkout/ });
  assert.equal(await go.isDisabled(), true);
  await page.getByRole('button', { name: /^One fewer/ }).click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="bag-limit"][role="alert"]'));
  assert.equal(await go.isEnabled(), true);
  assert.equal(await overflow(page), false);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('375px: the first catalogue load fails (the shop restarting): it is tried again, and the saved bag is still there', { skip }, async () => {
  let failed = 0;
  const { ctx, page } = await openShop(375, 'en', [bagLine(2)], {
    setup: async (c) => {
      await c.route('**/api/products', (route) => (failed++ === 0 ? route.abort('connectionrefused') : route.continue()));
    },
  });
  await page.getByTestId('feed').waitFor({ timeout: 20_000 });
  assert.ok(failed >= 2, 'the catalogue was asked for again by itself');
  // The bag is as it was saved: in the header's count and in the browser's storage.
  await page.getByRole('button', { name: /2 items|bag.*2/i }).first().waitFor();
  await page.waitForTimeout(500);
  assert.deepEqual(await savedBag(page), [{ ...bagLine(2) }]);
  await ctx.close();
});

test('375px: a piece of the shop is gone after an update: the page reloads once by itself, then offers Reload; the bag is kept', { skip }, async () => {
  // The card form's code (its own chunk, fetched when checkout opens with card payments on).
  const chunks = fs.readdirSync('.next/static/chunks').filter((f) => f.endsWith('.js') && fs.readFileSync(path.join('.next/static/chunks', f), 'utf8').includes('js.stripe.com'));
  assert.ok(chunks.length >= 1);
  let blocked = 0;
  const { ctx, page } = await openShop(375, 'en', [bagLine(1)], {
    path: '/?open=bag',
    setup: async (c) => {
      await c.route('**/_next/static/chunks/**', (route) => {
        if (!chunks.some((f) => route.request().url().includes(f))) return route.continue();
        blocked++;
        return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not found' });
      });
    },
  });
  let loads = 0;
  page.on('load', () => loads++);
  await page.getByRole('button', { name: /Proceed to Checkout/ }).click();
  // The old version's chunk is gone: one reload, by itself, back to the shop (the new version).
  await page.waitForEvent('load', { timeout: 20_000 });
  await page.getByTestId('feed').waitFor();
  assert.equal(await page.getByTestId('shop-error').count(), 0);
  assert.deepEqual(await savedBag(page), [bagLine(1)], 'the bag is kept');
  // It fails again right away: no second reload by itself (no loop), the shop's own page with Reload.
  await page.locator('header button').last().click();
  await page.getByRole('button', { name: /Proceed to Checkout/ }).click();
  const broken = page.getByTestId('shop-error');
  await broken.waitFor({ timeout: 20_000 });
  assert.match((await broken.textContent()) ?? '', /Your bag and your details are saved/);
  assert.equal(loads, 1, 'reloaded once, not in a loop');
  assert.ok(blocked >= 2);
  assert.deepEqual(await savedBag(page), [bagLine(1)]);
  assert.equal(await overflow(page), false);
  // Reload brings the shop back.
  await broken.getByRole('button', { name: 'Reload' }).click();
  await page.getByTestId('feed').waitFor();
  await ctx.close();
});

test('1280px: a cash order whose answer was lost, then Card: the customer is told, and Pay then places a card order (never a dead button)', { skip }, async () => {
  const { ctx, page, errors } = await openShop(1280, 'en', [bagLine(1)], { path: '/?open=bag' });
  await page.getByRole('button', { name: /Proceed to Checkout/ }).click();
  await page.locator('[data-stub-wallet]').waitFor();
  await fillAddress(page, 'en', nextPhone());
  // The cash order reaches the shop, but its answer never reaches the phone.
  const lose = async (route: import('playwright').Route) => {
    await route.fetch();
    await route.abort('connectionreset');
  };
  await page.route('**/api/orders', lose);
  await page.getByRole('button', { name: /^Place order/ }).click();
  const alert = page.getByRole('dialog').getByRole('alert');
  await alert.first().waitFor();
  await page.unroute('**/api/orders', lose);
  // Card instead, in the same checkout.
  await page.getByRole('radio', { name: /^Card/ }).click();
  await page.locator('[data-testid="card-element"] input[data-stub-card]').waitFor();
  const pay = page.getByRole('button', { name: /^Pay AED/ });
  await pay.click();
  await alert.filter({ hasText: 'Your order changed since the first try. Please confirm again.' }).waitFor();
  assert.equal(await pay.isEnabled(), true, 'Pay can be tapped again');
  await pay.click();
  const status = page.getByTestId('card-payment-status');
  await status.waitFor({ timeout: 15_000 });
  assert.match((await status.textContent()) ?? '', /Payment is being confirmed/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the shop’s promise follows the settings, and the Terms page has no made-up canonical', { skip }, async () => {
  const { ctx, page } = await openShop(375, 'en', []);
  const promise = page.getByTestId('shop-promise');
  await promise.waitFor();
  await page.getByTestId('feed').waitFor();
  assert.equal((await promise.textContent())?.trim(), 'Bedding for UAE homes, delivered to your door in all seven emirates. Pay by card, cash on delivery or bank transfer.');
  assert.doesNotMatch((await page.locator('main').textContent()) ?? '', /handcraft|Made slowly/);
  // The owner delivers to two emirates only and switches bank transfer off: the promise says so by itself.
  const settings = (await (await api('GET', '/api/admin/settings')).json()) as { delivery: { value: Record<string, unknown> } };
  // (Saved again if the page had not yet started listening for changes when the first save was made.)
  let shown = false;
  for (let i = 0; i < 6 && !shown; i++) {
    assert.equal((await api('PUT', '/api/admin/settings/delivery', { settings: { ...settings.delivery.value, emirates: ['Dubai', 'Sharjah'], standardDays: i % 2 ? '1–2 days' : '1-2 days' } })).status, 200);
    assert.equal((await api('PUT', '/api/admin/settings/payments', { settings: { bankTransferMode: 'off' } })).status, 200);
    shown = await page
      .waitForFunction(() => /Dubai and Sharjah/.test(document.querySelector('[data-testid="shop-promise"]')?.textContent ?? '') && !/bank transfer/.test(document.querySelector('[data-testid="shop-promise"]')?.textContent ?? ''), null, { timeout: 5_000 })
      .then(() => true, () => false);
  }
  assert.equal((await promise.textContent())?.trim(), 'Bedding for UAE homes, delivered to your door in Dubai and Sharjah. Pay by card or cash on delivery.');
  assert.equal(await overflow(page), false);
  await api('PUT', '/api/admin/settings/delivery', { settings: settings.delivery.value });
  await api('PUT', '/api/admin/settings/payments', { settings: { bankTransferMode: 'ask_whatsapp' } });
  await ctx.close();

  // #14: without the shop's address set, the Terms page gives no canonical (never the server's own address).
  const html = await (await rawFetch(`${server.base}/terms`)).text();
  assert.match(html, /Terms &amp; Conditions|Terms & Conditions/);
  assert.doesNotMatch(html, /rel="canonical"/);
});
