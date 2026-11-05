/**
 * The order's private tracking link against the real build (BUH-02.31.00): /track/<token> opens
 * Track Order with the order (no phone number), with no-referrer, noindex and no-store; a changed
 * link is the shop's 404; the lookup takes { token } only. In Chromium at 375 and 1280 px: the
 * customer's tracking page, and in the hub the confirmed order's "Send confirmation & tracking
 * link" (a WhatsApp message with the order number and the link). No sideways scroll, no page errors.
 * Skipped without a build.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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

const api = (method: string, p: string, body?: unknown) =>
  fetch(`${server.base}${p}`, { method, headers: { 'content-type': 'application/json', origin: server.base, cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
const post = (p: string, body: unknown) => rawFetch(`${server.base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: server.base }, body: JSON.stringify(body) });
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

let phoneN = 0;
async function confirmedOrder(): Promise<{ id: string; trackPath: string }> {
  const products = (await (await rawFetch(`${server.base}/api/products`)).json()).products as Array<{ id: string; profiles: Array<{ id: string }> }>;
  const res = await post('/api/orders', {
    idempotencyKey: crypto.randomUUID(),
    customer: { fullName: 'Noura Test', phone: `+97150881${String(++phoneN).padStart(4, '0')}`, emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '9' },
    items: [{ productId: products[0].id, profileId: products[0].profiles[0].id, quantity: 1 }],
    paymentMethod: 'cod',
  });
  const text = await res.text();
  assert.equal(res.status, 201, text);
  const { order } = JSON.parse(text);
  assert.match(order.trackPath, /^\/track\//);
  const ok = await api('POST', `/api/admin/orders/${order.id}/whatsapp`, { result: 'confirmed' });
  assert.equal(ok.status, 200);
  return order;
}

test('the link: opens only its order, privately; the lookup takes the token alone', { skip }, async () => {
  const order = await confirmedOrder();
  const page = await rawFetch(`${server.base}${order.trackPath}`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.match(page.headers.get('x-robots-tag') ?? '', /noindex/);
  assert.match(page.headers.get('cache-control') ?? '', /no-store/);
  const token = order.trackPath.split('/').pop()!;
  assert.equal((await rawFetch(`${server.base}/track/${token.slice(0, -2)}xx`)).status, 404);
  assert.equal((await rawFetch(`${server.base}/track/BUH-1`)).status, 404);
  const found = await (await post('/api/orders/lookup', { token })).json();
  assert.equal(found.found, true);
  assert.equal(found.order.id, order.id);
  assert.ok(!JSON.stringify(found).includes('Walk 1'), 'never the address');
  assert.equal((await post('/api/orders/lookup', { token, phone: '0501234567' })).status, 400);
  assert.equal((await post('/api/orders/lookup', { token: `${order.id}.${'A'.repeat(43)}` })).status, 404);
});

test('at 375 and 1280 px: the customer’s tracking page; the hub’s "Send confirmation & tracking link"', { skip: skip || skipBrowser }, async () => {
  for (const width of [375, 1280]) {
    const order = await confirmedOrder();
    const ctx = await browser.newContext({ viewport: { width, height: 860 }, hasTouch: width < 800 });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${server.base}${order.trackPath}`, { waitUntil: 'domcontentloaded' });
    const dialog = page.getByRole('dialog', { name: 'Track your order' });
    await dialog.getByText(order.id, { exact: true }).waitFor();
    // Confirmed on WhatsApp by the shop: the customer sees "confirmed", as the message says.
    await dialog.getByText('confirmed', { exact: true }).waitFor();
    assert.equal(await overflow(page), false, `tracking page at ${width}: no sideways scroll`);
    if (process.env.SHOTS) await dialog.screenshot({ path: `${process.env.SHOTS}/track-${width}.png` });
    assert.deepEqual(errors, []);
    await ctx.close();

    const hub = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 800 });
    const [name, value] = cookie.split('=');
    await hub.addCookies([{ name, value, url: server.base }]);
    const hp = await hub.newPage();
    const hubErrors: string[] = [];
    hp.on('pageerror', (e) => hubErrors.push(e.message));
    await hp.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });
    await openAdminSection(hp, /^Orders/);
    const send = hp.locator(`a[href*="${encodeURIComponent(order.id)}"]`).filter({ hasText: 'Send confirmation & tracking link' }).first();
    await send.waitFor();
    const href = decodeURIComponent((await send.getAttribute('href')) ?? '');
    assert.match(href, new RegExp(`your order ${order.id} is confirmed`));
    assert.ok(href.includes(`Track it any time: ${server.base}${order.trackPath}`) || href.includes(order.trackPath), href);
    await send.scrollIntoViewIfNeeded();
    // The keyboard reaches it.
    await send.focus();
    assert.equal(await send.evaluate((el) => el === document.activeElement), true);
    assert.equal(await overflow(hp), false, `hub at ${width}: no sideways scroll`);
    if (process.env.SHOTS) await send.locator('xpath=ancestor::*[@data-testid="whatsapp-check"]').screenshot({ path: `${process.env.SHOTS}/track-hub-${width}.png` });
    assert.deepEqual(hubErrors, []);
    await hub.close();
  }
});
