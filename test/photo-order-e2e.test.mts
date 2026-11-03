/**
 * "Order from your photo" against the real build (BUH-02.28.00). The routes:
 *  - /order-by-photo is not found until the owner switches it on;
 *  - the photos are for the owner only (hidden without the door, 401 without a session,
 *    sandboxed, nosniff, never cached);
 *  - "Confirm amount" needs a session and the same origin, and takes an allow-listed body;
 *  - nothing is confirmed before the amount is.
 * In Chromium at 375 and 1280 px: the home banner and the shared link open the photo form;
 * photos, amount, then checkout (WhatsApp check) places the order and says what comes next;
 * in the hub the photos show and "Confirm amount" lets it go ahead. No sideways scroll, no
 * page errors. Skipped without a build.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { hasBuild, rawFetch, startServer, type RunningServer } from './server.mjs';
import { openAdminSection } from './helpers.mjs';

type PW = typeof import('playwright');
const pw: PW | null = hasBuild ? await import('playwright').catch(() => null) : null;
const skip = !hasBuild;
const skipBrowser = !pw;
type Page = import('playwright').Page;

const EMAIL = 'admin@beautifuluaehome.com';
const PHOTO = fs.readFileSync('test/fixtures/sheet-indigo.png');
const PHOTO_URL = `data:image/png;base64,${PHOTO.toString('base64')}`;

let server: RunningServer;
let browser: import('playwright').Browser;
let cookie = '';

before(async () => {
  if (skip) return;
  server = await startServer();
  const h = { 'content-type': 'application/json', origin: server.base };
  await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'x@y.z', password: 'x' }) });
  let once: string | undefined;
  for (let i = 0; i < 100 && !(once = server.log().match(/Password: (\S+)/)?.[1]); i++) await new Promise((r) => setTimeout(r, 100));
  const login = await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: EMAIL, password: once }) });
  const first = (login.headers.get('set-cookie') || '').split(';')[0];
  const changed = await fetch(`${server.base}/api/admin/password`, { method: 'POST', headers: { ...h, cookie: first }, body: JSON.stringify({ currentPassword: once, newPassword: 'Photo-Owner-Pass-1' }) });
  cookie = (changed.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie);
  await setStore({ whatsappNumber: '+971509998877' });
  if (pw) browser = await pw.chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.stop();
});

const api = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${server.base}${p}`, { method, headers: { 'content-type': 'application/json', origin: server.base, cookie, ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
const post = (p: string, body: unknown) => rawFetch(`${server.base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: server.base }, body: JSON.stringify(body) });
async function setStore(settings: Record<string, unknown>) {
  const res = await api('PUT', '/api/admin/settings/store', { settings });
  assert.equal(res.status, 200, await res.text());
}
async function waitForPage(want: number) {
  // Settings reach the pages within a moment (the shop's cache): wait for the answer wanted.
  let status = 0;
  for (let i = 0; i < 50 && status !== want; i++) {
    status = (await rawFetch(`${server.base}/order-by-photo`)).status;
    if (status !== want) await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(status, want);
}
let phoneN = 0;
async function placePhotoOrder(amount = 350): Promise<{ id: string; total: number }> {
  const phone = `+97150660${String(++phoneN).padStart(4, '0')}`;
  const res = await post('/api/orders', {
    idempotencyKey: crypto.randomUUID(),
    customer: { fullName: 'Layla Test', phone, emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '9' },
    items: [],
    photo: { photos: [PHOTO_URL], note: 'Queen set', pieces: 1, amount },
    paymentMethod: 'cod',
  });
  const text = await res.text();
  assert.equal(res.status, 201, text);
  return JSON.parse(text).order;
}
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

test('the routes: the link only when switched on; the photos for the owner only; "Confirm amount" checked; nothing goes ahead before it', { skip }, async () => {
  await waitForPage(404);
  await setStore({ photoOrders: true });
  await waitForPage(200);
  const order = await placePhotoOrder();
  const photo = `/api/admin/orders/${order.id}/photos/1`;
  assert.equal((await rawFetch(`${server.base}${photo}`)).status, 404, 'hidden without the door');
  assert.equal((await fetch(`${server.base}${photo}`)).status, 401, 'needs a session');
  const got = await api('GET', photo);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'image/png');
  assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
  assert.match(got.headers.get('cache-control') ?? '', /no-store/);
  assert.match(got.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), PHOTO);
  assert.equal((await api('GET', `/api/admin/orders/${order.id}/photos/2`)).status, 404);
  assert.equal((await api('GET', `/api/admin/orders/${order.id}/photos/x`)).status, 404);

  const amount = `/api/admin/orders/${order.id}/photo-amount`;
  assert.equal((await fetch(`${server.base}${amount}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: server.base }, body: '{"amount":1}' })).status, 401);
  assert.equal((await api('POST', amount, { amount: 400 }, { origin: 'https://evil.test' })).status, 403);
  assert.equal((await api('POST', amount, { amount: 400, extra: 1 })).status, 400);
  assert.equal((await api('POST', amount, { amount: 0 })).status, 400);
  assert.equal((await api('POST', amount, JSON.stringify({ amount: 400, pad: 'x'.repeat(2000) }))).status, 413);
  // Before the amount: not confirmed, not booked.
  const early = await api('PATCH', `/api/admin/orders/${order.id}`, { status: 'confirmed', shipUnconfirmed: true });
  assert.equal(early.status, 409);
  assert.match((await early.json()).message, /confirm the amount first/);
  assert.equal((await api('POST', '/api/courier/dispatch', { orderId: order.id, provider: 'jeebly', shipUnconfirmed: true })).status, 409);
  const ok = await api('POST', amount, { amount: 400 });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.changed, true);
  assert.equal(body.order.total, 400);
  assert.equal((await api('PATCH', `/api/admin/orders/${order.id}`, { status: 'confirmed', shipUnconfirmed: true })).status, 200);
  // The customer sees the amount is confirmed (and nothing about who).
  const tracked = await (await post('/api/orders/lookup', { orderId: order.id, phone: `+97150660${String(phoneN).padStart(4, '0')}` })).json();
  assert.deepEqual(tracked.order.photoOrder, { photos: 1, pieces: 1, agreedTotal: 350, note: 'Queen set', amountConfirmed: true });
  // Not an order from a photo: not found.
  assert.equal((await api('POST', '/api/admin/orders/BUH-000000-NOPE00/photo-amount', { amount: 5 })).status, 404);
});

test('in the shop at 375 and 1280 px: the banner and the link open the form; photos, amount, checkout; then the hub confirms the amount', { skip: skip || skipBrowser }, async () => {
  await setStore({ photoOrders: true, photoOrdersOnHome: true });
  const shots = process.env.SHOTS;
  for (const [width, phone] of [[375, '050 661 3001'], [1280, '055 661 3002']] as const) {
    const ctx = await browser.newContext({ viewport: { width, height: 860 }, hasTouch: width < 800 });
    await ctx.route('https://wa.me/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>wa</title>' }));
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // The home banner (width 375), the shared link (1280).
    if (width === 375) {
      await page.goto(server.base, { waitUntil: 'domcontentloaded' });
      const banner = page.getByTestId('photo-order-banner');
      await banner.waitFor();
      // Highlighted: a gold glow around it (still for people who asked for less motion).
      assert.notEqual(await banner.evaluate((el) => getComputedStyle(el).boxShadow), 'none');
      assert.equal(await overflow(page), false);
      if (shots) await banner.screenshot({ path: path.join(shots, `photo-banner-${width}.png`) });
      await banner.click();
    } else {
      await page.goto(`${server.base}/order-by-photo`, { waitUntil: 'domcontentloaded' });
    }
    const sheet = page.getByTestId('photo-order');
    await sheet.waitFor();
    const next = sheet.getByRole('button', { name: /Continue: address/ });
    assert.equal(await next.isDisabled(), true, 'needs a photo and the amount');
    await sheet.getByTestId('photo-order-file').setInputFiles({ name: 'piece.png', mimeType: 'image/png', buffer: PHOTO });
    await sheet.getByTestId('photo-order-photos').getByRole('img').first().waitFor();
    await sheet.getByLabel(/What is it/).fill('King set, blue print');
    await sheet.getByLabel('Total agreed, with delivery (AED)').fill('275');
    assert.equal(await overflow(page), false, `no sideways scroll at ${width}`);
    if (shots) await sheet.screenshot({ path: path.join(shots, `photo-sheet-${width}.png`) });
    await next.click();
    // Checkout: the summary says it is the photo order; address and phone as usual.
    await page.getByTestId('checkout-photo-summary').waitFor();
    await page.getByPlaceholder('e.g. Fatima Al Mansoori').fill('Hessa Test');
    await page.locator('#checkout-phone').fill(phone);
    await page.getByPlaceholder('e.g. Dubai Marina, Saadiyat, JVC').fill('Dubai Marina');
    await page.getByPlaceholder('Street name, road, or community number').fill('Marina Walk');
    await page.getByPlaceholder('e.g. Marina Gate 1 or Villa 24').fill('Marina Gate 1');
    await page.getByPlaceholder('e.g. Apt 1402 or Villa 24').fill('1402');
    assert.equal(await overflow(page), false);
    await page.locator('form button[type=submit]').last().click();
    await page.locator('#order-confirmed-title').waitFor({ timeout: 15_000 });
    const nextStep = page.getByTestId('photo-order-next');
    await nextStep.waitFor();
    assert.match(await nextStep.innerText(), /AED 275/);
    await page.getByRole('link', { name: /Confirm (my order )?on WhatsApp/ }).waitFor();
    assert.equal(await overflow(page), false);
    if (shots) await page.screenshot({ path: path.join(shots, `photo-placed-${width}.png`) });
    const id = (await nextStep.innerText()).match(/BUH-\d{6}-[A-Z2-9]{6}/)?.[0];
    assert.ok(id);
    assert.deepEqual(errors, []);
    await ctx.close();

    // The hub: the photo shows, "Confirm amount" lets it go ahead.
    const hub = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 800 });
    const [name, value] = cookie.split('=');
    await hub.addCookies([{ name, value, url: server.base }]);
    const hp = await hub.newPage();
    const hubErrors: string[] = [];
    hp.on('pageerror', (e) => hubErrors.push(e.message));
    await hp.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });
    await openAdminSection(hp, /^Orders/);
    const check = hp.getByTestId('photo-order-check').filter({ has: hp.getByRole('link', { name: `Open photo 1 of ${id}` }) });
    await check.waitFor();
    await check.scrollIntoViewIfNeeded();
    const img = check.getByRole('img').first();
    await img.waitFor();
    await hp.waitForFunction((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0, await img.elementHandle());
    assert.match(await check.innerText(), /customer typed AED 275/);
    assert.equal(await overflow(hp), false, `hub at ${width}: no sideways scroll`);
    if (shots) await check.screenshot({ path: path.join(shots, `photo-hub-${width}.png`) });
    await check.getByRole('button', { name: 'Confirm amount' }).click();
    await check.getByText(/amount confirmed/).waitFor();
    assert.deepEqual(hubErrors, []);
    await hub.close();
  }
});
