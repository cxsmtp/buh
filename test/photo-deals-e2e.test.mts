/**
 * Photo deals against the real build (BUH-02.31.00). The routes: the owner's (hidden without the
 * door, a session, the same origin, an allow-listed and size-capped body); the customer's private
 * page and pictures (no-referrer, noindex, no-store, sandboxed pictures; a token that opens nothing
 * is the shop's ordinary 404); an order takes the deal's price whatever is sent, and the link
 * closes. In Chromium at 375 and 1280 px: the owner makes a deal in Orders (pictures, price, ways
 * to pay), the customer opens the link, sees the pictures and the fixed price, adds the address
 * and orders; the hub shows it as the owner's fixed price. No sideways scroll, no page errors.
 * Skipped without a build.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { hasBuild, rawFetch, startServer, type RunningServer } from './server.mjs';
import { openAdminSection } from './helpers.mjs';
import { ownerPassword, wrongLogin } from './fixtures/fake.mjs';
const OWNER_PASSWORD = ownerPassword();

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
  await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify(wrongLogin()) });
  let once: string | undefined;
  for (let i = 0; i < 100 && !(once = server.log().match(/Password: (\S+)/)?.[1]); i++) await new Promise((r) => setTimeout(r, 100));
  const login = await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: EMAIL, password: once }) });
  const first = (login.headers.get('set-cookie') || '').split(';')[0];
  const changed = await fetch(`${server.base}/api/admin/password`, { method: 'POST', headers: { ...h, cookie: first }, body: JSON.stringify({ currentPassword: once, newPassword: OWNER_PASSWORD }) });
  cookie = (changed.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie);
  const res = await api('PUT', '/api/admin/settings/store', { settings: { whatsappNumber: '+971509998877' } });
  assert.equal(res.status, 200, await res.text());
  if (pw) browser = await pw.chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.stop();
});

const api = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${server.base}${p}`, { method, headers: { 'content-type': 'application/json', origin: server.base, cookie, ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
const post = (p: string, body: unknown) => rawFetch(`${server.base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: server.base }, body: JSON.stringify(body) });
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
const DEAL = { photos: [PHOTO_URL, PHOTO_URL], note: 'Queen set, rose print', pieces: 1, amount: 260, payments: ['cod'], days: 3 };

test('the routes: the owner’s checked; the customer’s page and pictures private; the order takes the deal’s price and closes the link', { skip }, async () => {
  assert.equal((await rawFetch(`${server.base}/api/admin/deals`)).status, 404, 'hidden without the door');
  assert.equal((await fetch(`${server.base}/api/admin/deals`)).status, 401);
  assert.equal((await api('POST', '/api/admin/deals', DEAL, { origin: 'https://evil.test' })).status, 403);
  assert.equal((await api('POST', '/api/admin/deals', { ...DEAL, extra: 1 })).status, 400);
  assert.equal((await api('POST', '/api/admin/deals', JSON.stringify({ ...DEAL, note: 'x'.repeat(12 * 1024 * 1024) }))).status, 413);
  const made = await api('POST', '/api/admin/deals', DEAL);
  assert.equal(made.status, 201);
  const { deal } = await made.json();
  assert.match(deal.url, /\/deal\/[A-Za-z0-9_-]{43}$/);
  const token = deal.url.split('/').pop();
  const listed = await (await api('GET', '/api/admin/deals')).json();
  assert.ok(listed.deals.some((d: { id: string }) => d.id === deal.id));

  const page = await rawFetch(`${server.base}/deal/${token}`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.match(page.headers.get('x-robots-tag') ?? '', /noindex/);
  assert.match(page.headers.get('cache-control') ?? '', /no-store/);
  const pic = await rawFetch(`${server.base}/api/deal/${token}/photos/2`);
  assert.equal(pic.status, 200);
  assert.equal(pic.headers.get('content-type'), 'image/png');
  assert.equal(pic.headers.get('x-content-type-options'), 'nosniff');
  assert.match(pic.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.deepEqual(Buffer.from(await pic.arrayBuffer()), PHOTO);
  assert.equal((await rawFetch(`${server.base}/api/deal/${token}/photos/3`)).status, 404);
  assert.equal((await rawFetch(`${server.base}/deal/${'B'.repeat(43)}`)).status, 404);
  assert.equal((await rawFetch(`${server.base}/api/admin/deals/${deal.id}/photos/1`)).status, 404, 'the hub’s copy: hidden without the door');
  assert.equal((await api('GET', `/api/admin/deals/${deal.id}/photos/1`)).status, 200);

  const order = {
    idempotencyKey: crypto.randomUUID(),
    customer: { fullName: 'Layla Test', phone: '+971506671001', emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '9' },
    items: [],
    paymentMethod: 'cod',
  };
  // The customer "changes the rate": refused.
  assert.equal((await post('/api/orders', { ...order, deal: { token, amount: 10 } })).status, 400);
  assert.equal((await post('/api/orders', { ...order, deal: { token }, expectedTotal: 10 })).status, 409);
  const placed = await post('/api/orders', { ...order, deal: { token }, expectedTotal: 260 });
  const text = await placed.text();
  assert.equal(placed.status, 201, text);
  const body = JSON.parse(text);
  assert.equal(body.order.total, 260);
  assert.equal(body.order.photoOrder.fixedPrice, true);
  assert.equal((await rawFetch(`${server.base}/deal/${token}`)).status, 404, 'used: the link closes');
  // Ordered: can't be stopped (the order is the record); the action is allow-listed.
  assert.equal((await api('POST', `/api/admin/deals/${deal.id}`, { action: 'cancel' })).status, 409);
  assert.equal((await api('POST', `/api/admin/deals/${deal.id}`, { action: 'delete' })).status, 400);
  // The order goes ahead without "Confirm amount": the price was the owner's.
  assert.equal((await api('PATCH', `/api/admin/orders/${body.order.id}`, { status: 'confirmed', shipUnconfirmed: true })).status, 200);
});

test('at 375 and 1280 px: the owner makes the deal in Orders; the customer sees the pictures and the fixed price and orders', { skip: skip || skipBrowser }, async () => {
  const shots = process.env.SHOTS;
  for (const [width, phone] of [[375, '050 667 2001'], [1280, '055 667 2002']] as const) {
    // The hub: Orders → New photo deal.
    const hub = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 800 });
    const [name, value] = cookie.split('=');
    await hub.addCookies([{ name, value, url: server.base }]);
    const hp = await hub.newPage();
    const hubErrors: string[] = [];
    hp.on('pageerror', (e) => hubErrors.push(e.message));
    await hp.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });
    await openAdminSection(hp, /^Orders/);
    const deals = hp.getByTestId('photo-deals');
    await deals.getByRole('button', { name: 'New photo deal' }).click();
    const form = deals.getByTestId('deal-form');
    await form.getByTestId('deal-file').setInputFiles([
      { name: 'a.png', mimeType: 'image/png', buffer: PHOTO },
      { name: 'b.png', mimeType: 'image/png', buffer: PHOTO },
    ]);
    await form.getByTestId('deal-form-photos').getByRole('img').nth(1).waitFor();
    await form.getByLabel(/What it is/).fill('King set, indigo block print');
    await form.getByLabel(/^For/).fill(`Hessa ${width}`);
    await form.getByLabel('Price with delivery (AED)').fill('310');
    await form.getByLabel('Card').uncheck();
    await form.getByLabel('Bank transfer').uncheck();
    assert.equal(await overflow(hp), false, `hub at ${width}: no sideways scroll`);
    if (shots) await deals.screenshot({ path: path.join(shots, `deal-form-${width}.png`) });
    await form.getByRole('button', { name: 'Make the link' }).click();
    const link = await deals.getByTestId('deal-link').innerText();
    assert.match(link, /\/deal\/[A-Za-z0-9_-]{43}$/);
    await deals.getByTestId('deal-list').getByText(`Hessa ${width}`).waitFor();
    assert.equal(await overflow(hp), false);
    if (shots) await deals.screenshot({ path: path.join(shots, `deal-made-${width}.png`) });

    // The customer.
    const ctx = await browser.newContext({ viewport: { width, height: 860 }, hasTouch: width < 800 });
    await ctx.route('https://wa.me/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>wa</title>' }));
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(new URL(new URL(link).pathname, server.base).href, { waitUntil: 'domcontentloaded' });
    const sheet = page.getByTestId('deal-sheet');
    await sheet.waitFor();
    const img = sheet.getByTestId('deal-photo');
    await page.waitForFunction((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0, await img.elementHandle());
    assert.match(await sheet.getByTestId('deal-price').innerText(), /AED 310/);
    assert.match(await sheet.getByTestId('deal-price').innerText(), /Fixed price, standard delivery included\. Pay by cash on delivery\./);
    assert.match(await sheet.getByTestId('deal-note').innerText(), /indigo block print/);
    // The keyboard reaches the next picture and the button.
    await sheet.getByRole('button', { name: 'Next picture' }).focus();
    await page.keyboard.press('Enter');
    assert.match((await img.getAttribute('alt')) ?? '', /Picture 2 of 2/);
    assert.equal(await overflow(page), false, `deal page at ${width}: no sideways scroll`);
    if (shots) await sheet.screenshot({ path: path.join(shots, `deal-sheet-${width}.png`) });
    await sheet.getByRole('button', { name: /Continue: address/ }).click();
    // Checkout: the fixed price, only the ways to pay allowed, no price to type.
    const summary = page.getByTestId('checkout-photo-summary');
    await summary.waitFor();
    assert.match(await summary.innerText(), /Fixed price/);
    assert.equal(await page.getByRole('radio', { name: /Card/ }).count(), 0);
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
    assert.match(await nextStep.innerText(), /prepare it as agreed/);
    await page.getByRole('link', { name: /confirm (my order )?on WhatsApp/i }).waitFor();
    assert.equal(await overflow(page), false);
    if (shots) await page.screenshot({ path: path.join(shots, `deal-placed-${width}.png`) });
    const id = (await nextStep.innerText()).match(/BUH-\d{6}-[A-Z2-9]{6}/)?.[0];
    assert.ok(id);
    assert.deepEqual(errors, []);
    await ctx.close();

    // Back in the hub: ordered, and the order shows the owner's fixed price (nothing to confirm).
    await hp.reload({ waitUntil: 'domcontentloaded' });
    await openAdminSection(hp, /^Orders/);
    const check = hp.getByTestId('photo-order-check').filter({ has: hp.getByRole('link', { name: `Open photo 1 of ${id}` }) });
    await check.waitFor();
    assert.match(await check.innerText(), /your fixed price/);
    assert.equal(await check.getByRole('button', { name: /Confirm amount/ }).count(), 0);
    assert.deepEqual(hubErrors, []);
    await hub.close();
  }
});
